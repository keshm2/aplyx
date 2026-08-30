-- aplyx hosted backend — local/hosted profile-schema parity fix (2026-08-27).
--
-- gpa, citizenship_status, and currently_enrolled are three fields
-- src/config/targets.example.json's safe_fields has always supported
-- locally, but that were never part of the onboarding wizard's PAGES
-- (src/core/src/onboarding/fields.ts) or this table — no UI anywhere,
-- hosted or local, ever collected them, so they sat as a documented but
-- unfixed gap (docs/hosted-no-agent-tiers-plan.md's open questions).
-- Deferred out of the hosted-to-local carryover pass
-- (docs/web-onboarding-hosted-sync-plan.md) to keep that change focused;
-- fixed now as its own follow-on.
--
-- Additive and backward-compatible, same "add column if not exists"
-- pattern as 0019_profile_demographics_columns.sql: existing rows get
-- null, same as every other unset text field on this table.
--
-- fields.ts now collects all three (Education page for gpa/
-- currently_enrolled, Work eligibility for citizenship_status) —
-- SupabaseAdapter's field routing needs no changes: HOSTED_PROFILE_FIELD_IDS
-- is derived from FIELD_IDS, so it already includes these three now that
-- fields.ts does; readProfileField/writeProfileField map any such id
-- straight to its same-named column, exactly like every other plain
-- profile field.

alter table public.profiles
  add column if not exists gpa text,
  add column if not exists citizenship_status text,
  add column if not exists currently_enrolled text;
