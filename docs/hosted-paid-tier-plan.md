# aplyx accounts — free hosted tier, paid hosted tiers, and usage tracking

> **Status: planned, not started.** A design document, not a phase in
> progress — nothing in the free/paid-tier or usage-tracking sections below
> has been built. This supersedes the previous, narrower version of this
> same file (titled "Hosted, paid agent tier"), which covered paid hosted
> plans only. Everything from that version that's still true is folded
> forward here (Stripe choice, worker-host bake-off findings, reliability
> pattern, security/PII, the concrete open questions) — nothing below is a
> rewrite-from-scratch of settled decisions, only an extension of them.
> Extends Phase 17 ("Hosted service," `docs/PLAN.md` §3.18) and depends on
> Phase 12's model-tier registry (§3.13, not built). Needs its own explicit
> operator go-ahead before any part of it starts, per this project's
> one-phase-at-a-time rule.

## What's new in this version, and why

Two things the operator asked for, directly:

1. **A free hosted account tier**, distinct from both today's local/no-account
   mode and the paid hosted tiers this doc already designed. This is
   **additive, not a reversal** — Phase 11's shipped principle ("local-only
   mode remains first-class, no account, no network") is untouched. Local
   stays exactly as it is: `LocalAdapter` takes a filesystem path, nothing
   else, no user_id, no network call, ever. What's new is a *second*,
   parallel free path — sign in, get an account, get a narrower but real
   set of hosted capabilities — sitting between local and the paid tiers.
   This resolves the open question `docs/hosted-no-agent-tiers-plan.md`
   deliberately left unanswered ("free or paid — a real pricing/positioning
   decision, not this document's to make"): **free**, decided here.
2. **A usage-limit progress bar**, so a user can see how much of their plan's
   usage they've consumed — for a hosted paid tier, aplyx's own per-day
   quota; for local mode, aplyx's own consumption against whatever the
   user's coding-agent provider actually exposes (see "Usage-limit tracking"
   below — this is the part that needed real design, not just a UI
   component, because "the coding agent's own usage limit" isn't a single
   knowable number across providers).

## The three-way account model

