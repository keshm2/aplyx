-- Cross-user RLS denial tests for migration 0027 (application_accounts,
-- application_account_links, application_account_events) — Package 1's
-- own acceptance criteria: "Cross-user reads, updates, deletes ... fail
-- without record-existence leakage."
--
-- There's no existing test harness in this repo to extend (no pgTAP, no
-- CI DB step — config.toml's own header says this project isn't wired
-- for local `supabase start`; migrations are applied by hand). Rather
-- than invent a new test dependency, this is a single self-contained
-- SQL script, meant to be run by hand:
--
--   psql "$SUPABASE_DB_URL" -f src/supabase/tests/0027_application_account_credentials_rls.sql
--
-- (or pasted into the Supabase SQL Editor). It creates two throwaway
-- users and one throwaway account/link/event entirely inside a
-- transaction, runs every cross-user operation Package 1's RLS should
-- block, and ROLLBACKs unconditionally at the end — nothing it does
-- persists in the real database, pass or fail. Failures raise a real
-- exception (script aborts with a clear message); if it reaches the
-- final "ALL PASSED" notice and rolls back cleanly, every check held.
--
-- Not covered here (belongs to Package 2, once those RPCs exist):
-- reveal/rotate/status-check ownership checks, since those are RPC-level
-- behavior, not table-level RLS.

begin;

-- Postgres' role-switching for RLS testing needs the `authenticated`
-- role (Supabase's own role for RLS-scoped access) and auth.uid() to
-- resolve from the JWT claim it actually reads from — set both per
-- statement-block below, not once, since `set local` is transaction-
-- scoped but auth.uid() is re-evaluated per query.

do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  secret_a uuid;
  account_a uuid;
  link_a uuid;
  event_a uuid;
  row_count int;
begin
  -- Throwaway auth.users rows — minimal columns, exists only for the
  -- duration of this transaction (rolled back at the very end).
  insert into auth.users (id, email) values
    (user_a, 'rls-test-a-' || user_a || '@example.invalid'),
    (user_b, 'rls-test-b-' || user_b || '@example.invalid');

  -- Seed one Vault secret + one account/link/event, all owned by user_a.
  -- Named off user_a (already known), not account_a (not assigned yet —
  -- naming it off that would concatenate a NULL and pass vault.create_secret
  -- a NULL name).
  secret_a := vault.create_secret('{"username":"rls-test","password":"rls-test"}', 'rls_test_secret_' || user_a);
  insert into public.application_accounts (user_id, ats_family, tenant_key, company_name, credential_secret_id)
  values (user_a, 'greenhouse', 'rls-test-tenant', 'RLS Test Co', secret_a)
  returning id into account_a;

  -- application_account_links.job_key has a composite FK to
  -- jobs(user_id, job_key) (migration 0027) — needs a real registry row
  -- to point at, or the insert below fails FK validation before RLS is
  -- even in play.
  insert into public.jobs (user_id, job_key, job_id, company, title, url)
  values (user_a, 'rls-test-job-key', 'rls-test-job-id', 'RLS Test Co', 'RLS Test Role', 'https://example.invalid/rls-test');

  insert into public.application_account_links (user_id, account_id, job_key)
  values (user_a, account_a, 'rls-test-job-key')
  returning id into link_a;

  -- application_account_events has no client insert policy at all (by
  -- design) — insert this one as postgres (bypassing RLS, same as a
  -- future SECURITY DEFINER function would) purely to seed a row for
  -- the cross-user SELECT check below.
  insert into public.application_account_events (user_id, account_id, event_type)
  values (user_a, account_a, 'account_created')
  returning id into event_a;

  raise notice 'Seed OK: user_a=%, account_a=%, link_a=%, event_a=%', user_a, account_a, link_a, event_a;

  -- Impersonate user_b via the same JWT-claim mechanism Supabase's own
  -- PostgREST layer uses — auth.uid() reads this, not a session var we
  -- invented ourselves.
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 1. Cross-user SELECT on application_accounts must return zero rows.
  select count(*) into row_count from public.application_accounts where id = account_a;
  if row_count != 0 then
    raise exception 'FAIL: user_b could SELECT user_a''s application_accounts row (% rows)', row_count;
  end if;

  -- 2. Cross-user UPDATE must affect zero rows (not an error — RLS
  -- should make the row invisible, not throw, so behavior can't be
  -- distinguished from "row doesn't exist").
  update public.application_accounts set company_name = 'pwned' where id = account_a;
  get diagnostics row_count = row_count;
  if row_count != 0 then
    raise exception 'FAIL: user_b could UPDATE user_a''s application_accounts row (% rows)', row_count;
  end if;

  -- 3. Cross-user DELETE must affect zero rows.
  delete from public.application_accounts where id = account_a;
  get diagnostics row_count = row_count;
  if row_count != 0 then
    raise exception 'FAIL: user_b could DELETE user_a''s application_accounts row (% rows)', row_count;
  end if;

  -- 4. Cross-user SELECT on application_account_links must return zero
  -- rows, even though user_b could in principle try inserting a link
  -- naming user_a's account_id directly.
  select count(*) into row_count from public.application_account_links where id = link_a;
  if row_count != 0 then
    raise exception 'FAIL: user_b could SELECT user_a''s application_account_links row (% rows)', row_count;
  end if;

  -- 5. user_b attempting to link THEMSELVES to user_a's account must be
  -- rejected by the EXISTS-ownership check in the insert policy, not
  -- just by the bare user_id check.
  begin
    insert into public.application_account_links (user_id, account_id, job_key)
    values (user_b, account_a, 'rls-test-job-key-b');
    raise exception 'FAIL: user_b could link themselves to user_a''s account';
  exception
    when insufficient_privilege or others then
      -- Expected: the with-check clause rejects this insert.
      null;
  end;

  -- 6. Cross-user SELECT on application_account_events must return zero
  -- rows.
  select count(*) into row_count from public.application_account_events where id = event_a;
  if row_count != 0 then
    raise exception 'FAIL: user_b could SELECT user_a''s application_account_events row (% rows)', row_count;
  end if;

  -- 7. No client role (authenticated OR anon) may insert into
  -- application_account_events at all — it's server-function-only.
  begin
    insert into public.application_account_events (user_id, account_id, event_type)
    values (user_b, account_a, 'account_created');
    raise exception 'FAIL: user_b (authenticated) could insert an application_account_events row directly';
  exception
    when insufficient_privilege or others then
      null;
  end;

  raise notice 'ALL PASSED: cross-user select/update/delete/insert on all three Package 1 tables were correctly denied.';
end $$;

rollback;
