-- aplyx hosted backend: "does this account have an app install" signal
-- (2026-09-03).
--
-- aplyx.app shows an "Install aplyx" prompt to a signed-in web user who
-- has never opened the desktop app. There was no way to know that: a
-- Supabase session is the same whether it came from the website or the
-- app. This column is the signal. The desktop app stamps it (now())
-- on every sign-in via SupabaseAdapter.touchAppLastSeen(); the website
-- reads it once after sign-in and hides the prompt when it is non-null.
--
-- Additive and backward-compatible: existing rows get NULL, which reads
-- correctly as "no known install" (every account predates any app that
-- stamps this). No RLS change needed: the existing profiles_update_own /
-- profiles_select_own policies (migration 0001) already scope both the
-- app's upsert and the website's read to auth.uid() = user_id.
--
-- Run via `supabase db push` or the SQL editor; NOT applied automatically
-- by committing this file.

alter table public.profiles
  add column if not exists app_last_seen_at timestamptz;
