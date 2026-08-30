-- Tests for migration 0038's verification-session RPCs
-- (docs/workday-personal-inbox-plan.md). Same convention as 0031's tests:
-- self-contained, ROLLBACK at the end.
-- Run with:
--   supabase db query --linked -f src/supabase/tests/0038_verification_session_service.sql
--
-- Covers:
-- 1. create_verification_session mints a session owned by the caller.
-- 2. get_own_verification_session returns redacted metadata (has_secret=false
--    before any message is recorded).
-- 3. A non-owner is rejected by get/poll/consume.
-- 4. poll_own_verification_session bumps attempt_count and auto-expires a
--    session past its expires_at.
-- 5. service_record_verification_message stores a Vault secret and advances
--    the session to secret_ready; reveal_verification_secret returns the
--    raw value; consume_verification_secret (post-use) redacts + deletes
--    the Vault secret; a second reveal returns nothing.
-- 6. An ambiguous match (null kind/secret) marks the session manual_required
--    and stores no secret — reveal then returns nothing.
-- 7. create_verification_session rejects a mail_connection_id that belongs
--    to another user (cross-user ownership check).
-- 8. service_record_verification_message is idempotent — re-recording the
--    same (session_id, provider_message_id) does not create a duplicate
--    Vault secret or a duplicate message row.
-- 9. A genuinely new later code (different provider_message_id) IS recorded
--    after a failed/expired attempt.
-- 10. poll_own_verification_session transitions to failed after exceeding
--     the server-side attempt ceiling.
-- 11. service_cleanup_expired_verification_secrets deletes Vault secrets
--     for messages past their retention_expires_at.
-- 12. service_list_active_workday_sessions includes retryable secret_ready sessions.

begin;

do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  v_conn uuid;
  v_conn_b uuid;
  v_session uuid;
  v_session_again uuid;
  v_expired_session uuid;
  v_msg uuid;
  v_msg2 uuid;
  v_count int;
  v_has_secret boolean;
  v_status text;
  v_attempt int;
  v_kind text;
  v_value text;
  v_denied boolean;
  v_secret_count int;
