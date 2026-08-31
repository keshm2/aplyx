-- Hosted-only inbox status tracking (2026-08-19, supersedes the
-- forwarding-based and local-IMAP designs explored earlier the same day;
-- see docs/application-status-tracking-plan.md's own history). Matches
-- what docs/website.md's pricing page already advertises: "automatic job
-- status tracking from your account email" is a Pro-tier HOSTED feature,
-- not something the free local tier gets. Local installs have no access
-- to this at all; only signed-in hosted accounts do, which sidesteps the
-- entire "which local install gets to hold a powerful credential"
-- problem the earlier designs kept running into: everything here is
-- scoped by real Supabase Auth + RLS, same as `profiles`/`applied_jobs`.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;
-- supabase_vault is already installed on this project (confirmed live,
-- 2026-08-19), used below to store app_password encrypted at rest,
-- never as a plain column.

-- --- applied_jobs: outcome tracking columns -----------------------------------
-- Same `outcome_status` taxonomy as the local design
-- (docs/application-status-tracking-plan.md): a genuinely different axis
-- from `status` above (whether *aplyx* submitted the application vs what
-- the *employer* has said since).

alter table public.applied_jobs
  add column if not exists outcome_status text
    check (outcome_status in ('applied', 'oa_sent', 'interview_requested', 'offer', 'rejected', 'withdrawn')),
  add column if not exists outcome_updated_at timestamptz,
  add column if not exists outcome_source text;

-- Terminal-state guard, enforced at the DB layer exactly like
-- jobs_guard_status_transition above guards `latest_status`: once
-- rejected/offer/withdrawn is reached, no update (from the worker or
-- anywhere else) can silently move it again. Fires for every writer,
-- including the service-role worker; triggers aren't bypassed by RLS
-- exemption the way policies are.
create or replace function public.applied_jobs_guard_outcome_transition()
returns trigger as $$
begin
  if old.outcome_status in ('rejected', 'offer', 'withdrawn')
     and new.outcome_status is distinct from old.outcome_status then
    new.outcome_status := old.outcome_status;
    new.outcome_updated_at := old.outcome_updated_at;
    new.outcome_source := old.outcome_source;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger applied_jobs_outcome_transition_guard
  before update on public.applied_jobs
  for each row execute function public.applied_jobs_guard_outcome_transition();

-- --- email_tracking_config -----------------------------------------------------
-- One row per opted-in hosted account. app_password is NEVER stored in a
-- plain column -- only a pointer (app_password_secret_id) to a Vault
-- secret, which only set_email_tracking_config() below (SECURITY
-- DEFINER) can write, and only the service-role worker can decrypt
-- (via vault.decrypted_secrets, itself RLS-restricted to service_role).

create table if not exists public.email_tracking_config (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null default false,
  email text not null,
  imap_server text not null,
  imap_port integer not null default 993,
  app_password_secret_id uuid references vault.secrets (id) on delete set null,
  -- Highest IMAP UID already processed for this user, so the worker only
  -- fetches messages newer than its last run (same idea as the local
  -- design's data/email_watermark.json, just per-row instead of per-file).
  last_uid integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.email_tracking_config enable row level security;

create policy "email_tracking_config_select_own" on public.email_tracking_config
  for select using (auth.uid() = user_id);
-- No insert/update/delete policy for the client: writing requires
-- calling vault.create_secret/update_secret (normally service-role-only),
-- so the ONLY way a signed-in user can set this is through
-- set_email_tracking_config() below.

create trigger email_tracking_config_set_updated_at
  before update on public.email_tracking_config
  for each row execute function public.set_updated_at();

-- The only way a signed-in user can set/update their own inbox-tracking
-- config. SECURITY DEFINER so it can call vault.create_secret/
-- update_secret; still scoped to the CALLER's own auth.uid() (derived
-- from the request's JWT regardless of the function's execution
-- privileges), so this can never touch another user's row.
create or replace function public.set_email_tracking_config(
  p_enabled boolean,
  p_email text,
  p_imap_server text,
  p_imap_port integer,
  p_app_password text
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_user_id uuid := auth.uid();
  v_secret_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select app_password_secret_id into v_secret_id
    from public.email_tracking_config where user_id = v_user_id;

  if v_secret_id is not null then
    perform vault.update_secret(v_secret_id, p_app_password);
  else
    v_secret_id := vault.create_secret(p_app_password, 'email_tracking:' || v_user_id::text);
  end if;

  insert into public.email_tracking_config (user_id, enabled, email, imap_server, imap_port, app_password_secret_id)
  values (v_user_id, p_enabled, p_email, p_imap_server, p_imap_port, v_secret_id)
  on conflict (user_id) do update set
    enabled = excluded.enabled,
    email = excluded.email,
    imap_server = excluded.imap_server,
    imap_port = excluded.imap_port,
    app_password_secret_id = excluded.app_password_secret_id;
end;
$$;

grant execute on function public.set_email_tracking_config(boolean, text, text, integer, text) to authenticated;
