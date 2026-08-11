# Hosted, paid agent tier — server-side runs behind aplyx's own domain

> **Status: planned, not started.** This is a design document, not a phase
> in progress — nothing here has been built. It extends Phase 17 ("Hosted
> service," `docs/PLAN.md` §3.18) with a paid dimension Phase 17 itself does
> not cover, and depends on Phase 12's model-tier registry (§3.13, also not
> built). Needs its own explicit operator go-ahead before any part of it
> starts, per this project's one-phase-at-a-time rule.

## Context

Today aplyx requires a user to bring their own coding-agent CLI (Claude Code
or opencode) running locally. The operator wants a **paid, hosted** option:
a user without a coding-agent subscription pays aplyx, and aplyx's own
backend — at aplyx's own domain — runs the job-search/tailoring pipeline
server-side using aplyx's own Anthropic API key, instead of the user's local
CLI.

The operator's original framing ("call the opencode API, claude code API
from our domain") is based on a misconception worth naming directly: neither
opencode nor Claude Code offers a hosted multi-tenant API. `opencode serve`
and Claude Code's `-p` headless mode are both things *you* run on
infrastructure *you* control; under the hood both just call the standard
Anthropic Messages API with a supplied key. Two research passes confirmed
the real building block is calling that API directly — either raw (the
pattern already proven in `src/scripts/runtime/generate_interest_letter.py`,
which forces structured tool-use output instead of free text) or via the
**Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), Claude Code's own
harness packaged as an embeddable library, billed as plain per-token API
usage with no CLI-seat fee.

This maps onto the project's own roadmap: **Phase 17** ("hosted service,"
`docs/PLAN.md:2130-2410`) already specs a free, review-first, consent-gated
hosted tier, and depends on **Phase 12**'s not-yet-built model-tier
registry. Neither phase says anything about *paid* plans or billing — that
dimension is entirely new and needs its own design. A repo-wide search
confirmed zero billing/Stripe/payment/quota infrastructure exists today, and
zero server-compute surface exists either (no `server/`, no API routes, no
Supabase Edge Functions) — the only "runs on a schedule, not on someone's
laptop" precedent is `.github/workflows/refresh-job-cache.yml`, a stateless
hourly cron job, not a fit for a paid multi-tenant agent worker.