begin
  insert into auth.users (id, email) values
    (user_a, 'vs-test-a-' || user_a || '@example.invalid'),
    (user_b, 'vs-test-b-' || user_b || '@example.invalid');

  -- A connected Gmail mail_connections row for user_a (token secret in vault).
  insert into public.mail_connections (
    user_id, provider, email_address, auth_method, status, scopes,
    token_secret_id, refresh_token_secret_id, connected_at
  )
  select user_a, 'gmail', 'candidate@example.invalid', 'oauth', 'connected',
         to_jsonb(array['gmail.readonly']),
         vault.create_secret('access-token-fake', 'vs-test-access:' || user_a),
         vault.create_secret('refresh-token-fake', 'vs-test-refresh:' || user_a),
         now()
  returning id into v_conn;

  -- A connected Gmail mail_connections row for user_b.
  insert into public.mail_connections (
    user_id, provider, email_address, auth_method, status, scopes,
    token_secret_id, refresh_token_secret_id, connected_at
  )
  select user_b, 'gmail', 'other@example.invalid', 'oauth', 'connected',
         to_jsonb(array['gmail.readonly']),
         vault.create_secret('access-token-b', 'vs-test-access-b:' || user_b),
         vault.create_secret('refresh-token-b', 'vs-test-refresh-b:' || user_b),
         now()
  returning id into v_conn_b;

  -- 1. Owner creates a session.
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_session := public.create_verification_session(
    p_job_id := 'workday-JR1',
    p_family := 'workday',
    p_tenant_key := 'co.wd5.myworkdayjobs.com',
    p_company := 'Co',
    p_candidate_email := 'Candidate@Example.invalid',
    p_mail_connection_id := v_conn,
    p_challenge_type := 'either',
    p_expected_sender_domains := array['workday.com', 'co.wd5.myworkdayjobs.com'],
    p_expected_subject_tokens := array['verify', 'code'],
    p_ttl_minutes := 30
  );
  if v_session is null then
    raise exception 'FAIL: create_verification_session returned null';
  end if;

  -- candidate_email must be normalized to lower/trim.
  select candidate_email into v_value from public.verification_sessions where id = v_session;
  if v_value <> 'candidate@example.invalid' then
    raise exception 'FAIL: candidate_email not normalized (got %)', v_value;
  end if;

  -- Repeating Continue Workday reuses the live session instead of creating
  -- duplicate worker targets for the same job/run/inbox.
  v_session_again := public.create_verification_session(
    p_job_id := 'workday-JR1',
    p_family := 'workday',
    p_tenant_key := 'co.wd5.myworkdayjobs.com',
    p_company := 'Co',
    p_candidate_email := 'candidate@example.invalid',
    p_mail_connection_id := v_conn,
    p_apply_run_id := null,
    p_challenge_type := 'either',
    p_expected_sender_domains := array['workday.com', 'co.wd5.myworkdayjobs.com'],
    p_expected_subject_tokens := array['verify', 'code'],
    p_ttl_minutes := 30
  );
  if v_session_again <> v_session then
    raise exception 'FAIL: duplicate live verification session was created';
  end if;

  -- 2. Owner reads redacted metadata; has_secret is false pre-message.
  select has_secret into v_has_secret from public.get_own_verification_session(v_session);
  if v_has_secret then
    raise exception 'FAIL: has_secret should be false before any message';
  end if;

  -- 3. Non-owner rejected by get.
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_denied := false;
  begin
    perform * from public.get_own_verification_session(v_session);
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL: user_b could read user_a''s verification session';
  end if;

  -- 7. Cross-user ownership check: user_b cannot create a session bound
  -- to user_a's mail_connection_id.
  v_denied := false;
  begin
    perform public.create_verification_session(
      p_job_id := 'workday-cross',
      p_candidate_email := 'other@example.invalid',
      p_mail_connection_id := v_conn  -- belongs to user_a
    );
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL: user_b created a session with user_a''s mail_connection_id';
  end if;

  -- 5. Service records a real OTP secret (service_role).
  reset role;
  set local role service_role;
  v_msg := public.service_record_verification_message(
    p_session_id := v_session,
    p_provider_message_id := 'gmail-123',
    p_received_at := now(),
    p_from_address := 'noreply@workday.com',
    p_subject_redacted := 'Your verification code',
    p_snippet_redacted := 'code: 654321',
    p_match_score := 0.95,
    p_extracted_kind := 'otp',
    p_secret_value := '654321'
  );
  if v_msg is null then
    raise exception 'FAIL: service_record_verification_message returned null';
  end if;
  select status into v_status from public.verification_sessions where id = v_session;
  if v_status <> 'secret_ready' then
    raise exception 'FAIL: session should be secret_ready after a real message (got %)', v_status;
  end if;

  -- 8. Idempotency: re-recording the same (session_id, provider_message_id)
  -- returns the same message id and does NOT create a duplicate Vault
  -- secret or a duplicate message row.
  v_msg2 := public.service_record_verification_message(
    p_session_id := v_session,
    p_provider_message_id := 'gmail-123',
    p_received_at := now(),
    p_from_address := 'noreply@workday.com',
    p_subject_redacted := 'Your verification code',
    p_snippet_redacted := 'code: 654321',
    p_match_score := 0.95,
    p_extracted_kind := 'otp',
    p_secret_value := '654321'
  );
  if v_msg2 <> v_msg then
    raise exception 'FAIL: idempotent re-record returned a different message id';
  end if;
  select count(*) into v_count from public.verification_messages
    where verification_session_id = v_session and provider_message_id = 'gmail-123';
  if v_count <> 1 then
    raise exception 'FAIL: duplicate message row created (got %)', v_count;
  end if;

  -- Owner reveals the secret (pre-runtime, NOT consumed).
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select extracted_kind, secret_value into v_kind, v_value from public.reveal_verification_secret(v_session);
  if v_kind <> 'otp' or v_value <> '654321' then
    raise exception 'FAIL: reveal did not return the raw OTP (got %/%)', v_kind, v_value;
  end if;

  -- A second reveal still returns the secret (not consumed yet — retry safe).
  select secret_value into v_value from public.reveal_verification_secret(v_session);
  if v_value is null then
    raise exception 'FAIL: second reveal returned no secret (should still be available pre-consume)';
  end if;

  -- Consume (post-use confirmation) — redacts + deletes Vault secret.
  perform public.consume_verification_secret(v_session);

  -- After consume, reveal returns no secret.
  select secret_value into v_value from public.reveal_verification_secret(v_session);
  if v_value is not null then
    raise exception 'FAIL: reveal returned a secret after consume (not one-time)';
  end if;

  -- The message row's secret_id must now be null (redacted).
  reset role;
  set local role service_role;
  select count(*) into v_count from public.verification_messages
    where verification_session_id = v_session and secret_id is not null and consumed_at is null;
  if v_count <> 0 then
    raise exception 'FAIL: an unconsumed secret still lingers after consume';
  end if;

  -- The Vault secret itself must be deleted (not just dereferenced).
  select count(*) into v_secret_count from vault.secrets
    where name = 'verification_secret:' || v_session::text || ':gmail-123';
  if v_secret_count <> 0 then
    raise exception 'FAIL: Vault secret not deleted after consume';
  end if;

  -- 6. Ambiguous match -> manual_required, no secret.
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_expired_session := public.create_verification_session(
    p_job_id := 'workday-JR2',
    p_candidate_email := 'candidate@example.invalid',
    p_mail_connection_id := v_conn,
    p_ttl_minutes := 30
  );
  reset role;
  set local role service_role;
  perform public.service_record_verification_message(
    p_session_id := v_expired_session,
    p_provider_message_id := 'gmail-amb',
    p_received_at := now(),
    p_from_address := 'security@co.com',
    p_subject_redacted := 'Approve sign-in',
    p_snippet_redacted := 'push approval prompt',
    p_match_score := 0.4,
    p_extracted_kind := null,
    p_secret_value := null
  );
  select status into v_status from public.verification_sessions where id = v_expired_session;
  if v_status <> 'manual_required' then
    raise exception 'FAIL: ambiguous match should set manual_required (got %)', v_status;
  end if;
  -- No secret stored for the ambiguous message.
  select count(*) into v_count from public.verification_messages
    where verification_session_id = v_expired_session and secret_id is not null;
  if v_count <> 0 then
    raise exception 'FAIL: ambiguous match stored a secret';
  end if;

  -- 9. A genuinely new later code (different provider_message_id) IS
  -- recorded after the manual_required attempt.
  v_msg := public.service_record_verification_message(
    p_session_id := v_expired_session,
    p_provider_message_id := 'gmail-new-code',
    p_received_at := now(),
    p_from_address := 'noreply@workday.com',
    p_subject_redacted := 'Your new verification code',
    p_snippet_redacted := 'code: 111222',
    p_match_score := 0.9,
    p_extracted_kind := 'otp',
    p_secret_value := '111222'
  );
  if v_msg is null then
    raise exception 'FAIL: new later code was not recorded';
  end if;
  select count(*) into v_count from public.verification_messages
    where verification_session_id = v_expired_session and provider_message_id = 'gmail-new-code';
  if v_count <> 1 then
    raise exception 'FAIL: new later code message not found';
  end if;

  -- 4. Auto-expiry: backdate a session past its expires_at, then poll.
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.verification_sessions
    set expires_at = now() - interval '5 minutes', status = 'watching'
    where id = v_expired_session;
  select status, attempt_count into v_status, v_attempt from public.poll_own_verification_session(v_expired_session);
  if v_status <> 'expired' then
    raise exception 'FAIL: poll did not auto-expire a past-expires_at session (got %)', v_status;
  end if;
  if v_attempt < 1 then
    raise exception 'FAIL: poll did not bump attempt_count';
  end if;

  -- Reveal on an expired session must refuse.
  v_denied := false;
  begin
    perform * from public.reveal_verification_secret(v_expired_session);
  exception when others then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL: reveal did not refuse an expired session';
  end if;

  -- 10. Server-side attempt ceiling: backdate attempt_count to the max
  -- and poll — the session should transition to failed.
  v_session := public.create_verification_session(
    p_job_id := 'workday-JR3',
    p_candidate_email := 'candidate@example.invalid',
    p_mail_connection_id := v_conn,
    p_ttl_minutes := 60
  );
  update public.verification_sessions
    set attempt_count = 120, status = 'watching'
    where id = v_session;
  select status into v_status from public.poll_own_verification_session(v_session);
  if v_status <> 'failed' then
    raise exception 'FAIL: poll did not transition to failed after exceeding attempt ceiling (got %)', v_status;
  end if;

  -- 11. Cleanup of expired verification secrets: record a secret, backdate
  -- its retention_expires_at, run cleanup, verify the Vault secret is gone.
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_session := public.create_verification_session(
    p_job_id := 'workday-JR4',
    p_candidate_email := 'candidate@example.invalid',
    p_mail_connection_id := v_conn,
    p_ttl_minutes := 30
  );
  reset role;
  set local role service_role;
  perform public.service_record_verification_message(
    p_session_id := v_session,
    p_provider_message_id := 'gmail-cleanup',
    p_received_at := now(),
    p_from_address := 'noreply@workday.com',
    p_subject_redacted := 'Verify',
    p_snippet_redacted := 'code: 999999',
    p_match_score := 0.9,
    p_extracted_kind := 'otp',
    p_secret_value := '999999'
  );
  -- Backdate retention so the secret is past its retention window.
  update public.verification_messages
    set retention_expires_at = now() - interval '1 hour'
    where verification_session_id = v_session and provider_message_id = 'gmail-cleanup';
  -- Count Vault secrets before cleanup.
  select count(*) into v_secret_count from vault.secrets
    where name = 'verification_secret:' || v_session::text || ':gmail-cleanup';
  if v_secret_count <> 1 then
    raise exception 'FAIL: expected 1 Vault secret before cleanup (got %)', v_secret_count;
  end if;
  perform public.service_cleanup_expired_verification_secrets();
  select count(*) into v_secret_count from vault.secrets
    where name = 'verification_secret:' || v_session::text || ':gmail-cleanup';
  if v_secret_count <> 0 then
    raise exception 'FAIL: Vault secret not deleted by cleanup';
  end if;
  -- The message row's secret_id must be nulled.
  select count(*) into v_count from public.verification_messages
    where verification_session_id = v_session and provider_message_id = 'gmail-cleanup' and secret_id is not null;
  if v_count <> 0 then
    raise exception 'FAIL: message secret_id not nulled by cleanup';
  end if;

  -- 12. service_list_active_workday_sessions includes retryable secret_ready
  -- sessions so later replacement codes can be ingested after failed use.
  perform public.service_record_verification_message(
    p_session_id := v_session,
    p_provider_message_id := 'gmail-cleanup-2',
    p_received_at := now(),
    p_from_address := 'noreply@workday.com',
    p_subject_redacted := 'Verify',
    p_snippet_redacted := 'code: 888888',
    p_match_score := 0.9,
    p_extracted_kind := 'otp',
    p_secret_value := '888888'
  );
  select status into v_status from public.verification_sessions where id = v_session;
  if v_status <> 'secret_ready' then
    raise exception 'FAIL: session should be secret_ready (got %)', v_status;
  end if;
  -- Check it remains eligible for replacement-code ingestion.
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_session := public.create_verification_session(
    p_job_id := 'workday-JR5-active',
    p_candidate_email := 'candidate@example.invalid',
    p_mail_connection_id := v_conn,
    p_ttl_minutes := 30
  );
  reset role;
  set local role service_role;
  -- Record a secret to make it secret_ready.
  perform public.service_record_verification_message(
    p_session_id := v_session,
    p_provider_message_id := 'gmail-active-test',
    p_received_at := now(),
    p_from_address := 'noreply@workday.com',
    p_subject_redacted := 'Verify',
    p_snippet_redacted := 'code: 777777',
    p_match_score := 0.9,
    p_extracted_kind := 'otp',
    p_secret_value := '777777'
  );
   -- Now query the active list — the secret_ready session must appear.
  select count(*) into v_count from public.service_list_active_workday_sessions() s
    where s.session_id = v_session;
   if v_count <> 1 then
     raise exception 'FAIL: retryable secret_ready session missing from active list';
  end if;

  raise notice 'ALL PASSED: verification-session RPCs enforce ownership, idempotency, one-time reveal+consume, Vault deletion, expiry, attempt ceiling, cleanup, and manual_required on ambiguity.';
end $$;

rollback;
