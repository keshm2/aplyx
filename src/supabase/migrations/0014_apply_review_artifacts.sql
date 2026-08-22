-- Review/apply artifact columns for confirm-before-submit flows.
--
-- `review_queue` is what the desktop Review screen already reads. A
-- ready-to-submit application needs two extra pieces of context there:
-- the apply_run it came from, and the screenshot artifact the worker
-- captured after pre-submit verification. `applied_jobs` gets the same
-- columns so a later approved/failed outcome can keep pointing back at the
-- same artifact set for auditability.

alter table public.applied_jobs
  add column if not exists apply_run_id uuid,
  add column if not exists screenshot_url text,
  add column if not exists screenshot_path text;

alter table public.review_queue
  add column if not exists apply_run_id uuid,
  add column if not exists screenshot_url text,
  add column if not exists screenshot_path text;
