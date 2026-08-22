# Application status tracking (inbox-derived)

> **Status: built, hosted-only, shipped 2026-08-19 → 2026-08-21.** This
> doc's original design below — a local Python helper
> (`track_email_status.py`), a local IMAP config file, TUI settings —
> was **not** what shipped; it was superseded the same day it was first
> explored in favor of a hosted-only redesign, per migration
> `0007_hosted_email_tracking.sql`'s own header. What actually exists
> today: `applied_jobs.outcome_status` + a DB-level terminal-state guard
> trigger (`0007`), a `pg_cron`-scheduled Supabase Edge Function
> (`src/supabase/functions/email-tracking-worker/index.ts`) that opens a
> connected inbox read-only and classifies deterministically (no LLM),
> Vault-secured IMAP credentials, the `oa_completed` taxonomy addition
> (`0021`) and assessment-detail columns (`0023`), and full desktop UI
> (`src/tauri/src/lib/outcomeStatus.ts`,
> `src/tauri/src/routes/shell/StatusScreen.tsx`). See `AGENTS.md`'s
> "Hosted-only inbox status tracking" section for the authoritative
> up-to-date description. **Local installs have no path to this at
> all** — no config file, no TUI rendering — by design, not as a gap;
> `AppliedJob.outcome_status` is always `undefined` outside a hosted
> account. One open item, stated plainly in `AGENTS.md`: the IMAP fetch
> path has never been verified against a real inbox end-to-end. The
> section below is left as originally written for historical context
> (it documents the design that was explored and then superseded, not
> what's live) — do not use it as a guide to the current implementation.

## Context

Once aplyx submits an application, it currently has no way to know what
happens next — did the employer respond, request an interview, send an
assessment, or reject it? The operator wants aplyx to track this
automatically by watching the inbox of the email address already on the
user's profile (the same address used to apply), and surface a status
per job — Applied, OA Sent, Interview Requested, Offer, Rejected,
Withdrawn — each with a distinct color and symbol, in both the TUI and
the desktop app.

This is a genuinely new axis of state, not an extension of the existing
one. `AppliedJob.status` (`"applied" | "failed" | "needs_review"`)
already means something specific and different: whether *aplyx itself*
successfully submitted the application. The new field means something
else entirely: what the *employer* has said since. Conflating the two
would break the existing status-transition guard in
`src/scripts/state/job_state.py`'s `record_event()`, which already enforces
that a blocking status (`applied`/`needs_review`/`failed`/
`skipped_unfit`) can never be silently downgraded — this plan adds a
**separate field**, `outcome_status`, with its own, different guard
(below), rather than touching that one.

## Status taxonomy — colors and glyphs

Reuses the existing 3-color semantic system
(`good`/`warn`/`danger` — already shared identically between
`src/tauri/src/styles/tokens.css` and `src/tui/src/theme.ts`) rather than
inventing a parallel one, and adds exactly **two** new semantic roles
(`info`, `special`) rather than one per status — most of these outcomes
map naturally onto "good news" / "bad news" / "still pending," and only
two genuinely need a new color:

| Status | Role | Color family | Glyph (TUI) |
| --- | --- | --- | --- |
| Applied | `good` (existing) | green | `✓` (existing) |
| OA Sent | `info` (**new**) | blue | `▤` |
| Interview Requested | `special` (**new**) | violet | `◆` |
| Offer | `good` (existing) | green | `★` |
| Rejected | `danger` (existing) | red | `✗` |
| Withdrawn | muted (existing fallback) | gray | `–` |

Rejected deliberately reuses the same red/`✗` family `failed` already
uses — both are genuinely "bad outcome" states, just at different
pipeline stages (`failed` = aplyx couldn't submit it; `rejected` = the
employer reviewed and passed). The accompanying label text
(`"Failed"` vs. `"Rejected"`) is what disambiguates them, exactly like
every other status here already works (glyph + label together, never a
bare glyph) — matches the operator's own request for "a red X for
rejection" without inventing a confusingly-different shade of red.

**Concrete work this implies**: add `--info`/`--info-soft` and
`--special`/`--special-soft` custom properties to all 5 theme families ×
2 modes in `src/tauri/src/styles/tokens.css` (following the exact
light/dark pairing pattern `--good`/`--good-soft` already uses), and add
matching `info`/`special` fields to all 4 palettes in `src/tui/src/theme.ts`
plus new `statusGlyph` entries. Bounded, mechanical work — no new design
system needed, just filling in two more rows of an existing table.

## Data model

```ts
// src/core/src/stateDerive.ts — AppliedJob, extended
export interface AppliedJob {
  // ...existing fields unchanged...
  outcome_status?: "applied" | "oa_sent" | "interview_requested" | "offer" | "rejected" | "withdrawn";
  outcome_updated_at?: string;
  /** "email:<subject snippet>" or "manual" — never the full email body. */
  outcome_source?: string;
}
```

`outcome_status` defaults to `"applied"` the moment `status` first
becomes `"applied"` — before any email response, that's the accurate
state.

**Terminal-state guard** (Python-side, `job_state.py`, mirroring the
existing never-downgrade guard's spirit but for a different axis):
`rejected`, `offer`, and `withdrawn` are terminal — once reached, no
inbox-derived update may silently change them again (only an explicit
manual override could). Everything else can move forward freely
(`applied` → `oa_sent` → `interview_requested`, or directly
`applied` → `rejected`, etc.) — the one invariant that matters is that a
stray, misclassified later email can never flip a real rejection back
to "applied."

## How the tracking actually works

A new Python helper, `src/scripts/state/track_email_status.py`, run once per
scheduled cycle (see "Where this runs," below):

1. **Fetch.** Connect over IMAP (TLS) to the address already in the
   user's profile (`safe_fields.email` — the same "test@gmail.com"
   already on file, no new field needed), read-only, and fetch messages
   since a stored watermark (`data/email_watermark.json`, gitignored,
   same convention as every other local state file).
2. **Match.** For each new message, check whether it plausibly concerns
   a job aplyx actually applied to — sender domain or display name
   contains the company name, or the subject line does. **No confident
   match → skip entirely, don't guess.** This is the same
   validate-before-touching-state discipline the fit gate and
   canonicalize step already enforce locally.
3. **Classify.** Deterministic keyword rules first, cheap and auditable:
   - *Rejected*: "unfortunately," "not moving forward," "other
     candidates," "not selected"
   - *OA Sent*: "assessment," "coding challenge," "hackerrank,"
     "codesignal," "online test"
   - *Interview Requested*: "interview," "schedule a call," "next
     steps," "would like to speak"
   - *Offer*: "offer," "excited to extend," "pleased to offer"

   Only for messages that **matched** a job but hit **none** of these
   rules: an optional LLM classification fallback (Phase 3, not v1),
   using the exact forced-tool-use pattern already proven in
   `src/scripts/runtime/generate_interest_letter.py` — a
   `classify_application_email` tool call with an enum-constrained
   `outcome_status` field and a `confidence` self-report, validated
   against the terminal-state guard before it ever touches state, same
   as everything else. Never invoked for messages that already matched
   a deterministic rule — controls cost and keeps the common case fully
   auditable without any model call at all.
4. **Write.** A new `job_state.py` subcommand,
   `update-outcome-status <job_id> <new_status> --source "email:<subject>"`,
   enforcing the terminal-state guard and appending an event to
   `data/job_events.jsonl` (append-only, existing convention — "resolved"
   stays derived from later events, never from deleting anything).

**Never sends, replies to, deletes, or moves anything.** Read-only
access is sufficient for the whole feature — deliberately the smallest
possible privilege scope.

## Privacy and security — the load-bearing section

Reading someone's inbox is real trust, more sensitive than anything else
this product does today. Non-negotiable constraints, matching this
project's existing security posture (`SUPABASE_SECRET_KEY`-style secret
custody, the Discord opt-in's off-by-default pattern):

- **Opt-in, off by default.** New `src/config/email_tracking_config.json` +
  committed `.example.json`, identical shape/convention to
  `discord_config.json` — nothing runs until the user explicitly turns
  it on.
- **Read-only, always.** IMAP session opened read-only; the helper never
  issues a write/delete/move command, full stop.
- **Credentials never leave the local machine.** An IMAP app password
  (simplest, works with Gmail/most providers without needing an OAuth
  app registration for v1) lives only in the gitignored live config,
  same custody discipline as every other local secret in this repo —
  transmitted only directly to the mail provider's IMAP server over TLS.
- **Only matched emails get their body read at all.** The match step
  (company name against sender/subject) only ever needs headers; an
  email that doesn't match a known applied job is discarded immediately,
  never logged, never stored, never passed to the classifier.
- **Store the verdict, not the evidence.** Only the derived
  `outcome_status` + minimal metadata (sender, subject line, timestamp)
  is written to `job_events.jsonl` — never a full email body.
- **Follow-up required, not part of this build:** once this ships,
  `docs/website.md`'s privacy page needs an explicit update describing
  exactly this — matches the site's existing "plainly, not legally"
  honesty standard, not optional polish.

## UI plan — TUI

- Extend `src/tui/src/theme.ts`'s `statusGlyph`/`statusColor` with the two
  new keys once the new `info`/`special` palette fields exist (above).
- `HistoryScreen.tsx`: for any job with `status === "applied"`, show
  `outcome_status`'s glyph/color as the primary badge instead of the
  generic "applied" checkmark — that's the actually-interesting state
  now. Jobs with `status` of `failed`/`needs_review` keep their existing
  display unchanged; they were never successfully submitted, so they
  have no `outcome_status` to show.
- New keybinding (e.g. `u`) in `HistoryScreen.tsx`: "check inbox now," a
  manual on-demand trigger, alongside the automatic pass below.
- New Settings category, "Inbox tracking," mirroring "Discord webhooks"
  field-for-field: an `enabled` toggle plus `email`/`imap_server`/
  `app_password` fields, read/written via a new
  `settings.ts` helper pair (`readEmailTrackingEnabled`/
  `writeEmailTrackingEnabled`, etc.) modeled directly on
  `readDiscordEnabled`/`writeDiscordEnabled`.

## UI plan — desktop

- Extend the `STATUS_BADGE`/`STATUS_LABEL` maps in both
  `HomeScreen.tsx` and `HistoryScreen.tsx` with the same new keys, plus
  two new CSS classes in `src/tauri/src/components/dataList.css`
  (`.status-badge-info`, `.status-badge-special`), following the exact
  existing `background: var(--X-soft); color: var(--X);` pattern.
- **Scoped down for v1**: today the Discord opt-in has *no* desktop
  Settings UI at all — it's TUI/config-file-only (confirmed by code
  search). Rather than build a new credential-entry surface twice at
  once, v1 gives desktop Settings a **read-only indicator**
  ("Inbox tracking: on/off — configured via the TUI") and defers a full
  desktop-native opt-in flow to a later phase. Matches existing
  precedent instead of quietly expanding it.
