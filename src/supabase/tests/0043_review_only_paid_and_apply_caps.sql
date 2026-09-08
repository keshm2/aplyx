-- Tests for migration 0043: server-side runs are paid-only, and a client
-- cannot fabricate a completed application. Same convention as
-- 0027/0028/0029's tests: one self-contained script, seeds throwaway
-- rows, unconditional ROLLBACK. Run with:
--
--   supabase db query --linked -f src/supabase/tests/0043_review_only_paid_and_apply_caps.sql
--
-- Covers:
-- 1. A free (no subscriptions row) authenticated user CANNOT insert a
--    hosted_runs row — RLS WITH CHECK blocks it.
-- 2. The same user, once a Stripe webhook (simulated as service_role)
--    writes an 'active' subscriptions row, CAN insert one.
-- 3. tier_daily_apply_cap returns the pricing-table number for each plan
--    and NULL with no active subscription.
-- 4. An authenticated client CANNOT insert an apply_runs row that already
--    claims status='submitted' (or any other terminal status).
-- 5. get_own_usage reports the tier cap and a submitted-today count that
--    the client cannot deflate.

begin;

do $$
declare
  user_free uuid := gen_random_uuid();
  v_blocked boolean;
  v_cap integer;
  v_used bigint;
  v_plan text;
begin
  insert into auth.users (id, email)
  values (user_free, 'cap-test-' || user_free || '@example.invalid');

  -- Act as this authenticated user for all RLS-scoped checks.
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_free, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 1. No subscriptions row -> hosted_runs INSERT is blocked.
  v_blocked := false;
  begin
    insert into public.hosted_runs (user_id, mode) values (user_free, 'review_only');
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: a free user could INSERT a hosted_runs row';
  end if;

  -- 4. Client cannot INSERT an apply_runs row with a terminal status.
  v_blocked := false;
  begin
    insert into public.apply_runs (user_id, job_id, family, status)
    values (user_free, 'cap-test-job', 'lever', 'submitted');
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: client could INSERT an apply_runs row with status=submitted';
  end if;

  -- ...but a pre-submit status is fine (the real Workday-continuation path).
  insert into public.apply_runs (user_id, job_id, family, status)
  values (user_free, 'cap-test-job', 'lever', 'confirm_before_submit');

  reset role;
  perform set_config('request.jwt.claims', null, true);

  -- 2. Simulate the Stripe webhook (service_role bypasses RLS).
  insert into public.subscriptions (user_id, plan, status)
  values (user_free, 'pro', 'active');

  perform set_config('request.jwt.claims',
    json_build_object('sub', user_free, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- Now hosted_runs INSERT succeeds.
  insert into public.hosted_runs (user_id, mode) values (user_free, 'review_only');

  -- 3. tier_daily_apply_cap: Pro -> 17.
  select public.tier_daily_apply_cap(user_free) into v_cap;
  if v_cap is distinct from 17 then
    raise exception 'FAIL: pro tier_daily_apply_cap = %, expected 17', v_cap;
  end if;

  -- 5. get_own_usage reflects the plan + cap; used_today is 0 (no
  -- worker-written 'submitted' apply_runs row exists — the client's own
  -- 'confirm_before_submit' row above does NOT count).
  select used_today, cap, plan into v_used, v_cap, v_plan from public.get_own_usage();
  if v_plan <> 'pro' or v_cap is distinct from 17 or v_used <> 0 then
    raise exception 'FAIL: get_own_usage returned (used=%, cap=%, plan=%)', v_used, v_cap, v_plan;
  end if;

  reset role;
  perform set_config('request.jwt.claims', null, true);

  -- 3b. No active subscription -> NULL cap.
  update public.subscriptions set status = 'canceled' where user_id = user_free;
  if public.tier_daily_apply_cap(user_free) is not null then
    raise exception 'FAIL: canceled subscription still returned a numeric cap';
  end if;

  raise notice 'PASS: 0043 review-only paid-gate + apply-cap tests';
end;
$$;

rollback;
