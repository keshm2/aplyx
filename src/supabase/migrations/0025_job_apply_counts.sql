-- Global, cross-user "how many people applied to this posting" counter.
-- Aggregate-only, non-PII (a job_id and a number -- never a user list),
-- same disclosure posture as public.job_cache's public-select policy in
-- the separate job-cache project: this number carries no per-user
-- information, so it's readable by any signed-in client.
--
-- Keyed by job_id (not job_key): applied_jobs already carries job_id, and
-- job_state.py's derive_job_id() -- "{source}-{external_job_id}" when an
-- external id was extracted, else falls back to job_key -- is already
-- deterministic across users for the same posting (it only depends on
-- properties of the posting itself), so no join back to public.jobs is
-- needed here.

create table if not exists public.job_apply_counts (
  job_id text primary key,
  apply_count integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.job_apply_counts enable row level security;

create policy "job_apply_counts_select_all" on public.job_apply_counts
  for select using (true);

-- No insert/update/delete policy for anon or authenticated -- the only
-- writer is the trigger below (SECURITY DEFINER, runs as the table
-- owner), specifically so no client can inflate a count directly by
-- calling an RPC or writing the table itself.

create or replace function public.bump_job_apply_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.job_apply_counts (job_id, apply_count, updated_at)
  values (new.job_id, 1, now())
  on conflict (job_id) do update
    set apply_count = public.job_apply_counts.apply_count + 1,
        updated_at = now();
  return new;
end;
$$;

-- Two triggers, not one combined INSERT-OR-UPDATE trigger with an OLD
-- reference in the WHEN clause -- Postgres doesn't allow referencing OLD
-- for the INSERT half of a combined trigger. Both call the same function.
--
-- Fires on INSERT when a row is created already-applied (the common
-- path: SupabaseAdapter.markQueueEntryApplied's plain insert()).
create trigger applied_jobs_bump_count_on_insert
  after insert on public.applied_jobs
  for each row
  when (new.status = 'applied')
  execute function public.bump_job_apply_count();

-- Fires on UPDATE only for the one real transition that matters: a row
-- that existed as something else (needs_review, the other branch of
-- markQueueEntryApplied) becoming applied for the first time. Guards
-- against ever double-counting the same (user_id, job_id) row -- its
-- primary key already caps this at one increment per user per job, no
-- matter how many times the row is touched afterward.
create trigger applied_jobs_bump_count_on_update
  after update on public.applied_jobs
  for each row
  when (new.status = 'applied' and old.status is distinct from 'applied')
  execute function public.bump_job_apply_count();
