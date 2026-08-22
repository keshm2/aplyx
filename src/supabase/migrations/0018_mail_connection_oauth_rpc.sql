-- Service-role-only helper to persist hosted inbox OAuth tokens in Vault.

create or replace function public.service_upsert_mail_connection_oauth(
  p_user_id uuid,
  p_provider text,
  p_email_address text,
  p_provider_account_id text,
  p_scopes text[],
  p_access_token text,
  p_refresh_token text
)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing record;
  v_access_id uuid;
  v_refresh_id uuid;
  v_connection_id uuid;
begin
  select id, token_secret_id, refresh_token_secret_id into v_existing
  from public.mail_connections
  where user_id = p_user_id and provider = p_provider and email_address = p_email_address
  limit 1;

  if v_existing.token_secret_id is not null then
    perform vault.update_secret(v_existing.token_secret_id, p_access_token);
    v_access_id := v_existing.token_secret_id;
  else
    v_access_id := vault.create_secret(p_access_token, 'mail_connection_access:' || p_user_id::text || ':' || p_provider);
  end if;

  if p_refresh_token is not null and p_refresh_token <> '' then
    if v_existing.refresh_token_secret_id is not null then
      perform vault.update_secret(v_existing.refresh_token_secret_id, p_refresh_token);
      v_refresh_id := v_existing.refresh_token_secret_id;
    else
      v_refresh_id := vault.create_secret(p_refresh_token, 'mail_connection_refresh:' || p_user_id::text || ':' || p_provider);
    end if;
  else
    v_refresh_id := v_existing.refresh_token_secret_id;
  end if;

  insert into public.mail_connections (
    user_id,
    provider,
    email_address,
    auth_method,
    status,
    scopes,
    token_secret_id,
    refresh_token_secret_id,
    provider_account_id,
    connected_at,
    revoked_at,
    last_health_error
  )
  values (
    p_user_id,
    p_provider,
    p_email_address,
    'oauth',
    'connected',
    to_jsonb(coalesce(p_scopes, ARRAY[]::text[])),
    v_access_id,
    v_refresh_id,
    nullif(p_provider_account_id, ''),
    now(),
    null,
    null
  )
  on conflict (user_id, provider, email_address)
  do update set
    auth_method = 'oauth',
    status = 'connected',
    scopes = to_jsonb(coalesce(p_scopes, ARRAY[]::text[])),
    token_secret_id = v_access_id,
    refresh_token_secret_id = v_refresh_id,
    provider_account_id = nullif(p_provider_account_id, ''),
    connected_at = now(),
    revoked_at = null,
    last_health_error = null
  returning id into v_connection_id;

  return v_connection_id;
end;
$$;

revoke all on function public.service_upsert_mail_connection_oauth(uuid, text, text, text, text[], text, text) from public, authenticated, anon;
grant execute on function public.service_upsert_mail_connection_oauth(uuid, text, text, text, text[], text, text) to service_role;
