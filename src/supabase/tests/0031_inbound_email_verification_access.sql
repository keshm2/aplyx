-- Tests for migration 0031's list_own_inbound_emails/consume_inbound_email
-- RPCs (Package 5 of docs/ats-account-credentials-plan.md). Same
-- convention as prior packages: self-contained, ROLLBACK at the end.
-- Run with:
--   supabase db query --linked -f src/supabase/tests/0031_inbound_email_verification_access.sql
--
-- Covers:
-- 1. Owner can list their own alias's inbound emails via the RPC (the
--    thing that was silently broken before this migration — zero RLS
--    policies meant a direct table SELECT as `authenticated` always
--    returned nothing).
-- 2. A non-owner (user_b) is rejected by both RPCs for user_a's alias.
-- 3. An expired parsed_otp/parsed_link is redacted (returned as NULL)
--    by list_own_inbound_emails, even though the row itself is still
--    visible.
-- 4. consume_inbound_email nulls parsed_otp/parsed_link at the same
--    time it sets consumed_at — the secret does not linger after use.

begin;

do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  alias_a uuid;
  row_fresh uuid;
  row_expired uuid;
  v_count int;
  v_otp text;
  v_link text;
  v_consumed_at timestamptz;
  v_denied boolean;
begin
  insert into auth.users (id, email) values
    (user_a, 'inbound-test-a-' || user_a || '@example.invalid'),
    (user_b, 'inbound-test-b-' || user_b || '@example.invalid');

  insert into public.managed_aliases (user_id, family, alias, forwarding_to)
  values (user_a, 'workday', 'inbound-test-alias-' || substr(user_a::text, 1, 8), 'user-a-real@example.invalid')
  returning id into alias_a;

  insert into public.inbound_emails (alias_id, from_address, subject, body_text, parsed_otp, parsed_link, received_at, expires_at)
  values (alias_a, 'noreply@employer.example', 'Verify your account', 'code: 123456', '123456', 'https://employer.example/verify?t=abc', now(), now() + interval '30 minutes')
  returning id into row_fresh;

  insert into public.inbound_emails (alias_id, from_address, subject, body_text, parsed_otp, parsed_link, received_at, expires_at)
  values (alias_a, 'noreply@employer.example', 'Verify your account (old)', 'code: 654321', '654321', 'https://employer.example/verify?t=old', now() - interval '1 hour', now() - interval '30 minutes')
  returning id into row_expired;

  -- 1. Owner (user_a) lists both rows via the RPC.
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into v_count from public.list_own_inbound_emails(alias_a);
  if v_count != 2 then
    raise exception 'FAIL: owner should see 2 inbound_emails rows via the RPC, got %', v_count;
  end if;

  -- 3. The expired row's parsed_otp/parsed_link must be redacted; the
  -- fresh row's must still be visible.
  select parsed_otp, parsed_link into v_otp, v_link from public.list_own_inbound_emails(alias_a) where id = row_expired;
  if v_otp is not null or v_link is not null then
    raise exception 'FAIL: expired row''s parsed_otp/parsed_link were not redacted (got %/%)', v_otp, v_link;
  end if;
  select parsed_otp, parsed_link into v_otp, v_link from public.list_own_inbound_emails(alias_a) where id = row_fresh;
  if v_otp != '123456' or v_link != 'https://employer.example/verify?t=abc' then
    raise exception 'FAIL: fresh row''s parsed_otp/parsed_link were unexpectedly redacted (got %/%)', v_otp, v_link;
  end if;

  -- 4. Consuming the fresh row nulls the secret and stamps consumed_at.
  -- Called as authenticated/user_a (to exercise the RPC's own ownership
  -- check for real), but verified afterward via a direct table read as
  -- the unrestricted session role — inbound_emails has zero RLS
  -- policies by design, so a direct SELECT as `authenticated` would
  -- itself return nothing regardless of whether the update worked,
  -- which would make this assertion meaningless.
  perform public.consume_inbound_email(row_fresh);
  reset role;
  select parsed_otp, parsed_link, consumed_at into v_otp, v_link, v_consumed_at
    from public.inbound_emails where id = row_fresh;
  if v_otp is not null or v_link is not null then
    raise exception 'FAIL: consume_inbound_email did not redact parsed_otp/parsed_link (got %/%)', v_otp, v_link;
  end if;
  if v_consumed_at is null then
    raise exception 'FAIL: consume_inbound_email did not stamp consumed_at';
  end if;

  -- 2. user_b must be rejected by both RPCs against user_a's alias.
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_denied := false;
  begin
    perform * from public.list_own_inbound_emails(alias_a);
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL: user_b could list user_a''s inbound emails via the RPC';
  end if;

  v_denied := false;
  begin
    perform public.consume_inbound_email(row_expired);
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL: user_b could consume user_a''s inbound email via the RPC';
  end if;

  raise notice 'ALL PASSED: ownership-checked list/consume RPCs work for the owner, redact expired/consumed secrets, and reject a non-owner.';
end $$;

rollback;
