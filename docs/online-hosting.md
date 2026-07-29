# Online hosting research: Upstash Box vs. Fly.io

> Consolidates the 2026-07-27 research + hands-on spike into Upstash Box as
> an alternative worker host for the (still unapproved, planned-not-started)
> hosted paid tier. See `docs/hosted-paid-tier-plan.md` for the tier's
> overall architecture — this doc is the detailed evidence behind its
> "Worker host: undecided" section, not a replacement for it.

## Verdict, up front

Upstash Box **technically works** for both `review_only` and `auto_apply` —
confirmed hands-on, not just from docs. It is **not a clean win over
Fly.io**: it trades Fly's deploy/ops overhead for weaker per-tenant
isolation (one account-level API key with blast radius across every
customer's box, no scoped/per-box key found anywhere), an unconfirmed
backup/encryption story for its durable storage, and per-customer cost that
scales linearly (keep-alive pricing) rather than bin-packing across a
shared fleet. Usability of the SDK/docs themselves: **65/100** (see
breakdown below). Real ATS targets (tested live, read-only) universally ship
reCAPTCHA, which is a hard blocker for full automation on *either* platform
— that risk is orthogonal to the hosting decision.

---

## Part 1 — Desk research (docs, GitHub, pricing, community)

### Isolation model
Each box is a plain Docker container — own filesystem/process tree/network
stack, **not a microVM** (no Firecracker/gVisor, unlike competitors E2B and
Vercel Sandbox per Upstash's own comparison post). No SOC2/audit/pen-test
claim exists for Box specifically. Cloud-metadata and private-IP SSRF are
blocked by default. [Box Basics](https://upstash.com/docs/box/overall/how-it-works), [Security & Secrets](https://upstash.com/docs/box/overall/security), [Sandbox Providers Comparison](https://upstash.com/blog/best-sandbox-providers-for-ai-agents)

### Runtimes
Ten values: `node/python/golang/ruby/rust` × `{plain, -alpine}`. Custom
runtime/Dockerfile support is roadmap-only, not live. [types.ts](https://github.com/upstash/box/blob/main/packages/sdk/src/types.ts), [Launch post](https://upstash.com/blog/upstash-box)

### Networking / egress
Per-box policy: `allow-all` (default) / `deny-all` / `custom` allowlist by
domain/wildcard/CIDR; private IPs always blocked. **Undocumented**: whether
egress IPs are static, shared, or rotating — relevant to ATS anti-bot
fingerprinting. Inbound only via Public URLs (`{box}-{port}.preview.box.upstash.com`)
or SSH tunnel — no generic webhook-in mechanism. **Open bug #167**: Public
URLs silently inject a Basic-auth header even with no auth configured,
breaking Bearer-token flows. [Network Policy](https://upstash.com/docs/box/overall/network-policy), [Public URLs](https://upstash.com/docs/box/overall/preview)

### Persistence / snapshots
Durable block storage, 5/10/20 GB by size tier, $0.10/GB/mo. Snapshot a box
and restore via `Box.fromSnapshot()` — **this is Upstash's own documented
production pattern for pre-baking Chromium**, and we verified it works.
Idle-timeout-before-freeze: 1hr (free) / 6hr (PayG) — **open bug #161**
reports boxes not auto-pausing per the documented number. **Open bug #160**:
`exec.command`/`exec.stream`/`exec.code` return a **false HTTP 500 after
~5 minutes** even when the command succeeds server-side — directly
relevant to any long-running automation. [Snapshots](https://upstash.com/docs/box/overall/snapshots), [Pricing & Limits](https://upstash.com/docs/box/overall/pricing)

### Concurrency & pricing (Pay-as-you-Go)

| Size | vCPU/RAM/Disk | Active-CPU rate | Keep-alive (always-on) |
|---|---|---|---|
| Small | 2/4GB/5GB | $0.10/hr | $8/mo |
| Medium | 4/8GB/10GB | $0.20/hr | $16/mo |
| Large | 8/16GB/20GB | $0.40/hr | $32/mo |

1,000 concurrent boxes (soft cap, raisable) on PayG — a total non-issue at
5-customer scale. No egress charge documented. [Box Pricing](https://upstash.com/pricing/box)

**The arithmetic that matters for auto-apply**: a logged-in browser session
needs keep-alive pricing (frozen boxes lose the live Chromium process), and
Upstash's own "Agent Servers" use case recommends one box per end user —
cost scales **linearly per paying tenant** ($8-32/mo/user), unlike a Fly.io
fleet that can bin-pack multiple tenants' sessions onto shared machines.

### Agent harness — optional, not required
`EphemeralBox` and plain `box.exec.command()` work with **zero agent
configured**. Built-in harnesses (Claude Code, Codex, OpenCode, Cursor) are
opt-in. This matters because it means Box doesn't *force* a reversal of this
project's "narrow forced-tool-use calls, not a broad agent loop"
reliability stance — but using the harness feature anyway (see Part 3) would
be a choice, not a platform requirement. [Shell](https://upstash.com/docs/box/overall/shell)

### Secrets
Env vars (visible to any code running in the box — risky for untrusted
code) or "Attach Headers" (host-level TLS-intercepting proxy injects
secrets into outbound HTTPS without them ever entering the container). No
vault/secrets-API primitive; **open issue #120** shows a real user asking
for one. [Attach Headers](https://upstash.com/docs/box/overall/attach-headers)

### Preview status
Launched 2026-03-09 — ~4.5 months in "developer preview" as of this
research, no SLA, no GA date. Six open, unresolved GitHub issues found
(#101, #120, #154, #160, #161, #167), mostly from one deeply-engaged
external user — real signal, not broad community consensus; no independent
HN/Reddit discussion found at all.

### Company context
Founded 2022, $11.9M raised (Series A led by a16z, Feb 2024), ~85k
developers, $1M ARR milestone reported. Core platform (Redis/QStash/Vector)
shows 99.82% uptime over a trailing 30 days per third-party trackers — but
that history is about the *core* platform, not Box, which is too new to
have its own track record. [Story of Upstash](https://upstash.com/blog/story-of-upstash), [StatusGator](https://statusgator.com/services/upstash)

---

## Part 2 — Hands-on spike (2026-07-27, real account, real boxes)

Setup: `@upstash/box` Node SDK, `EphemeralBox` (auto-TTL, no agent/git
fields — matches the "No Agent" / "skip GitHub connect" decisions made
during console setup). All test boxes deleted after each run; a final
inspection box (`trusty-kingfish-20900`) was left running at the operator's
request to observe live.

| Question | Result |
|---|---|
| Node+Python coexistence | **Native, zero setup** — Python 3.11.2 ships preinstalled in the `node` runtime image; no `apt-get` needed |
| Execution identity | Runs as non-root `boxuser` (uid 1002) — **not root**, contradicting the implicit assumption in Upstash's own Playwright guide. Passwordless `sudo` is available. |
| Playwright/Chromium install | Upstash's own documented `sudo npx playwright install --with-deps` **is broken in practice** — the browser installs into root's cache, invisible to the boxuser process that runs it. **Fix**: split into `sudo npx playwright install-deps chromium` (root, system libs) + plain `npx playwright install chromium` (boxuser, browser binary) — ~12s total. |
| Browser launch | Works cleanly as boxuser after the fix — ~515-820ms full launch+navigate+read |
| **Persistent logged-in session across separate calls** | **Confirmed** — a background browser-driving HTTP server inside the box held a cookie set in one call, still present 2 calls later, across 7 fully independent `exec.command` round-trips (145-460ms each) |
| Egress IP | Stable across repeated checks within one box's lifetime (didn't rotate mid-session); rotation across different boxes/restarts untested |
| Snapshot-restore | Verified for real: baking took ~40s (one-time), restoring + launching Chromium immediately took under 1.3s combined — no reinstall needed |
| Cost telemetry | Every `exec.command` returns `run.cost.computeMs`; `totalUsd` read 0 at this usage level |
| Box lifecycle bugs hit directly | `EphemeralBox.delete()` (both static and instance form) reported success while `list()` still showed the box seconds later — silent staleness, no error. `files.download()` didn't work as documented; had to fall back to manual base64 read/write. `EphemeralBox.get()` doesn't exist (undocumented) — had to discover `getByName()` by introspecting the SDK's own exports. |

### Mock auto-apply run (safe target, no real company/posting)
Built a self-hosted mock ATS form (Greenhouse-like: name/email/phone fields,
resume file upload, cover-letter textarea, submit) and drove a full
multi-step apply flow — navigate, fill 4 fields, upload a fake resume file,
fill cover letter, click submit, read confirmation — as 9 separate discrete
calls per job, on one persistent browser session, for **two sequential
jobs back-to-back**. Server-side records matched exactly what was
submitted (filename, size, cover-letter length, confirmation code). This
confirms the core `auto_apply` infrastructure requirement works.

### Real Greenhouse board test (read-only, nothing submitted)
Tested against two real, live company career pages to see actual real-world
friction — navigation only, no form fields ever filled, no submit ever
clicked:

- **Samsara** (`boards.greenhouse.io/samsara`, redirects to
  `samsara.com/company/careers`): real page rendered correctly. Found an
  **invisible reCAPTCHA v2**, an **intellimizeio.com** A/B-testing embed,
  and a **cookie-consent banner that blocks the application form from
  rendering** until dismissed (attempt to auto-dismiss it failed — selector
  timeout). Most notably: the posting's own footer text **explicitly
  discloses Samsara uses "Tofu," a fraud-detection tool, to validate
  applicant authenticity** — direct, documented evidence this employer
  actively screens for automated-application patterns.
- **Fundraise Up** (`boards.greenhouse.io/fundraiseup`, redirects to
  `fundraiseup.com/careers`): meaningfully simpler — no blocking
  cookie-consent gate. Found the **actual real Greenhouse embed form**
  (`job-boards.greenhouse.io/embed/job_app`) with its genuine field
  structure: `first_name`, `last_name`, `preferred_name`, `email`,
  `country`, `phone` (intl-phone-input widget), `resume` (file),
  `cover_letter` (file), ~7 custom screening questions
  (`question_88029XXXXX`), a submit button — and still a
  **`g-recaptcha-response` field (reCAPTCHA Enterprise)**.

**Pattern across both**: reCAPTCHA showed up on every real Greenhouse
posting tested. That's a consistent, real signal — solving it
programmatically crosses into CAPTCHA-bypass territory, a hard blocker for
full automation regardless of which platform hosts the worker.

### Usability score: 65/100

What earns points: the SDK is well-designed (typed, small surface —
`exec`/`files`/`snapshot`/`git`/`cd`), fast box creation (~700ms), and the
documented snapshot-restore pattern works exactly as advertised.

What costs points, all hit directly in this session:
- API key discovery was confusing — the obvious "Personal Settings >
  Developer API" console page is the **wrong key entirely** (that one's
  for Redis/Vector/QStash), no in-console pointer to Box's actual key.
- Upstash's **own documented Playwright recipe is broken** (see table
  above) — no error explaining why, just a dead end.
- `EphemeralBox.get()` doesn't exist and isn't documented anywhere.
- Delete semantics are unclear (silent staleness, no error).
- `files.download()` didn't behave as documented.
- Restarting a background process required manual port-killing
  (`fuser -k`) — no clean redeploy primitive.

None were fatal — everything was worked around within one session — but a
developer following the docs literally hits real, undocumented gaps within
the first hour, consistent with ~4.5 months into preview rather than a
fundamental maturity failure.

---

## Part 3 — Architecture discussion: "one box per customer"

A proposal came up mid-session: since Box's concurrency limit is a
non-issue at small scale, why not have a persistent agent create one Box
per paying customer, store their info/resume on that box, run their chosen
coding-agent harness (Claude Code/OpenCode) inside it, and skip most of the
Fly.io + Supabase-queue machinery? Evaluated on three axes:

**API key blast radius.** One `UPSTASH_BOX_API_KEY` is an account-level
control-plane credential — it can create/read/exec/delete *any* box on the
account. There is no per-box or per-tenant scoped key documented anywhere.
Compromise of that one key means compromise of every customer's box and
whatever they store on it. This is structurally weaker than the
Supabase-RLS model the existing hosted-tier plan already commits to, where
a compromised client credential can't reach other users' rows.

**PII storage.** Storing resumes/customer info as each box's *primary*
copy is a step down from Supabase Postgres+Storage: Box's durable storage
has no documented backup/DR story and no stated encryption-at-rest
guarantee, on top of the container-level (not microVM) isolation already
noted. **Recommendation**: keep Supabase as the actual system of record;
treat each box as ephemeral compute only, same pattern the plan already
specifies for Fly.io ("per-run scratch dir, not the shared repo checkout").
A box crashing or being recreated shouldn't be a data-loss event.

**Reliability model.** Letting the customer's chosen agent run with the
full Box agent-harness feature (`Agent.ClaudeCode`/`Agent.OpenCode`) is a
reversal, not a simplification — the hosted-tier plan's "Reliability"
section deliberately avoids a broad-tool-access agent loop on multi-tenant
infra in favor of narrow, forced-tool-use steps. Using the harness feature
gives that property up, and stacks a second LLM-usage budget (Box's own,
capped $1-100/mo) on top of whatever's already metered through Stripe.

**Hassle vs. Fly.io.** At ~5 customers, box-per-user is genuinely *less*
deploy/ops work up front — no Docker image, no CI/CD, no `fly.toml`, just
SDK calls. But cost doesn't stay simple: persistent per-user boxes need
keep-alive pricing (idle-freeze kills a logged-in session), so 5 customers
is already **$40-160/mo in box compute alone** before any LLM spend —
versus Fly's shared-machine model where cost doesn't scale one-to-one per
customer.

**Net recommendation**: use Box as the per-customer compute layer (real
win on deploy simplicity at this scale) — but keep Supabase as the PII
system of record, and keep driving each box with narrow forced-tool-use
scripts rather than the full agent-harness feature. That captures the
deployment simplicity without giving up the two things the original plan
was already careful about (data custody, blast-radius control). This is a
third option, not yet written into `docs/hosted-paid-tier-plan.md`'s
worker-host section — pending operator decision on whether to formalize it
there.

## Status

Spike box `trusty-kingfish-20900` was left running (operator request) to
observe live operations; TTL 7200s from creation, will auto-expire if not
extended or deleted. Fly.io side of the original bake-off plan (see
`docs/hosted-paid-tier-plan.md`) has not been started — no Fly.io account
was set up this session (operator chose to test Upstash only, "skip Fly for
now").