| | Local | Free hosted | Paid hosted |
|---|---|---|---|
| Account required? | No | Yes | Yes |
| Auth mechanism | none | email/password or Google OAuth (already built, `AuthContext.tsx`) | same |
| Coding agent required? | Yes (bring your own) | No | No |
| Data location | local JSON/JSONL files | Supabase, RLS-scoped to `auth.uid()` | same |
| Capabilities | everything (search, tailor, apply, review) | Tier 0 (cached job search) + Tier 1 (hosted extension autofill) — see below | + `review_only` server-side runs, then `auto_apply` once shipped |
| Cost to aplyx | $0 (runs on the user's own machine + their own coding-agent spend) | ~$0 (cached reads + a stateless subprocess service, no LLM call, no persistent browser) | real (Anthropic API + worker compute), billed via Stripe |

Local and free-hosted are not a ladder a user is pushed up — they're
different trade-offs. Local gets full capability (including `auto_apply`
today, and the eventual local `apply` flow generally) in exchange for
bringing a coding agent. Free hosted gets a real but narrower slice (no
tailoring, no auto-apply — see Tier 0/1 below) with nothing to install and
no coding-agent bill. Paid hosted removes that narrowing at the cost of a
subscription.

**No new `account_tier` column.** A tier is derived, not stored redundantly:

```
tier = (subscriptions.status = 'active') ? subscriptions.plan : 'free_hosted'
```

A free-hosted user has no `subscriptions` row at all (not an inactive one —
none). This keeps `subscriptions` exactly as already designed (only
paying-customer rows ever exist in it) rather than introducing a second
source of truth that could drift from it. `profiles` needs no schema change
for tier tracking at all.

## Account creation / what "linked to that account" means

**Signup itself is unchanged and tier-agnostic.** `AuthContext.tsx`'s
existing email/password (with Supabase's built-in "already registered"
handling) and Google OAuth flows, already shipped in Phase 11, are the
entire account-creation mechanism for every hosted tier — free and paid
alike. There is no new signup flow to build. What's new is only: (a) this
flow becoming reachable/promoted without implying "hosted = paid" (today's
in-app copy and onboarding wizard need a pass to stop conflating the two —
tracked in "Critical files" below), and (b) capability gating happening at
the point of *use*, not at signup. A free account and a Basic-tier account
go through the identical `AuthContext` call.

**"Linked" has a concrete, per-surface meaning:**

- **Desktop app / TUI.** Once signed in, the app's active adapter is
  `SupabaseAdapter` (mode `"hosted"`) instead of `LocalAdapter`. Profile
  fields, jobs, job_events, applied_jobs, and review_queue read/write
  against the user's own RLS-scoped rows — this sync already exists
  end-to-end (`docs/supabase-user-data-plan.md`, shipped 2026-08-10). A
  user can sign out and fall back to local mode at any time; the two modes
  are not exclusive, they're just which adapter is active right now.
- **Browser extension (Tier 1, free).** The extension has no Supabase
  session today — it only knows a local bridge bearer token. Linking here
  means the **hosted personal-access-token** concept
  `hosted-no-agent-tiers-plan.md` already proposed: a new, long-lived,
  revocable token, distinct from a Supabase session JWT, issued from the
  desktop app's Settings screen and pasted into a new "aplyx account" mode
  on the extension's options page (alongside today's unchanged "Local
  install" mode). This doc adopts that proposal as-is rather than
  redesigning it — see that document for the full mechanism.
- **Multiple devices, one account.** Already true today, unchanged: RLS is
  scoped by `user_id`, not by device, so signing into the desktop app on two
  machines (or the desktop app plus the extension via a token) is already
  "linked to the same account" with no new work — worth stating explicitly
  since it's a natural question, not because anything needs building for it.

## Free hosted tier — Tier 0 + Tier 1

Adopted from `docs/hosted-no-agent-tiers-plan.md` without redesign; summarized
here because this doc is what decides they're **free**, not paid:

- **Tier 0 — cached job search.** `readJobCache()`
  (`src/core/src/jobCache.ts`) is a plain anon-key Supabase RPC call, no
  Python, no LLM. Needs a `DEFAULT_JOB_CACHE_CONFIG` baked-in fallback
  (mirrors the existing `DEFAULT_SUPABASE_CONFIG` pattern in
  `supabaseConfig.ts`) so it works with no local config file. Covers
  Ashby/Lever/Greenhouse/SmartRecruiters only (the four cacheable sources) —
  narrower than local search, and the UI should say so plainly.
- **Tier 1 — hosted hybrid autofill.** The extension's existing fit-check +
  autofill + human-clicks-submit flow, reachable via the new
  personal-access-token connection mode instead of a local bridge. Backend
  is a small, stateless (or scale-to-zero) service that subprocess-execs
  `job_state.py`/`evaluate_job_fit.py`/`append_state_entry.py` unmodified —
  the same deterministic, no-LLM logic the local extension already uses,
  just fed by `profiles.safe_fields` instead of local `targets.json`.

**Why free is the right call, not just the operator's preference:** neither
tier costs aplyx an Anthropic API call or a persistent browser session — the
two things that actually cost money and carry CAPTCHA/anti-bot risk per the
paid-tier analysis below. A free account that only ever uses Tier 0/1 costs
aplyx close to nothing to serve. The thing that needs real gating is
tailoring and auto-apply, not search-and-autofill.

**Abuse surface this introduces that paid-only signup didn't have.** A
free, no-payment-required hosted account is a classic spam/abuse vector for
the Tier 0/1 backend services even though they're cheap per-call — flagged
as a real open question below (rate limiting per free account, whether
email verification alone is sufficient friction), not solved here.

## Paid hosted tiers — folded forward, reconciled against current pricing

Everything in this section is unchanged from the prior version of this
document except the "Concrete tiers" numbers, which are corrected to match
what's actually live on the marketing site today (the old numbers were
already stale — flagged in `docs/website.md` as an unreconciled
contradiction before this rewrite).

