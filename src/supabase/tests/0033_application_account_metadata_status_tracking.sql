-- Tests for migration 0033's extended get_application_account_metadata
-- (adds status_tracking_enabled). Self-contained, ROLLBACK at the end.
-- Run with:
--   supabase db query --linked -f src/supabase/tests/0033_application_account_metadata_status_tracking.sql

begin;

create temporary table _t (k text primary key, v text);
grant select, insert, update on _t to authenticated, service_role;

do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values
    (user_a, 'metadata-test-a-' || user_a || '@example.invalid'),
    (user_b, 'metadata-test-b-' || user_b || '@example.invalid');
  insert into _t values ('user_a', user_a::text), ('user_b', user_b::text);
end $$;

select set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, true)
  from _t where k = 'user_a';
set local role authenticated;

do $$
declare
  v_account_id uuid;
  v_tracking boolean;
begin
  v_account_id := public.create_application_account(
    'greenhouse', 'metadata-test-tenant', 'Metadata Test Co', 'metadata-test-user@example.invalid', 'S3cret!Pass1'
  );

  -- Owner's own update-own RLS policy (migration 0027) lets this go
  -- straight through the table, no RPC needed for this field.
  update public.application_accounts set status_tracking_enabled = true where id = v_account_id;

  select status_tracking_enabled into v_tracking
    from public.get_application_account_metadata() where id = v_account_id;
  if v_tracking is not true then
    raise exception 'FAIL: get_application_account_metadata did not return status_tracking_enabled=true, got %', v_tracking;
  end if;
end $$;

-- Cross-user: user_b must see nothing for user_a's account.
select set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, true)
  from _t where k = 'user_b';
set local role authenticated;

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.get_application_account_metadata()
    where tenant_key = 'metadata-test-tenant';
  if v_count != 0 then
    raise exception 'FAIL: user_b could see user_a''s account via get_application_account_metadata (% rows)', v_count;
  end if;
  raise notice 'ALL PASSED: status_tracking_enabled is returned for the owner and cross-user isolation still holds.';
end $$;

rollback;
