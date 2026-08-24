-- Adds pay_text to the shared job posting cache — a best-effort "$117K–
-- $160K/year" or "$45–$65/hour" line, extracted at fetch time
-- (src/core/src/jobs.ts's extractPay/ashbyPayText, mirrored in Python by
-- src/scripts/jobs/_jd_text.py's extract_pay for the non-JS sources).
-- Nullable and additive only — refreshJobCache.ts already upserts every
-- column it knows about per row, so existing rows simply get pay_text
-- filled in on their next refresh, no backfill needed here.

alter table public.job_cache add column if not exists pay_text text;
