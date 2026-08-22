-- Deletes old, resolved-nowhere job-registry rows to keep public.jobs from
-- growing unbounded. Scope is deliberately narrow and safety-first:
--
-- - Only latest_status IN ('new', 'seen', 'skipped_unfit') is eligible --
--   postings the worker looked at that never became a real outcome.
--   Deleting one just means a future fetch treats that posting as unseen
--   again (a benign re-evaluation, not data loss) -- run.ts's dedupe step
--   only skips a posting because a public.jobs row for its job_key already
--   exists.
-- - 'applied' / 'needs_review' / 'failed' rows are NEVER eligible, on
--   purpose: the worker's dedupe check relies on these rows existing to
--   avoid re-applying to (or re-flagging) a job it already resolved --
--   deleting one risks a duplicate application on a later run, the one
--   failure mode this migration exists specifically to avoid.
-- - public.job_events is untouched -- it's append-only by design (no
--   delete policy exists for it at all, see migration 0001's own
--   comment), mirroring data/job_events.jsonl's local convention:
--   "resolved" is derived from later events, never by deleting entries.
--   This cleanup only ever touches the mutable public.jobs registry.
--
-- Retention window: 60 days past a row's last update (operator's choice,
-- 2026-08-21) -- most postings close well within a month; 60 days gives
-- margin for a slow-moving one.

create or replace function public.cleanup_stale_jobs()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  delete from public.jobs
  where latest_status in ('new', 'seen', 'skipped_unfit')
    and updated_at < now() - interval '60 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.cleanup_stale_jobs() from public, authenticated, anon;
grant execute on function public.cleanup_stale_jobs() to service_role, postgres;

-- Daily at 03:00 UTC -- pure SQL housekeeping, no external HTTP call
-- needed (unlike email-tracking-worker's cron entry), so no Vault-secured
-- header/secret is required here.
select cron.schedule(
  'jobs-retention-cleanup-daily',
  '0 3 * * *',
  $$ select public.cleanup_stale_jobs(); $$
);
