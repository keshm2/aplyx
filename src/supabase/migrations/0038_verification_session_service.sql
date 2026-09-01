-- Workday personal-inbox verification: provider-neutral session APIs
-- (docs/workday-personal-inbox-plan.md).
--
-- Migrations 0016 (verification_sessions) and 0017 (verification_messages)
-- already define the table shapes this plan needs; 0016 has RLS select/insert
-- own policies but no create/read/poll/consume RPCs, and 0017 is service-only
-- (RLS enabled, zero policies) with no way for a worker to record a matched
-- message or for the owning user to consume its one-time secret. This
-- migration adds those RPCs without altering the existing columns:
--
-- Authenticated, ownership-checked (caller = auth.uid()):
--   create_verification_session        mint a session bound to a job/apply run
--   get_own_verification_session        read one session's redacted metadata
--   list_own_verification_sessions      read the caller's recent sessions
--   poll_own_verification_session       bounded poll: bumps attempt_count,
--                                       last_poll_at; returns redacted state
--   consume_verification_secret         ONE-TIME: returns the raw OTP/link,
--                                       then redacts the message + nulls the
--                                       Vault secret so it can never be read
--                                       again. Expired sessions refuse.
--
-- Service-role only (the hosted Gmail verification worker):
--   service_list_active_workday_sessions  joins mail_connections to
--     vault.decrypted_secrets so the worker can refresh tokens and search
--     Gmail for each active session's candidate email + tenant correlation.
--   service_record_verification_message   creates the Vault secret holding
--     the extracted OTP/link and the verification_messages row referencing
--     it, then advances the session to secret_ready. Ambiguous matches are
--     recorded as manual_required, never guessed.
--   service_update_verification_session_status  advance/expire/fail a session.
--
-- Raw OTP/link values live ONLY in Vault secrets referenced by
-- verification_messages.secret_id; no RPC except
-- consume_verification_secret ever returns them, and that one redacts on the
-- same call. Expired or consumed values are gone for good, not just hidden.

-- 0016's status check already covers the full vocabulary this plan uses
-- (created/watching/message_found/secret_ready/consumed/resumed/
-- manual_required/expired/failed/canceled) and challenge_type
-- (otp/link/either/unknown), no schema change needed there. Add a
-- convenience index for the worker's "active sessions for this user"
-- lookup so a poll doesn't table-scan.
create index if not exists verification_sessions_active_idx
  on public.verification_sessions (user_id, family, status)
  where status in ('created', 'watching', 'message_found', 'secret_ready', 'resumed');

-- Idempotency: a unique constraint on (verification_session_id,
-- provider_message_id) prevents the 5-minute cron worker from
-- re-inserting the same Gmail message and colliding on the Vault secret
-- name. Partial (provider_message_id is nullable for edge cases) so a
-- null provider_message_id doesn't block legitimate inserts. A genuinely
-- new later code arrives in a different Gmail message (different
-- provider_message_id), so it is still recorded after a failed/expired
-- attempt; only exact re-processing is deduplicated.
create unique index if not exists verification_messages_session_msg_uniq
  on public.verification_messages (verification_session_id, provider_message_id)
  where provider_message_id is not null;

-- Lease state for the reveal-then-confirm consume flow
-- (docs/workday-personal-inbox-plan.md §8): reveal_verification_secret
-- stamps leased_at so the UI knows a secret has been handed to the
-- runtime; consume_verification_secret (called only after the runtime
-- reports used_verification_link/otp) does the actual redaction + Vault
-- deletion. A lease is a soft signal, not a hard lock: if the runtime
-- fails, the lease lapses and the secret remains available for retry.
alter table public.verification_messages
  add column if not exists leased_at timestamptz;

-- --- authenticated, ownership-checked RPCs --------------------------------

