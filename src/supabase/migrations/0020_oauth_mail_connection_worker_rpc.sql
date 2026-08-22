-- Wires the OAuth Gmail connection (mail_connections) into
-- email-tracking-worker's status-tracking scan, alongside the existing
-- app-password/IMAP path (email_tracking_config, migration 0008). Gmail
-- OAuth here only ever requested gmail.readonly, not the broader
-- https://mail.google.com/ scope IMAP requires, so the worker reads via
-- the Gmail REST API instead of IMAP for these accounts — same
-- read-only guarantee, no re-consent needed from anyone already
-- connected.
--
-- Mirrors 0008_email_tracking_worker_rpc.sql's pattern: vault.decrypted_secrets
-- isn't PostgREST-exposed, so these SECURITY DEFINER functions do the
-- join/mutation server-side, locked to service_role alone.

create or replace function public.get_enabled_oauth_mail_connections()
returns table (
  connection_id uuid,
  user_id uuid,
  email text,
  access_token text,
  refresh_token text,
  watch_state jsonb
)
language sql
security definer
set search_path = public, vault
as $$
  select c.id, c.user_id, c.email_address, s.decrypted_secret, r.decrypted_secret, c.watch_state
  from public.mail_connections c
  join vault.decrypted_secrets s on s.id = c.token_secret_id
  left join vault.decrypted_secrets r on r.id = c.refresh_token_secret_id
  where c.provider = 'gmail' and c.auth_method = 'oauth' and c.status = 'connected';
$$;

revoke all on function public.get_enabled_oauth_mail_connections() from public, authenticated, anon;
grant execute on function public.get_enabled_oauth_mail_connections() to service_role;

-- Persists the refreshed access token in place after each run (Google
-- access tokens last ~1hr; the worker refreshes unconditionally at the
-- start of each account's scan rather than tracking expiry, simpler and
-- avoids ever attempting a stale token) — subsequent runs still benefit
-- from a warm token if this one is called more than once before it
-- naturally expires.
create or replace function public.service_update_mail_connection_access_token(p_connection_id uuid, p_access_token text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
begin
  select token_secret_id into v_secret_id from public.mail_connections where id = p_connection_id;
  if v_secret_id is not null then
    perform vault.update_secret(v_secret_id, p_access_token);
  end if;
end;
$$;

revoke all on function public.service_update_mail_connection_access_token(uuid, text) from public, authenticated, anon;
grant execute on function public.service_update_mail_connection_access_token(uuid, text) to service_role;

-- The Gmail-API path's equivalent of email_tracking_config.last_uid —
-- mail_connections has no dedicated cursor column, so this reuses the
-- existing watch_state jsonb (already used to store imap_server/imap_port
-- for the app-password path) rather than adding a migration for one field.
create or replace function public.service_update_mail_connection_watch_state(p_connection_id uuid, p_watch_state jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  update public.mail_connections set watch_state = p_watch_state where id = p_connection_id;
$$;

revoke all on function public.service_update_mail_connection_watch_state(uuid, jsonb) from public, authenticated, anon;
grant execute on function public.service_update_mail_connection_watch_state(uuid, jsonb) to service_role;