- Optional, later: a Home dashboard stat card ("N awaiting a response" —
  jobs whose `outcome_status` isn't yet terminal) and a NotificationBell
  entry when a status changes — both natural fits for components that
  already exist, not core to shipping the feature itself.

## Where this runs

No existing hook point for "a second thing to check per cycle" — the
scheduler (`src/scripts/runtime/scheduler.py`) only supplies cadence for one
script. Simplest option, and the one this plan recommends: have
`run_job_agent.py` call the new inbox-check step once per existing
30-minute cycle, after the apply pass — piggybacks on infrastructure
that already exists (overlap protection, health marker, heartbeat) with
zero new scheduling code, and outcome emails don't arrive fast enough to
need finer granularity than 30 minutes anyway.

## Phased rollout

1. **Phase 1 (core — Python + TUI).** `outcome_status` field + terminal-
   state guard + `track_email_status.py` (deterministic classification
   only, no LLM fallback yet) + `update-outcome-status` subcommand +
   TUI display + TUI "Inbox tracking" settings + wired into the existing
   scheduled cycle. Ships the cheapest, most auditable version first —
   no model calls anywhere in the default path.
2. **Phase 2 (desktop display).** Extend the desktop badge maps/CSS +
   the read-only "configured via TUI" indicator.
3. **Phase 3 (polish, optional, separately approved).** LLM-assisted
   classification fallback for ambiguous emails; a real desktop-native
   credential-entry UI; the dashboard stat card and notification-bell
   integration; Gmail OAuth as a friendlier alternative to a raw IMAP
   app password.

Same phasing discipline as `docs/hosted-paid-tier-plan.md`'s
review-only-before-auto-apply split: ship the narrow, deterministic,
lowest-risk slice, get it validated, then layer on the riskier/optional
pieces as their own separately-approved passes.

## Critical files

- `src/core/src/stateDerive.ts` — `AppliedJob` interface, add
  `outcome_status`/`outcome_updated_at`/`outcome_source`
- `src/scripts/state/job_state.py` — new `update-outcome-status` subcommand
  + terminal-state guard, alongside the existing `record_event()`/
  `ALLOWED_STATUSES`/`BLOCKING_STATUSES`
- `src/scripts/state/track_email_status.py` — new, the fetch/match/classify
  helper described above
- `src/tauri/src/styles/tokens.css`, `src/tui/src/theme.ts` — new `info`/
  `special` color roles, all theme families/palettes
- `src/tauri/src/routes/shell/HomeScreen.tsx`,
  `HistoryScreen.tsx`, `src/tauri/src/components/dataList.css` — extended
  badge maps + two new CSS classes
- `src/tui/src/ui/HistoryScreen.tsx`, `src/tui/src/ui/SettingsScreen.tsx` —
  extended glyph display + new "Inbox tracking" settings category
- `src/core/src/settings.ts` — new
  `readEmailTrackingEnabled`/`writeEmailTrackingEnabled`-style helpers,
  modeled on the existing Discord ones
- `src/config/email_tracking_config.example.json` (new, committed) /
  gitignored live `src/config/email_tracking_config.json`
- `src/scripts/runtime/run_job_agent.py` — new call to the inbox-check step
  once per existing cycle

## Verification (once implementation starts)

- A real applied job + a real matching test email in each of the 5
  categories → confirm the deterministic classifier assigns the correct
  `outcome_status` for each, and an unrelated email (wrong company,
  no match) is skipped entirely with nothing written.
- Confirm the terminal-state guard: once a job is `rejected`, feed it
  another plausible-but-wrong-classified email and confirm
  `outcome_status` does *not* change, while the event still logs.
- Confirm read-only IMAP access — verify the library/connection is never
  given write/delete/move capability, not just that the code happens not
  to call it.
- TUI and desktop: confirm each new status renders its own distinct
  color+glyph/badge, and that jobs with `status` of `failed`/
  `needs_review` are unaffected (no `outcome_status` shown for them).
- Confirm the opt-in default: with `src/config/email_tracking_config.json`
  absent, no IMAP connection is ever attempted.

## Open questions for the operator

- IMAP app password (simplest, v1) vs. Gmail OAuth (more secure/modern,
  more setup work) as the v1 credential mechanism — this plan assumes
  IMAP app password for v1 and OAuth as a later option; confirm that's
  the right order.
- Should the LLM-fallback classifier (Phase 3) be in scope at all, or is
  deterministic-only permanently sufficient? Given most rejection/
  interview/OA emails use fairly formulaic language, deterministic-only
  may cover the large majority of cases indefinitely.
- Multiple inbox addresses (e.g. a user applies from two different
  emails) — out of scope for this plan as written; flag if that's
  actually needed.
