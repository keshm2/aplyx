-- managed_aliases: mail.aplyx.app aliases for account-required apply flows.
--
-- Each row is one alias at mail.aplyx.app that a hosted user can use
-- as the contact email when applying to an account-required ATS
-- (workday today; any future account-required family per
-- src/core/src/atsRegistry.ts requiresAccount()). Employer replies to
-- that alias land in inbound_emails (migration 0013), so outcome
-- tracking works without the user forwarding mail from their personal
-- inbox; the hosted-only IMAP path (0007-0009) reads the user's real
-- inbox; this is the managed-alias counterpart for applications the
-- user submitted through aplyx using an alias, not their real address.
--
-- Distinct from the dropped mail_usernames (0006, dropped in 0010):
-- that table was the per-install forwarding-address registry for the
-- Resend-based pipeline that was superseded before it held real data.
-- managed_aliases is per-user (auth.uid()-scoped, RLS-protected) and
-- per-application-alias, not one shared forwarding address per
-- install. A user may hold multiple aliases (one per application, for
-- privacy / per-application filtering of replies).
--
-- `alias` is the local part (before @mail.aplyx.app). Globally unique
-- across all users: the MX record on mail.aplyx.app catches mail to
-- any address at that subdomain, so the only real work is this shared
-- registry making aliases globally unique regardless of which user
-- claims one. Uniqueness is enforced by the primary key itself (a
-- duplicate insert comes back as a real 23505 conflict), not an
-- application-side check-then-insert that could race, same pattern
-- the dropped mail_usernames used.
--
-- `family` is the ATS family this alias exists for (greenhouse/lever/
-- ashbyhq/workday). A user may hold multiple aliases, but they are
-- still grouped by family so an account-required flow can re-use an
-- existing alias instead of minting a new one every time.
--
-- `forwarding_to` is the user's real email, never connected to
-- directly by aplyx (the hosted IMAP worker reads the user's own
-- inbox separately via 0007's email_tracking_config). Stored purely so
-- the UI can show which personal inbox an alias was associated with,
-- and so a future "forward a copy to the user" path has the address
-- without re-prompting.
--
-- `status` is 'active' (in use, accepting replies) or 'disabled'
-- (retired: replies still land in inbound_emails but the alias won't
-- be handed out for new applications). Never deleted, so historical
-- apply_runs.alias_id (0011) stays resolvable.

create table if not exists public.managed_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  family text not null
    check (family in ('greenhouse', 'lever', 'ashbyhq', 'workday')),
  alias text not null unique
    check (alias ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
  forwarding_to text not null,
  status text not null default 'active'
    check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists managed_aliases_user_idx
  on public.managed_aliases (user_id, family, status);

alter table public.managed_aliases enable row level security;

create policy "managed_aliases_select_own" on public.managed_aliases
  for select using (auth.uid() = user_id);
create policy "managed_aliases_insert_own" on public.managed_aliases
  for insert with check (auth.uid() = user_id);
create policy "managed_aliases_update_own" on public.managed_aliases
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- No delete policy: an alias is retired (status='disabled'), never
-- deleted, so historical apply_runs.alias_id stays resolvable.

create trigger managed_aliases_set_updated_at
  before update on public.managed_aliases
  for each row execute function public.set_updated_at();
