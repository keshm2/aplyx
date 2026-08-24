-- Functional + cross-user tests for migration 0028's seven RPCs.
-- A migration applying cleanly only proves the SQL parsed — it does NOT
-- prove these functions work at call time (the pgcrypto/`extensions`
-- schema issue this file's sibling migration had to fix is exactly the
-- kind of bug that only surfaces when a function actually runs). This
-- script calls every RPC for real, as real (throwaway) impersonated
-- users, and ROLLBACKs at the very end regardless of outcome — nothing
-- persists, pass or fail.
--
-- Role-switching a JWT claim can't happen from inside a single PL/pgSQL
-- block (SET LOCAL ROLE needs to be a top-level statement in the same
-- transaction), so this is a sequence of top-level statements rather
-- than one big DO block, carrying values between steps via a temp table
-- (session/transaction-scoped, gone on rollback like everything else
-- here).
--
-- Run with: supabase db query --linked -f src/supabase/tests/0028_application_account_vault_service.sql

begin;

create temporary table _t (k text primary key, v text);
-- Created under the connecting role — authenticated/service_role need
-- explicit access to it once this script starts impersonating them via
-- SET LOCAL ROLE below, or every read/write against it fails on a
-- plain permission error before any real assertion even runs.
grant select, insert, update on _t to authenticated, service_role;

-- ---- seed two throwaway users -------------------------------------------

do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values
    (user_a, 'vault-test-a-' || user_a || '@example.invalid'),
    (user_b, 'vault-test-b-' || user_b || '@example.invalid');
  insert into _t values ('user_a', user_a::text), ('user_b', user_b::text);
end $$;

-- ---- as user_a: create_application_account (+ idempotent reuse) --------

select set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, true)
  from _t where k = 'user_a';
set local role authenticated;

do $$
declare
  v_account_1 uuid;
  v_account_2 uuid;
begin
  v_account_1 := public.create_application_account(
    'greenhouse', 'vault-test-tenant', 'Vault Test Co', 'vault-test-user@example.invalid', 'S3cret!Pass1'
  );
  -- Same identity, same tenant scope, same call again — must reuse, not
  -- mint a second Vault secret (plan's idempotent-retry requirement).
  v_account_2 := public.create_application_account(
    'greenhouse', 'vault-test-tenant', 'Vault Test Co', 'vault-test-user@example.invalid', 'S3cret!Pass1'
  );
  if v_account_1 != v_account_2 then
    raise exception 'FAIL: create_application_account was not idempotent (% vs %)', v_account_1, v_account_2;
  end if;
  insert into _t values ('account_id', v_account_1::text);
  raise notice 'create_application_account OK: account_id=%, idempotent reuse confirmed', v_account_1;
end $$;

-- ---- as user_a: get_application_account_metadata never leaks the secret id

do $$
declare
  v_account_id uuid; v_row record; v_col_count int;
begin
  select v::uuid into v_account_id from _t where k = 'account_id';
  select * into v_row from public.get_application_account_metadata() where id = v_account_id;
  if v_row.id is null then
    raise exception 'FAIL: get_application_account_metadata did not return the account';
  end if;
  if v_row.login_hint !~ '^v\*\*\*@example\.invalid$' then
    raise exception 'FAIL: login_hint was not masked as expected, got %', v_row.login_hint;
  end if;
  if v_row.status != 'creation_pending' then
    raise exception 'FAIL: unexpected status %', v_row.status;
  end if;
  raise notice 'get_application_account_metadata OK: masked hint=%', v_row.login_hint;
end $$;

-- ---- as user_a: reveal_own_account_credential returns what was stored --

do $$
declare
  v_account_id uuid; v_username text; v_password text;
begin
  select v::uuid into v_account_id from _t where k = 'account_id';
  select username, password into v_username, v_password
    from public.reveal_own_account_credential(v_account_id);
  if v_username != 'vault-test-user@example.invalid' or v_password != 'S3cret!Pass1' then
    raise exception 'FAIL: revealed credential did not round-trip (got %/%)', v_username, v_password;
  end if;
  raise notice 'reveal_own_account_credential OK (own account)';
end $$;

-- ---- as user_b: every operation against user_a's account must be denied

select set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, true)
  from _t where k = 'user_b';
set local role authenticated;

do $$
declare
  v_account_id uuid; v_row record; v_denied boolean;