The operator confirmed, when asked: build the review-only/auto-apply split
as a first-class **toggle**, not an either/or; use whichever worker host is
best suited to running agents (Fly.io, per research at the time — reopened
2026-07-27 as a two-candidate bake-off against Upstash Box, see "Worker
host" below); reuse the *existing*
Supabase auth/profile project rather than spin up a third (free-tier
Supabase caps out at 2 projects, both already in use); and pick a billing
processor by lowest fees + easiest setup + support for both subscription and
pay-as-you-go billing.

## Architecture

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
row, let the client poll. It never runs the agent loop itself; that's the
wrong workload for an edge/serverless duration model and the wrong place for
a future browser process. Platform choice (Vercel vs. Cloudflare Workers) is
low-stakes and can be decided at implementation time.

**Queue: a `hosted_runs` table, not Redis/BullMQ.** Postgres is already the
system of record. A `status` column + `SELECT ... FOR UPDATE SKIP LOCKED` (or
an atomic conditional `UPDATE ... RETURNING`) is the right-sized choice at
solo-operator scale — a real queue engine is only worth the operational
overhead once poll latency or fan-out volume actually becomes a bottleneck.

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

The `mode` column is the toggle the operator asked for — first-class from
day one, not bolted on later. See "Review-only vs. auto-apply" below for how
the two modes are sequenced.

**Worker host: undecided — Fly.io vs. Upstash Box, pending a bake-off spike.**
Originally this plan picked Fly.io outright. A 2026-07-27 research pass
surfaced **Upstash Box** (`upstash.com/docs/box`, developer preview since
2026-03-09) as a real second candidate worth testing rather than assuming —
it directly targets the same "give a worker persistent compute + a real
browser" problem this section exists to solve. Both candidates are
documented here; neither is chosen until the spike below produces a result.
Needs its own explicit operator go-ahead before any real account/billing
setup happens, same as the rest of this document.

**Fly.io** — justification specific to this project's needs, not a generic
pick:
- Needs a long-lived process (poll loop now, persistent Playwright browser
  sessions once auto-apply mode is implemented) — rules out pure serverless.
- Docker-image deploys fit a Node+Python hybrid worker cleanly in one image
  (Node for `@aplyx/core` + the Claude Agent SDK, Python for
  `src/scripts/state/*.py` subprocess calls).
- Scale-to-zero keeps early cost near $0 with no paying users yet, while
  supporting an always-on machine once there's real traffic.
- Fly's per-region machine model is a better fit than a centralized platform
  for the eventual auto-apply phase's IP-diversity/anti-bot needs.
- Known cost: no real free tier as of 2026 — a small always-on machine is
  ~$2-10/month, fixed, regardless of signups (see "Concrete tiers" below).

**Upstash Box** — real Linux containers (not restricted serverless),
`node`/`python` runtimes (plus `golang`/`ruby`/`rust`, each in Debian or
`-alpine` variants), durable block storage, and — directly relevant here —
Upstash's own docs describe *exactly* this project's Playwright pattern:
pre-install Chromium into a box, snapshot it, then spin up warm boxes from
that snapshot instead of reinstalling per run
(`upstash.com/docs/box/guides/web-scraping-playwright`). The agent-harness
feature (`Agent.ClaudeCode`, etc.) is optional — a box works as plain
sandboxed compute (`box.exec.command()`, no agent configured), so adopting
Box would **not** require reversing this plan's "narrow forced-tool-use
calls, not a broad-tool-access agent loop" reliability stance (see
"Reliability" below).

Real open concerns, not yet resolved by Upstash's own documentation:
- **Isolation is container-level** (own filesystem/process tree/network
  stack per box), not a microVM boundary like Firecracker/gVisor — no
  audit/SOC2/pen-test claim exists for Box specifically. Matters more here
  than for a single local user, since a hosted worker runs on behalf of
  multiple paying tenants.
- **Preview status**: launched 2026-03-09, still "APIs and pricing may
  change" ~4.5 months in, no SLA/uptime commitment, no stated GA date.
