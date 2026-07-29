-- aplyx hosted backend — Phase 11 schema.
--
-- Mirrors the local JSON shapes (packages/core/src/state.ts, the onboarding
-- field schema in packages/core/src/onboarding/fields.ts) so local <-> hosted
-- sync is mechanical, plus a `profiles` table for the safe_fields-shaped PII
-- the operator has explicitly approved syncing for signed-in users
-- (2026-07-16 decision — a deliberate override of this phase's original
-- local-only-PII default; see packages/core/src/onboarding/profile.ts's
-- HOSTED_PROFILE_FIELD_IDS comment for the exact field list and rationale).
--
-- Every table is scoped to auth.uid() via row-level security from the start
-- — a user can never read or write another user's rows. Run this file via
-- `supabase db push` or paste it into the Supabase SQL editor.

-- --- profiles ---------------------------------------------------------------
-- One row per signed-in user. Columns mirror the 18 non-preference onboarding
-- fields (HOSTED_PROFILE_FIELD_IDS) one-to-one; `preferences` holds the 3
-- job-search-preference fields (role_keywords/preferred_locations/
-- target_companies) as flexible jsonb since they only become meaningful once
-- synced into a local install's config/targets.json (Phase 14B), not because
-- they need per-field querying here.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  preferred_name text,
  first_name text,
  last_name text,
  email text,
  phone text,
  address_line1 text,
  address_line2 text,
  zip_code text,
  location text,
  linkedin_username text,
  github_username text,
  authorized_to_work text,
  require_sponsorship text,
  graduation_date text,
  gender text,
  ethnicity text,
  hispanic_or_latino text,
  date_of_birth text,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = user_id);
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = user_id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "profiles_delete_own" on public.profiles
  for delete using (auth.uid() = user_id);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- --- jobs (canonical registry) ----------------------------------------------
-- Mirrors data/job_registry.json (packages/core/src/state.ts RegistryRecord).
-- allowed/blocking statuses match scripts/state/job_state.py's
-- ALLOWED_STATUSES / BLOCKING_STATUSES exactly — keep these three lists in
-- sync if the Python side ever adds a status.

create table if not exists public.jobs (
  user_id uuid not null references auth.users (id) on delete cascade,
  job_key text not null,
  job_id text not null,
  company text,
  title text,
  latest_status text not null default 'new'
    check (latest_status in ('new', 'seen', 'applied', 'needs_review', 'failed', 'skipped_unfit')),
  url text,
  internship_term text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, job_key)
);

alter table public.jobs enable row level security;

create policy "jobs_select_own" on public.jobs
  for select using (auth.uid() = user_id);
create policy "jobs_insert_own" on public.jobs
  for insert with check (auth.uid() = user_id);
create policy "jobs_update_own" on public.jobs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "jobs_delete_own" on public.jobs
  for delete using (auth.uid() = user_id);

create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

-- Status-transition guard: never let an update silently downgrade a job from
-- a blocking outcome (applied/needs_review/failed/skipped_unfit) back to a
-- non-blocking discovery status (new/seen) — mirrors job_state.py's
-- record_event() guard so a sync can't regress what the local engine already
-- decided.
create or replace function public.jobs_guard_status_transition()
returns trigger as $$
begin
  if old.latest_status in ('applied', 'needs_review', 'failed', 'skipped_unfit')
     and new.latest_status in ('new', 'seen') then
    new.latest_status := old.latest_status;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger jobs_status_transition_guard
  before update on public.jobs
  for each row execute function public.jobs_guard_status_transition();

-- --- job_events (append-only event log) -------------------------------------
-- Mirrors data/job_events.jsonl. Insert-only from the client; there is
-- deliberately no update/delete policy, matching the local file's
-- append-only discipline (AGENTS.md "Canonical registry and event log").

create table if not exists public.job_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  job_key text not null,
  status text not null
    check (status in ('new', 'seen', 'applied', 'needs_review', 'failed', 'skipped_unfit')),
  reasoning text,
  company text,
  title text,
  url text,
  recorded_at timestamptz not null default now()
);

alter table public.job_events enable row level security;

create policy "job_events_select_own" on public.job_events
  for select using (auth.uid() = user_id);
create policy "job_events_insert_own" on public.job_events
  for insert with check (auth.uid() = user_id);
-- No update/delete policy: append-only, same as the local JSONL log.

-- --- applied_jobs ------------------------------------------------------------
-- Mirrors data/applied_jobs.json (packages/core/src/state.ts AppliedJob).

create table if not exists public.applied_jobs (
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id text not null,
  company text not null,
  title text not null,
  url text not null,
  apply_url text,
  date_applied text not null,
  status text not null check (status in ('applied', 'failed', 'needs_review')),
  role_type text,
  source text,
  resume_used text,
  ats_score numeric,
  location_tier text,
  cover_letter_used boolean,
  reasoning text,
  created_at timestamptz not null default now(),
  primary key (user_id, job_id)
);

alter table public.applied_jobs enable row level security;

create policy "applied_jobs_select_own" on public.applied_jobs
  for select using (auth.uid() = user_id);
create policy "applied_jobs_insert_own" on public.applied_jobs
  for insert with check (auth.uid() = user_id);
create policy "applied_jobs_update_own" on public.applied_jobs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- --- review_queue ------------------------------------------------------------
-- Mirrors data/review_queue.json (packages/core/src/state.ts QueueEntry) —
-- append-only, same discipline as the local file; "resolved" is derived from
-- applied_jobs/jobs, never deleted here.

create table if not exists public.review_queue (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id text not null,
  company text,
  title text,
  url text,
  apply_url text,
  date_applied text,
  status text,
  role_type text,
  source text,
  resume_used text,
  ats_score numeric,
  location_tier text,
  cover_letter_used boolean,
  reasoning text,
  created_at timestamptz not null default now()
);

alter table public.review_queue enable row level security;

create policy "review_queue_select_own" on public.review_queue
  for select using (auth.uid() = user_id);
create policy "review_queue_insert_own" on public.review_queue
  for insert with check (auth.uid() = user_id);
-- No update/delete policy: append-only, same as the local file.

-- --- resumes storage bucket --------------------------------------------------
-- Private bucket for the hosted onboarding wizard's resume-upload step
-- (docs/app-integration-plan.md hosted onboarding sequence). Objects are
-- keyed "<user_id>/<filename>" and RLS-scoped to that folder prefix, same
-- per-user isolation as every table above — a user can only read/write
-- objects under their own auth.uid() folder.

insert into storage.buckets (id, name, public)
values ('resumes', 'resumes', false)
on conflict (id) do nothing;

create policy "resumes_select_own" on storage.objects
  for select using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "resumes_insert_own" on storage.objects
  for insert with check (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "resumes_update_own" on storage.objects
  for update using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "resumes_delete_own" on storage.objects
  for delete using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