begin
  select v::uuid into v_account_id from _t where k = 'account_id';

  select * into v_row from public.get_application_account_metadata() where id = v_account_id;
  if v_row.id is not null then
    raise exception 'FAIL: user_b saw user_a''s account via get_application_account_metadata';
  end if;

  v_denied := false;
  begin
    perform * from public.reveal_own_account_credential(v_account_id);
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL: user_b could reveal user_a''s credential';
  end if;

  v_denied := false;
  begin
    perform public.rotate_application_account_secret(v_account_id, 'pwned', 'pwned');
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL: user_b could rotate user_a''s credential';
  end if;

  v_denied := false;
  begin
    perform public.mark_account_state(v_account_id, 'disabled');
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL: user_b could mark_account_state on user_a''s account';
  end if;

  v_denied := false;
  begin
    perform public.delete_application_account(v_account_id);
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL: user_b could delete user_a''s account';
  end if;

  v_denied := false;
  begin
    perform * from public.issue_account_credential_use_token(v_account_id, 'status_check');
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL: user_b could issue a credential-use token for user_a''s account';
  end if;

  raise notice 'Cross-user denial OK: reveal/rotate/mark_state/delete/issue-token all rejected for user_b';
end $$;

-- ---- back to user_a: issue + resolve a credential-use token ------------

select set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, true)
  from _t where k = 'user_a';
set local role authenticated;

do $$
declare
  v_account_id uuid; v_token text; v_expires timestamptz;
begin
  select v::uuid into v_account_id from _t where k = 'account_id';
  select token, expires_at into v_token, v_expires
    from public.issue_account_credential_use_token(v_account_id, 'status_check', 60);
  if v_token is null or length(v_token) < 32 then
    raise exception 'FAIL: issue_account_credential_use_token returned no usable token';
  end if;
  insert into _t values ('token', v_token);
  raise notice 'issue_account_credential_use_token OK: token issued, expires %', v_expires;
end $$;

-- resolve_application_account_credential_token is service_role-only —
-- authenticated has no execute grant on it at all, so this must be
-- called as service_role, independent of whose JWT claims are set.
set local role service_role;

do $$
declare
  v_token text; v_account_id uuid; v_expected_account uuid;
  v_username text; v_password text; v_denied boolean;
begin
  select v into v_token from _t where k = 'token';
  select v::uuid into v_expected_account from _t where k = 'account_id';

  select account_id, username, password into v_account_id, v_username, v_password
    from public.resolve_application_account_credential_token(v_token);

  if v_account_id != v_expected_account then
    raise exception 'FAIL: resolved token pointed at the wrong account';
  end if;
  if v_username != 'vault-test-user@example.invalid' or v_password != 'S3cret!Pass1' then
    raise exception 'FAIL: resolved credential did not round-trip (got %/%)', v_username, v_password;
  end if;

  -- Single-use: the same token must fail the second time.
  v_denied := false;
  begin
    perform * from public.resolve_application_account_credential_token(v_token);
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL: a credential-use token was redeemable twice';
  end if;

  raise notice 'resolve_application_account_credential_token OK: correct credential, single-use enforced';
end $$;

-- ---- back to user_a: rotate, mark_account_state, delete ----------------

select set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, true)
  from _t where k = 'user_a';
set local role authenticated;

do $$
declare
  v_account_id uuid; v_username text; v_password text; v_status text;
begin
  select v::uuid into v_account_id from _t where k = 'account_id';

  perform public.rotate_application_account_secret(v_account_id, 'rotated-user@example.invalid', 'NewP4ss!');
  select username, password into v_username, v_password from public.reveal_own_account_credential(v_account_id);
  if v_username != 'rotated-user@example.invalid' or v_password != 'NewP4ss!' then
    raise exception 'FAIL: rotate_application_account_secret did not actually replace the credential';
  end if;
  select status into v_status from public.application_accounts where id = v_account_id;
  if v_status != 'active' then
    raise exception 'FAIL: rotate did not mark the account active (got %)', v_status;
  end if;

  perform public.mark_account_state(v_account_id, 'login_failed', 'timeout', 'simulated failure');
  select status into v_status from public.application_accounts where id = v_account_id;
  if v_status != 'login_failed' then
    raise exception 'FAIL: mark_account_state did not apply (got %)', v_status;
  end if;

  declare
    v_rejected boolean := false;
  begin
    begin
      perform public.mark_account_state(v_account_id, 'not-a-real-status');
    exception
      when others then v_rejected := true;
    end;
    if not v_rejected then
      raise exception 'FAIL: mark_account_state accepted an invalid status';
    end if;
  end;

  perform public.delete_application_account(v_account_id);
  select status into v_status from public.application_accounts where id = v_account_id;
  if v_status != 'deleted' then
    raise exception 'FAIL: delete_application_account did not mark the account deleted (got %)', v_status;
  end if;

  declare
    v_reveal_denied boolean := false;
  begin
    begin
      perform * from public.reveal_own_account_credential(v_account_id);
    exception
      when others then v_reveal_denied := true;
    end;
    if not v_reveal_denied then
      raise exception 'FAIL: reveal succeeded on a deleted account';
    end if;
  end;

  raise notice 'rotate_application_account_secret / mark_account_state / delete_application_account all OK';
  raise notice 'ALL PASSED';
end $$;

rollback;
