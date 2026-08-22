-- Per-user inbound-mail usernames (2026-08-19 follow-on to 0005).
--
-- Each install (local or hosted) now forwards to its OWN address --
-- <username>@mail.aplyx.app -- instead of everyone sharing one generic
-- jobs@mail.aplyx.app. Resend's MX record on mail.aplyx.app already
-- catches mail to ANY address at that subdomain with zero per-address
-- provisioning, so the only real work is a shared registry that makes
-- `username` globally unique regardless of which deployment claims it.
--
-- This table IS that registry. It is the single source of truth --
-- local installs (holding the shared supabase_service_key, which
-- bypasses RLS) and any future hosted account both claim rows here, so
-- a username taken by one can never collide with the other. See
-- src/tauri/src/lib/mailUsername.ts's claimMailUsername(): uniqueness is
-- enforced by the primary key itself (a duplicate insert comes back as a
-- real 23505 conflict, reported to the UI as "taken"), not by an
-- application-side check-then-insert that could race.
--
-- `personal_email` is never connected to -- it's the address the user
-- says they're forwarding FROM, stored purely so
-- check_inbox_status.py can cross-check a forwarded message's From:
-- header against it before trusting it (same validate-before-touching-
-- state discipline the company-name match step already uses) and so the
-- onboarding UI can show provider-specific forwarding instructions.
--
-- `user_id` stays nullable and unused for now: hosted mode has no
-- desktop UI for this feature yet (InboxStep.tsx is local-only, see
-- docs/application-status-tracking-plan.md's own "Scoped down for v1"
-- precedent) -- wiring a hosted account's own auth.uid() in here is a
-- natural follow-up once that ships, not something to guess the shape of
-- now.

create table if not exists public.mail_usernames (
  username text primary key check (username ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
  personal_email text not null,
  user_id uuid references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.mail_usernames enable row level security;
-- No policies yet: service-role only, same backstop reasoning as
-- inbound_emails (0005) -- every caller today is a local install using
-- the shared service key directly. A user_id-scoped policy is the
-- natural follow-up once hosted accounts can claim their own username
-- through an authenticated (anon-key) session instead.
