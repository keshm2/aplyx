-- Tests for migration 0029's apply_runs.account_id composite FK
-- (Package 3 of docs/ats-account-credentials-plan.md). Same convention
-- as 0027/0028's tests: a single self-contained script, seeds throwaway
-- rows, ROLLBACKs unconditionally at the end. Run with:
--
--   supabase db query --linked -f src/supabase/tests/0029_apply_run_account_linkage.sql
--
-- Covers:
-- 1. A user's own account_id links onto their own apply_runs row.
-- 2. Cross-user account_id (right account, wrong apply_runs owner) is
--    rejected by the composite FK, not silently accepted.
-- 3. Deleting the application_accounts row sets apply_runs.account_id to
--    NULL (ON DELETE SET NULL) rather than cascading the apply_runs row
--    away; apply-run history must survive an account deletion.

begin;

do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  secret_a uuid;
  account_a uuid;
  run_a uuid;
  v_account_id uuid;
begin
  insert into auth.users (id, email) values
    (user_a, 'linkage-test-a-' || user_a || '@example.invalid'),
    (user_b, 'linkage-test-b-' || user_b || '@example.invalid');

  secret_a := vault.create_secret('{"username":"linkage-test","password":"linkage-test"}', 'linkage_test_secret_' || user_a);
  insert into public.application_accounts (user_id, ats_family, tenant_key, company_name, credential_secret_id)
  values (user_a, 'workday', 'linkage-test-tenant', 'Linkage Test Co', secret_a)
  returning id into account_a;

  insert into public.apply_runs (user_id, job_id, family)
  values (user_a, 'linkage-test-job', 'workday')
  returning id into run_a;

  -- 1. Owner linking their own account onto their own run must succeed.
  update public.apply_runs set account_id = account_a where id = run_a;
  select account_id into v_account_id from public.apply_runs where id = run_a;
  if v_account_id != account_a then
    raise exception 'FAIL: account_id did not persist on the owner''s own run';
  end if;

  -- 2. A run belonging to user_b cannot be linked to user_a's account:
  -- the composite FK must reject this even though account_a is a real,
  -- valid application_accounts.id (a bare id-only FK would have let it
  -- through, hiding an ownership bug).
  declare
    v_rejected boolean := false;
    run_b uuid;
  begin
    insert into public.apply_runs (user_id, job_id, family)
    values (user_b, 'linkage-test-job-b', 'workday')
    returning id into run_b;
    begin
      update public.apply_runs set account_id = account_a where id = run_b;
    exception
      when foreign_key_violation then v_rejected := true;
    end;
    if not v_rejected then
      raise exception 'FAIL: user_b''s apply_runs row accepted user_a''s account_id across the composite FK';
    end if;
  end;

  -- 3. Deleting the account must null out the link, not cascade-delete
  -- the apply_runs row (apply-run history survives account deletion,
  -- same as alias_id's existing on-delete behavior).
  delete from public.application_accounts where id = account_a;
  select account_id into v_account_id from public.apply_runs where id = run_a;
  if v_account_id is not null then
    raise exception 'FAIL: account_id was not nulled after the referenced account was deleted';
  end if;
  if not exists (select 1 from public.apply_runs where id = run_a) then
    raise exception 'FAIL: apply_runs row was cascade-deleted along with its account instead of being preserved';
  end if;

  raise notice 'ALL PASSED: composite FK enforces same-user ownership and ON DELETE SET NULL preserves apply-run history.';
end $$;

rollback;
