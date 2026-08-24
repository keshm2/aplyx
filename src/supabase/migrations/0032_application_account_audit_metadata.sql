-- ATS account-credential layer — Package 5 (verification and recovery)
-- of docs/ats-account-credentials-plan.md, "password rotation and
-- deletion are auditable" acceptance criterion.
--
-- rotate_application_account_secret and delete_application_account
-- (migration 0028) already wrote an application_account_events row on
-- every call, but with empty metadata — an auditor could see THAT a
-- rotation/deletion happened and on which account, but not what state
-- it overwrote. rotate_application_account_secret was the sharper gap:
-- it unconditionally force-sets status = 'active', silently discarding
-- whatever status the account was actually in (login_failed, locked,
-- reset_required, ...) with zero record of it — contrast
-- mark_account_state, which already logs a from/to pair. This
-- migration makes rotate/delete log the same from/to shape mark_account_state
-- uses, plus who authorized the call (the account owner via their own
-- session, vs. a service-role caller passing p_user_id explicitly —
-- there is currently no way to tell those two apart from the event log
-- alone).

create or replace function public.rotate_application_account_secret(
  p_account_id uuid,
  p_new_username text,
  p_new_password text,
  p_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_user_id uuid := public._application_account_caller_user_id(p_user_id);
  v_secret_id uuid;
  v_hint_hash text := public._application_account_hint_hash(p_new_username);
  v_previous_status text;
begin
  if p_new_username is null or p_new_username = '' or p_new_password is null or p_new_password = '' then
    raise exception 'username and password are required';
  end if;

  select credential_secret_id, status into v_secret_id, v_previous_status
  from public.application_accounts
  where id = p_account_id and user_id = v_user_id and deleted_at is null;
  if v_secret_id is null then
    raise exception 'account not found';
  end if;

  perform vault.update_secret(v_secret_id, jsonb_build_object('username', p_new_username, 'password', p_new_password)::text);

  update public.application_accounts
  set login_hint = public._application_account_mask_hint(p_new_username),
      login_hint_hash = v_hint_hash,
      status = 'active',
      last_error_code = null,
      last_error_message = null
  where id = p_account_id;

  perform public._application_account_log_event(
    v_user_id, p_account_id, 'password_rotated',
    jsonb_build_object(
      'previous_status', v_previous_status,
      'new_status', 'active',
      'caller', case when auth.uid() is not null then 'self' else 'service_role' end
    )
  );
end;
$$;

revoke all on function public.rotate_application_account_secret(uuid, text, text, uuid) from public, anon;
grant execute on function public.rotate_application_account_secret(uuid, text, text, uuid) to authenticated, service_role;

create or replace function public.delete_application_account(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_user_id uuid := auth.uid();
  v_secret_id uuid;
  v_previous_status text;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select credential_secret_id, status into v_secret_id, v_previous_status
  from public.application_accounts
  where id = p_account_id and user_id = v_user_id and deleted_at is null;
  if v_secret_id is null then
    raise exception 'account not found';
  end if;

  perform vault.update_secret(v_secret_id, jsonb_build_object('username', null, 'password', null)::text);

  update public.application_accounts
  set status = 'deleted', deleted_at = now(), status_tracking_enabled = false
  where id = p_account_id;

  perform public._application_account_log_event(
    v_user_id, p_account_id, 'deleted',
    jsonb_build_object('previous_status', v_previous_status)
  );
end;
$$;

revoke all on function public.delete_application_account(uuid) from public, anon, service_role;
grant execute on function public.delete_application_account(uuid) to authenticated;
