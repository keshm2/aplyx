-- ATS account-credential layer — Package 5 (verification and recovery)
-- of docs/ats-account-credentials-plan.md.
--
-- Real, live bug found while implementing this package: inbound_emails
-- (migration 0012) has RLS enabled with ZERO policies by design ("nothing
-- but service-role, ever" — 0012's own comment says per-user scoping was
-- meant to happen "via the alias_id -> managed_aliases -> user_id join at
-- read time"), but SupabaseAdapter.listInboundEmails/consumeInboundEmail
-- (src/core/src/adapters/supabase.ts) query the table directly using the
-- signed-in user's own JWT-scoped client, not a service-role client.
-- Under RLS with zero policies that join was never actually implemented
-- anywhere — every authenticated call silently returns zero rows (RLS
-- filters, it doesn't error), so the hosted Workday verification-mail
-- flow in ReviewScreen.tsx has been non-functional for any real signed-in
-- user: it always sees an empty inbox and never finds a link/OTP to hand
-- to the local script. This migration adds the missing ownership-checked
-- access path as two SECURITY DEFINER RPCs, rather than an RLS policy —
-- 0012 deliberately avoided RLS here because the table carries real
-- employer email content and the ownership check needs a join through
-- managed_aliases, which is exactly what a SECURITY DEFINER function
-- verifies before returning anything.
--
-- This migration also closes two OTP-handling gaps the plan's own
-- "Verification and Inbox Handling" section calls out directly:
-- - "Keep pending OTP state encrypted and expiring quickly if
--   persistence is required" — inbound_emails had no expiry column at
--   all; a parsed_otp/parsed_link sat in the table forever. Adds
--   expires_at, and list_own_inbound_emails() redacts parsed_otp/
--   parsed_link once expired.
-- - "Store no OTP after successful use" — consumeInboundEmail only ever
--   stamped consumed_at; the plaintext OTP/link stayed in the row
--   indefinitely even after being marked consumed. consume_inbound_email()
--   now also nulls parsed_otp/parsed_link at the same time.

alter table public.inbound_emails
  add column if not exists expires_at timestamptz;

create index if not exists inbound_emails_apply_run_idx
  on public.inbound_emails (apply_run_id);

-- Ownership-checked read: returns inbound_emails rows for an alias the
-- caller actually owns (verified via managed_aliases.user_id = auth.uid()),
-- with parsed_otp/parsed_link redacted once past expires_at — an expired
-- verification secret is treated the same as a consumed one, gone for
-- good, not just harder to find.
create or replace function public.list_own_inbound_emails(p_alias_id uuid)
returns table (
  id uuid,
  alias_id uuid,
  apply_run_id uuid,
  from_address text,
  subject text,
  body_text text,
  parsed_otp text,
  parsed_link text,
  classified_status text,
  forwarded_at timestamptz,
  consumed_at timestamptz,
  received_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.managed_aliases a
    where a.id = p_alias_id and a.user_id = auth.uid()
  ) then
    raise exception 'alias not found or not owned by the caller';
  end if;

  return query
    select
      e.id, e.alias_id, e.apply_run_id, e.from_address, e.subject, e.body_text,
      case when e.expires_at is not null and e.expires_at < now() then null else e.parsed_otp end,
      case when e.expires_at is not null and e.expires_at < now() then null else e.parsed_link end,
      e.classified_status, e.forwarded_at, e.consumed_at, e.received_at
    from public.inbound_emails e
    where e.alias_id = p_alias_id
    order by e.received_at desc;
end;
$$;

revoke all on function public.list_own_inbound_emails(uuid) from public;
grant execute on function public.list_own_inbound_emails(uuid) to authenticated;

-- Ownership-checked consume: marks a row consumed AND redacts the
-- verification secret it carried, in the same call — a one-time
-- verification link/OTP must never be readable again after use, not
-- just marked "used" while the plaintext lingers.
create or replace function public.consume_inbound_email(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alias_id uuid;
begin
  select alias_id into v_alias_id from public.inbound_emails where id = p_id;
  if v_alias_id is null then
    raise exception 'inbound email not found';
  end if;
  if not exists (
    select 1 from public.managed_aliases a
    where a.id = v_alias_id and a.user_id = auth.uid()
  ) then
    raise exception 'inbound email not owned by the caller';
  end if;

  update public.inbound_emails
  set consumed_at = now(), parsed_otp = null, parsed_link = null
  where id = p_id;
end;
$$;

revoke all on function public.consume_inbound_email(uuid) from public;
grant execute on function public.consume_inbound_email(uuid) to authenticated;
