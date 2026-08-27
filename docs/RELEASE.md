# Release notes — aplyx 1.0.2b

> **Build:** `1.0.2b` — fourth beta build. `1.0.1b` fixed a desktop
> harness-launch crash; `1.0.0b`/`1.0.0b1` are the two builds before
> that (see below); the `0.9.x` line was the alpha series.
> **Branch:** `main`, tagged `v1.0.2b` (all prior beta tags stay tagged
> too — none were removed from git, only superseded).
> **TUI in-app marker:** `src/core/src/version.ts` →
> `BUILD_MARKER = "1.0.2b"` (re-exported from `src/tui/src/theme.ts`,
> visible in the TUI side-panel footer and the desktop app's Settings
> screen — one shared constant, both surfaces agree).
> **npm package:** `@keshm/aplyx` version `1.0.2-beta.0`. Every prior
> `1.0.x-beta.N` stays published — npm never allows reusing a version
> number once unpublished, so each release gets a new version rather
> than a swap-in-place. The unscoped npm name `aplyx` belongs to an
> unrelated package — never `npm install aplyx`.
> **Desktop app:** `1.0.2-beta.0` (Tauri app + `Cargo.toml`).
> **Browser extension:** `1.0.2` — Chrome's `manifest.json` "version"
> field only accepts up to four dot-separated integers, no prerelease
> suffix, so it can never actually carry a `-beta.N` string. (`1.0.1b`'s
> release notes claimed `1.0.1-beta.0` here; that was never valid and
> never applied — the manifest stayed at `0.8.2` until this release.)
> **Previous releases:** the `0.9.x` alpha history is preserved under
> git tags `v0.9.945a` and earlier; see
> [`CHANGELOG.md`](./CHANGELOG.md) for the index. `v0.9.946a` through
> `v0.9.950a` were never tagged — that backlog is unrelated to this
> release and still outstanding.

## What's new in 1.0.2b

