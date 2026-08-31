-- aplyx hosted backend: Phase 17 first increment (2026-08-10).
--
-- `hosted_runs` is the work queue the GitHub-Actions-scheduled worker
-- (src/worker/) claims from: one row per server-side pipeline run
-- (fetch -> canonicalize -> fit-gate -> tailor -> land in review_queue)
-- for one signed-in hosted user. See docs/hosted-paid-tier-plan.md and
-- the approved plan for this increment for the full design.
--
-- `mode` is carried from day one (review_only/auto_apply) even though
-- this increment's worker only ever claims mode='review_only' rows,
-- so adding auto_apply later is a new code path, not a schema
-- migration + backfill. That claim restriction is enforced in the
-- worker's own claim query (src/worker/src/run.ts), not just here, but
-- the check constraint below still exists so a row can never be
-- inserted with a mode value the system doesn't understand at all.
--
-- No update/delete policy for the signed-in user, same append-then-
-- worker-updates discipline as review_queue/job_events: a user can
-- INSERT a request (or, in this increment, an operator inserts one
-- directly for verification, no "Run now" UI button yet) and SELECT
-- their own rows to see status, but only the worker (service-role,
-- bypasses RLS) ever transitions status/result/error.

create table if not exists public.hosted_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  mode text not null default 'review_only'
    check (mode in ('review_only', 'auto_apply')),
  claimed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  error text,
  created_at timestamptz not null default now()
);

alter table public.hosted_runs enable row level security;

create policy "hosted_runs_select_own" on public.hosted_runs
  for select using (auth.uid() = user_id);
create policy "hosted_runs_insert_own" on public.hosted_runs
  for insert with check (auth.uid() = user_id);
-- No update/delete policy for the authenticated role: only the
-- service-role worker (which bypasses RLS entirely) ever changes a
-- run's status/result/error once queued.
