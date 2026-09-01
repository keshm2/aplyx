-- Closes a real gap found in this week's security-audit release gate on
-- 0038_verification_session_service.sql: create_verification_session
-- already checks that a supplied p_mail_connection_id belongs to the
-- caller, but never checked that a supplied p_apply_run_id does. No
-- working exploit was found (verification_sessions/verification_messages
-- RLS and every downstream RPC are still scoped by their own user_id, so
-- a mismatched apply_run_id can't actually leak another user's secret
-- through this path), closed anyway for the same reason 0037 closed the
-- equivalent gap on application_accounts/managed_aliases: consistency
-- with an already-established ownership-check convention, not a
-- reaction to a demonstrated leak.
--
-- create or replace, same signature: this is a body-only change, no
-- migration to the table shape.

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
  -- Same check for apply_run_id, added 2026-08-30, see this migration's
  -- own header for why (consistency with 0037, not a demonstrated leak).
  if p_apply_run_id is not null then
    if not exists (
      select 1 from public.apply_runs r
      where r.id = p_apply_run_id and r.user_id = v_user_id
    ) then
      raise exception 'create_verification_session: p_apply_run_id does not belong to the caller';
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
