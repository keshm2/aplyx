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

> **Update (2026-08-26): backend host decided — Google Cloud Run.** The
> rest of this section was written before any concrete hosting choice
> existed; it's now filled in below with a real architecture, a real
> token mechanism, and real numbers. **Still not implemented** — this is
> a plan, not a build; needs its own explicit operator go-ahead to
> actually provision anything, same as every other piece of
> infrastructure in this repo's hosted plans.

**What it gives a no-coding-agent user:** the same experience a local
install's browser extension already gives — fit-check a posting, autofill
the form from their own profile fields, review and submit it themselves —
without installing anything but the extension and signing into their
aplyx account.

### Backend host: Google Cloud Run

Checked live against 2026 pricing/terms rather than assumed, the same
discipline `hosted-paid-tier-plan.md`'s own worker-host research already
held itself to:

- **Vercel Python Functions** — ruled out. Free (Hobby) plan is
  contractually **restricted to non-commercial use**, and aplyx has real
  paid tiers planned; a 10-second execution ceiling would be fine for
  this workload, but the licensing term alone disqualifies it.
- **Render.com** — ruled out. Free web services spin down after 15
  minutes idle, then take 30-60s to cold-start on the next request — a
  user clicking "Fit check" mid-application and waiting a minute for a
  response is a real UX regression versus the local bridge's near-instant
  response today.
- **Railway** — ruled out. Only $1/month of free credit on an ongoing
  basis after a one-time $5 trial; not meaningfully free at any real
  usage.
