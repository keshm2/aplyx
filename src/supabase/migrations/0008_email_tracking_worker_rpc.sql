-- Worker-only accessor for email_tracking_config + its decrypted Vault
-- secret in one call. `vault.decrypted_secrets` lives in the `vault`
-- schema, which PostgREST doesn't expose by default (only `public` is),
-- so the email-tracking-worker Edge Function can't select it directly
-- even with the service-role key -- this SECURITY DEFINER function does
-- the join server-side and is the only path to a decrypted app_password,
-- locked to service_role alone (see the revoke/grant below).

create or replace function public.get_enabled_email_tracking_configs()
returns table (
  user_id uuid,
  email text,
  imap_server text,
  imap_port integer,
  app_password text,
  last_uid integer
)
language sql
security definer
set search_path = public, vault
as $$
  select c.user_id, c.email, c.imap_server, c.imap_port, s.decrypted_secret, c.last_uid
  from public.email_tracking_config c
  join vault.decrypted_secrets s on s.id = c.app_password_secret_id
  where c.enabled = true;
$$;

revoke all on function public.get_enabled_email_tracking_configs() from public, authenticated, anon;
grant execute on function public.get_enabled_email_tracking_configs() to service_role;