### Architecture

```
  aplyx.app (thin front door — Vercel or Cloudflare Workers, stateless)
    - verifies Supabase JWT
    - checks subscriptions table (RLS-scoped read, no service-role needed)
    - POST /api/v1/runs        -> INSERT hosted_runs row, returns immediately
    - GET  /api/v1/runs/:id    -> poll status/result (or Supabase Realtime later)
    - POST /api/v1/stripe/webhook -> upserts subscriptions (service-role)
          |
          v  (row insert, not a direct call)
  Supabase Postgres: hosted_runs table (status column doubles as the queue)
          |
          v  (polled)
  worker (always-on process, host TBD — Fly.io vs. Upstash Box bake-off)
    - claims one queued row at a time (UPDATE ... WHERE status='queued' RETURNING, LIMIT 1)
    - imports @aplyx/core directly (same seam src/tui/ and src/tauri/ already use)
    - subprocess-execs src/scripts/state/*.py against a per-run scratch dir
    - runs the pipeline as narrow, forced-tool-use Anthropic calls (see Reliability)
    - translates the scratch-dir JSON back into Supabase rows (jobs/job_events/review_queue)
```

**Front door.** Stateless and cheap — verify auth, check billing, insert one
row, let the client poll. Platform choice (Vercel vs. Cloudflare Workers) is
low-stakes and can be decided at implementation time.

**Queue: a `hosted_runs` table, not Redis/BullMQ.** Postgres is already the
system of record; `SELECT ... FOR UPDATE SKIP LOCKED` (or an atomic
conditional `UPDATE ... RETURNING`) is the right-sized choice at
solo-operator scale.

```sql
create table public.hosted_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued','running','succeeded','failed','canceled')),
  mode text not null default 'review_only' check (mode in ('review_only','auto_apply')),
  tier text not null default 'flash',
  claimed_at timestamptz, claimed_by text,
  started_at timestamptz, finished_at timestamptz,
  input jsonb not null,   -- targets/preferences snapshot at enqueue time
  result jsonb,           -- summary: jobs found/tailored/applied, token usage
  error text,
  created_at timestamptz not null default now()
);
```

Note: a simpler `hosted_runs` table (no `tier`/`input` columns, no
`subscriptions` FK) already shipped as part of Phase 17's first increment
(migration `0004`) and is live-verified against a real test account. This
richer shape is what the paid tier needs on top of that — extend the
existing table, don't create a second one.

The `mode` column is the review-only/auto-apply toggle, first-class from day
one — see "Review-only vs. auto-apply" below.

**Worker host: undecided — Fly.io vs. Upstash Box, pending a bake-off spike.**
Upstash Box side tested hands-on 2026-07-27 (see `docs/online-hosting.md`);
Fly.io side not started. Real open concerns on the Box side: container-level
(not microVM) isolation with no SOC2/pen-test claim, preview status with no
SLA, several open GitHub issues including a false-500 on long-running
commands, and per-tenant (not shared-pool) pricing for persistent sessions.
Fly.io's justification: long-lived process support, Docker deploys fit a
Node+Python hybrid worker, scale-to-zero keeps early cost near $0, but no
real free tier as of 2026 (~$2-10/month fixed once a worker is always-on).
Decision criteria and the narrow worker-only spike scope (no Stripe, no
migrations, no front door — just cold-start latency, memory footprint,
Node+Python coexistence, egress IP behavior, and metered cost, measured
identically on both) are unchanged from before this rewrite.

**Supabase: reuse the existing auth/profile project** — not `job_cache`
(already I/O-constrained), not a new third project (free tier caps at 2,
both already spoken for). `hosted_runs` and `subscriptions` are low-volume,
on-demand tables, a different shape from `job_cache`'s bulk hourly refresh.

