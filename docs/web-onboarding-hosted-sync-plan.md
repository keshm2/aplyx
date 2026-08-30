# Plan: Web-first onboarding + hosted-to-local carryover

> **Status: both parts built, including the schema-parity follow-up
> (2026-08-27).** Part A (web-first onboarding) shipped as designed. Part
> B (hosted-to-local carryover) shipped with one real routing finding that
> changed the design, plus the `gpa`/`citizenship_status`/
> `currently_enrolled` gap, initially deferred, then closed same-day on
> explicit follow-up — see "What actually shipped" below before assuming
> the design above is exactly what's live.

## What actually shipped (Part B)

- **Only one of the two trigger points is real.** Re-reading
  `EntryScreen.tsx`'s routing while implementing this: a signed-in
  session always redirects away from the "Run locally" choice
  (`EntryScreen.tsx`'s own effect fires before that card ever renders),
  so `ProfileStep.tsx`'s local wizard can never actually be reached while
  a hosted session is already active — the first trigger point this plan
  proposed was unreachable through any real navigation path, not just
  unbuilt. Built instead: `SettingsAccountTab.tsx`'s existing "Sign in"
  button now passes `returnTo: "/app/settings"` through `/auth`, and
  `AuthScreen.tsx`'s post-sign-in redirect honors it instead of routing
  into hosted onboarding — landing back in Settings, where the pull is
  offered inline. This is the actually-reachable version of "install the
  app, use it locally, later sign in and have data carry over."
- **Update (2026-08-27, same day): the `gpa`/`citizenship_status`/
  `currently_enrolled` gap is now closed** — option 1, on explicit
  follow-up instruction. `0036_profile_local_only_fields.sql` added all
  three as nullable text columns on `profiles` (additive, same pattern as
  `0019_profile_demographics_columns.sql`) and all three were added to
  `src/core/src/onboarding/fields.ts`'s PAGES (Work eligibility gets
  `citizenship_status`; Education gets `gpa` and `currently_enrolled`) —
  picked up automatically by the Tauri wizard, the TUI wizard, and
  `HOSTED_PROFILE_FIELD_IDS` (derived from `FIELD_IDS`, so
  `SupabaseAdapter`'s routing needed no changes at all). `src/site/
  account.js`'s hand-copied `PROFILE_PAGES` was updated to match by hand,
  same as any other field addition to this schema. Migration pushed live
  to the `aplyx-users` project and verified via `supabase db query
  --linked` (all three columns present). This was the last open item
  from `hosted-no-agent-tiers-plan.md`'s own copy of the same question —
  that doc's mention of it is now stale/resolved, not updated as part of
  this change since it's tracking a different, still-unstarted phase.
- Conflict handling matches the recommended design: overwrite, with a
  plain-language warning ("this will replace the profile already saved
  on this local install") rather than a full per-field diff.
- New code: `src/tauri/src/lib/hostedPull.ts` (the pull itself),
  `importResumeBytes` added end-to-end (`src/core/src/bridge.ts` →
  `src-tauri/src/lib.rs` → `src/tauri/src/lib/bridge.ts`) since nothing
  before this could write downloaded bytes (as opposed to an
  already-on-disk file) into `data/resumes/`.
- Verified via `tsc --noEmit` (core + desktop) and `cargo check`, both
  clean.
- **Update (2026-08-28): exercised end-to-end against a real, disposable
  account.** Couldn't drive the native Tauri window directly, so instead:
  created a real Supabase user via the admin API (pre-confirmed), seeded
  every `HOSTED_PROFILE_FIELD_ID`/preference field including the new
  gpa/citizenship_status/currently_enrolled, uploaded a synthetic PDF,
  signed in as that user with the real anon key (a genuine RLS-scoped
  session, not a service-role bypass), read it back with
  `readHostedProfileSnapshot`'s exact query shape, and fed it into the
  real `LocalAdapter` class (`@aplyx/core`) plus the real
  `convertResumePdf` against a scratch local install. All 26 fields
  matched byte-for-byte; resume text extraction succeeded. Test user,
  storage object, and scratch files all cleaned up afterward (verified
  zero leftover rows). This covers the two things typechecking alone
  couldn't: field routing through a real authenticated session, and the
  local-write + resume-conversion pipeline actually working.

## tl;dr

Two separate gaps, both real, neither a greenfield build:

1. **Web has data-entry, not onboarding.** Signup is bare email/password;
   a new signup gets a one-time banner nudging them to the flat Profile
   tab (`account.js:848-856`), but there's no sequenced walkthrough, no
   resume upload, and no readiness checklist on the web — all three exist
   already, just only in the desktop app's hosted wizard.
2. **Hosted data never flows down to a local install.** The desktop app
   picks one data backend per session — local files if a local install is
   found, hosted Supabase otherwise (`useAplyxState.ts`) — and nothing
   bridges them. A user who signs in from Settings while running locally,
   or who fills in the web dashboard first and later does a real local
   install, gets zero carryover: the hosted profile and resume just sit
   there unread. The desktop hosted wizard's existing "Import your
   existing account details" button (`ImportOrFreshStep.tsx:66-76`)
   sounds like this but isn't — it only skips re-asking profile questions
   *within hosted mode*; it never touches a local file, and a genuinely
   local install (the separate `local/` wizard, `LocalWizard.tsx`) has
   zero awareness that a hosted account or profile exists at all.

Most of what Part A needs already exists as working code in the desktop
app (`src/tauri/src/routes/onboarding/hosted/`) — the work is porting it
to the site's plain-JS codebase, not inventing it. Part B needs new code
end to end: nothing today reads a hosted profile into local files.

## Part A — Web-first onboarding

### What's there today

- `account.html:81-90` / `account.js:167-175` — signup is `email` +
  `password` only, no profile fields collected at signup time.
- `account.js:844-857` — the one existing nudge: if `profiles.first_name`
  is empty after sign-in, show a banner and jump to the Profile tab, once
  per session. This already mirrors the exact check
  `ImportOrFreshStep.tsx:36-38` uses to decide whether an account "has a
  profile."
- `account.html:137,163,178` — three dashboard tabs exist: Activity,
  Profile, Search. No Resume tab, no candidate-email step, no readiness
  checklist.
- The Profile tab (`account.js:860-1005`, `PROFILE_PAGES`) already covers
  all 18 `FIELD_IDS` + 3 preference-array fields from
  `src/core/src/onboarding/fields.ts` — the identical field set the
  desktop wizard's `profile` step collects — as one scrollable form
  instead of 8 wizard pages, saved via one `.upsert()`
  (`account.js:1050`).
- No resume upload anywhere on the site (`grep` for "resume"/"storage.from"
  in `account.js`/`account.html` returns nothing relevant). The desktop
  wizard's own upload step (`ResumeUploadStep.tsx:13-16`) is a plain
  `client.storage.from("resumes").upload(...)` call against the Supabase
  JS client — no Tauri/Rust dependency, directly portable to a browser
  `<input type="file">`.
- `CandidateEmailStep.tsx` turns out to be a thin, separately-presented
  wrapper around the *same* `profiles.email` field the Profile form
  already collects (`supabase.ts:362-369`, `readCandidateEmail`/
  `writeCandidateEmail` literally call `readProfileField("email")`/
  `writeProfileField("email", ...)`). Not a second field to design —
  just a UI-sequencing question (see below).
- `HostedReadinessStep.tsx` reads `SupabaseAdapter.readHostedReadiness()`
  — a pure read, no reason it couldn't render on the web dashboard too.

### Proposed sequence (mirrors the desktop hosted wizard's already-generic steps)

Right after email confirmation / first sign-in, instead of (or in
addition to) the current banner-to-flat-tab nudge:

1. **Profile** — same fields, same one-scroll-form UX already built
   (`PROFILE_PAGES`), just reframed as step 1 of a sequence instead of a
   settings tab.
2. **Confirm applying-from email** — the existing Profile form's `email`
   field, called out once on its own screen the way the desktop wizard
   does, since it's the address employers reply to.
3. **Resume upload** — net-new on web: an `<input type="file">` posting
   straight to the `resumes` storage bucket, same call the desktop step
   already makes.
4. **Readiness / finish** — a short checklist (profile %, resume present,
   email set) reusing `readHostedReadiness()`, ending with a link into
   the full dashboard.

Explicitly **not** ported: the desktop wizard's `import` step
(`ImportOrFreshStep.tsx`) and everything in the `local/` wizard
(environment check, coding-agent detection, Discord config, local resume
parsing) — all either meaningless without a filesystem/Rust IPC layer or
about choices (which coding agent) the web has no way to act on.

### Open decisions — Part A

1. **New sequenced flow, replace the existing banner, or both?**
   Recommendation: replace — a banner-to-a-settings-tab is what's being
   upgraded, not something to keep alongside a real walkthrough.
2. **Build as a new set of routes/pages in `account.js`'s existing
   vanilla-JS structure, or introduce a small framework for this one
   flow?** Recommendation: extend `account.js` as-is — introducing React
   or a bundler step for one flow is a bigger, separate call, and
   `account.js` already proves this data model works without one.
3. **Does a web signup without ever installing anything need to see the
   coding-agent/local-only steps at all, even as a "here's what the
   desktop app adds" teaser?** Recommendation: no — out of scope, keep
   web onboarding scoped to what web can actually do.

## Part B — Hosted-to-local carryover

### What's there today (and why "import" doesn't already do this)

- `useAplyxState.ts` resolves the data source **once per session**: local
  install if found, hosted session as fallback, nothing otherwise. There
  is no mode where both are consulted.
- `EntryScreen.tsx:18-21` — a signed-in session is routed to `/app` or
  `/onboarding/hosted` unconditionally; `EntryScreen.tsx:41` means the
  "Run locally" card is only ever shown when **not** signed in. A user
  can't reach local setup and a signed-in hosted session from the same
  entry-screen visit — they're presented as alternatives, not a sequence,
  even though the footnote (`EntryScreen.tsx:80-83`) already claims "you
  can always start locally and connect an account later."
- Signing in later from Settings while already running locally
  (`SettingsAccountTab.tsx`'s "Sign in" button) *is* possible and does
  flip `useAuth()`'s `status` to `"signed-in"` — but nothing consumes
  that to pull anything down. `useAplyxState.ts`'s "local wins" rule
  means the hosted profile and resume just become permanently
  unreachable dead data for that session.
- `ImportOrFreshStep.tsx:66-76` ("Import your existing account details")
  only exists inside the *hosted* wizard (no local install found) and
  only skips forward past the hosted wizard's own `profile` step — it
  never writes a local file. `handleImport` (`:41-58`, "Import from this
  machine") is the opposite direction: local → hosted, not hosted →
  local.
- The `local/` wizard (`LocalWizard.tsx` and every step under
  `routes/onboarding/local/`) has zero references to Supabase, hosted, or
  session state (confirmed by grep) — it has no way to even know a
  hosted profile exists, let alone offer to use it.

So "connect an account later" is a real footnote promise with no code
behind it yet.

### Proposed design

**Trigger points** — both need to lead to the same pull, not two
different ones:
- The local wizard's very first step, if a Supabase session is already
  active (i.e. someone signed in once, then chose "Run locally" some
  other time, or a returning local install's cached session is still
  valid) — offer "We found an account with saved data — use it?" before
  `ProfileStep.tsx` starts.
- `SettingsAccountTab.tsx`'s "Sign in" success path, when running
  locally — after sign-in completes, check for a non-empty hosted
  profile the same way `ImportOrFreshStep.tsx:36-38` does, and if found,
  offer the pull as a one-time action rather than doing it silently
  (silent overwriting of whatever's already in local config is exactly
  the kind of surprise this project's own write-discipline rules
  guard against elsewhere).

**What the pull actually does**, reusing existing pieces on the local
side wherever possible:
1. Read all `FIELD_IDS` from `profiles` via `SupabaseAdapter.
   readProfileField` (same 18 fields `ImportOrFreshStep.handleImport`
   already reads, just in the opposite direction) and write each through
   the local wizard's own field writer (the `writeSafeField`/
   `profileLinks.ts` paths `OnboardingWizard.tsx` already uses) instead of
   a new one.
2. Read the 3 preference-array fields (`role_keywords`,
   `preferred_locations`, `target_companies`) out of `profiles.
   preferences` (jsonb) and write them into `targets.json`'s existing
   top-level arrays.
3. Download the resume PDF from the `resumes` storage bucket
   (`<user_id>/<filename>`, listable via the Supabase JS client's
   `storage.from("resumes").list()`) to `data/resumes/`, then call the
   **existing** `convertResume(root, stem, description, force)`
   (`bridge.ts:257`) — the same function the local wizard's own
   `ResumesStep.tsx` calls after a manual upload — to produce
   `resume.json`. No new resume-parsing code needed; this only needed the
   download step, which didn't exist.
4. Do **not** attempt to pull `gpa`, `citizenship_status`, or
   `currently_enrolled` — see the schema gap below; there's nothing
   hosted-side to pull yet.

### The schema gap this plan doesn't get to skip

`gpa`, `citizenship_status`, and `currently_enrolled` live only in local
`safe_fields` (`targets.example.json:124,127-128`) — no `profiles` column,
no field in `FIELD_IDS`, no UI anywhere, hosted or local wizard, ever sets
them. This is a pre-existing, already-documented gap
(`docs/hosted-no-agent-tiers-plan.md:183-187,343-345,394-396`), not
something this plan introduces — but a hosted-to-local pull makes it
newly visible: a user who fills in a hosted profile, then pulls it down
locally, will land with these three fields still blank, exactly as if
they were new, and won't necessarily know to go set them by hand.

**Options:**
1. **Add the three columns now** (a small additive migration, same
   pattern as `0019_profile_demographics_columns.sql`) and add them to
   `FIELD_IDS`/`PAGES` so both wizards and the web form collect them.
   Closes the gap for good, but is schema + UI work on top of this plan's
   own scope.
2. **Leave the gap, but surface it** — after a pull, show a message
   naming these three fields specifically as "not synced, set locally,"
   distinct from a normal empty-profile state.
3. **Leave the gap silent**, matching today's behavior (nothing anywhere
   currently tells a user these three fields are local-only either).

**Recommendation: option 1** — this plan's whole point is field parity
between hosted and local; leaving three known-missing fields out of a
"parity" project just relocates the same gap that was already flagged as
worth closing "before Tier 1 ships" in the other plan. If the operator
wants to keep this plan smaller, option 2 is the honest middle ground.

### Open decisions — Part B

1. **Silent auto-pull vs. an explicit offer the user accepts?**
   Recommendation: explicit offer, both trigger points — a background
   overwrite of local config a user might have already started editing
   is the wrong default.
2. **What happens to local data that already exists when a pull is
   accepted** — merge (hosted fills only blank local fields), overwrite
   (hosted wins outright), or block (refuse if local profile is already
   non-empty, force the user to pick one manually)? Recommendation:
   overwrite, but only after showing a diff-style confirmation ("this
   will replace your saved location, currently 'Austin, TX', with
   'Seattle, WA'") — merge silently hides which value survives, block is
   friction for the common case (local was still the empty wizard
   default).
3. **Does completing a hosted-to-local pull mark `onboarding_completed`
   locally**, skipping the rest of the local wizard (agent detection,
   Discord, extension) entirely, or does it only fill the `profile`/
   `resumes` steps and still walk the remaining local-only steps?
   Recommendation: only fill profile/resumes — the coding-agent/
   environment/Discord steps still need real per-machine answers a
   hosted profile has no way to supply.
4. **Resolve `gpa`/`citizenship_status`/`currently_enrolled`** — see
   above; this is the same open question `hosted-no-agent-tiers-plan.md`
   already has outstanding, now shared by two plans.

## Suggested build order

Independent enough to ship separately, and Part A is materially smaller:

1. Part A (web-first onboarding) — reuses existing, proven pieces; the
   only genuinely new code is the resume-upload UI and wiring the
   sequence into `account.js`.
2. The `gpa`/`citizenship_status`/`currently_enrolled` migration (small,
   and unblocks calling Part B a real parity fix rather than a partial
   one).
3. Part B (hosted-to-local pull) — the larger, more state-sensitive piece
   (file writes to a local install, merge/overwrite semantics, the resume
   download+convert round trip).

## What this plan does NOT cover

- Any change to `useAplyxState.ts`'s "local wins" precedence rule for
  ongoing app state (job registry, applied jobs, review queue) — that
  sync already works (`SupabaseAdapter.loadState()` is implemented, not a
  stub, contrary to a stale claim in `docs/supabase-user-data-plan.md:37`)
  and is out of scope here; this plan is only about onboarding-time
  profile/resume data.
- Local-only settings with no hosted equivalent by design — Discord
  webhook config, coding-agent/harness choice, extension bridge token,
  session caps, job-board target lists. These are per-machine or
  per-preference settings, not personal data; nothing here proposes
  syncing them.
- Any hosted-side structured-resume storage (a `resume.json`-shaped
  column/table). The pull direction in this plan (hosted PDF → local
  convert) sidesteps needing one; a future *local → hosted* structured
  sync would need to solve that separately if ever wanted.
- Billing/paid-tier gating of any of this — everything above applies
  equally regardless of the account-tier work tracked elsewhere.

## Critical files

- `src/site/account.js`, `account.html` — where Part A's new sequence
  lands, alongside the existing Profile/Activity/Search tabs
- `src/core/src/onboarding/fields.ts` — the 18-field/3-array schema both
  parts read from; the field-parity migration (if chosen) adds to this
- `src/tauri/src/routes/onboarding/hosted/*.tsx` — the already-working
  steps Part A ports to web
- `src/tauri/src/routes/onboarding/local/*.tsx`, `LocalWizard.tsx` —
  where Part B's pull offer is inserted
- `src/tauri/src/routes/shell/SettingsAccountTab.tsx` — the other Part B
  trigger point (sign-in while already running locally)
- `src/tauri/src/lib/bridge.ts` (`convertResume`, `getMasterResume`/
  `setMasterResume`) — reused as-is by Part B, not reimplemented
- `src/core/src/adapters/supabase.ts` (`readProfileField`,
  `writeProfileField`, `readHostedReadiness`) — reused by both parts
- `src/tauri/src/lib/useAplyxState.ts` — the precedence rule Part B has
  to work around, not replace
- `src/supabase/migrations/0019_profile_demographics_columns.sql` — the
  precedent migration shape for the `gpa`/`citizenship_status`/
  `currently_enrolled` fix, if chosen

## Open questions for the operator

- Build order: Part A first as proposed, or reverse, given Part B is the
  half that actually matches "sign in and have data carry over"?
- Fix the `gpa`/`citizenship_status`/`currently_enrolled` gap now (Option
  1 above), or accept it and revisit alongside
  `hosted-no-agent-tiers-plan.md`'s own open item on the same gap?
- Part B's conflict handling: overwrite-with-confirmation (recommended),
  merge, or block — a real UX call, not obvious from the code alone.
- Should the web walkthrough auto-start right after signup (before email
  confirmation resolves), or only after the user actually confirms and
  signs in for the first time?
