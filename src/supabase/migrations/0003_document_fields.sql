-- aplyx hosted backend: Phase 14B document-field gap fix (2026-08-10).
--
-- Closes the schema drift documented in docs/supabase-user-data-plan.md:
-- the local JSON shape (AppliedJob/QueueEntry in src/core/src/stateDerive.ts)
-- grew fields that predate migration 0001 and were never added here:
-- tailored_bullets, cover_letter, missing_keywords, doubt_signals,
-- fill_record. Without this, hosted sync would have nowhere to put any
-- of the five once it ships.
--
-- jsonb/text columns, not a storage bucket, per operator decision
-- (2026-08-10): cheapest to carry forward across future schema changes,
-- smallest footprint (no file-storage overhead), and directly queryable
-- by any agent/system with the anon key + RLS, the same shape the local
-- JSON files already use, just column-backed instead of file-backed
-- (same reasoning 0002 used for onboarding_completed).
--
-- fill_record holds the record's actual CONTENT (mirrors
-- data/fill_records/<job_id>.json's shape), not fill_record_path; a
-- local filesystem path has no meaning in a hosted context.
--
-- Additive and backward-compatible: existing rows get null for every new
-- column, no backfill required. RLS is inherited automatically from each
-- table's existing policies; no new policies needed, these are just new
-- columns on already-protected tables.

alter table public.applied_jobs
  add column if not exists tailored_bullets jsonb,
  add column if not exists cover_letter text,
  add column if not exists missing_keywords jsonb,
  add column if not exists doubt_signals jsonb,
  add column if not exists fill_record jsonb;

alter table public.review_queue
  add column if not exists tailored_bullets jsonb,
  add column if not exists cover_letter text,
  add column if not exists missing_keywords jsonb,
  add column if not exists doubt_signals jsonb,
  add column if not exists fill_record jsonb;
