-- Inbound email receiving via Resend (Phase 17 follow-on, 2026-08-19).
--
-- `inbound_emails` is the landing table for Resend's `email.received`
-- webhook (src/supabase/functions/inbound-email/) — any email sent to
-- an address at the mail.aplyx.app receiving domain lands here. This
-- exists so a local aplyx install (running check_inbox_status.py's
-- --source supabase mode) can poll for candidate emails instead of
-- connecting to the user's real inbox via IMAP — the same deterministic
-- keyword classification and company matching runs locally either way,
-- only the SOURCE of candidate emails changes. See AGENTS.md "Inbox
-- status detection".
--
-- Deliberately no RLS policies for anon/authenticated: this table can
-- carry real email content (subject/body), so only the service-role key
-- (the inbound-email function on write, the local poller on read) can
-- ever touch it — RLS stays enabled with zero policies as a hard
-- "nothing but service-role, ever" backstop, not just relying on nobody
-- calling it with a lesser key. No per-user scoping yet either
-- (single-tenant reality today, same as hosted_runs's own comment on
-- not pre-building unneeded structure) — a user_id column is a natural
-- follow-up once more than one person forwards mail through the same
-- receiving domain, not something to guess the shape of now.

create table if not exists public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  resend_email_id text not null unique,
  to_address text not null,
  from_address text not null,
  subject text not null default '',
  body_text text not null default '',
  received_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists inbound_emails_received_at_idx on public.inbound_emails (received_at);

alter table public.inbound_emails enable row level security;
-- No policies: RLS enabled with nothing granted means every role except
-- service-role (which bypasses RLS entirely) gets zero rows, zero
-- writes, full stop.
