-- ATS account-credential layer: Package 3 (apply-run integration) of
-- docs/ats-account-credentials-plan.md. Links apply_runs (migration 0013)
-- to application_accounts (migration 0027) so an account-required
-- family's apply run can carry which ATS account it used, without ever
-- carrying a credential; the plan's own Package 3 acceptance criteria
-- ("Apply runs store account_id, never a password").
--
-- A composite foreign key, not a bare `references application_accounts
-- (id)`, for the same reason migration 0027's application_account_links
-- used one: a bare id-only FK would let a user_id mismatch slip through
-- (nothing stops a bug from writing another user's account_id onto your
-- apply_runs row); the database, not application code, must be the
-- thing that refuses that. That requires a unique target on
-- (user_id, id) in application_accounts, added first below.
--
-- ON DELETE SET NULL (not CASCADE): deleting an ATS account
-- (delete_application_account, migration 0028) must not erase apply-run
-- history, matching apply_runs.alias_id's existing on-delete behavior
-- for the exact same reason (0013's own comment on alias_id).

alter table public.application_accounts
  add constraint application_accounts_user_id_id_key unique (user_id, id);

alter table public.apply_runs
  add column if not exists account_id uuid;

alter table public.apply_runs
  add constraint apply_runs_user_id_account_id_fkey
  foreign key (user_id, account_id) references public.application_accounts (user_id, id) on delete set null;

create index if not exists apply_runs_account_idx
  on public.apply_runs (account_id);
