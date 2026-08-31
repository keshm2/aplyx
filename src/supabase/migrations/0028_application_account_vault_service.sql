-- ATS account-credential layer: Package 2 (Vault service) of
-- docs/ats-account-credentials-plan.md. Builds the seven RPCs the plan
-- names under "Vault and Authorization Boundaries", plus one supporting
-- table the plan implies but never explicitly lists in its data model:
-- something has to hold the "valid purpose and unexpired request token"
-- issue_account_credential_use_token creates and a resolve step later
-- redeems, added here as application_account_credential_tokens, RLS
-- enabled with ZERO policies (invisible to every client role; only
-- SECURITY DEFINER functions, which bypass RLS via their owning role,
-- ever touch it).
--
-- Calling-role pattern used throughout: every RPC resolves "who is this
-- for" via _application_account_caller_user_id(p_user_id): if a real
-- JWT session exists (auth.uid() is not null), that identity always
-- wins and any passed p_user_id is ignored outright (this is the
-- concrete defense against the plan's own threat assumption: "A user
-- may attempt to alter user_id or account_id request parameters"). Only
-- when there's no JWT context at all (a service_role caller, e.g. a
-- future Package 7 worker) does an explicit p_user_id get trusted, and
-- only because reaching that branch already required the service-role
-- key, not something a client can forge over PostgREST.
--
-- Package 2 does NOT wire this into apply_runs (Package 3), does not
-- touch the ATS registry (Package 7's tenant-key resolution), and does
-- not build any UI (Package 6); those are separate follow-up packages.

-- Already installed on this project, confirmed live, in the `extensions`
-- schema, NOT `public`. `IF NOT EXISTS` makes this a no-op here either
-- way; kept only so this migration is self-sufficient on a fresh
-- project. Every function below that calls gen_random_bytes/digest/hmac
-- explicitly includes `extensions` in its own search_path because of
-- this: a plain `public, vault` search_path would fail at call time
-- with "function does not exist", not at migration-apply time.
create extension if not exists pgcrypto;

-- --- application_account_credential_tokens --------------------------------

create table if not exists public.application_account_credential_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null references public.application_accounts (id) on delete cascade,
  purpose text not null check (purpose in ('status_check', 'login_test')),
  -- The token itself is returned to the caller exactly once and never
  -- stored, only its hash, so reading this table (even with direct DB
  -- access) can't reconstruct a usable token, same reasoning a bearer
  -- API key or password reset link would use.
  token_hash text not null unique,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index if not exists application_account_credential_tokens_account_idx
  on public.application_account_credential_tokens (account_id);

alter table public.application_account_credential_tokens enable row level security;
-- No policies at all, deliberately: this table is not meant to be
-- readable or writable by `authenticated`/`anon` under any
-- circumstance, only by SECURITY DEFINER functions below.

-- --- Internal helpers (all revoked from public/authenticated/anon) -------

create or replace function public._application_account_caller_user_id(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is not null then
    return v_caller;
  end if;
  if p_user_id is null then
    raise exception 'user_id is required when calling without an authenticated session';
  end if;
  return p_user_id;
end;
$$;

revoke all on function public._application_account_caller_user_id(uuid) from public, authenticated, anon;

create or replace function public._application_account_log_event(
  p_user_id uuid, p_account_id uuid, p_event_type text, p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.application_account_events (user_id, account_id, event_type, metadata)
  values (p_user_id, p_account_id, p_event_type, p_metadata);
$$;

revoke all on function public._application_account_log_event(uuid, uuid, text, jsonb) from public, authenticated, anon;

-- Masked *display* value only ("j***@company.com"), never used for the
-- unique-constraint lookup (that's login_hint_hash, computed separately
-- below with a real keyed HMAC, not this).
create or replace function public._application_account_mask_hint(p_value text)
returns text
language sql
immutable
as $$
  select case
    when p_value is null or p_value = '' then null
    when position('@' in p_value) > 1 then
      left(p_value, 1) || '***@' || split_part(p_value, '@', 2)
    else
      left(p_value, 1) || repeat('*', greatest(length(p_value) - 1, 3))
  end;
$$;

-- The plan calls for "a keyed HMAC" for the login-identity lookup hash
-- but doesn't specify where the key lives. A per-row random salt would
-- defeat the actual purpose (finding a match requires computing the
-- SAME hash for the SAME identifier every time), so this needs one
-- stable server-side key: stored as its own Vault secret, bootstrapped
-- on first use, read only inside SECURITY DEFINER functions. The key
-- itself never leaves the database.
create or replace function public._application_account_hmac_key()
returns text
language plpgsql
security definer
-- extensions: pgcrypto (gen_random_bytes) lives there on this project,
-- confirmed live (not in public) before writing this; see migration
-- comment at the top of this file.
set search_path = public, vault, extensions
as $$
declare
  v_key text;
  v_id uuid;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets
    where name = 'application_account_login_hint_hmac_key' limit 1;
  if v_key is not null then
    return v_key;
  end if;
  v_id := vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'application_account_login_hint_hmac_key');
  select decrypted_secret into v_key from vault.decrypted_secrets where id = v_id;
  return v_key;
end;
$$;

revoke all on function public._application_account_hmac_key() from public, authenticated, anon;

create or replace function public._application_account_hint_hash(p_value text)
returns text
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
begin
  if p_value is null or p_value = '' then
    return null;
  end if;
  return encode(hmac(lower(p_value), public._application_account_hmac_key(), 'sha256'), 'hex');
end;
$$;

revoke all on function public._application_account_hint_hash(text) from public, authenticated, anon;

-- --- create_application_account -------------------------------------------

-- Idempotent by design (plan's Account Creation Lifecycle steps 3-4,
-- and "Account creation retries must be idempotent... must first check
-- for an existing account or pending account before generating another
-- password"): a retry with the same identity in the same tenant scope
-- returns the existing row's id instead of minting a second Vault
-- secret. Does NOT submit any account-creation form itself; that's a
-- browser-automation concern (Package 4), not this function's job; this
-- only reserves the Vault secret + metadata row *before* that submission
-- happens, exactly as lifecycle step 6 describes.
create or replace function public.create_application_account(
  p_ats_family text,
  p_tenant_key text,
  p_company_name text,
  p_username text,
  p_password text,
  p_managed_alias_id uuid default null,
  p_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_user_id uuid := public._application_account_caller_user_id(p_user_id);
  v_hint_hash text := public._application_account_hint_hash(p_username);
  v_existing_id uuid;
  v_secret_id uuid;
  v_account_id uuid;
begin
  if p_username is null or p_username = '' or p_password is null or p_password = '' then
    raise exception 'username and password are required';
  end if;

  select id into v_existing_id
  from public.application_accounts
  where user_id = v_user_id
    and ats_family = p_ats_family
    and tenant_key = p_tenant_key
    and login_hint_hash is not distinct from v_hint_hash
    and deleted_at is null
  limit 1;

  if v_existing_id is not null then
    perform public._application_account_log_event(
      v_user_id, v_existing_id, 'creation_started', jsonb_build_object('reused', true)
    );
    return v_existing_id;
  end if;

  -- Secret name is a random opaque id, never the email or company name
  -- (plan's "Vault secret format" section): the account row's own id
  -- doesn't exist yet at this point, so this uses its own fresh uuid
  -- rather than the row's id.
  v_secret_id := vault.create_secret(
    jsonb_build_object('username', p_username, 'password', p_password)::text,
    'application_account_cred_' || gen_random_uuid()::text
  );

  insert into public.application_accounts (
    user_id, ats_family, tenant_key, company_name, login_hint, login_hint_hash,
    credential_secret_id, managed_alias_id, status, verification_status
  )
  values (
    v_user_id, p_ats_family, p_tenant_key, p_company_name,
    public._application_account_mask_hint(p_username), v_hint_hash,
    v_secret_id, p_managed_alias_id, 'creation_pending', 'not_started'
  )
  returning id into v_account_id;

  perform public._application_account_log_event(v_user_id, v_account_id, 'creation_started', jsonb_build_object('reused', false));

  return v_account_id;
end;
$$;

revoke all on function public.create_application_account(text, text, text, text, text, uuid, uuid) from public, anon;
grant execute on function public.create_application_account(text, text, text, text, text, uuid, uuid) to authenticated, service_role;

-- --- get_application_account_metadata ---------------------------------

-- Exactly the "Credential Retrieval for User Actions" list: Company,
-- ATS family, Tenant, Masked username, Account status, Verification
-- status, Last login, Last status check, and nothing else. In
-- particular, credential_secret_id is never in this result shape, even
-- though it isn't secret by itself: no reason to hand the frontend an
-- identifier it has no legitimate use for.
create or replace function public.get_application_account_metadata()
returns table (
  id uuid,
  company_name text,
  ats_family text,
  tenant_key text,
  login_hint text,
  status text,
  verification_status text,
  last_login_at timestamptz,
  last_status_check_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select a.id, a.company_name, a.ats_family, a.tenant_key, a.login_hint,
         a.status, a.verification_status, a.last_login_at, a.last_status_check_at
  from public.application_accounts a
  where a.user_id = auth.uid() and a.deleted_at is null
  order by a.created_at desc;
$$;

revoke all on function public.get_application_account_metadata() from public, anon;
grant execute on function public.get_application_account_metadata() to authenticated;

-- --- issue_account_credential_use_token --------------------------------

-- "creates a short-lived, single-purpose token for a worker operation"
-- (plan); ttl is clamped, not caller-controlled beyond that range, so
-- a compromised/careless caller can't mint a long-lived token.
create or replace function public.issue_account_credential_use_token(
  p_account_id uuid,
  p_purpose text,
  p_ttl_seconds integer default 120,
  p_user_id uuid default null
)
returns table (token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid := public._application_account_caller_user_id(p_user_id);
  v_token text;
  v_expires timestamptz;
begin
  if p_purpose not in ('status_check', 'login_test') then
    raise exception 'invalid purpose';
  end if;

  perform 1 from public.application_accounts
  where id = p_account_id and user_id = v_user_id and deleted_at is null
    and status not in ('disabled', 'deleted');
  if not found then
    raise exception 'account not found or not usable';
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  v_expires := now() + make_interval(secs => least(greatest(p_ttl_seconds, 30), 600));

  insert into public.application_account_credential_tokens (user_id, account_id, purpose, token_hash, expires_at)
  values (v_user_id, p_account_id, p_purpose, encode(digest(v_token, 'sha256'), 'hex'), v_expires);

  return query select v_token, v_expires;
end;
$$;

revoke all on function public.issue_account_credential_use_token(uuid, text, integer, uuid) from public, anon;
grant execute on function public.issue_account_credential_use_token(uuid, text, integer, uuid) to authenticated, service_role;

-- --- resolve_application_account_credential_token ----------------------

-- The redemption half of the token issued above, deliberately NOT
-- named in the plan's own RPC list, but functionally required (a token
-- that can never be redeemed accomplishes nothing), and the plan's own
-- "Vault and Authorization Boundaries" section describes exactly this
-- resolve step's checks. service_role only: this is what a future
-- Package 7 worker calls just before opening a browser session, never
-- something a regular user's client should reach directly: "the
-- frontend must never receive another user's credential" applies with
-- extra force to a function whose entire purpose is returning a
-- decrypted secret. Single-use: a token is marked consumed on its first
-- successful resolve and every later attempt fails, matching "single-
-- purpose" from the plan and preventing replay if a token leaked.
create or replace function public.resolve_application_account_credential_token(p_token text)
returns table (account_id uuid, username text, password text)
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_row record;
  v_secret text;
begin
  select t.id, t.account_id, t.user_id, t.expires_at, t.used_at
    into v_row
  from public.application_account_credential_tokens t
  where t.token_hash = encode(digest(p_token, 'sha256'), 'hex');

  if v_row.id is null then
    raise exception 'invalid token';
  end if;
  if v_row.used_at is not null then
    raise exception 'token already used';
  end if;
  if v_row.expires_at < now() then
    raise exception 'token expired';
  end if;

  perform 1 from public.application_accounts a
  where a.id = v_row.account_id and a.user_id = v_row.user_id and a.deleted_at is null
    and a.status not in ('disabled', 'deleted');
  if not found then
    raise exception 'account not found or not usable';
  end if;

  update public.application_account_credential_tokens set used_at = now() where id = v_row.id;

  select s.decrypted_secret into v_secret
  from public.application_accounts a
  join vault.decrypted_secrets s on s.id = a.credential_secret_id
  where a.id = v_row.account_id;

  return query select v_row.account_id, (v_secret::jsonb ->> 'username'), (v_secret::jsonb ->> 'password');
end;
$$;

revoke all on function public.resolve_application_account_credential_token(text) from public, authenticated, anon;
grant execute on function public.resolve_application_account_credential_token(text) to service_role;

-- --- reveal_own_account_credential --------------------------------------

-- "requires explicit user action and recent re-authentication" (plan).
-- The re-authentication *timing* itself (operator decision 2026-08-22:
-- a short session window, not a fresh re-auth on every single reveal)
-- is enforced by the calling client/session layer via Supabase Auth's
-- own session freshness; this function's own job is strictly the
-- ownership + account-state check, and logging that a reveal happened.
-- authenticated-only: no service-role path exists here at all, on
-- purpose: nothing about "reveal to the owning user" has a legitimate
-- worker use case the way issue/resolve above do.
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

-- --- rotate_application_account_secret ----------------------------------

-- "Replace the Vault secret atomically" + "Revoke or invalidate the old
-- secret" (Password Reset and Rotation): vault.update_secret rewrites
-- the existing secret's value in place rather than creating a new one
-- and repointing credential_secret_id, so the old plaintext is gone the
-- moment this returns; there's no separate "old secret" left to revoke.
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

-- --- mark_account_state ---------------------------------------------------

-- The plan doesn't give an explicit state-transition graph (only a flat
-- "Recommended states" list), so the only rule enforced here is the one
-- unambiguous requirement stated elsewhere: 'deleted' is terminal (same
-- shape as the applied_jobs outcome-status guard trigger elsewhere in
-- this schema). Everything else is treated as a valid transition for
-- now; revisit if a real transition graph turns out to be needed once
-- Package 4 (browser resilience) is actually driving this.
create or replace function public.mark_account_state(
  p_account_id uuid,
  p_new_status text,
  p_error_code text default null,
  p_error_message text default null,
  p_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := public._application_account_caller_user_id(p_user_id);
  v_current_status text;
begin
  if p_new_status not in (
    'creation_pending', 'created_unverified', 'verification_pending', 'active',
    'login_failed', 'locked', 'reset_required', 'disabled', 'deleted'
  ) then
    raise exception 'invalid status';
  end if;

  select status into v_current_status
  from public.application_accounts
  where id = p_account_id and user_id = v_user_id and deleted_at is null;
  if v_current_status is null then
    raise exception 'account not found';
  end if;
  if v_current_status = 'deleted' then
    raise exception 'account is deleted; state is terminal';
  end if;

  update public.application_accounts
  set status = p_new_status,
      last_error_code = p_error_code,
      last_error_message = p_error_message,
      last_login_at = case when p_new_status = 'active' then now() else last_login_at end
  where id = p_account_id;

  perform public._application_account_log_event(
    v_user_id, p_account_id,
    case p_new_status when 'login_failed' then 'login_failed' when 'active' then 'login_succeeded' else 'status_check_succeeded' end,
    jsonb_build_object('from', v_current_status, 'to', p_new_status)
  );
end;
$$;

revoke all on function public.mark_account_state(uuid, text, text, text, uuid) from public, anon;
grant execute on function public.mark_account_state(uuid, text, text, text, uuid) to authenticated, service_role;

-- --- delete_application_account ------------------------------------------

-- "revokes the Vault secret and soft-deletes metadata": revocation
-- here means overwriting the secret's value with a tombstone, not
-- deleting the vault.secrets row (application_accounts.credential_secret_id
-- is NOT NULL with no "on delete" clause (see migration 0027), so the
-- row must keep pointing at *something* valid). authenticated-only: a
-- user deleting their own stored credential has no legitimate
-- service-role-initiated equivalent in this plan.
create or replace function public.delete_application_account(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_user_id uuid := auth.uid();
  v_secret_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select credential_secret_id into v_secret_id
  from public.application_accounts
  where id = p_account_id and user_id = v_user_id and deleted_at is null;
  if v_secret_id is null then
    raise exception 'account not found';
  end if;

  perform vault.update_secret(v_secret_id, jsonb_build_object('username', null, 'password', null)::text);

  update public.application_accounts
  set status = 'deleted', deleted_at = now(), status_tracking_enabled = false
  where id = p_account_id;

  perform public._application_account_log_event(v_user_id, p_account_id, 'deleted');
end;
$$;

revoke all on function public.delete_application_account(uuid) from public, anon, service_role;
grant execute on function public.delete_application_account(uuid) to authenticated;
