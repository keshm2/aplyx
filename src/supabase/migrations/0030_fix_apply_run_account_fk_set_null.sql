-- Fixes a real bug in migration 0029's composite FK, caught by actually
-- running src/supabase/tests/0029_apply_run_account_linkage.sql against
-- the live project: a composite-column FK's `on delete set null` nulls
-- EVERY column in the FK by default, not just the one you'd expect —
-- so deleting an application_accounts row was trying to null out
-- apply_runs.user_id too, which is NOT NULL, and the delete failed.
--
-- Postgres 15+ (confirmed 17.6 on this project) supports naming which
-- column(s) actually get nulled: `on delete set null (account_id)`.
-- That's the fix — only account_id should ever be nulled by this FK;
-- user_id is a separate ownership column, not something a Vault-account
-- deletion should ever touch.

alter table public.apply_runs
  drop constraint apply_runs_user_id_account_id_fkey;

alter table public.apply_runs
  add constraint apply_runs_user_id_account_id_fkey
  foreign key (user_id, account_id) references public.application_accounts (user_id, id)
  on delete set null (account_id);
