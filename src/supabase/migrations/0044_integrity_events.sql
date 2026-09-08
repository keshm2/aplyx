-- aplyx: client-integrity tracking (2026-09-07).
--
-- The local build ships enforcement as plain-text Python + markdown that
-- the user's own coding agent runs, so it cannot be made un-bypassable on
-- the user's machine. What it CAN do is detect tampering and make it
-- consequential:
--
--   * A per-release manifest of SHA-256 hashes for the enforcement-
--     critical files (run_job_agent.py, job_state.py, job-scraper.md, the
--     generated agent defs) plus a "must not exist" list for the features
--     disabled server-side (cover-letter-tailor / interest-letter agent
--     defs). CI publishes it here; `release_manifests` is the root of
--     trust the client compares against, since the client cannot forge a
--     service_role write.
--   * `integrity_events`: every violation the client detects, INSERT-only
--     for the authenticated user, no UPDATE/DELETE — a tampered client
--     can withhold a report but cannot erase one already sent, and a
--     `profiles.integrity_status` that goes stale is itself a signal.
--
-- A hosted account with `integrity_status = 'violation'` (or a stale
-- `integrity_checked_at`) should be treated as untrusted for paid
-- upgrades and worker runs — that check is a follow-up, not in this
-- migration.
--
-- Run via `supabase db push` or the SQL editor; NOT applied automatically
-- by committing this file.

-- --- release_manifests: the canonical per-version file hashes ----------

create table if not exists public.release_manifests (
  version text primary key,
  files jsonb not null,        -- { "<repo-relative path>": "<sha256 hex>", ... }
  forbidden text[] not null default '{}',  -- repo-relative paths that must NOT exist
  published_at timestamptz not null default now()
);

alter table public.release_manifests enable row level security;

-- Read by every client (signed in or not) to verify its own files.
create policy "release_manifests_read_all" on public.release_manifests
  for select using (true);
-- Written only by CI running as service_role (bypasses RLS). No
-- authenticated INSERT/UPDATE/DELETE policy.

grant select on public.release_manifests to anon, authenticated;

-- --- integrity_events: what the client reported ------------------------

create table if not exists public.integrity_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in (
    'file_modified', 'file_missing', 'forbidden_file_present',
    'disabled_feature_reenabled', 'cap_logic_missing', 'manifest_unavailable'
  )),
  detail jsonb not null default '{}'::jsonb,
  client_version text,
  source text not null default 'local' check (source in ('local', 'tui', 'desktop')),
  detected_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists integrity_events_user_idx
  on public.integrity_events (user_id, detected_at desc);

alter table public.integrity_events enable row level security;

create policy "integrity_events_select_own" on public.integrity_events
  for select using (auth.uid() = user_id);
create policy "integrity_events_insert_own" on public.integrity_events
  for insert with check (auth.uid() = user_id);
-- No UPDATE/DELETE for authenticated: a report, once sent, is permanent.

-- --- profiles: last verified integrity status -------------------------

alter table public.profiles
  add column if not exists integrity_status text
    check (integrity_status in ('ok', 'violation', 'unverified')),
  add column if not exists integrity_checked_at timestamptz;

-- Stamped by the client after each verify_integrity run via the existing
-- profiles_update_own policy (migration 0001) — already scoped to
-- auth.uid() = user_id. A client can set its own status to 'ok'
-- dishonestly, but it cannot remove the integrity_events rows that
-- contradict it, and a status that stops updating (integrity_checked_at
-- going stale) is the tell.

-- --- helper: does this account have an unresolved integrity violation? -

create or replace function public.has_integrity_violation(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.integrity_events e
    where e.user_id = p_user_id
      and e.detected_at > now() - interval '30 days'
  )
  or coalesce(
    (select p.integrity_status = 'violation' from public.profiles p where p.user_id = p_user_id),
    false
  )
$$;

revoke all on function public.has_integrity_violation(uuid) from public, anon;
grant execute on function public.has_integrity_violation(uuid) to authenticated, service_role;
