-- apply_runs: per-application submission lifecycle (apply-foundation).
--
-- Distinct from hosted_runs (migration 0004): hosted_runs is the
-- review_only worker's work queue (one row per server-side pipeline
-- run: fetch -> canonicalize -> fit-gate -> tailor -> land in
-- review_queue). apply_runs is one row per actual APPLICATION
-- SUBMISSION ATTEMPT: the lifecycle a single job's apply moves
-- through (initialized -> package_assembled -> fill_planned -> filling
-- -> ready_to_submit -> confirm_before_submit -> submitting ->
-- submitted/needs_review/failed/canceled), as defined in
-- src/core/src/applyStateMachine.ts.
--
-- This table exists from day one on both the local and hosted paths
-- (the state machine is framework-agnostic), but only hosted writes
-- here; a local install keeps its apply-run state in the existing
-- data/*.json files via the Python helpers, same as every other local
-- state write. The hosted adapter (src/core/src/adapters/supabase.ts)
-- and a future hosted auto-apply worker (docs/hosted-auto-apply-plan.md)
-- are the writers; the signed-in user only reads.
--
-- `status` carries the full state-machine vocabulary (not just the
-- three-value applied_jobs.status) so the confirm-before-submit UI
-- (Stage 1) can find runs paused in 'confirm_before_submit' and the
-- dashboard can show 'ready_to_submit' / 'submitting' for in-flight
-- runs. The check constraint tracks applyStateMachine.ts's
-- ApplyRunStatus union; keep in sync if the state machine adds a
-- state.
--
-- `family` is the ATS family (greenhouse/lever/ashbyhq/workday) from
-- src/core/src/atsRegistry.ts; drives whether the run used a managed
-- alias (account-required) or the applicant's real email (guest).
--
-- `alias_id` references managed_aliases (migration 0011) when the run
-- used a mail.aplyx.app alias; null for guest flows. The foreign key
-- is ON DELETE SET NULL (not CASCADE) so deleting an alias doesn't
-- erase the apply-run history; the run keeps its outcome, just loses
-- the alias linkage.
--
-- `fill_plan` is the jsonb serialization of the FillPlan
-- (src/core/src/fillPlan.ts): the structured field-mapping the
-- confirm-before-submit UI renders for approval. Written when the run
-- reaches fill_planned; null before that.

-- `checkpoint` stores resumable execution metadata (e.g. pending OTP,
-- waiting-on-review, next browser step) while `approval_state` tracks the
-- confirm-before-submit decision independently of the lifecycle status.
-- `screenshot_url` and `tailored_resume_artifact_path` let the review UI
-- render the filled-form snapshot and the exact resume artifact queued for
-- upload without looking anywhere else.
--
-- No update/delete policy for the signed-in user, same append-then-
-- worker-updates discipline as hosted_runs (0004): a user can INSERT a
-- request (or, in this foundation increment, an operator inserts one
-- directly for verification) and SELECT their own rows to see status,
-- but only the worker (service-role, bypasses RLS) ever transitions
-- status/fill_plan/error.

create table if not exists public.apply_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id text not null,
  family text not null
    check (family in ('greenhouse', 'lever', 'ashbyhq', 'workday')),
  status text not null default 'initialized'
    check (status in (
      'initialized', 'package_assembled', 'fill_planned', 'filling',
      'ready_to_submit', 'confirm_before_submit', 'submitting',
      'submitted', 'needs_review', 'failed', 'canceled'
    )),
  alias_id uuid references public.managed_aliases (id) on delete set null,
  tailored_resume_attached boolean not null default false,
  tailored_resume_artifact_path text,
  fill_plan jsonb,
  checkpoint jsonb,
  approval_state text not null default 'pending'
    check (approval_state in ('pending', 'approved', 'rejected')),
  screenshot_url text,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists apply_runs_user_status_idx
  on public.apply_runs (user_id, status);
create index if not exists apply_runs_job_idx
  on public.apply_runs (user_id, job_id);

alter table public.apply_runs enable row level security;

create policy "apply_runs_select_own" on public.apply_runs
  for select using (auth.uid() = user_id);
create policy "apply_runs_insert_own" on public.apply_runs
  for insert with check (auth.uid() = user_id);
-- No update/delete policy for the authenticated role: only the
-- service-role worker (which bypasses RLS entirely) ever transitions a
-- run's status/fill_plan/error once created.

create trigger apply_runs_set_updated_at
  before update on public.apply_runs
  for each row execute function public.set_updated_at();