Two threads, both large. First, a free hosted-account tier: sign in on
the website (no paid plan required), the desktop app can import an
existing hosted profile, and changes sync live to the web dashboard
over Supabase Realtime — the dashboard itself was rebuilt around a
sidebar layout, fixing a real bug where signed-out dashboard content
was visible on mobile even for a signed-in session. Second, a full
redesign of the browser extension: rebranded to Moss, rebuilt from an
always-visible bottom-right panel into a top-center "Autofill this
application with aplyx?" overlay that only appears once a debounced
`MutationObserver`-based detector finds a real application form on the
page, styled to match the desktop app's frosted-glass material, with
its own marketing page at `/extension.html` and install docs/scripts/
Settings screen all updated to point to it. The install page also
gained direct-download buttons that fetch the latest release from the
GitHub API live and match the visitor's OS/arch, replacing static
links. Full detail lives in
[`CHANGELOG.md`](./CHANGELOG.md#102b--2026-08-26); this section
covers the parts worth a longer explanation.

### Fixed: Windows desktop builds had no release assets for three releases

Confirmed via `gh run view --json jobs`/`--log`: macOS and Linux
succeeded on every one of the last three tags (`v1.0.0b`, `v1.0.0b1`,
`v1.0.1b`); Windows failed every time, at the same step. `tauri.conf.json`'s
`"targets": "all"` makes every platform attempt every bundle format it
supports, and on Windows that includes MSI — which requires a
numeric-only pre-release version identifier, a hard WiX constraint
this project's `-beta.N` scheme can never satisfy. The `.exe` itself
was already building successfully (the failure log shows `Built
application at: ...desktop.exe` immediately before the MSI-bundling
error) — only the MSI step failed, but that was enough to fail the
whole `tauri build` invocation and lose the entire Windows asset, not
just the MSI one. Fixed with a new `src-tauri/tauri.windows.conf.json`
scoping Windows to NSIS only (Tauri v2 merges a per-platform config
file over the base one via JSON Merge Patch), leaving the base
config's `"all"` untouched for macOS/Linux, which were never broken.
This fix only takes effect on a new tag — the existing failed
workflow runs checked out the old, unfixed source and can't be
re-run into passing.

### Added: browser extension redesign and marketing

The extension's content-script UI (`src/extension/src/content.ts`) was
rewritten: a debounced (200ms), timeout-bounded (12s) `MutationObserver`
watches for a real application form before showing anything, replacing
a panel that was visible on every page regardless of whether there was
anything to autofill. The prompt itself moved from a collapsed
bottom-right panel to a top-center overlay (`translate(-50%,-14px)
scale(.94)` → `translate(-50%,0) scale(1)`, frosted-glass
`background: rgba(30,27,20,.72)` + `backdrop-filter: blur(24px)
saturate(180%)`), with `pointer-events: none` while hidden so the
near-position hidden state (needed for the slide/fade transition)
can't silently intercept clicks on the host page underneath it before
becoming visible. Respects `prefers-reduced-motion`.

New marketing page `src/site/extension.html` reuses the extension's
actual CSS for its mockup rather than a separate illustration, so the
site and the real product can't visually drift apart. `privacy.html`
gained a real section describing exactly what the extension reads and
where it goes today (only the user's own local bridge). Chrome Web
Store submission prep (single-purpose description, per-permission
justification for `host_permissions: ["http://127.0.0.1/*"]`, privacy
policy URL) is ready; the store listing itself, developer account, and
one-time $5 fee are still the user's own step.

### Fixed: install docs and scripts were stale, only documented on the website

An audit of every surface a new user might land on (install scripts,
`docs/SETUP.md`, the desktop app's own Settings screen) found the
extension's existence and setup steps were only ever documented on the
marketing site. `docs/SETUP.md` also had two stale facts: a `cd
extension` path that doesn't exist (real path is `cd src/extension`),
and a description of the old bottom-right panel UI. Both fixed;
`install.sh`/`install.ps1` now print a load-unpacked pointer after a
successful build, and the desktop Settings screen links to
`/extension.html` directly.

### Added: direct-download buttons, verified against the live GitHub API

`install.html` now fetches `GET /repos/keshm2/aplyx/releases?per_page=1`
and matches the newest release's assets by filename suffix
(`_aarch64.dmg`, `-setup.exe`, `.AppImage`, etc.), auto-detecting the
visitor's OS from `navigator.userAgent`. Deliberately not
`/releases/latest` — tested live via curl and found that endpoint
excludes every prerelease-flagged release, and this repo's latest
release is always prerelease-flagged, so it actually resolved to
`v0.9.7a`, a pre-rename release with assets still named `applyr_...`.
That would have shipped a badly outdated, wrongly-branded download to
real visitors had it not been caught before merging. The corrected
logic was re-verified in a standalone Node script against the live API
before shipping.

## Install / update / uninstall

```bash
# install (one command; puts `aplyx` on your PATH):
curl -fsSL https://raw.githubusercontent.com/keshm2/aplyx/main/src/scripts/install/install.sh | bash

# or via npm:
npm install -g @keshm/aplyx

# optionally also install the desktop app (or from TUI Settings > Desktop app):
bash src/scripts/install/install_desktop.sh        # macOS / Linux
powershell -ExecutionPolicy Bypass -File src\scripts\install\install_desktop.ps1   # Windows

# or download the matching bundle directly from aplyx.app/install.html

# check the installed version:
aplyx version

# update now (also happens automatically on runs and launches):
aplyx update

# uninstall (removes the desktop app too, if installed):
aplyx uninstall          # add --keep-data to keep config/data/resumes
```

Windows: `powershell -ExecutionPolicy Bypass -File src\scripts\install\install.ps1`
(or `irm .../src/scripts/install/install.ps1 | iex`), native PowerShell, no WSL.

## Verification

- `npm run build:core`, `tsc --noEmit` for `src/tui` and `src/tauri`,
  the extension's `npm run build`, and `cargo check` in
  `src-tauri` are all clean on this release, each correctly picked up
  `1.0.2-beta.0`.
- The direct-download matching logic was verified against the live
  GitHub API via a standalone Node script (see above) before shipping,
  not assumed to work from reading the code.
- The Windows CI fix (`tauri.windows.conf.json`) is config-only and
  scoped to a platform this release couldn't build/test locally
  (no Windows hardware) — it takes effect for the first time on this
  tag's own CI run. If that run fails, the Windows asset will be
  missing from the GitHub Release and the install page's Windows
  download button will silently fall back to the generic releases
  link.
- The hosted-account/dashboard and extension-detection features were
  built and reviewed across this whole release cycle but not
  re-verified end-to-end as part of this specific version-bump pass;
  see the individual commits for what testing each one already had.

## Release artifacts

- Git tag `v1.0.2b` on `main` (all prior beta/alpha tags stay tagged,
  none removed — only superseded).
- npm: `@keshm/aplyx@1.0.2-beta.0` under the `latest` dist-tag
  (`cd src/tui && npm publish` — `publishConfig` sets `access: public`
  and the tag). Every earlier `1.0.x-beta.N` stays published — npm
  blocks reusing a version number once unpublished.
- CI workflow `.github/workflows/tui.yml` runs on every push touching
  the TUI/core. `.github/workflows/desktop-release.yml` builds and
  attaches desktop app bundles (now including a working Windows NSIS
  installer) once the tag above exists.
- Browser extension: not yet published to the Chrome Web Store —
  submission material is prepared (single-purpose description,
  per-permission justification, privacy policy) but the store listing,
  developer account, and one-time $5 fee are a manual step for the
  account owner. Until then, install is load-unpacked only (documented
  in `docs/SETUP.md` §2.6 and `/extension.html`).

## Known gaps

- Chrome Web Store submission hasn't happened yet (see above) — the
  extension only installs via load-unpacked for now.
- Everything under "Known gaps" in the `1.0.1b` entry below still
  applies; nothing in this release touches those paths.

## Older releases

## Fixed in 1.0.0b1 (folded into this release): broken desktop-app production build

`ResumesScreen.tsx`'s new `reflowExtractedResumeText` import (see
below) was a real, non-type import from `masterResume.ts` — unlike
every other consumer of that file, which only ever imports its types
(erased entirely by `tsc`) or goes through the Rust/bridge IPC layer.
That pulled `masterResume.ts`'s Node-only `platform.js` dependency
(used only by `exportResumePdf`, for the PDF-export subprocess) into
the desktop app's browser/webview bundle for the first time, and broke
the production Vite build outright: `"join" is not exported by
"__vite-browser-external"`. Moved the reflow logic into its own
dependency-free module, `resumeReflow.ts`, and registered it in
`src/core`'s `package.json` `exports` map. Verified with a clean
`npm run build` in `src/tauri/` (not just `tsc --noEmit`, which this
class of bug slips straight past) and a full `npm run tauri build` —
the resulting `.app`/`.dmg` were installed and run.

## Fixed in 1.0.1b: the desktop app couldn't launch a run

Reported live: an application run started from the desktop app crashed
with `FileNotFoundError: [Errno 2] No such file or directory:
'opencode'`, even with a working opencode install
(`~/.opencode/bin/opencode`, found instantly from a terminal). A
Finder/Dock-launched `.app` inherits `launchd`'s minimal PATH
(`/usr/bin:/bin:/usr/sbin:/sbin`), not the user's shell PATH, so
`shutil.which("opencode")` came back empty. `src/core/src/harness.ts`'s
`extraSearchDirs()` already solved this exact problem for *detecting*
an installed harness (the Settings screen's "Auto" label);
`harness_adapter.resolve_harness_exe()` is the same well-known-
directory fallback applied to actually *running* one, used by
`run_job_agent.py` and `preview_resume.py`. Verified against the real
opencode install under both a normal PATH and a simulated minimal one.
Python-only fix — took effect immediately, no rebuild needed, since the
desktop app runs these scripts from the live checkout rather than a
bundled copy.

## What's new in 1.0.0b

The headline change is the ATS account-credential system: when aplyx
creates an account on a job site for you, the password now goes into
Postgres Vault behind ownership-checked RPCs, with a new Account
Center screen to reveal, rotate, or delete a stored credential.
Alongside that, the Workday apply runtime got a real hardening pass
(bounded retry/backoff, generalized challenge detection, a fix for a
password that could end up in a plaintext checkpoint file), the fit
gate picked up a broader hard-reject vocabulary plus its first
regression suite and now runs automatically across a whole page of
search results instead of one job at a time, and resumes can finally
be replaced after onboarding in both local and hosted mode — including
a fix for raw PDF-extracted text silently dropping every bullet, job,
and skill on import. Full detail lives in
[`CHANGELOG.md`](./CHANGELOG.md#100b--2026-08-24); this file expands
on the parts worth a longer explanation.

### Added: ATS account-credential storage

`application_accounts` / `application_account_links` /
`application_account_events` (migrations `0027`–`0033`) replace the
old plaintext-in-a-JSON-file approach with Vault-backed secrets behind
`SECURITY DEFINER` RPCs — `create_application_account`,
`reveal_own_account_credential`, `rotate_application_account_secret`,
`mark_account_state`, `delete_application_account`, plus a
token-issue/redeem pair (`issue_account_credential_use_token` /
`resolve_application_account_credential_token`) so a Playwright run
can use a credential without ever holding it in a shell environment
variable. `apply_runs.account_id` links back to the account via a
composite foreign key — worth calling out because Postgres's plain
`ON DELETE SET NULL` on a composite FK nulls every column in it, not
just the one you meant; migration `0030` fixes that with the
column-scoped `ON DELETE SET NULL (account_id)` syntax.

The new Account Center screen (`AccountCenterScreen.tsx`) lists stored
accounts masked, and gates reveal/copy/rotate behind a 10-minute
in-memory re-auth window. Deleting one goes through a confirmation
modal first.

Hosted verification-mail reads moved behind the same kind of
ownership-checked RPC (`list_own_inbound_emails`,
`consume_inbound_email`). The `inbound_emails` table has zero RLS
policies by design, and the desktop app was querying it directly with
the user's own JWT — meaning every hosted user's verification inbox
looked permanently empty, regardless of what mail had actually arrived.
The Edge Function (`inbound-email`) also stopped echoing the parsed
OTP/link back in its own HTTP response.

### Added: browser-resilience hardening for the apply runtimes

`browser_resilience.py` is new: bounded retry with backoff and jitter
that re-acquires a Playwright locator on each attempt
(`click_with_retry`), a generalized bot-check/CAPTCHA detector
(`detect_challenge`), page-signature helpers for loop detection, and
checkpoint sanitization that strips password/OTP/cookie-shaped keys
before a checkpoint gets written to disk.

Two real bugs came out of testing this against a live NVIDIA Workday
posting. First, step-loop detection fell back to reading the page
title, which never changes between wizard steps on at least this
tenant — it now reads the `progressBarActiveStep` element first, which
does. Second, a "Save and Continue" click that fails client-side
validation didn't raise an exception or navigate, and nothing was
checking for that outside the final submit step — a validation-error
check now runs after every intermediate step, not just the last one.

A generated Workday account password was also found sitting in a
plaintext checkpoint file (`data/workday_apply_runs/workday-*.json`)
instead of going through the existing `.secrets/<job_id>.json` sidecar
it was supposed to use. Moved it there, and closed the `.gitignore` gap
that let it happen — `data/workday_apply_runs/`, `data/screenshots/`,
and `data/fill_records/` were never added to this repo's explicit
per-file ignore list, even though all three hold PII.

### Changed: the fit gate is stricter, tested, and runs automatically

`evaluate_job_fit.py` gained a `sponsorship_blocked` gate (rejects a
posting that requires sponsorship when the candidate's own profile
says they need it and doesn't have it), a broader
`FOREIGN_LOCATION_RE` (several real countries and cities were
missing), and a clearance regex fixed to also catch "active *security*
clearance" phrasing — found while writing the new test for it.
`test_evaluate_job_fit.py` is the first dedicated regression suite for
this file (18 tests); `run_conformance.py`'s golden fixtures are
re-pinned to `decision_version = "phase4-v5"` to match.

Results now show up automatically across a whole page of search
results. `checkJobFitBatch` runs canonicalization and the fit gate for
every job on the page in two subprocess calls total, matched back to
each listing by URL — replacing what used to be a manual, one-job-at-
a-time check.

### Fixed: resumes can be replaced any time, and imports actually import

Hosted mode had no resume upload path outside the onboarding wizard —
`ResumesScreen.tsx` was local-only, and both wizards' own upload code
was never wired up anywhere reachable afterward, despite the UI
claiming it would be. Both screens now have a real upload path; the
desktop Settings screen gained a dedicated Resume section for hosted
accounts.

Re-uploading a resume under a name that already existed didn't
overwrite it — `convert_resume.py` refuses to clobber an existing
`.md` without `--force`, and `force` was never threaded through the
Rust/bridge/TypeScript layers between the UI and that script. It's
wired through now, behind a warn-then-confirm modal rather than a
silent overwrite.

Separately — and this was the bigger one — importing a real,
PDF-extracted resume only ever pulled in a name and contact line.
`importFromMarkdown` is a strict, position-dependent parser built for
five hand-written `base_resume_*.md` files; raw pypdf output has none
of the markers it looks for (no `#`/`##`/`###`, "•" instead of "- "
bullets, a job's title and date frequently run together with no space:
`"...Development Engineer InternJune 2025 – Present"`). A new
`reflowExtractedResumeText` pass normalizes section names, bullets, and
job/project entry boundaries before the parser ever sees the text —
verified against a real resume conversion, not just read: two jobs
with all 11 bullets intact and correctly dated, three projects with
all 12 bullets, four of five skill categories exact. The import
preview is an editable textarea now instead of read-only, so whatever
the reflow doesn't catch — this release, mainly the education section,
which had no clean delimiter to guess a split on — can be fixed by
hand before confirming.

### Fixed: two install-time bugs that would break every fresh install

Found while verifying this release, not carried over from an earlier
one. `npm install --workspace=src/core` can, on a genuinely empty npm
cache — exactly what a new user has — extract an incomplete copy of a
dependency shared with another workspace (`@supabase/supabase-js`,
also used by `src/tauri`), missing its build output entirely even
though the real published package has it. Reproduced with a fresh npm
cache and a fresh `$HOME` before fixing it: `install.sh` and
`install.ps1` now detect a failed core build and retry once with
`node_modules` removed and a full, unscoped install.

Separately, `src/extension` has had its own `package.json` since it
was added but was never listed in the root `package.json`'s
`workspaces` array — its build step in both installers has been
silently failing on every fresh install since. Added it to the
workspace list.

While fixing the first bug, also found that `src/tui` and `src/tauri`
still pointed at `@aplyx/core` by the semver range `^0.1.0`, which
stopped matching the moment core's own version crossed 1.0.0 —
breaking workspace linking outright on a genuinely fresh `npm install`
(npm falls back to fetching the never-published `@aplyx/core` from the
real registry and 404s). Switched both to `file:../core`, the pattern
`src/worker` already used, so a future version bump can't reintroduce
this.

## Install / update / uninstall

```bash
# install (one command; puts `aplyx` on your PATH):
curl -fsSL https://raw.githubusercontent.com/keshm2/aplyx/main/src/scripts/install/install.sh | bash

# or via npm:
npm install -g @keshm/aplyx

# optionally also install the desktop app (or from TUI Settings > Desktop app):
bash src/scripts/install/install_desktop.sh        # macOS / Linux
powershell -ExecutionPolicy Bypass -File src\scripts\install\install_desktop.ps1   # Windows

# check the installed version:
aplyx version

# update now (also happens automatically on runs and launches):
aplyx update

# uninstall (removes the desktop app too, if installed):
aplyx uninstall          # add --keep-data to keep config/data/resumes
```

Windows: `powershell -ExecutionPolicy Bypass -File src\scripts\install\install.ps1`
(or `irm .../src/scripts/install/install.ps1 | iex`), native PowerShell, no WSL.

## Verification

- `npm run build:core`, and `tsc --noEmit`/`cargo check` for `src/tui`,
  `src/tauri`, and `src/worker`, are all clean after the dependency and
  workspace fixes above.
- The full fresh-install path was simulated end to end, not just read:
  a snapshot of the working tree with no `.git` directory (matching a
  real extracted release archive), a brand-new `$HOME`, and a
  never-touched npm cache. Reproduced both install-time bugs this way
  before fixing them, then re-ran the same simulation after each fix
  until core, the TUI, and the browser extension all built clean and
  the resulting `aplyx status`/`aplyx version` ran correctly.
- The npm package was verified with `npm pack` into an isolated global
  prefix (not the real registry — publishing is a separate, later
  step): ships exactly `dist/cli.js` + `package.json`, and correctly
  detects a missing core checkout on a fresh machine.
- The resume-reflow fix was verified against a real PDF conversion
  (`~/Desktop/resumes/Kesh_muthu_swe_2027.pdf`), not just read: two
  jobs with 8 and 3 bullets and correct dates, three projects with 4,
  5, and 3 bullets, four of five skill categories exact.
- `install.ps1`'s matching fix is audited, not executed — no `pwsh` on
  the machine this release was built on. Flagged under Known gaps.
- The formula-injection and umask fixes from `0.9.949a`/`0.9.950a`
  remain in place; nothing in this release touches those paths.

## Release artifacts

- Git tag `v1.0.1b` on `main` (`v1.0.0b`/`v1.0.0b1` also still exist,
  superseded).
- npm: `@keshm/aplyx@1.0.1-beta.0` under the `latest` dist-tag
  (`cd src/tui && npm publish` — `publishConfig` sets `access: public`
  and the tag). `1.0.0-beta.0` and `1.0.0-beta.1` were both published
  and neither is being unpublished — npm blocks reusing a version
  number once unpublished, so leaving them in place is strictly safer
  than removing them.
- CI workflow `.github/workflows/tui.yml` runs on every push touching
  the TUI/core. `.github/workflows/desktop-release.yml` builds and
  attaches desktop app bundles once the tag above exists.
- The `v0.9.946a`–`v0.9.950a` tag backlog noted above is still
  outstanding and unrelated to this release.

## Known gaps

- `install.ps1`'s install-time fix is reasoned-through and matches the
  bash version exactly, but hasn't run on real Windows hardware — no
  `pwsh` available on the machine this release was verified on.
- The resume-reflow pass doesn't attempt the education section — the
  sample PDF's degree/GPA/graduation-date line had no clean delimiter
  to split on, and a wrong guess there seemed worse than an honest gap
  the editable preview box can now absorb.
- Everything carried forward from `0.9.90a`'s Known Gaps still
  applies — see that entry in `CHANGELOG.md` for the full list
  (automatic-run gate/sidebar reports awaiting re-confirmation on a
  fresh build, the 80×20–22 terminal render glitch, Codex subagent
  registry-only status, desktop hosted-sync, Workday review-only,
  desktop locations-only filter).
- The real-time Discord field-clarification idea
  (`docs/discord-field-clarification-plan.md`) is a design doc only —
  nothing from it has shipped. The interim workaround already has:
  an unknown field routes the posting to the review queue instead of
  guessing.
