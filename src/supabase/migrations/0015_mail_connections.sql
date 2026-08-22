-- Hosted inbox connections for gated ATS verification sessions.

create table if not exists public.mail_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('gmail', 'microsoft', 'imap')),
  email_address text not null,
  auth_method text not null check (auth_method in ('oauth', 'app_password')),
  status text not null default 'connected'
    check (status in ('connected', 'reauth_required', 'failed', 'revoked')),
  scopes jsonb not null default '[]'::jsonb,
  token_secret_id uuid references vault.secrets (id) on delete set null,
  refresh_token_secret_id uuid references vault.secrets (id) on delete set null,
  imap_password_secret_id uuid references vault.secrets (id) on delete set null,
  provider_account_id text,
  watch_state jsonb not null default '{}'::jsonb,
  last_health_error text,
  connected_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mail_connections_user_status_idx
  on public.mail_connections (user_id, status, provider);
create unique index if not exists mail_connections_user_provider_email_uq
  on public.mail_connections (user_id, provider, email_address);

alter table public.mail_connections enable row level security;

create policy "mail_connections_select_own" on public.mail_connections
  for select using (auth.uid() = user_id);
create policy "mail_connections_insert_own" on public.mail_connections
  for insert with check (auth.uid() = user_id);
create policy "mail_connections_update_own" on public.mail_connections
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger mail_connections_set_updated_at
  before update on public.mail_connections
  for each row execute function public.set_updated_at();
