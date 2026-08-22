-- Short-lived verification sessions for hosted gated-ATS flows.

create table if not exists public.verification_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  apply_run_id uuid references public.apply_runs (id) on delete cascade,
  job_id text not null,
  family text not null check (family in ('greenhouse', 'lever', 'ashbyhq', 'workday')),
  tenant_key text,
  company text,
  candidate_email text not null,
  mail_connection_id uuid references public.mail_connections (id) on delete set null,
  status text not null default 'created'
    check (status in ('created', 'watching', 'message_found', 'secret_ready', 'consumed', 'resumed', 'manual_required', 'expired', 'failed', 'canceled')),
  challenge_type text not null default 'unknown'
    check (challenge_type in ('otp', 'link', 'either', 'unknown')),
  expected_sender_domains jsonb not null default '[]'::jsonb,
  expected_subject_tokens jsonb not null default '[]'::jsonb,
  detection_started_at timestamptz,
  expires_at timestamptz,
  attempt_count integer not null default 0,
  last_poll_at timestamptz,
  resolved_at timestamptz,
  failure_reason text,
  checkpoint jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists verification_sessions_user_status_idx
  on public.verification_sessions (user_id, status, family);

alter table public.verification_sessions enable row level security;

create policy "verification_sessions_select_own" on public.verification_sessions
  for select using (auth.uid() = user_id);
create policy "verification_sessions_insert_own" on public.verification_sessions
  for insert with check (auth.uid() = user_id);

create trigger verification_sessions_set_updated_at
  before update on public.verification_sessions
  for each row execute function public.set_updated_at();
