-- Package 6 (user account center) needs a "disable status tracking"
-- toggle to reflect the account's current status_tracking_enabled
-- value, but get_application_account_metadata (migration 0028) never
-- returned it. Postgres won't let `create or replace function` change
-- a `returns table(...)` shape, so this drops and recreates it;
-- still masked-metadata-only, still no username/password field.

drop function if exists public.get_application_account_metadata();

create or replace function public.get_application_account_metadata()
returns table (
  id uuid,
  company_name text,
  ats_family text,
  tenant_key text,
  login_hint text,
  status text,
  verification_status text,
  status_tracking_enabled boolean,
  last_login_at timestamptz,
  last_status_check_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select a.id, a.company_name, a.ats_family, a.tenant_key, a.login_hint,
         a.status, a.verification_status, a.status_tracking_enabled,
         a.last_login_at, a.last_status_check_at
  from public.application_accounts a
  where a.user_id = auth.uid() and a.deleted_at is null
  order by a.created_at desc;
$$;

revoke all on function public.get_application_account_metadata() from public, anon, service_role;
grant execute on function public.get_application_account_metadata() to authenticated;
