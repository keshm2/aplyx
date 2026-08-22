-- One-time backfill for public.job_apply_counts (migration 0025): the
-- triggers only fire on new inserts/updates going forward, so any
-- applied_jobs row that already existed as status='applied' before 0025
-- landed would otherwise be silently missing from its count forever (that
-- row never gets touched again once applied). Idempotent (ON CONFLICT
-- adds, doesn't overwrite) and safe to run on a fresh project too --
-- zero pre-existing applied rows there just means a zero-row no-op.

insert into public.job_apply_counts (job_id, apply_count, updated_at)
select job_id, count(*), now()
from public.applied_jobs
where status = 'applied'
group by job_id
on conflict (job_id) do update
  set apply_count = public.job_apply_counts.apply_count + excluded.apply_count,
      updated_at = now();
