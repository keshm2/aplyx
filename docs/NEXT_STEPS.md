# Next steps

This is a living, high-level "what's real and what's left" doc. For the
full phase-by-phase history and the authoritative current-phase pointer,
read `docs/PLAN.md` (gitignored, local-only) and `AGENTS.md`'s "Phase
status" block; this doc summarizes and points forward, it doesn't
replace either.

## What's built and working right now

aplyx is a local-first job-application agent (TUI + Tauri desktop app +
browser extension) that scrapes 15+ job sources deterministically
(Ashby, Lever, Greenhouse, Workday, SmartRecruiters, Workable, JazzHR,
Amazon, Oracle Recruiting Cloud, Eightfold, Apple, Google, Stripe, Gem,
The Muse, plus Playwright-scraped LinkedIn/Indeed/Handshake/Wellfound),
runs every candidate through a deterministic, non-LLM fit gate before
any tailoring happens, tailors a resume and cover letter per posting,
and applies via Playwright with mandatory pre-submit field verification
and fail-closed handling of CAPTCHAs/ambiguous outcomes. Workday now
goes through full auto-apply (account creation, Vault-backed credential
storage, an Account Center screen, and Gmail-OAuth-based verification-
mail retrieval via the hosted `workday-verification-worker`), not just
review-only. A hosted Supabase backend backs a free account tier
(desktop↔web sync, Realtime dashboard, hosted-to-local profile/resume
carryover) and the first increment of a hosted `review_only` pipeline
(Phase 17, live-verified against a real test account). Employer-outcome
tracking (Applied/OA Sent/Interview/Offer/Rejected, inbox-derived) is
built and shipped, hosted-only. The marketing site (aplyx.app) is built
and content-complete across all six pages, pending DNS. Current release:
`1.0.2b`.

## Known bugs (real, unfixed)

- **Workday field-mislabeling**: the "Email Address" field on at least
  one real Workday tenant gets filled with a street address instead of
  an email value. Needs a real repro + fix in
  `src/scripts/runtime/approve_submit_workday.py`'s field-mapping logic
  (`SAFE_FIELD_LABELS`-style label matching): check whether the label
  match is too loose (matching "Address" fields against something meant
  for "Email Address") before assuming it's a one-off tenant quirk.
- **Google OAuth refresh-token 7-day expiry risk** on the
  `workday-verification-worker`'s Gmail connection
  (`src/supabase/functions/mail-oauth-start/`,
  `mail-oauth-callback/`). If the Google Cloud OAuth consent screen for
  this app is still in "Testing" publishing status, Google expires
  refresh tokens after 7 days regardless of use, which would silently
  break Workday verification-mail retrieval for any connected user a
  week after they connect. Confirm the app's current publishing status
  in Google Cloud Console and either move it to production/verified
  status or add an explicit re-connect prompt before this bites a real
  user.
- **`email-tracking-worker`'s IMAP fetch path has never been verified
  against a real mailbox end-to-end**: the cron → `net.http_post` →
  Vault-sourced-header round trip is confirmed live, but no test IMAP
  credentials were available to confirm the actual mail fetch/classify
  step works against a real inbox. Needs a real test account.
- **Pricing/marketing drift**: `docs/website.md` itself flags that
  "cover-letter tailoring" reads as paid-only in the pricing page's copy
  while `/features` still lists it as a base, non-gated capability,
  unresolved: pick one and fix the other. The site's inbox-status-
  tracking feature is still marked "Planned" on `/features` and
  `/pricing` even though it shipped (2026-08-19 → 2026-08-21,
  hosted-only), and the marketing copy needs a pass to catch up with what's
  actually live.

## Queued phase work (needs explicit operator go-ahead per this repo's one-phase-at-a-time rule)

- **Rest of Phase 17**: real hosted onboarding, quotas/abuse controls,
  encryption-at-rest + deletion path, wiring the GitHub Actions schedule
  for real (`.github/workflows/hosted-worker.yml` exists but isn't
  relied on yet).
- **Phase 12**: cost/model tiering, not built.
- **Phase 18**: security audit + beta ship gate, not started.
- **Fly.io side of the worker-host bake-off** (`docs/online-hosting.md`):
  only the Upstash Box side has been spiked; needed before
  `hosted-paid-tier-plan.md`'s worker-host decision is final.

## Design docs ready to build from, none started

