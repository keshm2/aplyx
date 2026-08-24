# Release notes — aplyx 1.0.0b1

> **Build:** `1.0.0b1` — first beta, second build (`1.0.0b`/`beta.0` had
> a broken desktop-app production build, fixed below; the `0.9.x` line
> was the alpha series).
> **Branch:** `main`, tagged `v1.0.0b1` (`v1.0.0b` stays tagged too — it
> was never removed from git, only superseded).
> **TUI in-app marker:** `src/core/src/version.ts` →
> `BUILD_MARKER = "1.0.0b1"` (re-exported from `src/tui/src/theme.ts`,
> visible in the TUI side-panel footer and the desktop app's Settings
> screen — one shared constant, both surfaces agree).
> **npm package:** `@keshm/aplyx` version `1.0.0-beta.1`. `1.0.0-beta.0`
> was published, then found to ship a broken desktop build — npm never
> allows reusing a version number once unpublished, so this is a new
> version rather than a swap-in-place fix. The unscoped npm name `aplyx`
> belongs to an unrelated package — never `npm install aplyx`.
> **Desktop app:** `1.0.0-beta.1` (Tauri app + `Cargo.toml`).
> **Browser extension:** `1.0.0-beta.1` (previously `0.8.2a`).
> **Previous releases:** the `0.9.x` alpha history is preserved under
> git tags `v0.9.945a` and earlier; see
> [`CHANGELOG.md`](./CHANGELOG.md) for the index. `v0.9.946a` through
> `v0.9.950a` were never tagged — that backlog is unrelated to this
> release and still outstanding.

## Fixed in 1.0.0b1: broken desktop-app production build

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

- Git tag `v1.0.0b1` on `main` (`v1.0.0b` also still exists, superseded).
- npm: `@keshm/aplyx@1.0.0-beta.1` under the `latest` dist-tag
  (`cd src/tui && npm publish` — `publishConfig` sets `access: public`
  and the tag). `1.0.0-beta.0` was published and is not being
  unpublished — npm blocks reusing a version number once unpublished,
  so leaving it in place is strictly safer than removing it.
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
