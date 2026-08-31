-- Operator request (2026-08-21): when email-tracking-worker classifies a
-- message as "oa_sent" (assessment invitation received), also pull out
-- the assessment link and however the company phrased its time limit
-- ("active for 7 days", "complete by August 30", "within 72 hours") so
-- the desktop app can show an "Open assessment link" button and a
-- "Duration to complete" line instead of just the bare status badge.
--
-- Deliberately plain text, not a parsed/structured deadline: extraction
-- is regex-based (same deterministic, no-LLM approach as classify()
-- itself) against wildly inconsistent phrasing across companies;
-- storing the matched phrase verbatim is honest about what this is
-- (a best-effort match, same spirit as outcome_source), where computing
-- and storing a real timestamp would imply a confidence the extraction
-- doesn't have.

alter table public.applied_jobs
  add column if not exists outcome_assessment_url text,
  add column if not exists outcome_assessment_note text;
