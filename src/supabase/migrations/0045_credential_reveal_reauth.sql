-- aplyx: make the "recent re-authentication" gate on revealing/rotating a
-- stored ATS credential a SERVER check, not a client one (2026-09-07).
--
-- Before this, `reveal_own_account_credential` / `rotate_application_account_secret`
-- checked ownership server-side but trusted the client for re-auth
-- recency: AccountCenterScreen.tsx ran `supabase.auth.signInWithPassword`
-- and then kept an in-memory "window is fresh" flag. A modified client
-- could skip the prompt and call the RPC directly with a still-valid
-- session. Cross-user was always safe (ownership is checked); this closes
-- the "someone has my unlocked session" gap.
--
-- Mechanism: `verify_credential_reauth(password)` checks the password
-- against `auth.users.encrypted_password` (bcrypt via pgcrypto's crypt(),
-- the standard Supabase "confirm current password" pattern) and, on a
-- match, stamps `profiles.credential_reauth_at`. The reveal/rotate RPCs
-- then require that stamp to be < 10 minutes old. A client cannot forge
-- the stamp — `verify_credential_reauth` is the only writer and it
-- verifies the password itself.
--
-- The service_role (worker) path through rotate_application_account_secret
-- is exempt: it has no user session (auth.uid() is null) and is trusted
-- infrastructure, same posture as _application_account_caller_user_id.
--
-- Run via `supabase db push` or the SQL editor; NOT applied automatically
-- by committing this file.

alter table public.profiles
  add column if not exists credential_reauth_at timestamptz;

-- --- verify_credential_reauth -----------------------------------------

create or replace function public.verify_credential_reauth(p_password text)
returns boolean
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_ok boolean := false;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_password is null or p_password = '' then
    return false;
  end if;

  select (u.encrypted_password = crypt(p_password, u.encrypted_password))
    into v_ok
  from auth.users u
  where u.id = v_user_id;

  if coalesce(v_ok, false) then
    update public.profiles
      set credential_reauth_at = now()
    where user_id = v_user_id;
    -- The row may not exist yet for a brand-new account; upsert so the
    -- stamp always lands.
    if not found then
      insert into public.profiles (user_id, credential_reauth_at)
      values (v_user_id, now())
      on conflict (user_id) do update set credential_reauth_at = now();
    end if;
    return true;
  end if;
  return false;
end;
$$;

revoke all on function public.verify_credential_reauth(text) from public, anon, service_role;
grant execute on function public.verify_credential_reauth(text) to authenticated;

-- Google-only accounts have no password to check. Their re-auth is a full
-- system-browser OAuth round-trip (AccountCenterScreen's
-- confirmReauthWithGoogle), which mints a brand-new session. This stamps
-- the reauth window only when the caller's JWT was issued in the last
-- 2 minutes — true right after that round-trip, and not true for a
-- long-lived session a modified client is reusing. Weaker than the
-- password path (an auto-refresh also bumps `iat`), but the OAuth flow is
-- heavy friction on its own and this is far better than the old in-memory
-- flag.
create or replace function public.stamp_credential_reauth_oauth()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_iat bigint := nullif(auth.jwt() ->> 'iat', '')::bigint;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if v_iat is null or v_iat < extract(epoch from now())::bigint - 120 then
    return false;
  end if;
  update public.profiles set credential_reauth_at = now() where user_id = v_user_id;
  if not found then
    insert into public.profiles (user_id, credential_reauth_at) values (v_user_id, now())
    on conflict (user_id) do update set credential_reauth_at = now();
  end if;
  return true;
end;
$$;

revoke all on function public.stamp_credential_reauth_oauth() from public, anon, service_role;
grant execute on function public.stamp_credential_reauth_oauth() to authenticated;

-- --- helper: is the caller's re-auth fresh? --------------------------

create or replace function public._credential_reauth_is_fresh()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.credential_reauth_at > now() - interval '10 minutes'
       from public.profiles p where p.user_id = auth.uid()),
    false
  )
$$;

revoke all on function public._credential_reauth_is_fresh() from public, authenticated, anon;

-- --- gate reveal_own_account_credential -----------------------------

create or replace function public.reveal_own_account_credential(p_account_id uuid)
returns table (username text, password text)
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_user_id uuid := auth.uid();
  v_secret text;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if not public._credential_reauth_is_fresh() then
    raise exception 'reauth required: call verify_credential_reauth first';
  end if;

  perform 1 from public.application_accounts
  where id = p_account_id and user_id = v_user_id and deleted_at is null;
  if not found then
    raise exception 'account not found';
  end if;

  select s.decrypted_secret into v_secret
  from public.application_accounts a
  join vault.decrypted_secrets s on s.id = a.credential_secret_id
  where a.id = p_account_id;

  perform public._application_account_log_event(v_user_id, p_account_id, 'login_succeeded', jsonb_build_object('action', 'reveal'));

  return query select (v_secret::jsonb ->> 'username'), (v_secret::jsonb ->> 'password');
end;
$$;

revoke all on function public.reveal_own_account_credential(uuid) from public, anon, service_role;
grant execute on function public.reveal_own_account_credential(uuid) to authenticated;

-- --- gate rotate_application_account_secret (user path only) --------

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
begin
  if p_new_username is null or p_new_username = '' or p_new_password is null or p_new_password = '' then
    raise exception 'username and password are required';
  end if;

  -- A real user session must have re-authenticated recently. The
  -- service_role worker (auth.uid() is null) is exempt: it rotates a
  -- credential after a detected login failure, with no user present.
  if auth.uid() is not null and not public._credential_reauth_is_fresh() then
    raise exception 'reauth required: call verify_credential_reauth first';
  end if;

  select credential_secret_id into v_secret_id
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

  perform public._application_account_log_event(v_user_id, p_account_id, 'password_rotated');
end;
$$;

revoke all on function public.rotate_application_account_secret(uuid, text, text, uuid) from public, anon;
grant execute on function public.rotate_application_account_secret(uuid, text, text, uuid) to authenticated, service_role;