- **Fly.io** — ruled out as a *free* option (it remains the paid-tier
  worker's own candidate for later, larger, persistent-browser needs).
  No free tier since 2024; a minimal always-on machine runs ~$2-5/month
  even at zero traffic.
- **Google Cloud Run** — the pick. A real Docker container (so the exact
  Node+Python hybrid image shape `hosted-paid-tier-plan.md` already
  designed for the bigger worker applies here unmodified, just far
  smaller), genuine scale-to-zero with no idle cold-start penalty anywhere
  near Render's, and an always-free monthly allowance (2M requests,
  180,000 vCPU-seconds, 360,000 GiB-seconds) that comfortably covers
  Tier 1's realistic near-term traffic on its own. Google's own published
  rates beyond that allowance are $0.40/million requests,
  $0.000024/vCPU-second, $0.0000025/GiB-second — at a (deliberately
  generous) 100,000-requests/month estimate, roughly $3-4/month total,
  entirely usage-linear with no fixed capacity to pre-purchase. The one
  real friction: Google's Cloud Run free tier has required a linked
  billing card since a February 2026 policy change (not itself a charge,
  but a new account relationship and a card on file, worth knowing before
  starting). Sources: [Cloud Run pricing](https://cloud.google.com/run/pricing),
  [Google Cloud Free Program](https://docs.cloud.google.com/free/docs/free-cloud-features).

### Architecture — reuse, don't fork, and reuse more than originally scoped

- `job_state.py`'s `canonicalize` and `evaluate_job_fit.py` run
  **unmodified**, subprocess-exec'd from the Cloud Run container exactly
  as `extension_bridge.py` already does locally — both are genuinely pure
  computation (no file I/O beyond `evaluate_job_fit.py` reading
  `config/targets.json`'s role/level keywords, which the hosted service
  instead sources from the signed-in user's `profiles.preferences`
  column, already synced there by the existing profile UI). This is the
  one piece of Python that has to run somewhere with a real Python
  runtime — everything downstream of it is a state write, not a
  computation, and that part turns out to already exist:
- **The Supabase write path needs almost nothing new.** Phase 17's
  worker-plumbing (`docs/PLAN.md` §3.12 Package 3) already built
  `SupabaseAdapter.registerJob`, `.recordSkippedUnfit`,
  `.saveJobForReview`, and `.markQueueEntryApplied` (service-role variant)
  generically enough to serve a hosted worker it hadn't been built yet —
  Tier 1 turns out to be exactly the kind of caller those methods were
  future-proofed for. Mapping `extension_bridge.py`'s three handlers onto
  them directly:
  - `handle_fit` → `registerJob` (canonicalize's output) then the fit
    gate's result decides candidate/needs_review/skipped_unfit, same as
    today.
  - `handle_fields` → `SupabaseAdapter.readProfileField` per requested
    key — already reads the `profiles` table, already RLS-scoped, no new
    schema. **Real gap found while checking this, not assumed clean:**
    `extension_bridge.py`'s `SAFE_FIELD_KEYS` includes `gpa`,
    `citizenship_status`, and `currently_enrolled` — none of which exist
    as columns on `profiles` (`0001_init.sql` + `0019`'s
    veteran/disability additions). Not fatal — a served-fields response
    already degrades to omitting any key it doesn't have a value for,
    same contract as an unset local field — but real profile parity would
    need a small migration adding those three columns, not assumed
    included.
  - `handle_outcome` (`needs_review`) → `saveJobForReview` directly, no
    new method needed.
  - `handle_outcome` (`applied`) → `markQueueEntryApplied` needs an
    existing registry `job_key`, which `registerJob` (called first, same
    as `saveJobForReview`'s own pattern) guarantees.
  - **One genuinely new, small piece**: `job_state.py`'s local `can-apply`
    check (blocks re-applying to something already `applied`/
    `needs_review`/`failed`/`skipped_unfit`) has no single named
    `SupabaseAdapter` equivalent — `dismissQueueEntry` inlines an
    equivalent check via `hasAppliedOrFailed`/`isDismissed`
    (`stateDerive.ts`), but nothing currently exposes it as a reusable
    "can I apply to this job_id" call. This exact derivation logic has
    already been ported twice independently in this session
    (`stateDerive.ts` for local, `account.js` for the web dashboard) —
    a third hand-port for the hosted service is the wrong move; the
    right one is finally factoring it into one shared, exported
    `canApply(state, jobId)` helper `SupabaseAdapter` calls, `account.js`
    could eventually call too, and this new service calls as its fourth
    user.
- **Container shape**: Node (for `@aplyx/core`'s `SupabaseAdapter`,
  service-role client) + Python (for the two subprocess calls) in one
  image — literally the same hybrid shape `hosted-paid-tier-plan.md`
  already designed for the bigger worker, just a much smaller,
  stateless, sub-second-response service with no persistent browser and
  no queue. Worth a deliberate note for later, not decided now: this
  container and the eventual `review_only` worker's container could
  plausibly converge into one shared base image once both exist, rather
  than staying two independent Dockerfiles.

### The hosted personal-access-token — a concrete design, not a placeholder

Today's extension deliberately hard-refuses a non-localhost bridge
(`options.ts`'s `if (parsed.hostname !== "127.0.0.1" && parsed.hostname
!== "localhost")` check) — this needs a genuinely new connection mode,
not a relaxed URL check, and that mode needs something to authenticate
with. Rather than invent a mechanism, this reuses the exact pattern
already shipped and tested in the ATS-account-credentials work
(migration `0028`'s `application_account_credential_tokens` +
`issue_account_credential_use_token`/
`resolve_application_account_credential_token` RPCs) — real prior art in
this codebase, not a new design:

- A new table, RLS-scoped to `auth.uid()`, storing only a **hash** of
  each token (never plaintext) alongside `user_id`, an optional label,
  `created_at`, and a nullable `revoked_at`.
- `issue_extension_token()` — SECURITY DEFINER RPC. Generates a token,
  returns the plaintext **once**, stores only its hash.
- `list_own_extension_tokens()` — metadata only (label, created_at,
  last-used timestamp) — can't leak a value it never stored.
- `revoke_extension_token(id)` — sets `revoked_at`; already-cached
  extension sessions fail their next request, same "revoke, don't
  rotate-and-hope" story `rotate_application_account_secret` already
  established for ATS credentials.
- `resolve_extension_token(token)` — SECURITY DEFINER, **service-role
  only** (never callable by `authenticated`, mirroring
  `resolve_application_account_credential_token`'s own restriction) —
  hashes the incoming bearer token and returns the owning `user_id` if
  it's live and unrevoked. This is what the Cloud Run service calls on
  every request to authenticate.

**Issued from the web dashboard, not only the desktop app** — this
resolves the previous version's open question directly, now that
`account.html` exists. A Tier-1-only user may never install the desktop
app at all (that's the entire point of this tier), so the web dashboard
is the more universal front door; a new "Extension access" section there
(same account.js/Supabase-client pattern the Profile tab already
established) generates and revokes tokens. The desktop app's Settings
screen can offer the identical action later, calling the same RPCs — not
a second mechanism, a second caller of one.

**Extension changes**, all additive, none touching the existing local
path:
- `options.ts`/`options.html` gain a connection-mode toggle — "Local
  install" (today's flow, byte-for-byte unchanged, including the
  localhost-only guard) or "aplyx account" (paste the token; the base URL
  becomes the fixed Cloud Run service origin, not user-editable, since
  there's only one).
- `background.ts`'s `callBridge` gains a second branch: hosted mode
  targets the Cloud Run origin and skips the localhost-only check
  (additive — the local-mode guard stays exactly as strict as it is
  today, never relaxed).
- `manifest.json`'s `host_permissions` needs the Cloud Run service's
  origin added alongside the existing `http://127.0.0.1/*` (a stable
  custom domain fronting the service is preferable to a raw
  `*.run.app` URL here, so a future redeploy never requires a manifest
  change and a re-review).
- `content.ts` needs **zero changes** — the recently-shipped busy-lock
  and honeypot-visibility fixes (commit `7c2b2fe`) and the whole
  fit-badge/autofill/outcome UI are already oblivious to which backend
  answers `/fit`/`/fields`/`/outcome`, by design.

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

**Verification, once implementation starts:** a real token round-trip
(issue on the web dashboard → paste into the extension → fit-check a real
posting → confirm the resulting `jobs`/`review_queue` row appears in both
the extension's own status line and the web dashboard's "My activity" tab
live, since Realtime — migration `0034` — is already wired for exactly
this); a revoked token's next request fails cleanly, not silently; the
`gpa`/`citizenship_status`/`currently_enrolled` gap either gets its
migration or is documented as a known Tier 1 vs local parity gap, not
silently dropped.

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

- **Actually provisioning anything** — no Cloud Run service, no
  migration, no extension code has been written. This whole section (and
  the updated Tier 1 section above) is a design, pending its own explicit
  operator go-ahead, per this project's one-phase-at-a-time rule and the
  operator's specific "build a plan, don't implement it yet" direction
  (2026-08-26).
- Any live (non-cached) job fetching for hosted Tier 0 — cache-only, by
  design, for the reasons above.
- Whether Tier 0/Tier 1 sit behind the same paid subscription as
  `auto_apply`, or ship free given how cheap they are to run — a real
  pricing/positioning decision, not this document's to make.
- Any change to the four supported ATS families or their selector logic.
- The `gpa`/`citizenship_status`/`currently_enrolled` profile-schema gap
  found while writing this — flagged, not fixed; a small follow-on
  migration if full local/hosted field parity is wanted before Tier 1
  ships, or a documented, accepted gap if not.

## Critical files

- `src/core/src/jobCache.ts`, `supabaseConfig.ts` — Tier 0's read path and
  the existing baked-in-default pattern to extend
- `src/config/job_cache_targets.json`, `job_cache_supabase.example.json` —
  the two static values Tier 0 needs bundled instead of read from a local
  checkout
- `src/scripts/runtime/extension_bridge.py` — confirmed deterministic;
  its `canonicalize`/fit-gate calls are exactly what Tier 1's hosted
  service subprocess-execs unmodified, while its state-write logic
  (local JSON files) is what gets replaced by `SupabaseAdapter` calls
- `src/extension/src/options.ts`, `background.ts`, `manifest.json` — the
  hard localhost-only guard, token-paste UX, and `host_permissions` list
  Tier 1's new connection mode extends
- `src/core/src/adapters/supabase.ts` — `readProfileField`,
  `registerJob`, `saveJobForReview`, `markQueueEntryApplied` — the write
  paths Tier 1 reuses directly, plus the new `canApply` helper this plan
  proposes factoring out of `stateDerive.ts`'s
  `hasAppliedOrFailed`/`isDismissed`
- `src/supabase/migrations/0028_application_account_vault_service.sql` —
  the token-issuance RPC pattern (`issue_*`/`resolve_*`/`revoke_*`,
  service-role-only resolution) the new extension-token schema mirrors
- `src/site/account.js`, `account.html` — where the new "Extension
  access" token-management section slots in, alongside the existing
  Profile tab
- `docs/hosted-paid-tier-plan.md`, `docs/hosted-auto-apply-plan.md` — the
  heavier tier this document is proposed as a cheaper on-ramp before

## Open questions for the operator

- Build order: Tier 0 and Tier 1 independently, or Tier 0 first as a
  smaller standalone win?
- Free or paid — see "out of scope" above; flagged because it changes
  whether this needs any billing-gate work at all before shipping.
- **Resolved**: the hosted personal-access-token concept is issued from
  the web dashboard (`account.html`), not only the desktop app — see
  Tier 1's updated design above.
- **Resolved**: Tier 1's backend host is Google Cloud Run — see Tier 1's
  updated design above for the full comparison and reasoning.
- **New**: which Google Cloud project/billing account to provision
  under — a real operator decision (new account vs. an existing one),
  not something to default silently.
- **New**: custom domain fronting the Cloud Run service, or ship the
  first version on the default `*.run.app` origin and add a custom
  domain later? Affects whether `manifest.json`'s `host_permissions`
  needs a future update.
- **New**: fix the `gpa`/`citizenship_status`/`currently_enrolled`
  profile-schema gap before Tier 1 ships, or accept it as a documented
  Tier 1-vs-local parity gap for a first version?
- Does client-side-in-the-webview (no Rust/IPC hop) for Tier 0's search
  path get evaluated seriously, or is a thin backend endpoint preferred
  for consistency with how Tier 1 and the future worker both need a real
  backend anyway?