- `docs/hosted-paid-tier-plan.md`: paid hosted tiers, `hosted_runs`
  queue extension, Stripe billing, usage metering. Partially landed
  (usage-quota schema, migration `0035`) but no billing integration
  exists yet.
- `docs/hosted-auto-apply-plan.md`: hosted `auto_apply` mode. Real
  finding baked in: every real Greenhouse posting tested in the Upstash
  Box spike carried reCAPTCHA, so this plan treats CAPTCHA-bypass as a
  permanent non-goal, not a v1 gap; a meaningful share of hosted
  auto-apply jobs will always fall through to `needs_review`.
- `docs/hosted-no-agent-tiers-plan.md`: Tier 0 (cached job search, no
  backend cost) and Tier 1 (hosted hybrid autofill via a small Google
  Cloud Run service). Backend host decided (Cloud Run); nothing
  provisioned yet.
- `docs/sms-notifications-plan.md`: Twilio SMS mirroring of Discord
  notifications + an optional confirm-before-apply gate. Planning only.
- `docs/discord-field-clarification-plan.md`: real-time Discord DM
  prompt (with buttons/select menus) the moment an application hits an
  unmapped required field, so the user can answer from their phone
  instead of finding out later in the review queue. **Explicitly
  deferred by the user ("skip for now")**: keep as a real, wanted
  future feature, not abandoned; revisit when asked.

## ATS coverage: what's left

- **Oracle and Eightfold vetted-tenant registries are still unbuilt.**
  Only `src/config/workday_vetted_tenants.json` exists (seeded
  2026-08-30); `oracle_vetted_tenants.json`/`eightfold_vetted_tenants.json`
  were explicitly out of scope for that pass. Without them, new Oracle/
  Eightfold tenants keep arriving one research pass at a time instead of
  in bulk, the same problem Workday's registry just fixed for itself.
- **A dedicated research pass across large employers** (banks, Fortune
  500, defense/aerospace, retail) to seed the tenant registries at
  scale: the HTML-recon technique documented in `docs/ATS.md` is cheap
  and mostly works, with a Playwright-network-inspection fallback for
  JS-rendered career sites.
- **Avature**: a distinct ATS found at Bank of America (campus/intern
  recruiting), zero adapter support today. Needs a public-API research
  spike before committing to build one.
- **Citi/BofA tenant leads**: unresolved (a guessed Eightfold PCSX
  query 403'd for Citi; a guessed Avature path 403'd for BofA). Resolve
  with the existing fetch helpers, not hand-guessed URLs.
- **iCIMS, Jobvite, Rippling, Breezy, BambooHR remain deferred for
  cause** (partner-gated APIs, no public API, or a direct ToS
  prohibition on automated access), not research gaps to revisit
  without a materially different access path (a real partner/API
  relationship). See `docs/ATS.md` and `docs/icims-automation-research.md`
  for the full reasoning.

## Business/legal

- **Form a single-member LLC before turning on real billing** and
  storing real user PII in a paid hosted tier, not before
  (`docs/legal.md`). Confirm whether the existing `kredosai.com` domain
  already implies a usable entity.
- **GitHub Pages + Name.com DNS wiring for `aplyx.app`**: the site is
  built and content-complete; enabling Pages and adding the DNS records
  is the only remaining step (`docs/website.md` "Still open").
- **Chrome Web Store submission** for the browser extension (Moss):
  submission material (single-purpose description, per-permission
  justification, privacy policy) is ready; the store listing, developer
  account, and one-time $5 fee are a manual step nobody has taken yet.
  Extension currently only installs via load-unpacked.

## Docs cleanup performed alongside this file

Removed (implemented, superseded, or abandoned working notes; see git
history for full content): `docs/application-status-tracking-plan.md`,
`docs/ats-account-credentials-plan.md`, `docs/supabase-user-data-plan.md`,
`docs/ui-development-plan.md`, `docs/web-onboarding-hosted-sync-plan.md`,
`docs/workday-personal-inbox-plan.md`, root `research-notes.md`, root
`security-analysis.md`, and both copies of `system_architecture.md`
(root and `docs/`, both untracked/gitignored session-notes logs that
stopped being updated before the aplyx rename and the `src/` restructure
, superseded by `docs/PLAN.md` and `docs/CHANGELOG.md`). Kept and, where
needed, patched their cross-references: `docs/ATS.md`,
`docs/website.md`, `docs/icims-automation-research.md`,
`docs/discord-field-clarification-plan.md`,
`docs/hosted-paid-tier-plan.md`.
