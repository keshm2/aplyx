-- inbound_emails — employer replies to applications submitted via a
-- managed alias (apply-foundation).
--
-- This is a fresh table, not a revival of the dropped 0005
-- inbound_emails (which was the landing table for Resend's
-- email.received webhook in the forwarding-based pipeline, dropped in
-- 0010 before it held real data). That pipeline was superseded by the
-- hosted-only IMAP design (0007-0009), which reads the user's real
-- inbox. This new inbound_emails is the managed-alias counterpart:
-- when a user applies using a mail.aplyx.app alias (managed_aliases,
-- 0011), employer replies to that alias land here, so outcome
-- tracking works for managed-alias applications without the user
-- forwarding mail or configuring IMAP for the alias.
--
-- `alias_id` references managed_aliases (0011) — the alias the reply
-- was sent to. ON DELETE CASCADE: if an alias is ever force-deleted
-- (which the no-delete-policy discipline makes rare), its replies go
-- too — an alias without its replies is meaningless for audit.
--
-- `from_address` is the employer's sender address; `subject`/`body_text`
-- carry the reply content. `classified_status` is the deterministic
-- keyword classification (applied | oa_sent | interview_requested |
-- offer | rejected | withdrawn — same taxonomy as the IMAP worker's
-- outcome_status, docs/application-status-tracking-plan.md) applied
-- at write time by the inbound-mail receiver, so the UI can filter
-- without re-classifying. Null when classification hasn't run yet.
--
-- Deliberately no RLS policies for anon/authenticated: this table
-- carries real email content, so only the service-role key (the
-- inbound-mail receiver on write, the hosted adapter on read) can
-- touch it — RLS stays enabled with zero policies as a hard
-- "nothing but service-role, ever" backstop, same as the original
-- 0005's reasoning. Per-user scoping happens via the alias_id →
-- managed_aliases → user_id join at read time, not via a direct
-- user_id column (the receiver doesn't know the user when it receives
-- the mail; it only knows the alias).

-- `apply_run_id` is an opaque correlation token emitted by the
-- mail.aplyx.app receiver when the alias was used for a concrete apply
-- run. Not a foreign key in this migration because apply_runs is created
-- later in the numbered sequence; correlation happens at the application
-- layer. `parsed_otp` and `parsed_link` hold the deterministic extraction
-- result for verification emails / OTP messages, while `forwarded_at`
-- records when a copy was forwarded to the user's real inbox.

create table if not exists public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  alias_id uuid not null references public.managed_aliases (id) on delete cascade,
  apply_run_id uuid,
  from_address text not null,
  subject text not null default '',
  body_text text not null default '',
  parsed_otp text,
  parsed_link text,
  classified_status text
    check (classified_status in ('applied', 'oa_sent', 'interview_requested', 'offer', 'rejected', 'withdrawn')),
  forwarded_at timestamptz,
  consumed_at timestamptz,
  received_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists inbound_emails_alias_received_idx
  on public.inbound_emails (alias_id, received_at);

alter table public.inbound_emails enable row level security;
-- No policies: RLS enabled with nothing granted means every role except
-- service-role (which bypasses RLS entirely) gets zero rows, zero
-- writes, full stop — same backstop as the original 0005.
