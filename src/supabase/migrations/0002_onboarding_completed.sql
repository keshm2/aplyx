-- aplyx hosted backend — Phase 14A follow-up (2026-07-17).
--
-- Tracks whether a signed-in user has finished the hosted onboarding
-- wizard (Welcome -> Import/Fresh -> Profile -> Resume -> Finish), so a
-- returning sign-in can land directly on the dashboard instead of
-- repeating the wizard every time. Mirrors the local install's existing
-- onboarding_completed flag (config/onboarding.json via
-- packages/core/src/settings.ts), just column-backed instead of file-backed.
-- Additive and backward-compatible: existing rows default to false, which
-- is correct — any account created before this migration hasn't been
-- through a wizard run that sets it.

alter table public.profiles
  add column if not exists onboarding_completed boolean not null default false;
