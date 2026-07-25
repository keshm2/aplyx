# Changelog

All notable changes to aplyx (formerly Ares) are documented here.
The format is roughly [Keep a Changelog](https://keepachangelog.com/)-style
but trimmed to fit a small in-repo doc.

> Per-`docs/RELEASE.md` is the canonical, deep-dive release
> document for each tagged build. This file is the index.

## [0.9.91a] — 2026-07-24

npm package: `@keshm/aplyx` version `0.9.91-alpha.0`. Full notes:
[`RELEASE.md`](./RELEASE.md).

### Changed

- **TUI: brighter ASCII-art banner gradient in Light mode.** The banner
  was never theme-reactive at all — same violet→maroon gradient in both
  modes, tuned for a dark background, muddy/low-contrast on a light
  one. Added a genuinely different, vivid violet→purple→fuchsia→pink→
  rose→red gradient for Light mode (all fully-saturated stops, no pale
  or near-black ends). Also fixed a second instance of the exact
  React.memo staleness bug found earlier for the banner's wordmark
  variant: `Banner` memoizes on props, so the new gradient has to be
  threaded through as an explicit `gradient` prop (like `accent`
  already is) rather than read from a theme.js function inside the
  component — otherwise switching Dark⇄Light would leave the art
  variant frozen at whichever gradient was live at the banner's last
  resize. Verified live in tmux: switching Theme to Light recolors all
  6 banner rows to the exact new hex values.

## [0.9.90a] — 2026-07-24

npm package: `@keshm/aplyx` version `0.9.90-alpha.0`. Full notes:
[`RELEASE.md`](./RELEASE.md).

### Fixed

- **Critical: `aplyx update` silently failed to actually rebuild the TUI
  whenever a shared-core change was involved** — which was most recent
  releases. `update.py`'s post-update rebuild ran `app`'s (and the
  extension's) own `npm run build` directly, but never rebuilt
  `packages/core` first. `app`'s build is `tsc && npm run bundle`; `tsc`
  type-checks against `@aplyx/core/*`'s `dist/*.d.ts`, and if core's
  source had changed (a new export, a fix) without its dist/ being
  fresh, that type-check failed — silently aborting before the bundle
  step ever ran. Net effect: source pulled down fine, `VERSION` bumped
  fine, but the compiled `dist/cli.js` a user actually runs was left
  **completely untouched**, not just missing the core-dependent parts —
  the whole build never got that far. Reproduced directly (removing a
  core `.d.ts` and running `app`'s own `npm run build` in isolation)
  before landing the fix: rebuild `packages/core` first, matching the
  ordering `install.sh`/`install.ps1` already use. Anyone who's been
  running `aplyx update` on a shared-core-touching release may need to
  run it twice (Python doesn't hot-reload — the *first* run picks up
  this fix's own source but still executes with the old, already-loaded
  broken rebuild order; the second run does it right) or just re-run
  the full installer directly once.
- **TUI Settings: "Theme → Light" explain text implied it would change
  the terminal's own background color.** It doesn't and never has —
  Light mode only recolors aplyx's own accent/status text to stay
  readable if the terminal already has a light background set via the
  terminal app's own profile. Reworded to say so explicitly.
- **Desktop onboarding: the profile step's 8 internal sub-pages had no
  transition effect at all** — a flat instant swap, unlike every other
  step in the wizard. Since "Your profile" is a large fraction of the
  post-"let's get to know more about you" flow by page count, this
  likely read as "nothing after that splash has any effects." Added the
  same fade-in used elsewhere (`wizard-step-in`, keyed per page) — a
  single-phase fade rather than the outer wizard's full freeze/out/in
  choreography, to avoid entangling with this component's own
  independent loading-state handling.

## [0.9.89a] — 2026-07-24

npm package: `@keshm/aplyx` version `0.9.89-alpha.0`. Full notes:
[`RELEASE.md`](./RELEASE.md).

### Added

- **TUI: "Install desktop app" in Settings.** A new Desktop app section
  lets anyone who skipped it during setup install it later without
  re-running the whole installer — leaves the TUI, hands off to
  `install_desktop.sh`/`.ps1` on the normal screen (its own interactive
  prompts, progress bars), then returns to a fresh `aplyx` launch when
  done. Already installed? The row shows dimmed with a green
  "✓ app is already installed (vX.Y)" note beneath it and Enter is a
  no-op — detected via a small marker file
  (`~/.aplyx/desktop_installed`) both installer scripts now write on
  success, read fresh on every render (no caching, no restart needed to
  pick up a manual install).

### Fixed

- **Windows: the desktop-app install offer (and the TUI-from-source
  build step) could be silently skipped**, going straight to "done"
  with no visible prompt or error — reported live: `npm install -g
  @keshm/aplyx` worked fine, but `install.ps1`'s own `Get-Command npm`
  check (gating both steps) came back empty when the script ran as a
  spawned subprocess (via the npm-installed `aplyx` command's own
  bootstrap, or the `irm | iex` one-liner), even though `npm` clearly
  resolved in the interactive shell. Root cause: a spawned subprocess's
  `$env:PATH` is a snapshot from its parent's process start, which can
  lag behind the registry — compounded by `-NoProfile`, which also skips
  any PATH customization a profile script would normally add. Fixed by
  refreshing `$env:PATH` from the registry (Machine + User) right after
  each script sets its working directory, in both `install.ps1` and
  `install_desktop.ps1` — the same fix already applied elsewhere in this
  file for a freshly-winget-installed Python, just never extended to
  Node/npm detection.

## [0.9.88a] — 2026-07-24

npm package: `@keshm/aplyx` version `0.9.88-alpha.0`. Full notes:
[`RELEASE.md`](./RELEASE.md).

### Fixed

- **Windows install completely hung** at the agent-definitions step
  (right after the resumes-folder message), every time, via both the
  `irm | iex` one-liner and the npm-installed `aplyx` bootstrap (both
  ultimately run `install.ps1`) — reported stuck with no way past it.
  Root cause: a helper function named `Py` called the real Python
  launcher via `& $py[0] ...`, and when `Find-Python` picked the `py`
  launcher (`$py[0]` -eq `"py"` — the standard outcome for anyone who
  installed Python from python.org or via winget, i.e. most Windows
  users), PowerShell's case-insensitive command resolution preferred
  the function over the external `py.exe`, so `Py` called itself
  instead of Python — recursing until the interpreter's call-depth
  limit tripped (`CallDepthOverflow`). Renamed to `Invoke-Python`, a
  verb-noun name that can't collide with a real Windows command.
- `install.sh`/`install_desktop.sh` and their PowerShell equivalents'
  npm-install/build steps (which have no byte total to track) now show
  an indeterminate sliding bar — `[..===..........]`, bouncing back and
  forth — instead of a bare rotating `|/-\` spinner character, so every
  long-running installer step reads as one consistent bar-based system
  rather than two different progress idioms.

## [0.9.87a] — 2026-07-24

npm package: `@keshm/aplyx` version `0.9.87-alpha.0`. Full notes:
[`RELEASE.md`](./RELEASE.md).

### Added

- **Desktop: redesigned first-run onboarding.** A narrative intro
  ("Welcome to Aplyx." → "Let's set up your preferences..." → "Now,
  let's get to know more about you.") now precedes the setup
  questions, each beat a full-bleed auto-advancing splash. The wizard
  reuses the app shell's own two-phase route-transition choreography
  (freeze → animate out → swap → animate in) instead of a plain
  fade-on-mount, content is vertically centered instead of top-aligned,
  and a new Preferences step (theme family/mode/font, reusing
  Settings' own controls) applies live and carries through the rest of
  onboarding and the app.
- **TUI: Theme (dark/light), 24-hour clock, and Reduced motion**
  Settings fields (Environment section), applied in-session — no
  restart needed. Light mode uses hand-tuned darker accent/status
  hexes rather than the dark palette's named ANSI colors, which are
  close to unreadable on a light background.
- **GitHub Copilot CLI gets real subagent support.** `.github/agents/*.md`
  are generated the same way `.claude/agents/` already was; a runtime
  probe (`copilot --help`) invokes `copilot --agent <name> --prompt
  ...` when the installed CLI supports it, falling back to the
  existing inlined-prompt path otherwise.
- **Codex CLI subagent scaffolding** (`.codex/agents/*.toml`),
  generated for forward-compat. Not yet wired into actual invocation —
  `codex exec` (non-interactive mode) has no way to spawn a named
  subagent from a registry file (tracked upstream as
  openai/codex#15250); see `AGENTS.md`'s harness capability matrix for
  the full breakdown of what each harness can and can't do.
- **Installer download progress.** `install.sh`/`install_desktop.sh`
  (and their PowerShell equivalents) now show a real byte-tracked
  `[====>.......]  10MB/149MB` bar for downloads, and a spinner for
  indefinite steps (npm install/build) instead of silent multi-minute
  pauses.

### Fixed

- **TUI theme-mode colors could silently freeze at launch-time values.**
  Four spots computed a color from `theme.accent`/`theme.good`/etc.
  once at module load or component mount instead of reading it fresh,
  so switching Settings' Theme field from Dark to Light (or back) left
  them stuck on the old palette: the AUTO-mode sparkle badge and
  default-gradient progress bars (`SPARKLE_GRADIENT`), StatusScreen/
  HistoryScreen's outcome colors (`statusColor`), the update-prompt
  box's border wave and fallback color (`UpdateBox`'s `PURPLE`/
  `blend()`), and the banner's wordmark title on narrow/short terminals
  (`Banner` was `React.memo`'d on `{columns, rows}` only, so a
  theme-only change never triggered a re-render). All four now read
  the mutated `theme` object live; verified in a running terminal that
  switching Dark ⇄ Light repaints every one of them without a restart.

### Removed

- A stale, superseded rebrand-strategy planning doc
  (`docs/product-positioning-and-rebrand-plan.md`) proposing name
  candidates that were never adopted.

## [0.9.85a] — 2026-07-24

npm package: `@keshm/aplyx` version `0.9.85-alpha.0`. Full notes:
[`RELEASE.md`](./RELEASE.md).

### Added

- **Logo rebrand.** Replaced the old tile-grid lowercase "a" mark with a
  new gradient badge holding a white "AX" monogram, based on an
  operator-supplied reference image — used verbatim (isolated from its
  background programmatically, not hand-traced) for both the in-app
  mark and the full macOS/Windows/Linux app icon set, with proper
  icon-canvas margin matching real macOS app icons instead of filling
  the canvas edge to edge.
- **Desktop: native-feeling macOS window chrome.** The title bar is now
  an overlay over the app's own themed background instead of the OS's
  default gray strip, draggable via a themed border-lined strip at the
  top of the window.

### Fixed

- **Google sign-in (and email-confirmation links) silently failed** —
  the deep-link handler passed the whole callback URL to Supabase's
  code-exchange call instead of just the auth code, so a successful
  Google auth just bounced back to the sign-in screen with no visible
  error.
- **Desktop window dragging worked only intermittently** — root cause
  was Tauri's permission system silently denying the drag command;
  fixed by granting `core:window:allow-start-dragging` explicitly.
- Desktop: the app shell's sidebar divider ran straight through the new
  title bar's border line instead of stopping at it.
- Desktop: Home dashboard's "Welcome back" / sign-in status line is now
  centered and fades in with the rest of the dashboard.

## [0.9.8a] — 2026-07-23

npm package: `@keshm/aplyx` version `0.9.8-alpha.0`. Full notes:
[`RELEASE.md`](./RELEASE.md).

### Added

- **Shared job-postings cache.** A Supabase `job_cache` table (~47
  curated companies, public read) refreshed hourly via a new GitHub
  Actions workflow backs job search for both UIs instead of hitting
  every ATS live on each query — per-company-capped Postgres RPC so
  one company can't starve a query's result budget. Auth/account
  storage lives on a separate Supabase project from the cache.
- **Pagination (both UIs).** Jobs search results default to 25 per
  page, user-configurable — dropdown on desktop (persisted), `[`/`]`
  keys plus a new `APLYX_RESULTS_PER_PAGE` Settings field on the TUI.
- **Desktop: Home "Recent activity" feed** — applied jobs and pending
  review items merged into one reverse-chronological list on the
  dashboard.
- **Desktop: Profile settings page.** Every onboarding field (all 8
  pages) is now editable from Settings → Profile without re-running
  setup.
- **Desktop: top-level error boundary** — a render error anywhere no
  longer unmounts the whole app with no recovery.

### Fixed

- **Amazon dominated search results**, other sources rarely appeared —
  a shared per-source deadline let one slow source starve the others;
  deadlines are now decoupled per source.
- **Results were silently truncated below the configured page size.**
- **A cache pre-filter bug excluded valid prefix matches**, causing
  near-identical queries (e.g. "software engineering intern" vs.
  "software engineer intern") to return very different result counts.
- **Search never covered the shared cache's full company list** — only
  the user's personal targets were searched, silently missing every
  shared-cache-only company (e.g. SpaceX). This was the single biggest
  fix in this release.
- Cache silently dropped personally-configured companies not present
  in the shared list; narrow queries (e.g. "intern") returned
  near-zero results due to an overly tight per-company cap.
- Desktop: redundant double-animation on route changes, an
  `onAnimationEnd` bug that could end a route transition early on a
  bubbled child event, and un-animated pop-in on a route's first visit
  while its chunk downloaded.
- Desktop: a missing-field crash in the new Recent-activity feed
  (older `review_queue.json` entries predate a field rename) that
  looked like the app hanging after "Run locally."

### Changed

- Desktop: the "preferred locations only" filter is temporarily
  offline pending a redesign now that pagination has landed — search
  still covers the whole US either way.

## [0.9.75a] — 2026-07-22

npm package: `@keshm/aplyx` version `0.9.75-alpha.0`.

### Added

- **Desktop app: Phase 14C, desktop UI refinement and theming — done.**
  Home is now a real dashboard (stat cards + one derived "next action"
  card instead of a flat checklist). A 4-family theme system ships in
  Settings: **Calm Cobalt** (new default, cool blue-tinted neutrals),
  **Sage Slate**, **Graphite Cyan**, and the original palette preserved
  verbatim as **Aplyx Classic** — mode (light/dark/system) and family are
  independent axes, every family carries the full token contract
  (`desktop/src/styles/tokens.css`, `desktop/src/lib/uiPrefs.ts`).
  Resumes moved from a flat inline-action list to the same list+detail
  split Jobs/Review/History already use; Review and History now
  auto-advance to the first pending / newest item instead of landing on
  a blank detail pane.
- **Desktop app: three more bundled font options.** Alongside the
  existing System/Geist choice, Settings now also offers **Inter**
  (dense/tabular product UI), **IBM Plex Sans** paired with **IBM Plex
  Mono** (enterprise/analytical tone), and **Atkinson Hyperlegible Next**
  (accessibility/readability-first) — all OFL-licensed, self-hosted via
  `@fontsource`/`@fontsource-variable` (no CDN fetch, works fully
  offline), same pattern as Geist. System stays the default.

### Fixed

- **The desktop nav rail (and every other in-app link) rendered with the
  browser-default underline** — no stylesheet anywhere reset
  `text-decoration` on `<a>`. Fixed globally in
  `desktop/src/styles/base.css`.

## [0.9.7a] — 2026-07-17

npm package: `@keshm/aplyx` version `0.9.7-alpha.0`.

### Added

- **Desktop app (early preview) — Tauri + React, macOS/Linux/Windows.**
  A graphical alternative to the TUI, opt-in during install, still
  catching up on features (Jobs/Review/History/Resumes are
  placeholders — Home and Settings are real). Local mode shells out to
  the same Python helpers the TUI uses (no state written directly from
  TypeScript); hosted mode talks to a new Supabase backend directly.
  Landing chooser (Run locally / Sign in), a local setup wizard sharing
  the TUI's 8-page onboarding schema, a hosted wizard with
  email/password + Google sign-in, and an app shell with a Settings
  screen (account, local-install status, theme, font).
- **Hosted accounts (optional, Supabase-backed).** Sign in to sync your
  profile across devices. `supabase/migrations/0001_init.sql` +
  `0002_onboarding_completed.sql` — every table RLS-scoped to
  `auth.uid()`, a status-transition guard mirroring the local engine's
  never-downgrade rule, a private per-user resume storage bucket.
  `aplyx://auth-callback` deep link handles both the email-confirmation
  and Google OAuth redirects, since a desktop app can't sit at a
  `localhost` URL to receive them.
- **All three installers can now also install the desktop app**, opt-in
  alongside the TUI. New `scripts/install/install_desktop.{sh,ps1}`
  first check this checkout's matching GitHub release for a prebuilt
  bundle — built once on CI (`.github/workflows/desktop-release.yml`,
  `tauri-apps/tauri-action` across macOS/Linux/Windows runners) — and
  just download + install that: no Rust, no Xcode Command Line Tools,
  no Visual C++ Build Tools, nothing beyond curl, the same as
  installing any other compiled app. Only falls back to compiling from
  source (detects Rust + OS-native GUI build deps, asks before
  installing anything missing) when no matching prebuilt bundle exists
  yet. Installs the platform-native way either way — `/Applications`
  on macOS (falling back to `~/Applications` rather than requiring
  sudo), `apt`/`dnf`/an AppImage + app-launcher entry on Linux, a
  no-admin-prompt NSIS installer on Windows. Never fails the main
  install — the TUI stays the reliable baseline either way. `aplyx
  uninstall` removes the desktop app too, if present.
- Settings (both TUI and the new desktop app) show a small, faded
  `build <version>` marker — one shared constant
  (`packages/core/src/version.ts`) so both surfaces always agree.
- Company/location preference fields (both onboarding wizards) are now
  search-and-tag: fuzzy search over a suggestion pool, selections
  render as removable chips that wrap into rows instead of overflowing.

### Fixed

- **The hosted and local onboarding wizards replayed on every sign-in
  or launch**, even for a fully set-up returning user — local mode
  already tracked a completion flag but nothing read it; hosted mode
  had no tracking at all. Both now skip straight to the dashboard for
  a returning user, and a persisted hosted session resumes into the
  app on relaunch instead of re-showing the landing chooser.
- **Coding-agent detection was flaky (~50% miss rate)** for a
  Finder/Dock-launched desktop app — it only searched `$PATH`, which is
  minimal for a GUI-launched process (no Homebrew/nvm/volta entries).
  Now also probes the common install locations directly.
- **`packages/core` had no build hook** — the TUI's own installer build
  step silently depended on it already being built from a prior run,
  which is never true on a fresh clone. Both installers now build it
  explicitly first.
- Supabase's built-in mailer is unreliable/rate-limited by design (not
  meant for production); retrying a signup for an already-registered,
  unconfirmed email silently did nothing. Surfaced clearly now, with a
  working resend action.

### Changed

- Desktop app's palette reworked to match the TUI's violet/pink
  identity (was an unrelated warm-orange placeholder scheme); light
  theme is a warm beige, dark matches the app icon's near-black plum.
  Real brand logo (block lowercase "a") replacing the placeholder mark.
- The TUI's fuzzy-match autocomplete (`app/src/ui/autocomplete.ts`)
  moved to `packages/core/src/autocomplete.ts` so the desktop app's tag
  search uses the identical matcher, not a second implementation.

## [0.9.1a] — 2026-07-16

npm package: `@keshm/aplyx` version `0.9.1-alpha.0`.

### Security

- **A real home address shipped as a placeholder** in
  `app/src/ui/onboarding/pages.ts` and reached both GitHub and npm
  (0.9.0-alpha.0/.1/.2). Purged from source and from git history
  (`main` rewritten, tag `v0.9.0a` moved). **The affected npm tarballs are
  still published** — unpublish them and use 0.9.1a. Placeholders must never
  contain real data: this file is committed and compiled into the package.

### Added

- **Interest letters (Letters tab).** When an application asks "Why do you
  want to work here?", aplyx no longer invents an answer: it parks the job
  and carries on. Write your own answer, or press `g` to have the new
  `@interest-letter` agent draft one grounded strictly in your resume and
  the JD — you edit and approve before anything is submitted. Approving is
  what lets the next run apply. New `scripts/state/interest_letter.py` store
  and `scripts/runtime/generate_interest_letter.py`.
- `gender` in setup/Settings, an `email` field, a graduation-date step, and
  a Settings action that opens the resumes folder on any OS.
- Coding-agent row now reads "Auto (detected and using <agent>)".

### Fixed

- **Setup discarded what you typed** unless you pressed Enter — tabbing away
  from target roles/companies silently lost them.
- Fresh installs no longer prefill template junk (`your.email@example.com`,
  `City, ST`) into the wizard, and no longer preload preferred locations.
- Date of birth auto-inserts `/` and refuses impossible dates as you type.
- Location autocomplete no longer silently swaps a typed city for a fuzzy
  match; ~150 metro suburbs added.
- **Search missed real postings**: "software engineering intern" now matches
  "Software Engineer Intern". Preferred locations sort to the first page.
- **The live-run screen misreported the phase** (and could claim "Scraping"
  during an apply); `x` now also stops runs the TUI didn't start.
- Dropdowns are selected by exact match only, with a mandatory pre-submit
  form check — typing "Seattle" could previously commit "Settle".

### Changed

- Harness-specific argv now lives only in
  `scripts/runtime/harness_adapter.py`; both the runner and the
  interest-letter generator use it, so all four coding agents stay in sync.
- `MIN_COLUMNS` 54 → 76 (the 7-tab row must not wrap).

## [0.9.0a] — 2026-07-15

npm package: `@keshm/aplyx` version `0.9.0-alpha.0`. Full notes:
[`RELEASE.md`](./RELEASE.md).

### Added

- Guided first-run onboarding wizard (`app/src/ui/onboarding/`) —
  multi-page form, live autocomplete, per-field write-through with
  resume-in-place, replaces the old readline `wizard.ts` prompts.
- Settings gained a "Company targets" section (roles/levels/seasons/
  locations/company slugs now live-editable) and new Personal info
  fields (location, zip, address, ethnicity, demographics).
- Greenhouse as a 4th toggleable Jobs-search source, alongside Ashby/
  Lever/Workday.
- Jobs search: posted-date column + default recency sort, 6-month
  results cutoff, configurable results-per-page (10-75,
  `APPLYR_JOBS_PER_PAGE`), redesigned fixed-column results table,
  fuller detail pane (company/source/location/posted + fit gate).

### Changed

- LinkedIn/GitHub profile fields store as a bare username, not a full
  URL (auto-migrates existing configs on read).
- Preferred location is now a sort/display preference in the fit gate,
  not a status-threshold input (`DECISION_VERSION` → `phase4-v4`).
- Sidebar: greeting/clock moved to the app header (all tabs); sidebar
  itself hidden on the Jobs tab for more table width.
- npm bootstrap installs the core automatically, no Y/n prompt
  (`--no-core`/`APPLYR_SKIP_CORE=1` to opt out).
- `docs/SETUP.md` trimmed to point at the wizard/Settings instead of a
  full field-by-field walkthrough.

### Fixed

- Jobs search title matching: a fuzzy-matching regression let
  "Internal"/"International" postings match an "intern" query.
- Windows installer: `install.ps1`'s post-bootstrap self-re-invoke used
  the wrong path (`scripts\install.ps1` instead of
  `scripts\install\install.ps1`), breaking the one-line installer on a
  genuinely fresh machine.
- Board-fetch failures now name the failing slug(s) instead of a bare
  count, and retry once before giving up.
- Results table: a long job title could overrun the posted/location/fit
  columns after it.
- Onboarding wizard's resume step: `Enter` is intercepted there for
  conversion, not "next," so the actual skip (`Shift+→`) went
  unnoticed; `Escape` now also skips, and the hints/step text spell
  out both "open folder" and "skip for now" explicitly.
- Installers (`install.sh`/`install.ps1`) no longer hard-fail the
  instant `jq`/`python3`/`pypdf` is missing — they now offer to install
  everything missing (or exit cleanly if declined).
- Windows installer: the new `pypdf` detection check could itself crash
  the installer with an unhandled exception on newer PowerShell
  versions (missing `try`/`catch` around a native command expected to
  fail exactly when `pypdf` is absent).

## [0.8.43a] — 2026-07-14

npm package: `@keshm/aplyx` version `0.8.43-alpha.0`.

### Added

- **Dedicated live-run screen** — a phase checklist (Scrape → Fit-gate →
  Tailor → Apply → Report) with an animated progress bar, driven by new
  progress markers the job-scraper agent prints at each phase boundary
  and per application attempt (`[apply] <title> @ <company>` — see
  `agents/bodies/job-scraper.md`). The screen now shows which company
  and role is currently being applied to, live.
- **Stop / correct-and-continue for a run in progress.** `x` arms a
  stop (press again to confirm); `c` on the confirm prompt instead
  queues a correction that stops the run cleanly and restarts it with
  the instruction folded in. Neither fires while typing. Backed by a
  real SIGTERM/SIGINT handler in `run_job_agent.py` that kills the
  whole harness process group on POSIX; Windows uses `taskkill /T /F`
  from the TUI side instead.
- **"AUTO" sparkle effect** — animates through a purple → white blend
  (matching the update-prompt box's traveling ring) everywhere "AUTO"
  appears in the TUI.
- **Cycling activity glyph** (`.` → `·` → `•` → `*`) on the
  running-status title and the current phase's checklist bullet.

### Changed

- **`needs_review` fit-score floor raised from 45 to 70** —
  `evaluate_job_fit.py`'s `decision_version` moved `phase4-v2` →
  `phase4-v3`.
- **Discord notifications and the review queue / history screens now
  link to the direct application-form URL** (`apply_url`) instead of
  the generic job-listing URL.

### Fixed

- **Fast-failing runs left the TUI stuck on "waiting for session
  log…"** with no way to see why. The log tail is now read
  synchronously the instant a run's process closes, instead of relying
  solely on a 1-second poll that a sub-second failure could outrun.
- **The progress bar could render blank** until phase-detection matched
  something in the log; it's now always visible during a run, with a
  minimum-fill floor.
- **Sparkle animation color artifacts** — a circular gradient wrap
  could interpolate directly between non-adjacent palette colors
  (maroon → violet), showing a stray green/blue tint. Switched to a
  ping-pong reflection, which only ever interpolates between adjacent
  colors.

## [0.8.42a] — 2026-07-14

npm package: `@keshm/aplyx` version `0.8.42-alpha.0`.

### Added

- **Resumes screen (6th TUI tab, `aplyx resumes`, or the welcome
  menu).** Shows all 6 filenames `resume-tailor.md` actually reads,
  each marked ready / needs conversion / not added; `o` opens
  `data/resumes/` in Finder/Explorer/xdg-open; `c` converts a PDF
  missing its markdown counterpart on the spot via the new
  `scripts/state/convert_resume.py` (`pypdf` text extraction, added to
  `requirements.txt`). A `(N)` badge on the tab bar surfaces pending
  conversions, matching the existing Review badge.

### Fixed

- **Auto-update could silently strand an already-installed schedule on
  a stale script path.** The 0.8.4a `scripts/` reorg was the first
  update to ever relocate the runner script itself; the tarball-overlay
  updater never deletes old files, so a launchd/schtasks entry written
  before the reorg kept invoking the old flat `scripts/run_job_agent.sh`
  forever — `VERSION` correctly reported current, but the *scheduled*
  pipeline silently never modernized (the interactive TUI was
  unaffected; it rebuilds fresh from source on every update).
  `update.py` now re-runs `scheduler.py install` (fully idempotent)
  after every update whenever a schedule is already present, so this
  class of bug can't recur for anyone past this release.
  **If you already have a schedule installed from before 0.8.4a**,
  one-time fix: run `aplyx` once and accept the update prompt, or
  just re-run the installer — either refreshes the schedule. Simplest
  option: `aplyx uninstall` then reinstall.

## [0.8.041a] — 2026-07-14

npm package: `@keshm/aplyx` version `0.8.41-alpha.0` (the human
marker `0.8.041a` maps to `0.8.41-alpha.0` in strict semver — a
leading zero in a numeric identifier, e.g. `041`, isn't valid semver
and npm strips it silently on publish, so it's set explicitly here
instead).

### Fixed

- **Installer PATH wrapper broke when the install directory was
  renamed or moved.** `scripts/install/install.sh` and `install.ps1`
  generate a tiny launcher (`~/.local/bin/aplyx` on Unix,
  `aplyx.cmd`/`aplyx.ps1` on Windows) that baked in the absolute
  install path as plain text at install time — moving or renaming
  that directory afterward (as just happened during the `0.8.4a`
  restructure: `~/ares` → `~/aplyx`) left the wrapper pointing at a
  path that no longer existed, surfacing as a raw Node
  `MODULE_NOT_FOUND` stack trace with no actionable guidance. Both
  wrappers now fall back through a short list of candidates —
  `$APPLYR_ROOT`, the originally recorded path, `$APPLYR_HOME`,
  `~/aplyx`, and `~/ares` (covering exactly this kind of rename in
  either direction) — before failing with a clear message pointing at
  `APPLYR_ROOT` or re-running the installer, instead of a cryptic
  crash. Verified with real (not just static) tests: normal launch,
  both rename-fallback directions, and the total-failure error path.

## [0.8.4a] — 2026-07-14

npm package: `@keshm/aplyx` version `0.8.4-alpha.0`.

### Changed

- **Repository renamed `keshm2/ares` → `keshm2/aplyx`** to match the
  product's actual name. All 19 hardcoded install/update URLs updated
  (installer scripts, the TUI's bootstrap/version constants,
  `app/package.json`), plus the GitHub-tarball extracted-folder-name
  assumption in `docs/SETUP.md`'s manual-download instructions.
- **`scripts/` reorganized** from 26 flat files into `install/`,
  `runtime/`, `state/`, `jobs/`, `validate/` by concern. Every literal
  `scripts/<name>` invocation across the TUI, the browser extension,
  the three agent system prompts, this repo's own inter-script calls,
  and the docs was updated to match; ten scripts that compute their
  own project root via `__file__`/`BASH_SOURCE` parent-directory
  arithmetic needed one more level of unwrapping. Verified end-to-end
  with a real `aplyx status` run and the full conformance suite
  (13/13 PASS), not just static checks.
- **Removed the unimplemented root `resumes/` drop-folder.** Nothing
  in the codebase ever consumed it; `data/resumes/` is the real,
  load-bearing location (`resume-tailor.md` reads from it directly).
  Every installer/doc/uninstaller reference now points at
  `data/resumes/`, with the actual expected filenames documented in
  `docs/SETUP.md`.

### Fixed

- Hardcoded `/Users/keshmuthu/ares` absolute path in three
  `.claude/settings.local.json` Bash permission strings.
- `scheduler.py`'s Linux advice hardcoded "every 30 min" regardless of
  `APPLYR_SCHEDULE_INTERVAL_SEC`; now reflects the actual configured
  interval.

### Housekeeping

- Purged 59MB of stale `logs/tmp/` scrape scratch, the orphaned
  `token-optimizer/` cache, and stale `.playwright-mcp/` session
  artifacts (all gitignored, no tracked-file impact). Moved
  `system_architecture.md` into `docs/`.
- Published `0.8.3-alpha.0` to npm (tagged on GitHub since the
  0.8.3a release but never published — `0.8.2-alpha.0` has the same
  gap and remains unpublished) and created the missing GitHub Release
  page for `0.8.3a`.

## [0.8.3a] — 2026-07-14

npm package: `@keshm/aplyx` version `0.8.3-alpha.0`.

### Fixed

- **Windows PowerShell installer: "Unexpected token" parse errors.**
  `install.ps1` had no BOM and used em-dashes in strings/comments;
  Windows PowerShell 5.1 (`powershell.exe`, not PS7's `pwsh.exe`) reads
  BOM-less `.ps1` files under the legacy ANSI codepage instead of
  UTF-8, which corrupted the em-dash bytes and broke the tokenizer —
  reproduced by round-tripping the file through cp1252 and reparsing
  with PowerShell's own AST parser. Replaced every em-dash with a
  plain ASCII hyphen.
- **Installer one-liner never healed a broken local install.**
  `install.ps1` / `install.sh` skipped re-downloading the source
  tarball whenever `$target/AGENTS.md` already existed, so anyone who
  hit the bug above (or any other stale/corrupted local copy) got
  stuck re-running the same broken script forever via
  `irm ... | iex`. Both installers now always re-fetch and overwrite
  tracked files before delegating, even for an existing install;
  gitignored local state (`config/*.json`, `data/`, `logs/`,
  `resumes/`, `docs/PLAN.md`) is never touched.

## [0.8.0a] — 2026-07-13

## [0.8.2a] — 2026-07-14

npm package: `@keshm/aplyx` version `0.8.2-alpha.0`.

### Added

- **Native Windows path completed.** `install.ps1`, `run_job_agent.py`,
  `scheduler.py`, `uninstall.py`, `update.py`, `append_state_entry.py`,
  and `validate_local_config.py` now cover install/update/runtime without
  WSL or bash on Windows.
- **Update prompt in the TUI.** On a plain `aplyx` launch, when a newer
  version is detected, the UI now shows a bottom-right install prompt with
  a purple-to-white wave outline and yes/no actions.

### Fixed

- **Browser extension Windows compatibility.** The localhost bridge no
  longer shells out to literal `python3` or `bash append_state_entry.sh`;
  it now uses `sys.executable` and `append_state_entry.py`, so the bridge
  works from native PowerShell/cmd installs.
- **Banner rerender glitch.** The logo/banner no longer rewrites stray
  ASCII blocks during navigation; `Banner` is memoized and only rerenders
  on actual size changes.

### Changed

- **README shortened again.** Kept practical install/usage/safety info,
  pushed the rest into the docs.

## [0.8.0a] — 2026-07-13

npm package: `@keshm/aplyx` version `0.8.0-alpha.0` (default `latest`
dist-tag — `npm install -g @keshm/aplyx` gets it).

### Fixed

- **Claude Code harness ran but did no work.** A scheduled/background
  `claude -p` run is non-interactive, so Claude Code could not prompt
  for tool approval and declined *every* Bash call — the read-only
  checks and the mandated `scripts/job_state.py` /
  `append_state_entry.sh` state helpers alike — finishing "complete"
  with zero applications. The runner now passes
  `--permission-mode bypassPermissions` (the analog of the Copilot
  branch's `--allow-all-tools`; override with
  `APPLYR_CLAUDE_PERMISSION_MODE`). `scripts/run_job_agent.sh`.

### Changed

- **Node ≥ 22 now required** (`app/package.json` `engines`, README
  prerequisites). Older runtimes fail to parse the TUI's modern
  syntax (e.g. `??` in `cli.js`).

### Added

- **TUI Settings tab (Config, tab 5).** Three `> [x]` sections that
  always show current values before editing, with a per-field
  explanation: Personal info (safe_fields plus the new
  **preferred name** the sidebar greets you by, falling back to
  first name), Discord webhooks (enabled toggle + per-route URLs),
  and Environment — persisted `APPLYR_*` overrides in the new
  gitignored `config/env.json`, exported by every run (real env vars
  win; only `APPLYR_*`/`ARES_*` keys are honored). New
  `APPLYR_LOG_DIR` moves run/session logs and the heartbeat
  (runner, `write_heartbeat.py`, and the TUI's log readers all honor
  it; agent fetch-scratch stays in `logs/tmp`).
- **README:** Codex CLI and GitHub Copilot CLI artwork added to the
  supported-agents row.

## [0.7.9a] — 2026-07-13

npm package: `@keshm/aplyx` version `0.7.9-alpha.0` (alpha tag).
This is the first build clients receive via **automatic update** —
pushing the `VERSION` bump to `main` rolls it out.

### Added

- **Phase 16 — multi coding-agent support.** Codex CLI and GitHub
  Copilot CLI adapters in `run_job_agent.sh`; 4-agent installer
  detection; harness capability matrix + mandatory degraded paths in
  `AGENTS.md`; conformance suite (`scripts/run_conformance.py`) with
  results in `docs/SETUP.md` §3.8.
- **One-command install.** The cURL one-liner now ends with a working
  `aplyx` command: the installer writes a wrapper to
  `~/.local/bin/aplyx` (override with `APPLYR_BIN`) pinned to the
  install via `APPLYR_ROOT`. An npm-installed `aplyx` with no core
  offers to download the core itself instead of printing
  instructions.
- **Automatic updates.** New root `VERSION` file and
  `scripts/update.sh`: compares local vs GitHub `main`, then
  fast-forward pulls (git checkouts) or overlays the main tarball
  (archive installs); regenerates agent definitions, revalidates
  config, and rebuilds the TUI afterwards. Per-user files are never
  touched. Hooked fail-open into every scheduled run (self-update,
  then re-exec the new runner; `APPLYR_SKIP_UPDATE` guards the loop)
  and every interactive `aplyx` launch (2.5 s check budget). New
  `aplyx update` command; `APPLYR_AUTO_UPDATE=0` opts out. Updater
  is single-flight with a 30-min stale-lock reclaim.
- **Phase 9 — migration-friendliness review.** Single-user
  assumption, per-user vs project-owned file table, and future
  multi-user seams documented in `AGENTS.md`; two-users-per-machine
  note in `docs/SETUP.md` §3.7.
- **Dedicated uninstall.** `scripts/uninstall.sh` (also `aplyx
  uninstall`): removes the launchd schedule and the `aplyx` PATH
  wrapper (only aplyx's own, only if it points at this install),
  then deletes the install directory after an explicit confirmation —
  it holds config/data/resumes PII. `--keep-data` keeps the
  directory; `--yes` skips the prompt; non-interactive without
  `--yes` never deletes data. npm installs additionally run
  `npm uninstall -g @keshm/aplyx`.

- **Discord is now optional (opt-in at install).** The installer and
  `aplyx setup` ask whether to use Discord for status updates; no
  writes `{"enabled": false}` and outcomes stay local (state files +
  TUI). Opting in offers one channel for all updates or separate
  channels per status, with a highlighted ⚠ warning that Discord
  binds each webhook to one channel — each channel needs its own
  webhook link. Validator treats a missing/disabled config as a
  warning, never an error (enabled configs still hard-fail on
  placeholders); the discord-reporter logs one skip line when
  disabled; an absent `enabled` field means enabled, so existing
  configs keep working.

### Changed

- **README cut to a quarter of its length.** Phase planning, roadmap
  tables, phase-status blurbs, and per-build inventories moved out of
  the README (they live in `docs/CHANGELOG.md`, `docs/RELEASE.md`,
  and the gitignored plan); what remains is install, updates,
  uninstall, usage, safety, and pointers.

## [0.7.8a] — 2026-07-12

npm package: **`@keshm/aplyx` version `0.7.8-alpha.0`** (the
unscoped npm name `aplyx` belongs to an unrelated package; `0.7.8a`
is the human-facing build marker, `0.7.8-alpha.0` its strict-semver
form).

### Added

- **Setup overhaul.** `scripts/install.sh` bootstraps itself from a
  cURL one-liner (`curl -fsSL …/scripts/install.sh | bash` downloads
  the source into `~/aplyx`, override with `APPLYR_HOME`, then
  re-runs from inside it); prompts for the user profile
  (`safe_fields`, written atomically via `jq`) behind a bold-cyan
  notice that everything stays **locally only**; creates the
  gitignored root `resumes/` drop-folder — drop all resumes there
  as PDFs for scan/convert-to-markdown tailoring. `aplyx setup`
  shows the same privacy notice and resumes instruction. Three
  documented install paths: bash, cURL, npm.
- **TUI density redesign.** Shared rules+columns split-view
  primitives (`app/src/ui/Pane.tsx`); Jobs MANUAL, Review, and
  History get a full-height detail pane (fit verdicts, urls,
  reasoning, totals); Status gets a full-height recent-activity
  column; AUTO mode is a cockpit — cap gauge, heartbeat outcome
  counters, elapsed run clock, and a log tail that fills the
  content region. Panes appear when the content band is ≥ 76
  columns and degrade to the stacked layouts below.
- **Cap tiers re-cut.** 25 = MAX with a **rainbow gauge**, 22–24 =
  `heavy+` in a new hot red (`#FF3B30`), 17–21 = `heavy` (yellow),
  6–16 standard, 1–5 light.
- **Sidebar.** Randomized per-launch greeting (Hello / Welcome /
  Nice to see you / Hey there) over the user's first name (rainbow,
  from `safe_fields`); Screen / Failed / Seen / Sched rows; local
  **12-hour clock with time-zone abbreviation**.
- **Navigation.** `esc` returns to the welcome menu from any screen
  (never quits, locked during a live run); an npm-installed
  `aplyx` with no core checkout prints the one-line core
  installer instead of a stack trace.
- **README.** aplyx banner artwork at the head; explicit
  requirement callout — **Claude Code or opencode must be
  installed** — with both agents' artwork.

### Fixed

- **Backspace deleted nothing on macOS.** The Backspace key sends
  DEL (0x7f), which Ink reports as `key.delete`; the editors
  treated that as forward-delete — a no-op at the end of the line.
  Backspace and delete now both erase backward in all three text
  inputs.
- **Resize breakage.** Welcome menu sheds intro / description /
  state / footer bands by available rows so the `> [x]` options
  are never clipped; option rows truncate instead of wrapping;
  `MIN_COLUMNS` 40 → 44 (the tab row with the Review badge wrapped
  at 40 and corrupted the pinned frame); sidebar threshold 64 → 72
  columns; the content band has an explicit width so wide nested
  rows can no longer squeeze the sidebar.

## [0.5.5a] — 2026-07-12 — first tagged build

### Added

- **Project rename Ares → aplyx.** TUI command and npm package
  renamed to `aplyx`. Documented env-var prefix is `APPLYR_*`
  (the legacy `ARES_*` names are still honored as fallbacks).
  launchd label is now `com.aplyx.job-agent`; the scheduler
  installer / uninstaller also cleans up the pre-rename
  `com.ares.job-agent` label.
- **TUI (Phase 13, re-scoped).** Persistent full-screen app
  in `app/`. Welcome page on launch, manual and automatic
  modes, review triage, status / history browse, in-app help
  (`?`), `q` confirms before quit, `Esc` never quits, responsive
  banner (art or wordmark), responsive list sizing, side panel
  (applied / queue / mode / build marker), tier-colored cap
  input with animated MAX warning, optional per-run extra
  prompt (`APPLYR_EXTRA_PROMPT`). Subcommands:
  `aplyx status`, `aplyx run`, `aplyx setup [--check]`,
  `aplyx review`, `aplyx history`, `aplyx help`.
- **Harness portability (Phase 15, partial).**
  `scripts/run_job_agent.sh` selects OpenCode or Claude Code via
  `$APPLYR_HARNESS` → `config/harness.json` → auto-detect. The
  installer detects both and prompts when both are present.
  Per-harness agent definitions are generated from
  `agents/bodies/` + `agents/frontmatter/{opencode,claude}/`
  by `scripts/generate_agent_definitions.py`. Runner runs a
  drift check (`--check`) at the start of every run.
- **Universal installer.** `scripts/install.sh` — one command
  from a fresh GitHub download to a validated, harness-configured
  setup. Non-destructive.
- **Fetch-efficiency rules (AGENTS.md).** Fetches redirect to
  `logs/tmp/`, deterministic role / level prefilter before
  canonicalizing, shortlist bound 5× session cap (min 10), ≤ 30
  shortlist lines in the transcript. Closes the runaway-cap
  failure mode.
- **CI.** `.github/workflows/tui.yml` (typecheck + build +
  smoke) and `.github/workflows/extension.yml` (typecheck +
  build).
- **TUI accessibility / polish.** Opencode `--print` flag
  probe (so OpenCode ≥ 1.17 launches); resize-invariant
  frame (overflow hidden, `MIN_ROWS = 12`); large-terminal
  fill (band centers when columns > 160 with side panel
  overhead, list cap 30 rows); clear-on-resize repaint;
  key-cap-colored hint bar.

### Changed

- **`data/resumes/` is now gitignored** (PII). The five base
  resumes (`swe`, `ai_ml`, `balanced`, `cyber`,
  `networking_cyber`) plus the cover letter are loaded at
  runtime from the working copy.
- **TUI bin / command** is `aplyx` (was `ares` in the prior
  TUI commit).
- **`extension/`** is now part of the project as the Phase 10
  hybrid-mode extension (MV3, TypeScript).
- **`scripts/extension_bridge.py`** is the localhost bridge for
  the extension. Token in `config/extension_bridge.json`
  (gitignored, `chmod 600`).

### Fixed

- TUI: duplicated / clipped frames on resize (frame now pinned
  to viewport height with `overflow="hidden"`).
- TUI: navigating into a Jobs tab no longer steals the
  keyboard; typing starts only on `/` (manual) or `e` / `p`
  (automatic).
- Runner: detects both old and new opencode CLIs (some removed
  `--print`; others still expect it).
- Runner: warns (does not block) when generated agent
  definitions are stale.
- Runner: `APPLYR_SESSION_CAP` is clamped to 1–25; values
  outside the range fall back to 25 with a warning.

### Security

- The extension still **never submits a form** — the user
  reviews and clicks submit themselves. Autofill comes only
  from `config/targets.json "safe_fields"`. The bridge serves
  only the keys a page's form mapped, never the whole map.
- Bridge requires a per-install bearer token on every
  request. Bound to `127.0.0.1` only.
- `skipped_unfit` outcomes remain local-only: never routed to
  Discord, never written to `data/applied_jobs.json`, never
  synced to the Google Sheet.

### Known gaps (do not claim these as shipped)

- Phase 9 (migration-friendliness review) is **planned**, not
  implemented.
- Phase 13: `npm` publication, provider-setup, and hosted
  storage are **deferred**. Install from the local repo.
- Phase 15: live parity run between opencode and Claude Code
  is **pending**.
- Phase 16 (Codex, GitHub Copilot) is **planned**.
- Workday is review-only by design — there is no auto-apply
  path.
- The TUI's side panel shows a `Test User` rainbow wordmark —
  a UI placeholder. No backend account store.
- `docs/PLAN.md` is gitignored by design; the public roadmap
  signal is the table in `README.md`.

## Pre-tag history (untagged, summarized)

- **TUI as a one-shot CLI** — the previous TUI commit
  (`28b1d4c`) shipped `aplyx` (then `ares-apply`) as a
  one-shot CLI with `status`, `review`, `history`, `run`,
  `setup` subcommands. 0.5.5a re-scopes that to a persistent
  full-screen app; the subcommands are preserved.
- **Phase 10** (`28b1d4c`, `0c843b9`, `afd87e3`) — extension
  + bridge.
- **Phases 0–8** (`cfebcd4`, `dac5376`, `75e1699`, `9b827cc`,
  `992aaca`, `5e0843f`, `d4568a6`) — state hardening,
  Sheets sync, fit gate, SimplifyJobs, vetted slugs, Workday,
  scheduler.
- **Initial release** (`0c843b9`, `dac5376`, `cfebcd4`,
  `75e1699`) — the README + agent scaffolding.

> Git history before `0.5.5a` is under the **Ares** name. The
> rename is reflected in the in-repo files (banner, docs,
> command names, env-var prefix); the git log retains the
> original commit subjects.
