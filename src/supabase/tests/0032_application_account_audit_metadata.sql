-- Tests for migration 0032's richer audit metadata on
-- rotate_application_account_secret / delete_application_account
-- (Package 5 of docs/ats-account-credentials-plan.md, "password
-- rotation and deletion are auditable"). Self-contained, ROLLBACK at
-- the end. Run with:
--   supabase db query --linked -f src/supabase/tests/0032_application_account_audit_metadata.sql

begin;

create temporary table _t (k text primary key, v text);
grant select, insert, update on _t to authenticated, service_role;

do $$
declare
  user_a uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (user_a, 'audit-test-a-' || user_a || '@example.invalid');
  insert into _t values ('user_a', user_a::text);
end $$;

select set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, true)
  from _t where k = 'user_a';
set local role authenticated;

do $$
declare
  v_account_id uuid;
  v_metadata jsonb;
begin
  v_account_id := public.create_application_account(
    'greenhouse', 'audit-test-tenant', 'Audit Test Co', 'audit-test-user@example.invalid', 'S3cret!Pass1'
  );
  -- Drive the account into login_failed first, so rotate's
  -- previous_status has something other than the default to prove it
  -- actually captured the prior state rather than a hardcoded value.
  perform public.mark_account_state(v_account_id, 'login_failed', 'timeout', 'simulated failure');

  perform public.rotate_application_account_secret(v_account_id, 'rotated-user@example.invalid', 'NewP4ss!');
  select metadata into v_metadata
    from public.application_account_events
    where account_id = v_account_id and event_type = 'password_rotated'
    order by created_at desc limit 1;
  if v_metadata is null or (v_metadata->>'previous_status') != 'login_failed' then
    raise exception 'FAIL: password_rotated event did not capture previous_status=login_failed (got %)', v_metadata;
  end if;
  if (v_metadata->>'caller') != 'self' then
    raise exception 'FAIL: password_rotated event did not capture caller=self (got %)', v_metadata;
  end if;

  perform public.delete_application_account(v_account_id);
  select metadata into v_metadata
    from public.application_account_events
    where account_id = v_account_id and event_type = 'deleted'
    order by created_at desc limit 1;
  if v_metadata is null or (v_metadata->>'previous_status') != 'active' then
    raise exception 'FAIL: deleted event did not capture previous_status=active (got %)', v_metadata;
  end if;

  raise notice 'ALL PASSED: rotate/delete now log previous_status (and rotate logs caller) in application_account_events.';
end $$;

rollback;
