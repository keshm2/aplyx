-- aplyx hosted backend: gate server-side runs behind an active
-- subscription, and give every tier a real per-day application cap that
-- the server (not the client) enforces (2026-09-06).
--
-- Operator decisions this encodes:
--   1. Server-side `review_only` runs (the pipeline that produces a
--      tailored resume + cover letter into the review queue) are
--      PAID-ONLY. A free hosted account gets Tier 0 cached search + Tier 1
--      extension autofill, never a server-side pipeline run.
--   2. Every paid tier caps auto-applications per day, matching pricing.html:
--      basic 5, intern 10, pro 17, premier 25. Free/local has no server
--      cap here (local runs on the user's own machine + agent; its own
--      25/day ceiling is enforced in run_job_agent.py).
--
-- Why this is server-side and un-bypassable: `subscriptions` has no
-- INSERT/UPDATE policy for `authenticated` (only a future Stripe webhook
-- running as service_role writes it — migration 0035), so a client cannot
-- fake an active plan by any means — a tampered JWT fails signature
-- verification, and there is no row it is allowed to write. The RLS
-- WITH CHECK below and the worker's own claim query (src/worker/src/run.ts)
-- both consult it; app code is never the gate.
--
-- Ground truth as of this migration: no Stripe integration exists, so
-- `subscriptions` is empty and `active_subscription_plan()` returns NULL
-- for every account. That means hosted_runs INSERT is currently blocked
-- for everyone — which is correct and harmless: there is no "Run now" UI
-- that inserts a row, and the worker is paused. The moment a Stripe
-- webhook writes an 'active' row, that user's inserts start succeeding
-- with no further change here.
--
-- Run via `supabase db push` or the SQL editor; NOT applied automatically
-- by committing this file.

-- --- helpers -----------------------------------------------------------

-- The caller's active plan name, or NULL when there is no active
-- subscription. Derived strictly from auth.uid(); never takes a
-- client-supplied user id.
create or replace function public.active_subscription_plan()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.plan
  from public.subscriptions s
  where s.user_id = auth.uid()
    and s.status = 'active'
$$;

revoke all on function public.active_subscription_plan() from public, anon;
grant execute on function public.active_subscription_plan() to authenticated;

-- Per-day auto-application cap for a given user. NULL = no server cap
-- (free hosted / no active subscription — free hosted cannot auto-apply
-- at all, so there is nothing to cap here). Takes an explicit user id so
-- the service-role worker can call it for the run's owner; an
-- authenticated caller can only meaningfully learn their own (every RLS
-- path routes through active_subscription_plan(), which is auth.uid()).
create or replace function public.tier_daily_apply_cap(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case (
    select s.plan from public.subscriptions s
    where s.user_id = p_user_id and s.status = 'active'
  )
    when 'basic' then 5
    when 'intern' then 10
    when 'pro' then 17
    when 'premier' then 25
    else null
  end
$$;

revoke all on function public.tier_daily_apply_cap(uuid) from public, anon;
grant execute on function public.tier_daily_apply_cap(uuid) to authenticated, service_role;

-- --- hosted_runs: paid-only INSERT ------------------------------------

drop policy if exists "hosted_runs_insert_own" on public.hosted_runs;
create policy "hosted_runs_insert_own" on public.hosted_runs
  for insert with check (
    auth.uid() = user_id
    and public.active_subscription_plan() is not null
  );
-- SELECT is unchanged (a user can still see the status of any run they
-- somehow own). No UPDATE/DELETE for authenticated — only the
-- service-role worker transitions a run.

-- --- apply_runs: a client may queue a run, never assert a terminal state

-- apply_runs INSERT is a legitimate authenticated path (a signed-in local
-- user's Workday continuation calls createApplyRun with status
-- 'confirm_before_submit'), so it stays open — but a client must not be
-- able to INSERT a row that already claims 'submitted'/'failed'/
-- 'needs_review'. Only the worker (service_role, bypasses RLS) sets a
-- terminal status. This keeps a per-day count of `status = 'submitted'`
-- rows monotonic from the client's side: it can add pre-submit rows
-- (harmless) but can neither fabricate a completed application nor delete
-- a real one (there is no UPDATE or DELETE policy).
drop policy if exists "apply_runs_insert_own" on public.apply_runs;
create policy "apply_runs_insert_own" on public.apply_runs
  for insert with check (
    auth.uid() = user_id
    and status in (
      'initialized', 'package_assembled', 'fill_planned', 'filling',
      'ready_to_submit', 'confirm_before_submit'
    )
  );

-- --- get_own_usage: report the apply cap, not the run count -----------

-- Was: count of hosted_runs today vs a plan cap. Now: count of
-- applications actually submitted today (apply_runs.status = 'submitted',
-- a status only the worker can set) vs tier_daily_apply_cap. Free hosted
-- gets cap = NULL (capability-gated, cannot auto-apply), so the client
-- can still tell "free, no numeric cap" from "0 of N remaining".
create or replace function public.get_own_usage()
returns table (used_today bigint, cap integer, plan text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  return query
  select
    (select count(*)::bigint
       from public.apply_runs r
      where r.user_id = v_user_id
        and r.status = 'submitted'
        and r.created_at > now() - interval '1 day'),
    public.tier_daily_apply_cap(v_user_id),
    coalesce(public.active_subscription_plan(), 'free_hosted');
end;
$$;

revoke all on function public.get_own_usage() from public, anon;
grant execute on function public.get_own_usage() to authenticated;
