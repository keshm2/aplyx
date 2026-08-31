# Hosted `auto_apply`: the deferred design pass

> **Status: planned, not started.** This is a design document, not a phase
> in progress. It picks up exactly where `docs/hosted-paid-tier-plan.md`
> left off: that plan explicitly scoped `auto_apply` as "ships second...
> should get its own dedicated design pass and explicit go-ahead once
> `review_only` is live and validated" and listed "auto-apply's actual
> execution" under its own out-of-scope section. `review_only` has not
> shipped yet either (it's the same "not started" phase), so this document
> is groundwork to have ready, not a next build step: needs its own
> explicit operator go-ahead before any part of it starts, per this
> project's one-phase-at-a-time rule, layered on top of `review_only`'s own
> go-ahead.
>
> **See also (2026-08-10):** [`docs/hosted-no-agent-tiers-plan.md`](./hosted-no-agent-tiers-plan.md)
> proposes two much cheaper tiers of hosted value (cached job search,
> hybrid-autofill via the browser extension) that need no LLM spend, no
> persistent browser session, and carry far less CAPTCHA/anti-bot exposure
> than this document's server-side worker: a recommended cheaper on-ramp
> to ship before this plan, not a replacement for it.

## Why this is a separate document, not a section bolted onto the existing plan

`hosted-paid-tier-plan.md` already covers the shared infrastructure
(front door, queue, worker host, billing, Supabase reuse) both modes need.
What it deliberately did not resolve is the part that's actually hard about
`auto_apply` specifically: the local apply flow
(`src/agents/bodies/job-scraper.md` Phase 3) is a broad-tool-access,
LLM-driven Playwright loop built for **one trusted user on their own
machine**, and the same plan's own "Reliability" section already says that
shape is wrong for multi-tenant infrastructure. Making `auto_apply` real
means resolving that tension concretely, not just standing up a worker that
happens to also drive a browser. This document is that resolution.

It also folds in a finding from the completed Upstash Box spike
(`docs/online-hosting.md`) that changes the risk framing materially: **every
real Greenhouse posting tested carried reCAPTCHA**, including one employer
(Samsara) whose own posting explicitly discloses using a fraud-detection
tool ("Tofu") to screen for automated applications. That's not a hosting
platform problem to engineer around: it's evidence that full,
CAPTCHA-solving automation is off the table entirely, on any host. This
plan treats that as a hard constraint, not a target to defeat.

## Ground rule, stated first because it shapes everything else

**This plan does not solve CAPTCHA, and never will.** Bypassing CAPTCHA
protection is a red line, both because it's the kind of anti-automation
evasion this assistant won't help build, and because Samsara's own posting
text shows real employers are actively watching for exactly this pattern,
which makes it a direct path to the account getting the operator's
infrastructure IP-banned, employer relationships burned, and the "trust-
first" positioning (`docs/product-positioning-and-rebrand-plan.md`)
undermined on the first real incident. Every design decision below treats
CAPTCHA as an **expected, common outcome to detect and defer**, not an edge
case to minimize.

This is not a new behavior invented for hosted mode: it's the exact local
policy already in `job-scraper.md`'s Error handling section, carried
forward unchanged:

> CAPTCHA detected → stop applying to that board, log all pending jobs as
> "needs_review" ... doubt_signals: `"captcha"` ... continue with other
> boards.

Given how often the spike found reCAPTCHA on real postings, hosted
`auto_apply` should expect a meaningful fraction of jobs to fall through to
`needs_review` for this reason alone; that's the system working as
designed, not a failure rate to hide from users. The consent screen and
marketing copy for this feature need to say so plainly (see "Setting
honest expectations" below), not oversell "fully automatic."

## The core problem: narrow steps vs. a browser-driving loop

`hosted-paid-tier-plan.md`'s Reliability section prescribes narrow,
forced-tool-use calls (`generate_interest_letter.py`'s pattern) for every
step that produces something destined for state. That works cleanly for
`review_only`: tailoring a resume bullet or writing a cover letter is
naturally one call with one structured output. Filling out and submitting
an actual web form is not that shape: it's a sequence of DOM
reads/clicks/types that has to react to what's actually on the page, which
is inherently more like the local Phase 3 loop than a single structured
call.

The resolution is to **decompose Phase 3 into the parts that are genuinely
judgment calls (narrow them) and the part that's mechanical DOM execution
(bound it tightly instead)**, rather than pretending the whole thing can be
one forced-tool-use call:

**Narrowed to forced-tool-use, single-purpose calls** (each gets exactly
one `submit_*` tool, no browser access, same shape as
`generate_interest_letter.py`):
- **Field-mapping resolution.** Given the form's field list (labels +
  types, extracted by a separate deterministic DOM-read step, not the LLM)
  and the user's `safe_fields`, produce a `{field_name -> safe_fields key |
  "essay" | "unmapped_required" | "unmapped_optional"}` mapping. This is a
  classification task, not a browser-interaction task: it doesn't need
  live page access to do correctly, and forcing it through one structured
  call means the same grounding-style validation
  (`generate_interest_letter.py`'s pattern) can check it before anything
  touches the page.
- **Dropdown/combobox exact-match resolution.** Given the rendered option
  list (again, extracted by a deterministic read) and the intended value,
  return either the exact matching option or an explicit "no exact match",
  mirroring local Phase 3 step 3's protocol precisely, just as a forced
  single call instead of inline LLM judgment mid-loop.
- **Essay/motivation questions.** Unchanged from local: never generated
  live. Requires a pre-approved answer via the same
  `interest_letter.py`-equivalent flow (hosted analog needed; see "New
  hosted-only pieces" below) or the job parks, exactly like local mode.

**Stays as bounded, narrowly-scoped browser execution** (not a
forced-tool-use call, because it genuinely can't be, but tightly fenced):
- The actual navigate/click/type/upload/submit sequence, driven by a
  small, fixed script that consumes the structured outputs above (field
  mapping, resolved dropdown values) rather than deciding anything itself.
  This is deliberately **not** an LLM given broad Playwright tool access
  and a goal; it's closer to a deterministic form-filler parameterized by
  upstream structured decisions, which shrinks the blast radius of "the
  model went off-script" to zero for the execution step itself, at the
  cost of needing per-ATS-family execution logic (this already exists and
  is reviewable in one place: `src/extension/src/ats.ts`'s four-family
  selector logic, extended to drive server-side Playwright the same way it
  already drives the extension's client-side autofill).
  This is the piece most directly informed by the Box spike's mock
  auto-apply run (9 discrete calls, one persistent session, two jobs
  back-to-back, server-side records matched exactly what was submitted):
  that confirmed the mechanics work; this section is what constrains what
  those calls are allowed to decide.
- **Mandatory pre-submit verification carries over unchanged.** Local
  mode's rule (every filled value gets read back from the DOM and compared
  against the intended value before submit) is not weakened for hosted;
  if anything it matters more here, since there's no user watching the
  screen live to catch a wrong-looking form before it goes out.

## CAPTCHA and unrecognized-state detection: deterministic, not judgment

Both of these should be **deterministic checks the fixed execution script
runs itself** (DOM pattern match: `g-recaptcha`, `iframe[src*=recaptcha]`,
known challenge-page markers), not something an LLM is asked to notice,
matching this project's existing bias toward deterministic checks over
model judgment wherever a check can be made deterministic at all. On a
hit: stop immediately, no further action on that job, route to
`needs_review` with `doubt_signals: ["captcha"]`, exactly like local mode.
An unrecognized page state (form didn't load, unexpected redirect, a field
that should exist doesn't) gets the same treatment: fail closed to
`needs_review`, never guess and continue.

## New hosted-only pieces this requires

- **Hosted interest-letter approval flow.** Local's
  `src/scripts/state/interest_letter.py` parks a job pending the user's own
  written answer to an essay question, surfaced via the TUI/desktop. Hosted
  needs the same park-and-wait semantic against `review_queue`/a small new
  `pending_essay_answers`-shaped state (reuse `review_queue`'s existing
  shape with a distinguishing flag rather than a new table, if the fields
  fit; decide at implementation time), critically, **never auto-answer
  this with the LLM**, same red line as local.
- **Per-tenant browser session lifecycle.** The Box spike confirmed the
  mechanics (snapshot-restore: ~40s one-time bake, <1.3s restore; a
  persistent session holds a cookie/login state across 7 independent
  round-trips). Whichever worker host wins the still-open bake-off, the
  auto-apply worker needs: one warm, pre-baked-Chromium session per
  in-progress job batch (not per-request cold start; the local flow
  assumes a live, warm browser throughout Phase 3), torn down after the
  batch completes or the daily quota is exhausted, never held open idle
  between runs.
- **Per-tenant ATS selector reliability signal.** `ats.ts` selector logic
  is currently reviewed by a human when it breaks (one company's DOM
  changes, someone notices, fixes it). At multi-tenant scale a broken
  selector silently affects every user applying to that company at once.
  Add a circuit breaker: if a given ATS family's execution step fails N
  times in a row across different users/jobs in a short window, disable
  auto-apply for that family, fall back every affected job to
  `needs_review` with a distinct reasoning ("ATS selector logic may be
  stale for `<family>`, flagged for review"), and alert the operator,
  same shape as `run_conformance.py`'s existing per-adapter health
  tracking, applied at runtime instead of at test time.
- **Fill-record audit trail, hosted.** Already unblocked by the write-path
  work landed earlier today: `applied_jobs`/`review_queue`'s `fill_record`
  jsonb column and `SupabaseAdapter`'s row mapping exist now. The worker
  just needs to populate it the same way `record_fill.py` does locally
  (field-by-field provenance, `verified` flag from the pre-submit
  read-back check above); no new schema work, this is calling
  functionality that already exists.

## Trust-building rollout, not a day-one full-autonomy flip

Given the liability surface (`hosted-paid-tier-plan.md`'s own Security
section already flags this as real, operator-run-infrastructure liability)
and the CAPTCHA-driven reality that a meaningful share of jobs will still
need a human, a staged rollout is lower-risk than shipping unconstrained
autonomy on day one:

1. **Stage 1: confirm-before-submit.** `auto_apply` runs the full pipeline
   through the pre-submit verification step, then **pauses** and surfaces
   the filled-but-not-submitted form state for the user to approve in the
   hosted dashboard before the worker actually clicks submit. This is
   strictly safer than local's own default (which submits directly) but is
   a reasonable way to earn trust in the hosted execution path specifically
   before removing the human click. Every field written matches what
   `fill_record` already records, so the review UI has real data to show,
   not just a promise.
2. **Stage 2: full autonomy, opt-in per user.** Once Stage 1 has run
   cleanly across enough real batches (operator sets the bar, a job count,
   not a time window, since volume is what actually exercises edge cases),
   offer a second, separate opt-in toggle for skip-the-pause autonomous
   submission. This is a second explicit consent action, not a default
   flip for existing Stage-1 users.

This sequencing is a proposal for the operator to accept, adjust, or
reject, not a requirement baked into the architecture. If the operator
prefers to ship straight to full autonomy behind the existing consent
screen, Stage 1 can be skipped; it's called out here because it's the
lower-risk default given the liability and CAPTCHA findings above, not
because the architecture requires it.

## Setting honest expectations (product/marketing surface)

Given the spike's own finding, the consent screen and any marketing copy
for hosted `auto_apply` should say plainly that a real share of
applications will still land in a human review queue because of CAPTCHA
and similar bot-detection, framed as the system correctly refusing to
guess or bypass protection, consistent with the "trust-first" positioning
`docs/product-positioning-and-rebrand-plan.md` already stakes out, not as a
limitation to downplay. This is a coordination note for whoever owns that
copy, not something this document builds.

## Quotas and rate limits

Reuses `hosted-paid-tier-plan.md`'s existing daily-quota numbers (3 / 10 /
25 per day) as the per-user cap on `auto_apply` batch size, no new numbers
invented here. Two additions specific to auto-apply's real browser cost:
a **per-batch wall-clock timeout** (a hung Playwright session shouldn't
silently hold a paid worker slot indefinitely; needs_review the remaining
jobs in the batch and release the session on timeout, same fail-closed
posture as everything else here), and the **ATS-family circuit breaker**
above, which caps blast radius, not per-user volume.

## Explicitly out of scope for this pass

- Actually resolving the Fly.io vs. Upstash Box worker-host bake-off: this
  plan is host-agnostic on purpose; either host's session model satisfies
  the persistent-browser requirement described above.
- Any attempt at CAPTCHA solving, bypass, or evasion, in any form: not a
  future phase, not a "revisit later." A hard boundary, not a gap.
- The confirm-before-submit UI itself (Stage 1): a real design/build task
  once this plan is approved, not sketched here beyond "surfaces
  fill_record state for approval."
- Anything about `review_only` mode: that's `hosted-paid-tier-plan.md`'s
  scope, already designed, still itself not started.

## Critical files

- `src/agents/bodies/job-scraper.md` (Phase 3, "Error handling"): the
  local behavior every rule above is a faithful port of, not a redesign
- `src/extension/src/ats.ts`: the four-ATS-family selector logic the
  bounded execution script extends to server-side Playwright
- `src/scripts/state/interest_letter.py`, `record_fill.py`: local
  helpers whose park-and-wait / provenance-recording semantics need hosted
  analogs, per "New hosted-only pieces" above
- `src/scripts/runtime/generate_interest_letter.py`: the forced-tool-use
  + grounding-confidence pattern the narrowed judgment-call steps
  (field-mapping, dropdown resolution) generalize
- `docs/hosted-paid-tier-plan.md`: the shared infrastructure (front door,
  queue, worker host, billing, Supabase reuse) this plan builds on top of
- `docs/online-hosting.md`: the Box spike this plan's session-lifecycle
  and CAPTCHA-reality sections are grounded in
- `src/core/src/adapters/supabase.ts`: `fill_record`/`markQueueEntryApplied`
  already built (2026-08-10) and directly reusable by the worker's
  write-back step

## Open questions for the operator

- Accept, adjust, or skip the Stage 1 (confirm-before-submit) rollout
  proposal above?
- Where should the ATS-family circuit-breaker threshold and per-batch
  timeout actually be set? Proposed here only as concepts, not numbers;
  needs real data once `review_only` (and ideally a Stage-1 auto-apply
  trial) has run enough real batches to size them against.
- Does the hosted interest-letter park-and-wait flow reuse `review_queue`'s
  shape with a flag, or warrant its own small table? Either is small
  either way; flagged so it isn't decided by default at implementation
  time.
- Confirm the "never CAPTCHA-bypass" line is understood as permanent, not
  a v1 limitation: this document treats it that way throughout.
