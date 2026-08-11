# Hosted apply-assist for users without a coding agent — cheaper tiers before `auto_apply`

> **Status: planned, not started.** A design document, not a phase in
> progress. It sits alongside `docs/hosted-paid-tier-plan.md` and
> `docs/hosted-auto-apply-plan.md` and proposes two cheaper, lower-risk
> tiers of value that can ship **before** either of those — needs its own
> explicit operator go-ahead before any part of it starts, per this
> project's one-phase-at-a-time rule.

## The actual gap today

A hosted-only user (signed in, no local install, no coding agent) can now
— as of the read/write sync work landed 2026-08-10 — see their dashboard,
review queue, and status, and can mark items applied or dismiss them. What
they still cannot do is **find a new job or get any help applying to
one**. `JobsScreen` (live search + save) and Playwright-driven apply are
both local-only. The only path to give this user real "auto apply" value
so far on the roadmap is `docs/hosted-auto-apply-plan.md` — a full
server-side worker with persistent browser sessions, Anthropic API billing,
a queue, Stripe, and (per that plan's own findings) a real CAPTCHA wall on
most real postings. That's the right eventual capability, but it's also
the most expensive and highest-liability thing on the roadmap, and
`review_only` (its own prerequisite) hasn't even shipped.

Re-reading the existing local code with the specific question "does this
actually need a coding agent" turned up two pieces that don't, currently
gated behind "local install" for reasons that turn out to be
implementation artifacts, not real requirements:

1. **Job search over the shared cache doesn't need Python, an LLM, or a
   local install at all.** `readJobCache()` (`src/core/src/jobCache.ts`) is
   a plain `fetch()` call to a Supabase RPC (`job_cache_search`), using the
   anon key — the same shape a browser can make directly. It only takes
   `root` today to read two **local files that are either committed and
   public or hold a publishable (not secret) key**:
   `src/config/job_cache_targets.json` (the shared ~47-company list —
   committed, public, no PII) and `src/config/job_cache_supabase.json`
   (the job_cache project's URL + anon/publishable key). Both are static
   values, not per-user secrets.
2. **The browser extension's "hybrid" autofill doesn't call an LLM
   either.** `extension_bridge.py`'s three endpoints
   (`/fit`, `/fields`, `/outcome`) shell out to `job_state.py` and
   `evaluate_job_fit.py` — both explicitly deterministic, stdlib-only
   Python (confirmed: no `anthropic`/`openai` import anywhere in either
   file). The extension's own content script
   (`src/extension/src/content.ts`) never invents a value and never clicks
   submit — a human is always the one who reviews the filled form and
   submits it, in their own real, logged-in browser session. The only
   reason this needs a local install today is that the bridge listens on
   `127.0.0.1` and reads `safe_fields` from a local config file — and the
   extension's options page (`src/extension/src/options.ts`) currently
   **hard-refuses** to save a non-localhost bridge URL, a deliberate guard
   that would need a real (not just relaxed) hosted-mode redesign, not a
   one-line change.

Both of these facts matter because they're the two most expensive parts of
`hosted-auto-apply-plan.md` that this alternative sidesteps entirely: no
LLM token spend, no persistent server-side browser session, and — because
a human is always the one clicking submit, in their own real browser — a
far smaller CAPTCHA/anti-bot exposure than a headless server-side worker
has. This is the same "assisted, not autonomous" trust story
`docs/product-positioning-and-rebrand-plan.md` already stakes out, just
realized in the cheapest possible way first.

## Tier 0 — hosted job search over the shared cache

**What it gives a no-coding-agent user:** real job browsing (Ashby, Lever,
Greenhouse, SmartRecruiters — the four sources the shared cache covers)
from the desktop app or a future web dashboard, with zero new backend
compute.

**What it needs:**
- A baked-in fallback for the job_cache project's config, mirroring the
  **existing, already-shipped precedent** —
  `DEFAULT_SUPABASE_CONFIG` in `src/core/src/supabaseConfig.ts` already
  bakes the hosted-auth project's URL + anon key into the app so a missing
  local `src/config/supabase.json` still works. A `DEFAULT_JOB_CACHE_CONFIG`
  constant, same file, same pattern, closes this gap for the job_cache
  project — not a new mechanism, an application of one that already
  exists and already ships.
- The shared company list (`job_cache_targets.json`) bundled into the app
  build the same way (it's already committed and public) instead of read
  from a local checkout path.
- A thin `searchJobs`-equivalent path that calls `readJobCache` directly
  without requiring `root` — either by making `root` genuinely optional
  in the cache-read path (it's only used for the two config reads above)
  or by having the desktop webview call `readJobCache`'s logic directly
  (it's a pure `fetch()`, no `node:fs`/`child_process` needed once the two
  config values are baked in — it could plausibly run **client-side in
  the webview itself**, no Rust/IPC hop at all, which would make this the
  cheapest possible way to ship it).
- Explicitly **not included**: the Python-backed sources
  (Amazon/Oracle/Workday/The Muse) and any live (non-cached) fetch for the
  four cacheable sources — those still need a real Python-executing
  backend, which is squarely `hosted-auto-apply-plan.md`/
  `hosted-paid-tier-plan.md` territory, not this tier. A hosted-only
  user's search results would be narrower than a local install's (cache
  coverage only) until a later tier closes that gap — worth saying
  plainly in the UI, not hidden.

## Tier 1 — hosted hybrid autofill (the extension, without a coding agent)

**What it gives a no-coding-agent user:** the same experience a local
install's browser extension already gives — fit-check a posting, autofill
the form from their own profile fields, review and submit it themselves —
without installing anything but the extension and signing into their
aplyx account.

**Architecture — reuse, don't fork, same discipline as the worker plans:**
- `job_state.py`, `evaluate_job_fit.py`, `append_state_entry.py` run
  **unmodified**, subprocess-exec'd from a small, stateless, always-on-or-
  scale-to-zero service (this needs far less than the auto-apply worker —
  no persistent browser, no queue, sub-second request/response, so it's a
  much smaller commitment on whichever worker-host decision
  `hosted-paid-tier-plan.md` eventually makes, or could even run on a
  separate, cheaper always-on machine ahead of that decision, since it
  doesn't share the auto-apply worker's persistent-session requirement at
  all).
- `safe_fields` values come from the `profiles` table (already built,
  already RLS-scoped, already read by `SupabaseAdapter.readProfileField`)
  instead of local `targets.json` — no new schema.
- Fit-check/canonicalize/record-event write to the already-built hosted
  `jobs`/`job_events`/`applied_jobs`/`review_queue` tables via
  `SupabaseAdapter` (service-role variant, since the service acts on the
  user's behalf) — the exact same write paths built earlier today for the
  desktop app's `ReviewScreen`, reused, not reimplemented.

**The real new problem: how does an extension "sign in"?** Today's
extension deliberately hard-refuses a non-localhost bridge (see above) —
this needs a genuinely new connection mode, not a relaxed URL check. The
cheapest option that reuses an interaction pattern users already have:
add a hosted "personal access token" concept (a new, long-lived,
revocable token — issued from the desktop app's or a future web
dashboard's Settings screen, distinct from a Supabase session JWT so it
can be scoped/revoked independently) and let the extension's options page
gain a **second mode** — "Local install" (today's flow, unchanged) or
"aplyx account" (paste this token instead of a local bridge token). This
mirrors the exact copy-a-token-paste-it-into-options interaction the
extension already has, just pointed at a hosted endpoint with hosted auth
instead of `127.0.0.1` with a local bearer token — no in-extension OAuth
popup flow needed for a first version.

**ATS coverage:** unchanged — the same four families
(`greenhouse`/`lever`/`ashbyhq`/`workday`) `ats.ts` and
`extension_bridge.py` already support. No new selector work required to
ship this tier; it's the same client-side logic, a different backend for
the three endpoints it calls.

**Safety properties carried over unchanged, not weakened:** never
auto-submits, never invents a value for an unmapped field, records an
outcome only after the user reports submitting it themselves — this
tier's whole value proposition is that it's the local extension's already-
established safety model, just reachable without a local install.

## Why this sequencing (Tier 0 → Tier 1 → the existing `auto_apply` plan)

- **Cost and risk order of magnitude apart.** Neither tier needs an
  Anthropic API key, a persistent server-side browser, Stripe, or a queue
  — all real, non-trivial pieces `hosted-auto-apply-plan.md` and
  `hosted-paid-tier-plan.md` require. Tier 0 is close to free to run at
  any scale (a cached read). Tier 1 is a small stateless service, not a
  fleet of warm Chromium sessions.
- **Much smaller CAPTCHA/anti-bot exposure.** Every real posting the Box
  spike tested carried reCAPTCHA when approached like an automated
  worker. Tier 1 runs in the user's own real, logged-in browser with a
  human present clicking submit — categorically different traffic than a
  headless server-side session, and the safer story to lead with.
  (Doesn't make Tier 1 immune to bot-detection scoring generally — just a
  meaningfully smaller and more defensible surface than Tier 2.)
- **Validates real hosted demand before the expensive build.** If
  hosted/no-coding-agent users don't materially engage with Tier 0/1, that's
  a cheap, fast signal before committing to the worker/queue/billing/
  reliability apparatus `auto_apply` needs. If they do, it's real evidence
  to bring to that build, not a guess.
- **Doesn't block or compete with the existing plans.** `hosted_runs`,
  `subscriptions`, the worker, and `auto_apply` remain exactly as designed
  in the other two documents — this is additive, ships independently, and
  a user could plausibly use Tier 1 (extension) even after `auto_apply`
  ships, for jobs they'd rather handle themselves.

## Explicitly out of scope for this pass

- The hosted personal-access-token issuance/revocation UI itself — a real
  small feature, not designed in detail here beyond "reuses the
  copy-paste-a-token pattern the extension already has."
- Any live (non-cached) job fetching for hosted Tier 0 — cache-only, by
  design, for the reasons above.
- Whether Tier 0/Tier 1 sit behind the same paid subscription as
  `auto_apply`, or ship free given how cheap they are to run — a real
  pricing/positioning decision, not this document's to make.
- Any change to the four supported ATS families or their selector logic.

## Critical files

- `src/core/src/jobCache.ts`, `supabaseConfig.ts` — Tier 0's read path and
  the existing baked-in-default pattern to extend
- `src/config/job_cache_targets.json`, `job_cache_supabase.example.json` —
  the two static values Tier 0 needs bundled instead of read from a local
  checkout
- `src/scripts/runtime/extension_bridge.py` — confirmed deterministic,
  the exact logic Tier 1's hosted service subprocess-execs unmodified
- `src/extension/src/options.ts`, `background.ts` — the hard localhost-only
  guard and token-paste UX Tier 1's new connection mode extends
- `src/core/src/adapters/supabase.ts` — `readProfileField`,
  `markQueueEntryApplied`, the write paths Tier 1 reuses directly
- `docs/hosted-paid-tier-plan.md`, `docs/hosted-auto-apply-plan.md` — the
  heavier tier this document is proposed as a cheaper on-ramp before

## Open questions for the operator

- Build order: Tier 0 and Tier 1 independently, or Tier 0 first as a
  smaller standalone win?
- Free or paid — see "out of scope" above; flagged because it changes
  whether this needs any billing-gate work at all before shipping.
- Where does the new hosted personal-access-token concept live — issued
  from the desktop app's Settings screen (exists today), or held for a
  future web dashboard?
- Does client-side-in-the-webview (no Rust/IPC hop) for Tier 0's search
  path get evaluated seriously, or is a thin backend endpoint preferred
  for consistency with how Tier 1 and the future worker both need a real
  backend anyway?
