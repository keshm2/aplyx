-- Adds "oa_completed" (assessment submitted/completed, distinct from
-- "oa_sent" = assessment invitation received but not yet done) to the
-- outcome_status taxonomy — operator-requested (2026-08-21) so the
-- classifier can distinguish "IBM assessment still waiting" (oa_sent)
-- from "Roblox assessment I completed" (oa_completed), not just lump
-- both under one status. Non-terminal, same as oa_sent/interview_requested
-- — applied_jobs_guard_outcome_transition (0007) only locks
-- rejected/offer/withdrawn, so this can still move forward from here.

-- Finds and drops whatever Postgres actually named the existing check
-- constraint (an inline `add column ... check (...)` in 0007 gets an
-- auto-generated name we can't verify from here without Docker/db dump
-- access) rather than guessing a name that might silently leave the old,
-- more restrictive constraint in place alongside a new one.
do $$
declare
  con record;
begin
  for con in
    select conname
    from pg_constraint
    where conrelid = 'public.applied_jobs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%outcome_status%'
  loop
    execute format('alter table public.applied_jobs drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.applied_jobs
  add constraint applied_jobs_outcome_status_check
  check (outcome_status in ('applied', 'oa_sent', 'oa_completed', 'interview_requested', 'offer', 'rejected', 'withdrawn'));
