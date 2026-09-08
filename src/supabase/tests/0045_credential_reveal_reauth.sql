-- Tests for migration 0045: server-side re-auth gate on credential
-- reveal/rotate. Same convention as 0027-0044: one script, throwaway
-- rows, unconditional ROLLBACK. Run with:
--
--   supabase db query --linked -f src/supabase/tests/0045_credential_reveal_reauth.sql
--
-- Covers:
-- 1. reveal_own_account_credential raises "reauth required" with no
--    fresh stamp.
-- 2. A stale credential_reauth_at (>10 min) is still "reauth required".
-- 3. A fresh stamp lets the reveal through.
-- 4. verify_credential_reauth returns false for a wrong password and
--    does NOT advance the stamp.
-- 5. _credential_reauth_is_fresh is not callable by the authenticated role
--    directly (internal helper).

begin;

do $$
declare
  u uuid := gen_random_uuid();
  acct uuid;
  secret uuid;
  v_blocked boolean;
  v_rows int;
  v_user text;
begin
  insert into auth.users (id, email) values (u, 'reauth-' || u || '@example.invalid');
  insert into public.profiles (user_id) values (u);
  secret := vault.create_secret('{"username":"acct-user","password":"acct-pass"}', 'reauth_test_' || u);
  insert into public.application_accounts (user_id, ats_family, tenant_key, company_name, credential_secret_id)
  values (u, 'workday', 'reauth-tenant', 'Reauth Co', secret) returning id into acct;

  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 1. no stamp -> blocked
  v_blocked := false;
  begin
    perform * from public.reveal_own_account_credential(acct);
  exception when others then
    v_blocked := (sqlerrm like '%reauth required%');
  end;
  if not v_blocked then raise exception 'FAIL: reveal succeeded with no reauth stamp'; end if;

  reset role;
  perform set_config('request.jwt.claims', null, true);

  -- 2. stale stamp -> still blocked
  update public.profiles set credential_reauth_at = now() - interval '11 minutes' where user_id = u;
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_blocked := false;
  begin
    perform * from public.reveal_own_account_credential(acct);
  exception when others then
    v_blocked := (sqlerrm like '%reauth required%');
  end;
  if not v_blocked then raise exception 'FAIL: reveal succeeded with a stale (>10m) reauth stamp'; end if;

  reset role;
  perform set_config('request.jwt.claims', null, true);

  -- 3. fresh stamp -> reveal works
  update public.profiles set credential_reauth_at = now() where user_id = u;
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select username into v_user from public.reveal_own_account_credential(acct);
  if v_user is distinct from 'acct-user' then
    raise exception 'FAIL: fresh reauth did not return the credential (got %)', v_user;
  end if;

  -- 4. wrong password -> false, stamp unchanged
  reset role;
  perform set_config('request.jwt.claims', null, true);
  update public.profiles set credential_reauth_at = now() - interval '20 minutes' where user_id = u;
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.verify_credential_reauth('definitely-not-the-password') then
    raise exception 'FAIL: verify_credential_reauth returned true for a wrong password';
  end if;
  select count(*) into v_rows from public.profiles
    where user_id = u and credential_reauth_at > now() - interval '10 minutes';
  if v_rows <> 0 then
    raise exception 'FAIL: a failed verify_credential_reauth still advanced the stamp';
  end if;

  -- 5. internal helper not directly callable
  v_blocked := false;
  begin
    perform public._credential_reauth_is_fresh();
  exception when insufficient_privilege then
    v_blocked := true;
  when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: _credential_reauth_is_fresh is callable by the authenticated role';
  end if;

  raise notice 'PASS: 0045 credential-reveal reauth tests';
end;
$$;

rollback;