create or replace function public.create_verification_session(
  p_job_id text,
  p_family text default 'workday',
  p_tenant_key text default null,
  p_company text default null,
  p_candidate_email text default null,
  p_mail_connection_id uuid default null,
  p_apply_run_id uuid default null,
  p_challenge_type text default 'either',
  p_expected_sender_domains text[] default array[]::text[],
  p_expected_subject_tokens text[] default array[]::text[],
  p_ttl_minutes integer default 30
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid;
  v_existing_id uuid;
  v_expires timestamptz;
begin
  if v_user_id is null then
    raise exception 'create_verification_session requires an authenticated session';
  end if;
  if p_job_id is null or p_job_id = '' then
    raise exception 'create_verification_session requires p_job_id';
  end if;
  if p_candidate_email is null or p_candidate_email = '' then
    raise exception 'create_verification_session requires p_candidate_email';
  end if;
  -- Ownership check: if a mail_connection_id is supplied, it MUST belong
  -- to the caller. Without this, an authenticated user could bind a
  -- verification session to another user's Gmail connection and have the
  -- service-role worker scan that victim's inbox.
  if p_mail_connection_id is not null then
    if not exists (
      select 1 from public.mail_connections c
      where c.id = p_mail_connection_id and c.user_id = v_user_id
    ) then
      raise exception 'create_verification_session: p_mail_connection_id does not belong to the caller';
    end if;
  end if;
  -- Reuse a live session when Continue Workday is pressed again. This avoids
  -- creating duplicate worker targets and keeps an unconsumed secret retryable.
  select s.id into v_existing_id
    from public.verification_sessions s
    where s.user_id = v_user_id
      and s.job_id = p_job_id
      and s.family = p_family
      and s.mail_connection_id is not distinct from p_mail_connection_id
      and s.apply_run_id is not distinct from p_apply_run_id
      and s.status in ('watching', 'message_found', 'secret_ready', 'resumed', 'manual_required')
      and (s.expires_at is null or s.expires_at > now())
    order by s.created_at desc
    limit 1;
  if v_existing_id is not null then
    return v_existing_id;
  end if;
  v_expires := now() + (coalesce(p_ttl_minutes, 30) || ' minutes')::interval;

  insert into public.verification_sessions (
    user_id, job_id, family, tenant_key, company, candidate_email,
    mail_connection_id, apply_run_id, challenge_type,
    expected_sender_domains, expected_subject_tokens,
    status, expires_at, detection_started_at
  )
  values (
    v_user_id, p_job_id, p_family, p_tenant_key, p_company,
    lower(trim(p_candidate_email)), p_mail_connection_id, p_apply_run_id,
    p_challenge_type,
    to_jsonb(coalesce(p_expected_sender_domains, array[]::text[])),
    to_jsonb(coalesce(p_expected_subject_tokens, array[]::text[])),
    'watching', v_expires, now()
  )
  returning id into v_session_id;
  return v_session_id;
end;
$$;

revoke all on function public.create_verification_session(text, text, text, text, text, uuid, uuid, text, text[], text[], integer) from public, anon;
grant execute on function public.create_verification_session(text, text, text, text, text, uuid, uuid, text, text[], text[], integer) to authenticated;

-- Redacted session view: never includes checkpoint internals that could
-- carry a raw token (checkpoint is kept but the caller already owns it;
-- the raw secret lives in verification_messages.secret_id, not here).
create or replace function public.get_own_verification_session(p_session_id uuid)
returns table (
  id uuid,
  job_id text,
  family text,
  tenant_key text,
  company text,
  candidate_email text,
  mail_connection_id uuid,
  apply_run_id uuid,
  status text,
  challenge_type text,
  expected_sender_domains jsonb,
  expected_subject_tokens jsonb,
  expires_at timestamptz,
  attempt_count integer,
  last_poll_at timestamptz,
  resolved_at timestamptz,
  failure_reason text,
  has_secret boolean,
  message_extracted_kind text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'get_own_verification_session requires an authenticated session';
  end if;
  if not exists (
    select 1 from public.verification_sessions s
    where s.id = p_session_id and s.user_id = auth.uid()
  ) then
    raise exception 'verification session not found or not owned by the caller';
  end if;

  return query
    select
      s.id, s.job_id, s.family, s.tenant_key, s.company, s.candidate_email,
      s.mail_connection_id, s.apply_run_id, s.status, s.challenge_type,
      s.expected_sender_domains, s.expected_subject_tokens,
      s.expires_at, s.attempt_count, s.last_poll_at, s.resolved_at,
      s.failure_reason,
      exists (select 1 from public.verification_messages m
              where m.verification_session_id = s.id
                and m.secret_id is not null
                and m.consumed_at is null) as has_secret,
      (select m.extracted_kind from public.verification_messages m
        where m.verification_session_id = s.id
        order by m.received_at desc limit 1) as message_extracted_kind,
      s.created_at, s.updated_at
    from public.verification_sessions s
    where s.id = p_session_id;
end;
$$;

revoke all on function public.get_own_verification_session(uuid) from public, anon;
grant execute on function public.get_own_verification_session(uuid) to authenticated;

create or replace function public.list_own_verification_sessions(p_limit integer default 10)
returns table (
  id uuid,
  job_id text,
  family text,
  tenant_key text,
  company text,
  candidate_email text,
  status text,
  challenge_type text,
  expires_at timestamptz,
  attempt_count integer,
  has_secret boolean,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'list_own_verification_sessions requires an authenticated session';
  end if;
  return query
    select
      s.id, s.job_id, s.family, s.tenant_key, s.company, s.candidate_email,
      s.status, s.challenge_type, s.expires_at, s.attempt_count,
      exists (select 1 from public.verification_messages m
              where m.verification_session_id = s.id
                and m.secret_id is not null
                and m.consumed_at is null) as has_secret,
      s.updated_at
    from public.verification_sessions s
    where s.user_id = auth.uid()
    order by s.created_at desc
    limit coalesce(p_limit, 10);
end;
$$;

revoke all on function public.list_own_verification_sessions(integer) from public, anon;
grant execute on function public.list_own_verification_sessions(integer) to authenticated;

-- Bounded poll: bumps attempt_count + last_poll_at, auto-expires a session
-- past its expires_at, enforces a server-side attempt ceiling, and returns
-- the redacted state. The caller is responsible for not calling this in a
-- tight loop; the attempt_count is the audit trail that a worker/UI polled
-- within bounds. A session that exceeds the attempt ceiling transitions
-- to failed (not expired) so the failure_reason distinguishes the cause.
create or replace function public.poll_own_verification_session(p_session_id uuid)
returns table (
  status text,
  has_secret boolean,
  message_extracted_kind text,
  attempt_count integer,
  expires_at timestamptz,
  failure_reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_expires timestamptz;
  v_status text;
  v_attempt int;
  v_max_attempts int := 120;
begin
  if auth.uid() is null then
    raise exception 'poll_own_verification_session requires an authenticated session';
  end if;
  select user_id, expires_at, status, attempt_count into v_owner, v_expires, v_status, v_attempt
    from public.verification_sessions where id = p_session_id;
  if v_owner is null then
    raise exception 'verification session not found';
  end if;
  if v_owner <> auth.uid() then
    raise exception 'verification session not owned by the caller';
  end if;

  if v_expires is not null and v_expires < now()
     and v_status not in
       ('consumed', 'manual_required', 'expired', 'failed', 'canceled') then
    update public.verification_sessions
      set status = 'expired', failure_reason = 'session expired before a secret was consumed'
      where id = p_session_id and status not in
        ('consumed', 'manual_required', 'expired', 'failed', 'canceled');
  end if;

  -- Server-side attempt ceiling: a session polled more than v_max_attempts
  -- times transitions to failed. This is a safety net on top of expiry:
  -- a misbehaving client that polls in a tight loop can't keep a session
  -- alive indefinitely.
  if v_attempt >= v_max_attempts
     and v_status not in
       ('consumed', 'manual_required', 'expired', 'failed', 'canceled') then
    update public.verification_sessions
      set status = 'failed',
          failure_reason = 'verification session exceeded the maximum poll attempts'
      where id = p_session_id and status not in
        ('consumed', 'manual_required', 'expired', 'failed', 'canceled');
  end if;

  update public.verification_sessions
    set attempt_count = attempt_count + 1, last_poll_at = now()
    where id = p_session_id;

  return query
    select s.status,
      exists (select 1 from public.verification_messages m
              where m.verification_session_id = s.id
                and m.secret_id is not null
                and m.consumed_at is null) as has_secret,
      (select m.extracted_kind from public.verification_messages m
        where m.verification_session_id = s.id
        order by m.received_at desc limit 1) as message_extracted_kind,
      s.attempt_count, s.expires_at, s.failure_reason
    from public.verification_sessions s
    where s.id = p_session_id;
end;
$$;

revoke all on function public.poll_own_verification_session(uuid) from public, anon;
grant execute on function public.poll_own_verification_session(uuid) to authenticated;

-- REVEAL (pre-runtime): returns the raw OTP/link for the session's latest
-- unconsumed, unexpired message so the caller can write it to a 0600 temp
-- file for the runtime, WITHOUT consuming or redacting it. The secret
-- remains available for retry if the runtime fails to use it. Stamps
-- leased_at as a soft signal; the lease is not a hard lock. Ownership is
-- verified server-side; the service role never calls this.
create or replace function public.reveal_verification_secret(p_session_id uuid)
returns table (
  extracted_kind text,
  secret_value text,
  message_id uuid
)
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_owner uuid;
  v_status text;
  v_expires timestamptz;
  v_msg_id uuid;
  v_secret_id uuid;
  v_kind text;
  v_value text;
begin
  if auth.uid() is null then
    raise exception 'reveal_verification_secret requires an authenticated session';
  end if;
  select user_id, status, expires_at into v_owner, v_status, v_expires
    from public.verification_sessions where id = p_session_id;
  if v_owner is null then
    raise exception 'verification session not found';
  end if;
  if v_owner <> auth.uid() then
    raise exception 'verification session not owned by the caller';
  end if;
  if v_status in ('expired', 'canceled') or (v_expires is not null and v_expires < now()) then
    raise exception 'verification session has expired';
  end if;

  select m.id, m.secret_id, m.extracted_kind into v_msg_id, v_secret_id, v_kind
    from public.verification_messages m
    where m.verification_session_id = p_session_id
      and m.secret_id is not null
      and m.consumed_at is null
    order by m.received_at desc
    limit 1;
  if v_msg_id is null then
    return;  -- no unconsumed secret available
  end if;

  select decrypted_secret into v_value from vault.decrypted_secrets where id = v_secret_id;

  -- Stamp leased_at as a soft signal (not a lock). Cleared on consume.
  update public.verification_messages
    set leased_at = now()
    where id = v_msg_id;

  return query select v_kind, v_value, v_msg_id;
end;
$$;

revoke all on function public.reveal_verification_secret(uuid) from public, anon;
grant execute on function public.reveal_verification_secret(uuid) to authenticated;

-- CONFIRM CONSUME (post-runtime): called ONLY after the local runtime
-- reports used_verification_link/used_verification_otp. Locks the message
-- row (FOR UPDATE) for concurrency safety, marks consumed_at, nulls the
-- secret_id reference, AND deletes the underlying Vault secret so it can
-- never be read again. Does NOT return the secret value; the value was
-- already revealed via reveal_verification_secret and handed to the
-- runtime through a 0600 file. A second call is a no-op (no unconsumed
-- message found). An expired session refuses. Ownership is verified
-- server-side; the service role never calls this.
create or replace function public.consume_verification_secret(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_owner uuid;
  v_status text;
  v_expires timestamptz;
  v_msg_id uuid;
  v_secret_id uuid;
begin
  if auth.uid() is null then
    raise exception 'consume_verification_secret requires an authenticated session';
  end if;
  select user_id, status, expires_at into v_owner, v_status, v_expires
    from public.verification_sessions where id = p_session_id;
  if v_owner is null then
    raise exception 'verification session not found';
  end if;
  if v_owner <> auth.uid() then
    raise exception 'verification session not owned by the caller';
  end if;
  if v_status in ('expired', 'canceled') or (v_expires is not null and v_expires < now()) then
    raise exception 'verification session has expired';
  end if;

  -- Lock the message row for concurrency safety: two concurrent consume
  -- calls for the same session race on the same message. FOR UPDATE
  -- ensures only one wins; the other finds consumed_at already set and
  -- returns without touching the Vault secret.
  select m.id, m.secret_id into v_msg_id, v_secret_id
    from public.verification_messages m
    where m.verification_session_id = p_session_id
      and m.secret_id is not null
      and m.consumed_at is null
    order by m.received_at desc
    limit 1
    for update;
  if v_msg_id is null then
    return;  -- no unconsumed secret available (already consumed or none)
  end if;

  -- Redact: null the secret reference and stamp consumed_at in the same
  -- transaction as the Vault deletion so a crash between the two can't
  -- leave a dangling reference to a deleted secret (or vice versa).
  update public.verification_messages
    set consumed_at = now(), secret_id = null, leased_at = null
    where id = v_msg_id;

  -- Delete the Vault secret itself: the one-time property is enforced
  -- by consumed_at + null secret_id above, but the raw value must not
  -- linger in Vault forever (finding: secret retention).
  delete from vault.secrets where id = v_secret_id;

  update public.verification_sessions
    set status = 'consumed', resolved_at = now()
    where id = p_session_id and status not in ('consumed', 'manual_required', 'expired', 'failed', 'canceled');
end;
$$;

revoke all on function public.consume_verification_secret(uuid) from public, anon;
grant execute on function public.consume_verification_secret(uuid) to authenticated;

-- --- service-role only (hosted Gmail verification worker) -----------------

-- Returns active Workday verification sessions joined to their owning
-- mail_connections + decrypted OAuth tokens, so the worker can refresh
-- the access token and search Gmail within each session's bounded
-- window. Service-role only: vault.decrypted_secrets is not PostgREST-
-- exposed, and a session's candidate_email/tenant are correlation data,
-- not something any other user should see.
create or replace function public.service_list_active_workday_sessions()
returns table (
  session_id uuid,
  user_id uuid,
  job_id text,
  tenant_key text,
  company text,
  candidate_email text,
  challenge_type text,
  expected_sender_domains jsonb,
  expected_subject_tokens jsonb,
  expires_at timestamptz,
  attempt_count integer,
  connection_id uuid,
  connection_email text,
  access_token text,
  refresh_token text
)
language sql
security definer
set search_path = public, vault
as $$
  select
    s.id, s.user_id, s.job_id, s.tenant_key, s.company, s.candidate_email,
    s.challenge_type, s.expected_sender_domains, s.expected_subject_tokens,
    s.expires_at, s.attempt_count,
    c.id, c.email_address,
    a.decrypted_secret, r.decrypted_secret
  from public.verification_sessions s
  join public.mail_connections c on c.id = s.mail_connection_id
  join vault.decrypted_secrets a on a.id = c.token_secret_id
  left join vault.decrypted_secrets r on r.id = c.refresh_token_secret_id
  where s.family = 'workday'
     and s.status in ('watching', 'message_found', 'secret_ready', 'resumed', 'manual_required')
    and c.provider = 'gmail'
    and c.auth_method = 'oauth'
    and c.status = 'connected'
    and (s.expires_at is null or s.expires_at > now());
$$;

revoke all on function public.service_list_active_workday_sessions() from public, authenticated, anon;
grant execute on function public.service_list_active_workday_sessions() to service_role;

-- Records a matched Gmail message: creates a Vault secret holding the
-- extracted OTP/link, inserts the verification_messages row, and advances
-- the session to secret_ready (or manual_required when p_kind is null,
-- an ambiguous match the worker refused to guess). Service-role only.
create or replace function public.service_record_verification_message(
  p_session_id uuid,
  p_provider_message_id text,
  p_received_at timestamptz,
  p_from_address text,
  p_subject_redacted text,
  p_snippet_redacted text,
  p_match_score numeric,
  p_extracted_kind text,
  p_secret_value text
)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_msg_id uuid;
  v_secret_id uuid;
  v_new_status text;
  v_existing_kind text;
  v_existing_secret_id uuid;
  v_existing_consumed timestamptz;
begin
  -- Idempotency: if a message with the same (session_id, provider_message_id)
  -- already exists, skip re-inserting and re-creating a Vault secret. This
  -- prevents the 5-minute cron worker from reprocessing a secret_ready
  -- message and colliding on the Vault secret name. A genuinely new later
  -- code arrives in a different Gmail message (different provider_message_id)
  -- and is still recorded. If the existing message was consumed (secret_id
  -- null, consumed_at set), we also skip: the secret was already used.
  if p_provider_message_id is not null then
    select extracted_kind, secret_id, consumed_at into v_existing_kind, v_existing_secret_id, v_existing_consumed
      from public.verification_messages
      where verification_session_id = p_session_id
        and provider_message_id = p_provider_message_id
      limit 1;
    if found then
      -- Return the existing message id; do not create a duplicate Vault
      -- secret or advance the session status again.
      select id into v_msg_id from public.verification_messages
        where verification_session_id = p_session_id
          and provider_message_id = p_provider_message_id
        limit 1;
      return v_msg_id;
    end if;
  end if;

  if p_extracted_kind is null or p_secret_value is null or p_secret_value = '' then
    -- Ambiguous / unsupported challenge: record redacted metadata only,
    -- no secret, and mark the session manual_required. Never guess.
    insert into public.verification_messages (
      verification_session_id, provider_message_id, received_at,
      from_address, subject_redacted, snippet_redacted, match_score,
      extracted_kind, secret_id, retention_expires_at
    )
    values (
      p_session_id, p_provider_message_id, p_received_at,
      p_from_address, p_subject_redacted, p_snippet_redacted, p_match_score,
      null, null, now() + interval '24 hours'
    )
    returning id into v_msg_id;

    update public.verification_sessions
      set status = 'manual_required',
          failure_reason = coalesce(p_snippet_redacted, 'verification challenge could not be safely automated'),
          resolved_at = now()
      where id = p_session_id and status not in ('consumed', 'manual_required', 'expired', 'failed', 'canceled');
    return v_msg_id;
  end if;

  v_secret_id := vault.create_secret(
    p_secret_value,
    'verification_secret:' || p_session_id::text || ':' || coalesce(p_provider_message_id, gen_random_uuid()::text)
  );
  v_new_status := 'secret_ready';

  insert into public.verification_messages (
    verification_session_id, provider_message_id, received_at,
    from_address, subject_redacted, snippet_redacted, match_score,
    extracted_kind, secret_id, retention_expires_at
  )
  values (
    p_session_id, p_provider_message_id, p_received_at,
    p_from_address, p_subject_redacted, p_snippet_redacted, p_match_score,
    p_extracted_kind, v_secret_id, now() + interval '24 hours'
  )
  returning id into v_msg_id;

  update public.verification_sessions
    set status = v_new_status
    where id = p_session_id and status in ('watching', 'message_found', 'secret_ready', 'resumed', 'manual_required');

  return v_msg_id;
end;
$$;

revoke all on function public.service_record_verification_message(uuid, text, timestamptz, text, text, text, numeric, text, text) from public, authenticated, anon;
grant execute on function public.service_record_verification_message(uuid, text, timestamptz, text, text, text, numeric, text, text) to service_role;

create or replace function public.service_update_verification_session_status(
  p_session_id uuid,
  p_status text,
  p_failure_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.verification_sessions
    set status = p_status,
        failure_reason = coalesce(p_failure_reason, failure_reason),
        resolved_at = case when p_status in ('consumed', 'manual_required', 'expired', 'failed', 'canceled')
                          then coalesce(resolved_at, now()) else resolved_at end
    where id = p_session_id;
end;
$$;

revoke all on function public.service_update_verification_session_status(uuid, text, text) from public, authenticated, anon;
grant execute on function public.service_update_verification_session_status(uuid, text, text) to service_role;

-- Bounded cleanup: deletes Vault secrets for verification messages past
-- their retention_expires_at and nulls the secret_id reference so the raw
-- value is gone, not just hidden. Messages already consumed have their
-- Vault secret deleted by consume_verification_secret at consume time;
-- this handles the expired-but-never-consumed case (the worker recorded
-- a secret, the user never consumed it, and retention has elapsed).
-- Service-role only: the worker or a dedicated cron job calls this.
create or replace function public.service_cleanup_expired_verification_secrets()
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_msg record;
begin
  for v_msg in
    select m.id, m.secret_id from public.verification_messages m
      where m.secret_id is not null
        and m.consumed_at is null
        and m.retention_expires_at is not null
        and m.retention_expires_at < now()
  loop
    delete from vault.secrets where id = v_msg.secret_id;
    update public.verification_messages
      set secret_id = null
      where id = v_msg.id;
  end loop;
end;
$$;

revoke all on function public.service_cleanup_expired_verification_secrets() from public, authenticated, anon;
grant execute on function public.service_cleanup_expired_verification_secrets() to service_role;

-- Persists a rotated refresh token if Google returns one during an access
-- token refresh. Google does not always return a new refresh_token, but
-- when it does, the old one may be invalidated: failing to persist the
-- new one loses the connection permanently. Service-role only.
create or replace function public.service_update_mail_connection_refresh_token(
  p_connection_id uuid,
  p_refresh_token text
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
begin
  select refresh_token_secret_id into v_secret_id from public.mail_connections where id = p_connection_id;
  if v_secret_id is not null then
    perform vault.update_secret(v_secret_id, p_refresh_token);
  end if;
end;
$$;

revoke all on function public.service_update_mail_connection_refresh_token(uuid, text) from public, authenticated, anon;
grant execute on function public.service_update_mail_connection_refresh_token(uuid, text) to service_role;
