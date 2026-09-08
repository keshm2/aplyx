-- Tests for migration 0044: integrity-event tracking. Same convention as
-- 0027/0028/0029/0043: one self-contained script, throwaway rows,
-- unconditional ROLLBACK. Run with:
--
--   supabase db query --linked -f src/supabase/tests/0044_integrity_events.sql
--
-- Covers:
-- 1. release_manifests is world-readable but not client-writable.
-- 2. A user can INSERT their own integrity_events row and SELECT it back.
-- 3. A user cannot INSERT an integrity_events row for another user.
-- 4. integrity_events has no UPDATE/DELETE for authenticated — a report,
--    once sent, is permanent.
-- 5. has_integrity_violation() reflects a recent event.

begin;

do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  v_blocked boolean;
  v_id uuid;
  v_count int;
begin
  insert into auth.users (id, email) values
    (user_a, 'integ-a-' || user_a || '@example.invalid'),
    (user_b, 'integ-b-' || user_b || '@example.invalid');
  insert into public.profiles (user_id) values (user_a), (user_b);

  -- Service-role seeds a manifest (this is the CI path).
  insert into public.release_manifests (version, files, forbidden)
  values ('test-1', '{"a.py":"deadbeef"}'::jsonb, array['x.md']);

  -- --- act as user_a ---
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 1. release_manifests readable, not writable.
  select count(*) into v_count from public.release_manifests where version = 'test-1';
  if v_count <> 1 then
    raise exception 'FAIL: authenticated user could not read release_manifests';
  end if;
  v_blocked := false;
  begin
    insert into public.release_manifests (version, files) values ('hacked', '{}'::jsonb);
  exception when others then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: a client could INSERT into release_manifests';
  end if;

  -- 2. own integrity_events INSERT + SELECT.
  insert into public.integrity_events (user_id, kind, detail, client_version)
  values (user_a, 'file_modified', '{"path":"run_job_agent.py"}'::jsonb, '1.0.9b')
  returning id into v_id;
  select count(*) into v_count from public.integrity_events where id = v_id;
  if v_count <> 1 then
    raise exception 'FAIL: user_a could not read back their own integrity_events row';
  end if;

  -- 3. cannot INSERT for another user.
  v_blocked := false;
  begin
    insert into public.integrity_events (user_id, kind) values (user_b, 'file_modified');
  exception when others then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: user_a could INSERT an integrity_events row for user_b';
  end if;

  -- 4. no UPDATE / DELETE.
  v_blocked := false;
  begin
    update public.integrity_events set kind = 'file_missing' where id = v_id;
  exception when others then v_blocked := true;
  end;
  -- RLS with no UPDATE policy makes the UPDATE affect 0 rows rather than
  -- raise; assert nothing actually changed.
  perform 1 from public.integrity_events where id = v_id and kind = 'file_modified';
  if not found then
    raise exception 'FAIL: an integrity_events row was mutable by its owner';
  end if;
  begin
    delete from public.integrity_events where id = v_id;
  exception when others then null;
  end;
  select count(*) into v_count from public.integrity_events where id = v_id;
  if v_count <> 1 then
    raise exception 'FAIL: an integrity_events row was deletable by its owner';
  end if;

  reset role;
  perform set_config('request.jwt.claims', null, true);

  -- 5. has_integrity_violation reflects the recent event.
  if not public.has_integrity_violation(user_a) then
    raise exception 'FAIL: has_integrity_violation(user_a) is false despite a recent event';
  end if;
  if public.has_integrity_violation(user_b) then
    raise exception 'FAIL: has_integrity_violation(user_b) is true with no events';
  end if;

  raise notice 'PASS: 0044 integrity-event tracking tests';
end;
$$;

rollback;