- **Six open, unresolved GitHub issues** on `upstash/box` as of the
  research pass, including `exec.command`/`exec.stream` returning a false
  HTTP 500 after ~5 minutes even when the command succeeds server-side
  (#160) — directly relevant to any long-running scrape/apply automation —
  and idle-timeout-before-freeze behavior not matching documented numbers
  (#161).
- **Pricing shape is per-tenant, not shared-pool.** A persistent, logged-in
  auto-apply browser session needs Box's fixed-rate "keep-alive" tier
  ($8/mo Small / $16/mo Medium / $32/mo Large *per box*), and Upstash's own
  "Agent Servers" use case recommends one box per end user — cost scales
  linearly per paying tenant, unlike a Fly.io fleet that can bin-pack
  several tenants' sessions onto fewer shared machines.
- **Undocumented**: whether egress IPs are static/shared/rotating (matters
  for ATS anti-bot fingerprinting), real cold-start latency, headless
  Chromium's RAM/CPU footprint inside a box, and whether a `node` runtime
  box reliably supports installing Python alongside it (implied by their
  own Playwright guide's `apt-get` usage, never explicitly documented).

### Bake-off spike (before either candidate is chosen)

Scope, per the operator's direction: a **narrow worker-layer spike only** —
not the full hosted stack (no Stripe, no `hosted_runs`/`subscriptions`
migrations, no front door). Build the same minimal representative worker
twice, once per platform, and measure the open concerns above directly
instead of guessing from docs:

1. A persistent process that (a) execs a Python subprocess the way
   `src/core/src/helpers.ts` already shells out to `src/scripts/`, (b)
   installs and launches Playwright/headless Chromium, and (c) holds one
   browser session open across several sequential actions (simulating a
   logged-in multi-step apply flow — the one pattern neither platform's own
   docs directly address).
2. Metrics to record identically on both: cold-start/wake latency, memory
   footprint of Node + Python + Chromium together, whether Node+Python
   coexist in one deploy unit without friction, egress IP behavior across
   repeated requests (via a public IP-echo check), and actual metered cost
   for a realistic test run.
3. Decision criteria: whichever platform clears the persistent-session and
   Node+Python requirements with acceptable latency/cost wins the worker-host
   slot in this plan; a tie or both-fail result is itself a valid outcome
   worth recording rather than forcing a pick.

**Status: Upstash Box side complete, hands-on (2026-07-27)** — see
`docs/online-hosting.md` for the full research + spike writeup
(persistent-session, Node+Python, Playwright install gotcha, real
Greenhouse-board testing, usability score, and a third "box-per-customer"
architecture option not yet decided on). **Fly.io side not started** — no
account was set up this pass (operator chose to test Upstash only).

**Supabase: reuse the existing auth/profile project**, not the `job_cache`
project (already I/O-constrained under its own hourly refresh load — same
failure mode this would risk repeating) and not a new third project (free
tier caps at 2 projects; both slots are already spoken for). `hosted_runs`
and `subscriptions` are low-volume, on-demand-per-user tables, a different
shape from `job_cache`'s ~14k-row hourly bulk refresh, so this is a
reasonable initial fit. If/when write volume from paying users makes this
project's I/O a real constraint the way `job_cache` did, the mitigation is
upgrading that project to Supabase Pro (removes the 2-project cap too) —
justified once the feature is generating revenue, called out here so it
isn't a surprise later.

## Reusing `src/core` and the Python helpers — not forking

The worker is a new workspace, `packages/worker` (consistent with the
existing `workspaces: ["packages/*", "app", "desktop"]` glob in root
`package.json`). It:

1. **Imports `@aplyx/core` directly** — same seam `src/tui/` and
   `src/tauri/src-tauri`'s bridge already use. Reuses `SupabaseAdapter`
   (`src/core/src/adapters/supabase.ts`) with a **service-role**
   client instead of the anon-key client the desktop webview uses, since the
   worker acts on a user's behalf rather than as that user's own session.
   `SupabaseAdapter.loadState()` currently returns `undefined` (comment:
   "Hosted pipeline-state sync ... is Phase 14B scope") — this plan is what
   actually builds that sync, via the translation step below rather than by
   changing the adapter's contract.

2. **Subprocess-execs the Python helpers, never ports them to TypeScript** —
   directly required by `CLAUDE.md`'s "Do not port helper logic into
   TypeScript without an explicitly approved decision" and AGENTS.md's "all
   state writes go through the helpers." Follows the existing
   `src/core/src/helpers.ts` pattern (`runValidator`,
   `convertResumePdf` already shell out to Python) —
   `child_process.execFile("python3", ["src/scripts/state/job_state.py", ...])`
   against a **per-run, ephemeral scratch directory**
   (`/tmp/hosted-runs/<run_id>/data/...`), not the shared repo checkout a
   local install uses. The Python helpers stay completely unmodified — they
   don't need to know hosted mode exists — and the worker owns the
   mechanical translation from that scratch dir's JSON/JSONL back into
   Supabase rows (`jobs`/`job_events`/`review_queue`), matching the shape
   `supabase/migrations/0001_init.sql`'s own comments already describe as a
   mirror of the local JSON files. The worker's Docker image needs a copy of
   `src/scripts/` baked in alongside `src/core/dist` — new deployment
   surface, `src/scripts/` has never run anywhere but a user's own machine or
   the GitHub Actions cron before.

3. **Minimal hosted model-tier registry (a real prerequisite, not a
   nice-to-have).** Phase 12's full tier registry isn't built; today model
   IDs are hardcoded per-agent (`opencode-go/...`, `openai/gpt-5.4`) — none
   of which the hosted worker can use, since it calls Anthropic directly
   with aplyx's own key. Add a small `src/config/models.hosted.json` (or a
   `hosted` block once Phase 12 lands) mapping `{"flash": ..., "mid": ...,
   "premium": ...}` to concrete Anthropic model IDs — **the exact IDs need a
   live lookup at build time, never guessed from memory, and explicit
   operator sign-off per the "no new model name without approval" rule**,
   same discipline Phase 12 already requires locally. This stays narrower
   than full Phase 12 (Anthropic-only, no multi-provider opencode-go
   catalog) — full Phase 12 remains separate, later, local-mode work.

## Review-only vs. auto-apply — the toggle

Both modes are part of this plan's architecture (the `mode` column exists
from day one), but they are **built and shipped in sequence**, not
simultaneously, because they carry very different risk:

**Ships first — `review_only`.** Server-side scrape (API-fed boards only:
Ashby/Lever/Greenhouse/SmartRecruiters/Amazon/Oracle — the same set
`job-scraper.md` already routes to when browser tools aren't available) →
canonicalize/dedupe/fit-gate via the unmodified Python helpers → tailor
(resume bullets + cover letter) via narrow, forced-tool-use Anthropic calls
→ results land in `review_queue`/`jobs`/`job_events`, surfaced in a hosted
dashboard. No apply action of any kind runs server-side; the user applies
manually. This isn't a new behavior invented for hosted mode — it's the
existing "no browser tools" fallback path in `job-scraper.md` becoming the
default path for hosted runs, which is a strong signal it's the right seam
to build against first and validate the rest of the pipeline (billing,
queue, worker, reliability pattern) before adding the highest-risk piece.

**Ships second — `auto_apply`.** Reuses the existing local Playwright
apply-flow logic (`ats.ts` selector logic, currently local/single-user/
single-IP) ported to run from the worker, gated by an explicit per-user
opt-in with its own consent screen (Phase 17's own requirement — "load-
bearing, not polish"). This is a substantially larger lift: persistent
browser sessions on the worker host, proxy/anti-bot handling, per-tenant ATS
selector reliability at multi-tenant scale, and real liability for applying
on someone's behalf from operator-run infrastructure. Because of that gap in
risk and effort, `auto_apply` should get its own dedicated design pass and
explicit go-ahead once `review_only` is live and validated — the schema and
toggle exist now so that isn't a redesign later, but flipping it on for real
users is a separate approval, consistent with this project's one-thing-at-
a-time phase discipline.

**That dedicated design pass is now written: see
[`docs/hosted-auto-apply-plan.md`](./hosted-auto-apply-plan.md)
(2026-08-10).** It resolves the narrow-forced-tool-use-vs-broad-browser-loop
tension this section only flags, incorporates the completed Box spike's
CAPTCHA finding (real Greenhouse postings universally carry it — a hard
constraint, not an edge case), and proposes a staged confirm-before-submit
rollout. Still not started, still needs its own operator go-ahead layered
on top of `review_only`'s.

**Cheaper on-ramp before either mode ships (2026-08-10).** Re-reading the
local code with the question "does this actually need a coding agent"
found two pieces that don't: job search over the shared cache
(`jobCache.ts` is a plain anon-key `fetch()`, no Python) and the browser
extension's hybrid autofill (`extension_bridge.py`'s three endpoints are
confirmed deterministic, stdlib-only Python — no LLM call anywhere). Both
are gated behind "local install" today as an implementation artifact, not
a real requirement.
[`docs/hosted-no-agent-tiers-plan.md`](./hosted-no-agent-tiers-plan.md)
proposes shipping both as much cheaper, lower-risk tiers before this
plan's worker or `auto_apply` — no LLM spend, no persistent browser, no
CAPTCHA exposure, no Stripe/queue infra. Also planned, not started, needs
its own operator go-ahead.

## Billing

**Processor: Stripe.** Against the operator's stated criteria (lowest fees,
easy setup, subscription + pay-as-you-go both): Stripe's standard fee
(2.9% + $0.30, US card payments) is at or below every mainstream
easy-setup alternative (Paddle/LemonSqueezy both run higher, typically 5%+,
because they act as Merchant of Record and absorb global tax
remittance for you). Stripe Billing natively supports both flat
subscriptions and metered/usage-based prices, so "subscription or
pay-as-you-go" is one product, not two integrations. The real tradeoff:
Stripe is not a Merchant of Record, so the operator — not Stripe — is
responsible for their own sales-tax/VAT handling; Stripe Tax is a low-effort
add-on for that once it matters, not a blocker for getting started.

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

`POST /api/v1/runs` gates on `subscriptions.status = 'active'` before it will
insert a `hosted_runs` row (402 if not). The Stripe webhook handler
(`POST /api/v1/stripe/webhook`) verifies the signature and upserts this table
on `checkout.session.completed` / `customer.subscription.updated` /
`customer.subscription.deleted`, using the service-role key — never the
anon key, same custody discipline as `SUPABASE_SECRET_KEY` today.

**Usage metering.** Every Anthropic response carries
`usage.input_tokens`/`output_tokens`. The worker accumulates per-run totals
into `hosted_runs.result` (no new table needed yet) and logs
`{step, tier, model_id, input_tokens, output_tokens}` per call — cheap now,
and what makes a future pay-as-you-go price or a free/paid cost split
possible later without re-instrumenting. Actual quota *enforcement* (vs.
just measuring) is explicitly follow-on work, not v1.

## Concrete tiers + quota capacity analysis (2026-07-27)

The marketing site's pricing page (`site/pricing.html`) now shows concrete
numbers — Free / Pro $13 / Business $33, differentiated mainly by a daily
auto-apply quota (3 / 10 / 25 per day) rather than by which features are
gated at all. Checked this against the actual free-tier limits of the
infra this plan already picked, rather than choosing numbers first and
hoping:

- **Storage (Supabase, 500MB DB / 5GB egress free) is not the real
  constraint.** Each application's full footprint — job record, JD text,
  tailored-resume snippet, event log — is generously ~10KB. Even a fully
  generous free tier (3/day × a few hundred free users, retained forever
  with no cleanup) stays in the tens-of-MB range for months — nowhere
  near the 500MB cap. Storage only becomes a real concern at a much
  larger free-tier user count with no retention policy at all, which is
  a data-lifecycle problem worth a future note, not a launch blocker.
- **Fly.io no longer has a real free tier as of 2026** — confirmed live:
  new accounts get a 2-hour/7-day trial only; a real always-on worker is
  a small (~$2-10/month for a single shared-cpu-1x machine) but *real*
  fixed cost from day one, not the "$0 with no users" this plan
  originally assumed. Doesn't change the architecture, just the framing:
  the operator carries a small fixed infra cost regardless of free-tier
  signups, which is fine at solo-operator scale but isn't literally free
  anymore.
- **The actual bottlenecks are Anthropic API cost and Playwright
  browser-automation concurrency, not storage.** Every auto-apply needs
  a real Chromium session (~300-500MB RAM alone) plus a tailoring API
  call — a minimal single worker machine can realistically run only a
  handful of concurrent browser sessions, and free-tier usage generates
  real per-call API cost with zero revenue behind it. This is the
  argument for the daily-quota shape itself (a hard per-user cap, not
  "unlimited until we notice"), and for treating `hosted_runs` as a real
  queue whose *drain rate* is bounded by worker capacity — quotas cap
  demand per user; worker fleet size (funded by paid-tier revenue) is
  what determines how fast the queue actually processes. Start with one
  worker handling everything sequentially; add machines as paid
  conversions fund them, not ahead of it.
- **Conclusion: 3 / 10 / 25 per day are reasonable starting caps**, sized
  well within what a single small worker can plausibly sustain during
  early access, not because storage allows it (it allows far more) but
  because compute concurrency and API cost don't. Treat these as a
  starting allocation to re-measure against real usage once any of this
  is actually live — not a permanent commitment, same as the pricing
  page's own "illustrative, not final" framing already says.
- **Auto-apply still isn't built.** These quotas describe the *planned*
  free/paid split for a capability (`auto_apply`) that this same document
  already scoped as "ships second," after `review_only` — the marketing
  copy describes the intended future state, consistent with the pricing
  page's existing disclaimer, not a claim that it's live today.

Sources checked live rather than assumed from memory: [Supabase pricing/free-tier limits, 2026](https://uibakery.io/blog/supabase-pricing); [Fly.io's free trial replacing its old free tier, 2026](https://fly.io/docs/about/pricing/).

## Reliability — carrying the pattern forward, not just the transport

This is where the operator's actual concern lives (an API call alone
doesn't fix hallucination risk). The hosted pipeline generalizes the
pattern already proven in `generate_interest_letter.py`, not just its
transport:

1. **Forced structured tool-use output per step.** Every model call that
   produces something destined for state uses `tool_choice: {"type": "tool",
   "name": "..."}` with a strict `input_schema` — exactly
   `_SUBMIT_LETTER_TOOL`'s shape, generalized to each pipeline step
   (tailoring, ambiguous fit-gate calls). This is the actual reliability
   mechanism, not the direct-API-call by itself.
2. **Deterministic validation before any state write, every time.** Reuses
   `job_state.py`'s existing canonicalize/fit-gate schema checks unchanged;
   tailored-content output gets the same grounding-flag checks
   `generate_interest_letter.py` already does (company-name mismatch,
   word-count self-report vs. actual, `grounding_confidence`) before a
   `review_queue` row is written. Flagged output still lands in review
   (never silently dropped) but visibly marked for extra scrutiny.
3. **Narrow per-step tool surfaces, not one giant do-everything agent.**
   `job-scraper.md`'s current 80-max-turn orchestrator with broad tool
   access is the right shape for a trusted, single-user local run — wrong
   for a multi-tenant server. The worker decomposes the pipeline into
   discrete, narrowly-scoped calls: a tailoring step gets no tool access
   beyond its one `submit_*` tool, matching
   `generate_interest_letter.py` exactly. Smaller blast radius, easier to
   validate, no single step gets broad execution rights against
   multi-tenant infrastructure.
4. **Human-in-the-loop gate before anything touches an ATS** — already the
   default by construction in `review_only` mode; carried forward as a
   standing principle (explicit opt-in, own consent language) once
   `auto_apply` ships.

## Security / PII

- **Secret custody.** `ANTHROPIC_API_KEY` and the Supabase service-role key
  live only as Fly.io app secrets (`fly secrets set`) — never in the front
  door's client-reachable environment, never in a shipped bundle. Same
  discipline as `SUPABASE_SECRET_KEY`/`UPSTASH_REDIS_WRITE_TOKEN` today; the
  service-role key on a worker is new secret-custody surface for this repo
  (previously only a GitHub Actions runner held anything equivalent).
- **`safe_fields`/resume encryption at rest.** Phase 17 already requires
  this and it isn't designed yet. Supabase's infra provides disk-level
  encryption by default — confirm explicitly whether that satisfies the bar
  or whether field-level `pgcrypto` encryption is wanted on top; the private
  `resumes` bucket (already RLS-scoped) needs the same confirmation.
- **Consent screen.** Explicit, plain-language, at hosted-onboarding time —
  what's stored, why, that it's server-side now (a real reversal of Phase
  11's local-only-PII default), and a link to deletion. Gates onboarding
  completion, not a buried settings checkbox.
- **Deletion path.** One deterministic, testable function: `auth.users`
  cascade already covers table rows (`on delete cascade` wired on every
  `user_id` FK per `0001_init.sql`); storage bucket objects need an explicit
  delete step (cascade doesn't reach Storage); the Stripe customer/
  subscription needs an explicit Stripe API call (lives outside Supabase
  entirely); worker scratch directories are already ephemeral. Verify on a
  real account, not just typechecked — matches Phase 17's existing bar.

## Explicitly out of scope for this pass

- Auto-apply's actual execution (schema/toggle included now; execution
  ships second, separately gated — see above).
- Phase 12's full multi-provider tier registry (only the narrow
  Anthropic-only hosted subset is in scope here).
- Multi-plan/tiered pricing beyond the `subscriptions.plan` column existing.
- Hard quota enforcement (v1 measures usage; enforcing a cap is separate).
- Anthropic's Managed Agents beta as a replacement for the worker — worth a
  future re-evaluation once it's more mature, not a v1 bet.

## Critical files

- `src/core/src/adapter.ts`, `adapters/supabase.ts` — the `Adapter`
  interface and hosted adapter to extend (service-role variant, real
  `loadState()`), not fork
- `supabase/migrations/0001_init.sql` — existing RLS-scoped schema pattern;
  extend with `hosted_runs` and `subscriptions`
- `src/scripts/runtime/generate_interest_letter.py` — the forced-tool-use +
  grounding-confidence pattern every pipeline step generalizes
- `src/scripts/state/job_state.py` — subprocess-exec target, per-run scratch
  dir, never ported to TypeScript
- `src/agents/bodies/job-scraper.md` — existing pipeline logic and the "no
  browser tools" fallback path the worker's `review_only` mode mirrors
- `.github/workflows/refresh-job-cache.yml` — existing secret-custody
  precedent to mirror on Fly.io
- `docs/PLAN.md` (Phase 12 §1393-1493, Phase 17 §2130-2410) — the roadmap
  constraints this plan is scoped against (tier registry dependency,
  review-first default, PII-boundary reversal, "don't fork business logic")

## Verification (once implementation starts)

- `hosted_runs`/`subscriptions` migrations apply cleanly against the
  existing auth/profile Supabase project; RLS re-verified with two real
  accounts (mirrors Phase 11's own still-open verification item).
- A real Stripe test-mode subscription drives `POST /api/v1/runs` from 402
  (inactive) to accepted (active) via the webhook path, end to end.
- One full `review_only` run, against a real test account, produces
  tailored review-queue entries visible in the hosted dashboard, with every
  tailored item passing through the grounding-flag checks before being
  written — spot-check a deliberately mismatched job/resume pair to confirm
  a flagged, not silently-dropped, result.
- Deletion path removes auth row, table rows, storage objects, and the
  Stripe subscription for one real test account — verified by direct
  inspection after, not just a 200 response.
- Local-only mode (no account, no network) continues to pass unchanged —
  hosted is additive per Phase 17's own constraint.

## Open questions for the operator, still unresolved

- Hosting budget — approved monthly infra spend (Fly.io + Anthropic API
  usage) before build starts?
- Timeline/urgency relative to the Phase 16B ATS-expansion and pre-beta
  positioning-review gates already called out in Phase 17.
- Pricing itself — flat monthly vs. usage-based, and the actual number.
  This document deliberately doesn't guess one.
- Worker-host bake-off (Fly.io vs. Upstash Box) — Upstash side tested
  hands-on, see `docs/online-hosting.md`; Fly.io side still not started.
  Whether to formalize the "box-per-customer, Supabase-as-system-of-record"
  hybrid option from that doc into this plan is still an open operator
  decision.
