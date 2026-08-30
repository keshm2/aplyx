-- Tests for migration 0037's composite account-scope foreign keys.
-- Run with:
--   supabase db query --linked -f src/supabase/tests/0037_application_account_scope_integrity.sql

begin;

do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  alias_a uuid;
  account_a uuid;
  secret_a uuid;
  rejected boolean;
  run_id uuid;
begin
  insert into auth.users (id, email) values
    (user_a, 'scope-test-a-' || user_a || '@example.invalid'),
    (user_b, 'scope-test-b-' || user_b || '@example.invalid');

  insert into public.managed_aliases (user_id, family, alias, forwarding_to)
  values (user_a, 'workday', 'st-' || left(replace(user_a::text, '-', ''), 28), 'scope-test-a@example.invalid')
  returning id into alias_a;

  secret_a := vault.create_secret(
    '{"username":"scope-test","password":"scope-test"}',
    'scope_test_secret_' || user_a
  );
  insert into public.application_accounts (
    user_id, ats_family, tenant_key, company_name, credential_secret_id, managed_alias_id
  )
  values (user_a, 'workday', 'scope-test-tenant', 'Scope Test Co', secret_a, alias_a)
  returning id into account_a;

  rejected := false;
  begin
    insert into public.application_accounts (
      user_id, ats_family, tenant_key, company_name, credential_secret_id, managed_alias_id
    )
    values (user_b, 'workday', 'scope-test-tenant-b', 'Scope Test Co B', secret_a, alias_a);
  exception when foreign_key_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'FAIL: account accepted another user''s managed alias';
  end if;

  rejected := false;
  begin
    insert into public.application_accounts (
      user_id, ats_family, tenant_key, company_name, credential_secret_id, managed_alias_id
    )
    values (user_a, 'greenhouse', 'scope-test-greenhouse', 'Scope Test Greenhouse', secret_a, alias_a);
  exception when foreign_key_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'FAIL: account accepted a managed alias from another ATS family';
  end if;

  insert into public.apply_runs (user_id, job_id, family)
  values (user_a, 'scope-test-job', 'workday')
  returning id into run_id;

  update public.apply_runs set account_id = account_a where id = run_id;
  if not exists (
    select 1 from public.apply_runs where id = run_id and account_id = account_a
  ) then
    raise exception 'FAIL: same-user, same-family account link was rejected';
  end if;

  insert into public.apply_runs (user_id, job_id, family)
  values (user_a, 'scope-test-job-wrong-family', 'greenhouse')
  returning id into run_id;

  rejected := false;
  begin
    update public.apply_runs set account_id = account_a where id = run_id;
  exception when foreign_key_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'FAIL: apply run accepted an account from another ATS family';
  end if;

  delete from public.application_accounts where id = account_a;
  if not exists (
    select 1 from public.apply_runs where job_id = 'scope-test-job' and account_id is null
  ) then
    raise exception 'FAIL: deleting an account did not null its apply-run link';
  end if;

  raise notice 'ALL PASSED: account alias ownership and ATS-family scope are enforced.';
end $$;

rollback;
