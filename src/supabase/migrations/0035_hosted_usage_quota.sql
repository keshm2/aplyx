-- Usage-limit bar backend, per docs/hosted-paid-tier-plan.md's
-- "Usage-limit tracking" section (the hosted half only; the local half,
-- reading a provider's own usage API or a self-reported cap, is a
-- separate, unrelated build against local install state, not this
-- migration).
--
-- Ground truth checked before writing this: no `subscriptions` table or
-- any Stripe integration exists anywhere in this project yet (confirmed
-- against every migration and every site/core/tauri file), and
-- `hosted_runs` (migration 0004) has no UI path that ever inserts a row;
-- its own comment says as much ("no 'Run now' UI button yet"), and the
-- worker that would process queued rows is currently paused. So for
-- every real signed-up account today, this RPC's real, honest answer is
-- "0 runs today, no active plan"; that's expected and correct, not a
-- bug. The mechanism itself is real: the moment a future Stripe
-- integration writes an 'active' subscriptions row, this RPC starts
-- returning a real cap and a real count against real hosted_runs rows,
-- with no further changes needed here.
--
-- Tier names/caps are the live pricing.html table (Basic $5/5-day,
-- Intern $9/10-day, Pro $13/17-day, Premier $25/25-day); see
-- hosted-paid-tier-plan.md's "Concrete tiers + quota reconciliation"
-- section for the capacity reasoning behind these specific numbers.
-- Free-hosted (every account today) is capability-gated, not
-- quota-gated, per that same doc: cap is null, not zero, so the client
-- can tell "unlimited within free capabilities" apart from "zero
-- remaining."

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null check (plan in ('basic', 'intern', 'pro', 'premier')),
  status text not null default 'inactive'
    check (status in ('active', 'inactive', 'canceled', 'past_due')),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

create policy "subscriptions_select_own" on public.subscriptions
  for select using (auth.uid() = user_id);
-- No insert/update/delete policy for `authenticated`: a subscription
-- row is only ever written by a future Stripe-webhook handler running
-- as service_role (which bypasses RLS entirely), the same "only the
-- backend transitions state" discipline hosted_runs and
-- application_accounts already use.

create or replace function public.get_own_usage()
returns table (used_today bigint, cap integer, plan text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_plan text;
  v_status text;
  v_cap integer;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select s.plan, s.status into v_plan, v_status
  from public.subscriptions s
  where s.user_id = v_user_id;

  if v_status = 'active' then
    v_cap := case v_plan
      when 'basic' then 5
      when 'intern' then 10
      when 'pro' then 17
      when 'premier' then 25
      else null
    end;
  else
    -- No active subscription (true for every account today): free
    -- hosted, capability-gated not quota-gated, so no numeric cap.
    v_plan := 'free_hosted';
    v_cap := null;
  end if;

  return query
  select count(*)::bigint, v_cap, v_plan
  from public.hosted_runs r
  where r.user_id = v_user_id
    and r.created_at > now() - interval '1 day'
    and r.status != 'canceled';
end;
$$;

revoke all on function public.get_own_usage() from public, anon;
grant execute on function public.get_own_usage() to authenticated;
