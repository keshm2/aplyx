-- aplyx hosted backend — schema-drift fix (2026-08-21).
--
-- veteran_status and disability_status are two of the "Demographics"
-- fields in src/core/src/onboarding/fields.ts (required select3 EEO
-- fields, added after 0001_init.sql shipped) but were never added to
-- profiles. SupabaseAdapter.writeProfileField maps every non-preference
-- field id straight to a same-named column, so upserting either field
-- hit "column does not exist" — breaking both the hosted profile wizard's
-- Demographics page (stuck, can't advance) and ImportOrFreshStep's local
-- import (aborts mid-loop on the missing column).
--
-- Additive and backward-compatible: existing rows get null, same as
-- every other unset text field on this table.

alter table public.profiles
  add column if not exists veteran_status text,
  add column if not exists disability_status text;