### Reusing `src/core` and the Python helpers — not forking

The worker is a new workspace (`packages/worker`, matching the existing
`workspaces` glob). It imports `@aplyx/core` directly and reuses
`SupabaseAdapter` with a service-role client (the worker acts on a user's
behalf, unlike the desktop webview's anon-key client) —
`SupabaseAdapter.loadState()` is what this plan builds out for the worker's
translation step. It subprocess-execs the Python helpers unmodified, never
ports them to TypeScript (directly required by `CLAUDE.md`), against a
per-run ephemeral scratch directory — the Python helpers never need to know
hosted mode exists. Needs a minimal hosted model-tier registry — a small
`src/config/models.hosted.json` mapping `{"flash", "mid", "premium"}` to
concrete Anthropic model IDs, looked up live at build time and explicitly
operator-approved, never guessed from memory (narrower than Phase 12's full
multi-provider registry — Anthropic-only, since the worker calls Anthropic
directly with aplyx's own key).

### Review-only vs. auto-apply — the toggle

Both modes exist in the schema from day one but ship in sequence:

**Ships first — `review_only`.** Server-side scrape (the API-fed boards
`job-scraper.md` already routes to when browser tools aren't available) →
canonicalize/dedupe/fit-gate via the unmodified Python helpers → tailor via
narrow, forced-tool-use Anthropic calls → results land in
`review_queue`/`jobs`/`job_events`. No apply action runs server-side.

**Ships second — `auto_apply`.** Its own dedicated design pass is already
written: `docs/hosted-auto-apply-plan.md`. Incorporates the completed Box
spike's finding that real Greenhouse postings universally carry CAPTCHA — a
hard constraint on full automation, not an edge case. Needs its own
operator go-ahead layered on top of `review_only`'s, unchanged from before.

### Billing

**Processor: Stripe**, unchanged — lowest fees among easy-setup options
(2.9% + $0.30 vs. Paddle/LemonSqueezy's 5%+ Merchant-of-Record model),
native support for both flat subscriptions and metered pricing. The
operator carries their own sales-tax/VAT responsibility (Stripe is not a
Merchant of Record); Stripe Tax is a low-effort add-on once it matters.

```sql
create table public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_subscription_id text,
  status text not null default 'inactive'
    check (status in ('inactive','active','past_due','canceled')),
  plan text not null default 'hosted_basic',
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);
-- RLS: select-only for the owning user; only the webhook handler
-- (service-role key) ever inserts/updates this table.
```

`POST /api/v1/runs` gates on `subscriptions.status = 'active'` (402 if not
— a free-hosted account, which has no row here at all, is exactly the same
402 path as a lapsed paid one). The Stripe webhook handler verifies the
signature and upserts this table on `checkout.session.completed` /
`customer.subscription.updated` / `customer.subscription.deleted`, using
the service-role key.

**Usage metering.** Every Anthropic response carries
`usage.input_tokens`/`output_tokens`. The worker accumulates per-run totals
into `hosted_runs.result` and logs `{step, tier, model_id, input_tokens,
output_tokens}` per call. This is also the data source the usage-limit bar
(below) reads for hosted users — no separate metering system needed, the
paid-tier plan already produces exactly what the bar needs to display.

### Concrete tiers + quota reconciliation (updated against live pricing)

The previous version of this document analyzed a **Free / Pro $13 /
Business $33** three-tier shape with 3/10/25-per-day quotas. The marketing
site has since been rewritten (`docs/website.md` flags this exact drift) to
the current four-paid-tier shape, with no free *hosted* tier on the
pricing page at all (the free tier shown there is local-only, $0, no
account — this document's new free-hosted tier is not yet reflected on
`pricing.html` and should be added there once this plan is approved):

| Tier | Price | Daily cap | Scope |
|---|---|---|---|
| Local | $0, no account | unbounded (bounded by the user's own coding agent) | full local capability |
| *Free hosted (new, this doc)* | $0, account required | n/a — Tier 0/1 aren't quota-gated, they're capability-gated | search + autofill only |
| Basic | $5/mo | 5/day | internship postings only |
| Intern | $9/mo | 10/day | internship-only |
| Pro | $13/mo | 17/day | internship + new-grad |
| Premier | $25/mo | 25/day | all levels/markets |

The original capacity analysis's conclusion still holds at these numbers:
storage is not the constraint (each application's footprint is ~10KB;
even generous free-tier volume stays well under Supabase's 500MB free
cap for months), Fly.io has no real free tier as of 2026 (~$2-10/month
fixed cost regardless of signups), and the actual bottleneck is Anthropic
API cost plus Playwright browser-automation concurrency (a real Chromium
session is 300-500MB RAM alone) — a single worker machine can only sustain
a handful of concurrent `auto_apply` sessions, which is the argument for
hard per-user daily caps rather than "unlimited until we notice." 5/10/17/25
are, like the original 3/10/25, a starting allocation to re-measure against
real usage once live, not a permanent commitment — consistent with the
pricing page's own "illustrative, not final" disclaimer.

**Auto-apply still isn't built.** These caps describe the planned free/paid
split for a capability (`auto_apply`) that ships second, after
`review_only` — not a claim that daily quotas are enforced today.

### Reliability

Unchanged from before — the actual mechanism, not just the transport:

1. **Forced structured tool-use output per step**, exactly
   `generate_interest_letter.py`'s `_SUBMIT_LETTER_TOOL` pattern,
   generalized to every pipeline step.
2. **Deterministic validation before any state write** — reuses
   `job_state.py`'s canonicalize/fit-gate checks and
   `generate_interest_letter.py`'s grounding-flag checks unchanged. Flagged
   output still lands in review, never silently dropped.
3. **Narrow per-step tool surfaces**, not one broad-access agent loop — the
   worker decomposes the pipeline into discrete, narrowly-scoped calls.
4. **Human-in-the-loop before anything touches an ATS** — the default by
   construction in `review_only`, carried forward as a standing principle
   once `auto_apply` ships.

### Security / PII

Unchanged: secrets (`ANTHROPIC_API_KEY`, Supabase service-role key) live
only as worker-host app secrets, never client-reachable. `safe_fields`/resume
encryption-at-rest still needs an explicit decision (disk-level default vs.
field-level `pgcrypto`). Consent screen at hosted-onboarding time — what's
stored, why, that it's server-side now, link to deletion — gates onboarding
completion for **any** hosted tier, free or paid, since a free-hosted
account's `profiles`/`safe_fields` data is real PII too, not just paid
accounts'. Deletion path: `auth.users` cascade covers table rows already;
storage bucket objects and the Stripe customer/subscription (paid accounts
only) need explicit delete steps; worker scratch directories are already
ephemeral.

## Usage-limit tracking — the bar the operator asked for

Two genuinely different problems, because "usage limit" means something
different in each mode. Building one honest mechanism per mode, not a
single fake unified number.

### Hosted (paid or free-with-Tier-1): aplyx's own quota

Straightforward — aplyx fully controls this number. For a paid tier, the
bar is:

```
used_today = count(hosted_runs) where user_id = X and created_at > now() - interval '1 day' and status != 'canceled'
cap = tier's daily cap (5 / 10 / 17 / 25, from the table above)
```

No new table needed at this scale (the capacity analysis above already
established volume is nowhere near a real constraint) — a `COUNT(*)`
against the existing `hosted_runs` table, exposed via a small RPC
(`get_own_daily_run_count`, same SECURITY DEFINER pattern the ATS-account-
credentials RPCs already use) so the client never needs a broad `hosted_runs`
read. Tier 0/1 (free hosted) aren't quota-gated at all per this doc's own
design (capability-gated instead, not cost-gated) — no bar needed there,
just a plain "included in your free account" label.

### Local: aplyx's own consumption, honestly labeled against what's actually knowable

This is the part that needed real design. "How much of the coding agent's
usage limit have I used" is not one queryable number across providers —
some expose a real usage/remaining-credits API, most don't, and aplyx has
no visibility into a user's total usage from *other* tools sharing the same
provider account regardless. The honest design, consistent with this
project's existing convention of never fabricating a stat the product can't
back (the same convention behind `feature-badge`'s "Planned" labels on the
marketing site):

1. **aplyx's own consumption is always knowable and always the base
   number.** Every local run already goes through the same Anthropic-call
   surface the paid-tier worker's usage metering targets — extend that same
   `{step, tier, model_id, input_tokens, output_tokens}` logging to local
   runs, appended to a new local, gitignored `data/usage_events.jsonl`
   (same append-only convention as `data/job_events.jsonl`, same helper
   pattern — a small addition to `job_state.py` or a sibling helper, never
   hand-written). This is real and buildable regardless of provider.
2. **Where a provider exposes a real usage/remaining-budget API, query it
   and show a true fraction.** Confirmed candidates: OpenRouter (used by
   several opencode-go model routes) exposes a `/api/v1/credits` endpoint
   returning remaining balance; OpenAI exposes an organization usage/billing
   API. For these, the bar can show `aplyx's own usage this period / actual
   remaining budget` — a real fraction, not an estimate.
3. **Where no such API exists — this includes Claude Code's own
   consumer-plan weekly caps, which Anthropic does not expose via a
   documented per-user usage API — do not fabricate a denominator.** Two
   honest options, not mutually exclusive: show aplyx's own consumption as
   a plain count ("aplyx has made 42 requests this week"), or let the user
   manually enter their own known plan cap as a **self-reported**
   denominator, explicitly labeled as self-reported in the UI (e.g. a small
   "you told us" tag next to the bar) so it's never confused with a number
   aplyx actually verified. This is the same honesty bar the pricing page
   already holds itself to for unshipped features — a silently-guessed
   "80% used" bar for a provider aplyx can't actually query would be a
   regression from that standard, not a UI nicety.
4. **Per-coding-agent, not per-provider globally**, since the operator's
   original framing was "for any of their coding agents" — a user may have
   both Claude Code and an opencode-go provider configured; the bar (or a
   small set of bars) is scoped to whichever agent/provider combination
   actually ran a given aplyx session, read from the same harness-selection
   config (`src/config/harness.json`) already driving `run_job_agent.sh`'s
   agent choice.

**Where this surfaces in the UI.** TUI: a `?`-help-adjacent status line or
a dedicated panel, consistent with the existing Status tab. Desktop app:
most naturally the Home screen, near the existing "Applications sent /
Waiting in review / Jobs seen" stat tiles already shown there (per the
homepage showcase-row screenshot of `desktop-home.png`) — a fourth stat
tile or a small bar beneath them, not a new screen.

## Explicitly out of scope for this pass

- Auto-apply's actual execution (schema/toggle included now; execution
  ships second — see `hosted-auto-apply-plan.md`).
- Phase 12's full multi-provider tier registry (only the narrow
  Anthropic-only hosted subset is in scope here).
- Hard quota *enforcement* for hosted paid tiers (this pass measures and
  displays usage; enforcing a hard cutoff at the quota is separate,
  follow-on work).
- The hosted personal-access-token issuance/revocation UI's detailed design
  (deferred to `hosted-no-agent-tiers-plan.md`, adopted here as-is).
- Provider usage-API integrations beyond identifying OpenRouter and OpenAI
  as real candidates — actual client code for each is a separate,
  narrower build.
- Rate limiting / anti-abuse specifics for free-hosted signups (flagged as
  an open question below, not designed here).
- Anthropic's Managed Agents beta as a worker replacement — a future
  re-evaluation, not a v1 bet.

## Critical files

- `src/tauri/src/lib/AuthContext.tsx` — the existing signup/signin flow
  this whole account model reuses unmodified
- `src/core/src/adapter.ts`, `adapters/supabase.ts` — the `Adapter`
  interface; service-role variant + real `loadState()` for the worker
- `src/core/src/jobCache.ts`, `supabaseConfig.ts` — Tier 0's read path and
  the `DEFAULT_SUPABASE_CONFIG` baked-in-default pattern `DEFAULT_JOB_CACHE_CONFIG`
  extends
- `src/scripts/runtime/extension_bridge.py` — Tier 1's unmodified
  subprocess target
- `src/extension/src/options.ts`, `background.ts` — the local-only guard
  Tier 1's new "aplyx account" connection mode extends
- `src/supabase/migrations/0001_init.sql`, `0004_hosted_runs.sql` — existing
  schema to extend, not replace
- `src/scripts/runtime/generate_interest_letter.py` — the forced-tool-use +
  grounding-confidence pattern every pipeline step generalizes
- `src/scripts/state/job_state.py` — subprocess-exec target for both the
  worker and the new local usage-event logging
- `src/config/harness.json` — the per-install agent selection the local
  usage bar scopes against
- `src/site/pricing.html` — needs a free-hosted-tier card added once this
  plan is approved (does not exist there today); the "usage-hook" copy
  already there ("bounded by your own coding agent's own usage limits")
  is what this plan's local usage bar makes concretely true
- `docs/hosted-no-agent-tiers-plan.md` — Tier 0/1's full design, adopted
  here, not re-derived
- `docs/hosted-auto-apply-plan.md` — auto-apply's dedicated design pass
- `docs/PLAN.md` (Phase 11 §3.12, Phase 12 §3.13, Phase 17 §3.18) — the
  roadmap constraints this plan is scoped against

## Verification (once implementation starts)

- `hosted_runs`/`subscriptions` migrations apply cleanly against the
  existing auth/profile Supabase project; RLS re-verified with two real
  accounts.
- A free-hosted signup, with no Stripe interaction at all, can use Tier 0
  search and Tier 1 autofill end to end.
- A real Stripe test-mode subscription drives `POST /api/v1/runs` from 402
  (inactive/free) to accepted (active) via the webhook path.
- One full `review_only` run against a real test account produces tailored
  review-queue entries visible in the hosted dashboard, every item passing
  through the grounding-flag checks first.
- The daily-quota bar shows a correct count against a real account's actual
  `hosted_runs` rows; the local usage bar shows a correct count against a
  real `data/usage_events.jsonl` on a real local install, with the
  self-reported-cap path visibly labeled as such.
- Deletion path removes auth row, table rows, storage objects, and the
  Stripe subscription (paid accounts) for one real test account.
- Local-only mode (no account, no network) continues to pass unchanged —
  everything in this document is additive per Phase 17's own constraint.

## Open questions for the operator, still unresolved

- Hosting budget — approved monthly infra spend (Fly.io/Upstash + Anthropic
  API usage) before build starts?
- Pricing itself for the four paid tiers — still marked "illustrative, not
  final" on the marketing site; this document doesn't fix a final number.
- Worker-host bake-off (Fly.io vs. Upstash Box) — Upstash tested hands-on,
  Fly.io still not started.
- **New**: free-hosted signup abuse/rate-limiting — email verification
  alone, or something stronger, before Tier 0/1 backends are reachable by
  an unlimited number of free accounts?
- **New**: build order — free-hosted tier (Tier 0/1) first since it's
  cheaper and validates hosted demand per `hosted-no-agent-tiers-plan.md`'s
  own sequencing argument, or alongside the paid-tier build since both now
  share the same signup/account layer?
- **New**: which provider usage APIs (OpenRouter, OpenAI) are worth
  building real integrations for first, versus shipping the self-reported-
  cap fallback everywhere initially and adding real API reads later?
