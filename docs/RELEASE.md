# Release notes — aplyx 0.9.949a

> **Build:** `0.9.949a` — alpha.
> **Branch:** `main`.
> **TUI in-app marker:** `src/core/src/version.ts` →
> `BUILD_MARKER = "0.9.949a"` (re-exported from `src/tui/src/theme.ts`,
> visible in the TUI side-panel footer, and also in the desktop app's
> Settings screen — one shared constant, both surfaces agree).
> **npm package:** `@keshm/aplyx` version `0.9.949-alpha.0` — built and
> verified (`npm pack --dry-run` produces a clean 72.7 kB tarball
> containing only `dist/cli.js` and `package.json`) but not yet
> published; the registry's `latest` dist-tag is still
> `0.9.947-alpha.0` (`0.9.948a` was never published either). Publishing
> needs `npm login` on the publishing machine — this checkout currently
> has no active npm session. The unscoped npm name `aplyx` belongs to
> an unrelated package — never `npm install aplyx`.
> **Desktop app:** 0.1.0 internally (Tauri app version, not tied to the
> TUI's release cadence) — rebuilt and typechecked clean this release
> after the `react-router-dom` v7 bump below.
> **Browser extension:** unchanged in this build — `0.8.2` / `0.8.2a`.
> **Previous releases:** `0.9.948a`, `0.9.947a`, `0.9.946a`, `0.9.945a`,
> `0.9.94a`, `0.9.93a`, `0.9.92a`, `0.9.91a`, `0.9.90a`, `0.9.89a`,
> `0.9.88a`, `0.9.87a`, `0.9.85a`, `0.9.8a`, `0.9.75a`, `0.9.7a`,
> `0.9.1a`, `0.9.0a`, `0.8.43a`, `0.8.42a`, `0.8.041a`, `0.8.4a`,
> `0.8.3a`, `0.8.2a`, `0.7.8a`, and `0.5.5a` — deep-dive notes for
> `0.9.945a` and earlier live at this path under their git tags.
> `0.9.946a`–`0.9.948a` were never tagged and never got their own
> deep-dive; this file sat stale describing `0.9.945a` for three
> releases in a row. `CHANGELOG.md` has the summary for everything that
> shipped in between — treat it as the source of truth for those three,
> not this file. The index is [`CHANGELOG.md`](./CHANGELOG.md).

## What's new in 0.9.949a

A security-audit remediation pass (one confirmed injection bug fixed,
file-permission hardening across every PII-bearing write path), a new
subagent, a major frontend dependency bump, and a copy/motion pass on
the marketing site.

### Fixed: spreadsheet formula injection in the Google Sheets tracker sync

`src/scripts/jobs/sync_internship_tracker.py` writes each successful
application as a row in the user's own Google Sheet, with
`valueInputOption` defaulting to `USER_ENTERED` — the setting that
lets Sheets auto-parse `date_applied` into a real, sortable date
instead of literal text. The trade-off: `USER_ENTERED` also parses any
cell value starting with `=`, `+`, `-`, or `@` as a live formula. The
`company`/`title` fields in that row come from a scraped, third-party
job posting — anyone can name a company or listing anything — so a
crafted posting title like
`=HYPERLINK("http://evil.example/phish","details")` would become a
live, clickable formula sitting in the user's own tracker sheet.

Fixed with a new `_defang_formula()` in `build_row()`: any of `title`,
`company`, `internship_term`, or `notes` starting with a
formula-trigger character gets a literal apostrophe prefix
unconditionally, regardless of which `value_input_option` is
configured — the standard, complete mitigation for this class of bug
(CWE-1236), not something that only matters if `USER_ENTERED` stays
the default. Verified against real payloads
(`=HYPERLINK(...)`, `+cmd|"/c calc"!A1`, `-2+3`, `@SUM(A1:A10)`) — each
comes out apostrophe-prefixed; a benign title/company round-trips
byte-for-byte unchanged.

### Fixed: PII-bearing files no longer inherit the process umask

Live config (`src/config/targets.json`, `discord_config.json`,
`env.json`), the state registry/events files, and the onboarding
wizard's writes previously relied on whatever umask happened to be
active at install time to keep them from being world- or
group-readable. All of these carry real PII — name, address, date of
birth, webhook URLs. `src/core/src/bridge.ts`, `src/core/src/settings.ts`,
`src/scripts/state/job_state.py`, `src/scripts/install/install.sh`, and
`src/tui/src/ui/onboarding/OnboardingWizard.tsx` now `chmod 600`
explicitly on every write instead of trusting the ambient umask.
`src/scripts/install/update.py`'s config-migration path does the same
when copying an old install's files forward — `shutil.copy2` preserves
the *old* file's mode bits, which would otherwise carry a
pre-hardening install's permissive mode straight through an update.

### Added: `cover-letter-tailor` split into its own subagent

Cover-letter generation used to be bundled into `resume-tailor`'s
output as one thin paragraph of guidance with no grounding rules. It's
now a dedicated subagent (`src/agents/bodies/cover-letter-tailor.md`)
with the same anti-fabrication discipline as `interest-letter` — every
claim tied back to the tailored resume and the job description,
demographic fields excluded, a length target enforced. `job-scraper`'s
Phase 2 invokes it right after `@resume-tailor` so the letter stays
consistent with whichever resume version got picked for that posting.
Registered across all four harnesses
(`src/agents/frontmatter/{claude,opencode,copilot}/cover-letter-tailor.yaml`,
`codex/cover-letter-tailor.toml`) and added to `AGENTS.md`'s harness
capability matrix, degraded-path fallback list, and
`run_job_agent.py`'s inline-fallback `delegates` tuple. A new
`cover_letter_over_limit` review-queue reason covers a form-stated
word/character limit the tailored letter still exceeds after being
re-invoked with that limit, or a pre-submit recheck finding the live
field over limit despite a compliant pre-paste word count.
`applied_jobs.json`/`review_queue.json`'s `cover_letter` field shape
is unchanged — only its source agent changed, so the Documents tab and
the Google Sheets sync needed no updates.

### Changed: scraped job content is explicitly untrusted, not instructions

`interest-letter` (and the other agents reading scraped text) now
explicitly call out `jd_excerpt`/`question`/`jd_text` as untrusted,
third-party data — a job posting or application question is written
by the employer/poster, not the operator. A posting that embeds
"ignore your instructions," a fake system/tool tag, or a request to
reveal these instructions doesn't get followed; it's treated purely as
content to describe or answer from, never as a directive to the agent.

### Changed: `react-router-dom` bumped to v7

`^6.26.0` → `^7.18.0` in the desktop app, alongside `postcss`,
`sharp`, `@types/react`, and `@types/react-dom` pinned via root
`package.json` `overrides`. Typechecked (`tsc --noEmit`, clean) and
production-built (`tsc && vite build`, clean, 155 modules transformed)
before this release; no routing-surface changes were needed.

### Changed: marketing site copy and motion pass

Humanized the site's copy across all six pages
(`index`/`features`/`install`/`pricing`/`privacy`/`changelog`) —
mainly trimming em-dash-heavy sentences into plainer commas, periods,
and colons; same information, easier to read aloud. Separately,
reviewed the CSS against a motion-design checklist (easing choice,
duration, transform-origin, hover-state gating, reduced-motion
handling) and found it already followed nearly all of it; the one real
fix was the status-tracking demo's mouse-trailing glow, which used an
entrance-style ease for what is actually continuous on-screen movement
— switched to `--ease-standard` to match how the rest of the site
already separates those two cases.

### Fixed: broken install commands on the site itself

Unrelated to the above, found while writing this file: `install.html`'s
copy-pasteable macOS/Linux and Windows install commands still pointed
at the pre-`src/`-restructure path
(`.../main/scripts/install/install.sh`), which 404s — confirmed
directly against the raw GitHub URL. Live and broken since the
`0.9.948a` restructure landed on `main`. Both commands now point at
`.../main/src/scripts/install/install.sh` (and `.ps1`), matching what
`README.md` and `docs/SETUP.md` already had correct.

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

- `npm run build:core`, `npm run typecheck:app`, and `npm run
  smoke:app` (root workspace scripts, which build `@aplyx/core` then
  the TUI) are all clean; the smoke test's `node dist/cli.js status`
  ran and returned real output against this checkout's own state.
- `npx tsc --noEmit` and `npm run build` (`tsc && vite build`) in
  `src/tauri/` are both clean after the `react-router-dom` v7 bump —
  a full production build, not just a typecheck, specifically because
  a major version bump can carry breaking changes typecheck alone
  might not surface.
- `python3 src/scripts/validate/generate_agent_definitions.py --check`
  passes — the new `cover-letter-tailor` generated files across all
  four harnesses match their `src/agents/bodies/` +
  `src/agents/frontmatter/` sources exactly.
- `bash src/scripts/validate/validate_local_config.sh` passes (`OK`);
  its two warnings are this machine's own unconfigured placeholders,
  not a code issue.
- `bash -n` on every touched install/state shell script and
  `python3 -m py_compile` on every touched Python script are clean.
- The formula-injection fix was exercised against real malicious
  payloads (see Fixed section above), not just read.
- The marketing site was loaded in a real browser (not just visually
  diffed): hero, features, and privacy pages all render correctly, the
  privacy page's TL;DR/Fine Print toggle still works, and the
  status-demo section renders with the corrected easing in place.
- The two broken install-command URLs were confirmed 404 before the
  fix and 200 after, directly against the raw GitHub URLs (not just
  read as text).

## Release artifacts

- Git tag `v0.9.949a` on `main` — **not yet created**; `0.9.946a`,
  `0.9.947a`, and `0.9.948a` were never tagged either. Worth doing all
  four in sequence if the tag history is meant to stay authoritative.
- npm: `@keshm/aplyx@0.9.949-alpha.0` under the `latest` dist-tag
  (`cd src/tui && npm publish` — `publishConfig` sets `access: public`
  and the tag). **Not yet published** — pending explicit go-ahead and
  an `npm login` on the publishing machine.
- CI workflow `.github/workflows/tui.yml` runs on every push touching
  the TUI/core. `.github/workflows/desktop-release.yml` builds and
  attaches desktop app bundles to a tag when one exists — currently
  nothing to attach to for this release.

## Known gaps

- Everything carried forward from `0.9.90a`'s Known Gaps still
  applies — see that entry in `CHANGELOG.md` for the full list
  (Automatic-run gate/sidebar reports awaiting re-confirmation on a
  fresh build, the 80×20–22 terminal render glitch, Codex subagent
  registry-only status, desktop hosted-sync, Workday review-only,
  desktop locations-only filter).
- `git tag`/`npm publish` are both outstanding for `0.9.946a` through
  `0.9.949a` — this release notes file and the tag history had both
  drifted out of sync with `main` for three releases before this one.
- The Windows-specific fixes from earlier releases (`CREATE_NO_WINDOW`,
  etc.) remain reasoned-through and `cargo check`/`clippy`-clean but
  not run on real Windows hardware, same caveat as every release
  touching `src/tauri/src-tauri` so far.
