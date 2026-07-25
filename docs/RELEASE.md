# Release notes — aplyx 0.9.92a

> **Build:** `0.9.92a` — alpha.
> **Branch:** `main`.
> **TUI in-app marker:** `packages/core/src/version.ts` →
> `BUILD_MARKER = "0.9.92a"` (re-exported from `app/src/theme.ts`,
> visible in the TUI side-panel footer, and also in the desktop app's
> Settings screen — one shared constant, both surfaces agree).
> **npm package:** `@keshm/aplyx` version `0.9.92-alpha.0`, published to
> the default `latest` dist-tag — `npm install -g @keshm/aplyx` gets it.
> The unscoped npm name `aplyx` belongs to an unrelated package — never
> `npm install aplyx`. If a re-publish is ever needed for this same
> build, the npm semver bumps to `alpha.1`/`alpha.2` while the
> human-facing build marker/git tag stay `0.9.92a`.
> **Rollout — still applies from 0.9.90a:** if your install predates
> 0.9.90a's `update.py` fix, run `aplyx update` **twice** (the first run
> pulls the fix's source but still executes with the old, already-loaded
> broken rebuild order — Python doesn't hot-reload — so it won't take
> effect until the *second* run), or just re-run the full installer
> one-liner directly once.
> **Desktop app:** 0.1.0 internally (Tauri app version, not tied to the
> TUI's release cadence) — unaffected by this release, TUI-only.
> **Browser extension:** unchanged in this build — `0.8.2` / `0.8.2a`.
> **Previous releases:** `0.9.91a`, `0.9.90a`, `0.9.89a`, `0.9.88a`,
> `0.9.87a`, `0.9.85a`, `0.9.8a`, `0.9.75a`, `0.9.7a`, `0.9.1a`,
> `0.9.0a`, `0.8.43a`, `0.8.42a`, `0.8.041a`, `0.8.4a`, `0.8.3a`,
> `0.8.2a`, `0.7.8a`, and `0.5.5a` — deep-dive notes live at this path
> under their git tags; the index is [`CHANGELOG.md`](./CHANGELOG.md).

## What's new in 0.9.92a

A theme-persistence bug fix, a Settings section rename, and a new
opt-in debug-logging toggle.

### Fixed: theme could show up wrong on relaunch

Reported live: "sometimes the theme does not show up properly when
relaunching the app." Root cause: `App.tsx` applied the persisted
theme (and reduced-motion) inside a `useEffect`, which runs *after*
the component's first paint/commit — and `applyThemeMode` works by
mutating a shared, plain `theme` object in place, which does **not**
by itself trigger a React re-render. The only thing in that effect
that *could* force one was `setHour24`, and only when the persisted
24-hour-clock value actually differed from what `hour24`'s own
`useState` initializer had already read at mount — which it usually
hadn't, since that one already read the correct persisted value from
the start. Net effect: the very first frame of every launch rendered
with whatever `theme` happened to hold at module load (always Aplyx
Default's violet, the hardcoded initial value), and unless something
*unrelated* happened to re-render the tree shortly after, that
first-frame theme just... stayed. Not actually "sometimes" random —
reproduced deterministically: with Mint Frost saved, 5 out of 5 fresh
launches showed Aplyx Default's violet banner at 400ms after start,
every single time, with the old code.

Fixed by applying the persisted theme/reduced-motion via a lazy
`useState` initializer instead of a `useEffect` — that function runs
synchronously as part of the component's first render, before
anything paints, so `Banner`/`SidePanel`/etc. see the correct values
in that very first pass. Re-verified the same way afterward: 5 out of
5 fresh launches with Mint Frost saved now show the correct teal
banner from the first captured frame, every time. `refresh()` still
re-applies both on every tab switch, unchanged, for in-session Theme
edits.

### Changed: "Environment" → "Preferences"

Settings' "Environment" section is renamed "Preferences" — same
fields (Log directory, Session cap, Theme, 24-hour clock, Reduced
motion, etc.), just a name that describes what the section actually
is rather than a leftover from when it only held `APLYX_*` env-var
overrides.

### Added: opt-in "Debug logging" toggle (defaults to No)

A new Preferences field writes a separate `logs/debug.log` — resolved
`APLYX_*`/`FLUX_*`/`ARES_*` env vars at run start, which harness got
selected, the exact command argv passed to it, session-cap resolution
detail, and run duration/exit code at the end — for troubleshooting a
specific run. Deliberately does **not** touch either log the app
already depends on for real functionality: `session_*.log` (the
harness's own transcript — RunScreen's live progress tail and Status'
"last run" both read from this) and `run_job_agent.log` (the
always-on scheduler-health log) are both unaffected by this setting,
on or off. Defaults to **No**: this is purely additive diagnostic
detail for when something needs debugging, not something that should
add noise to `logs/` for everyone by default.

## Install / update / uninstall

```bash
# install (one command; puts `aplyx` on your PATH):
curl -fsSL https://raw.githubusercontent.com/keshm2/aplyx/main/scripts/install/install.sh | bash

# or via npm:
npm install -g @keshm/aplyx

# optionally also install the desktop app (or from TUI Settings > Desktop app):
bash scripts/install/install_desktop.sh        # macOS / Linux
powershell -ExecutionPolicy Bypass -File scripts\install\install_desktop.ps1   # Windows

# update now (also happens automatically on runs and launches):
aplyx update

# uninstall (removes the desktop app too, if installed):
aplyx uninstall          # add --keep-data to keep config/data/resumes
```

Windows: `powershell -ExecutionPolicy Bypass -File scripts\install\install.ps1`
(or `irm .../install.ps1 | iex`), native PowerShell, no WSL.

## Verification

- `npm run typecheck:app`, `npm run build`, and `npm run smoke` are all
  clean. `python3 -m py_compile scripts/runtime/run_job_agent.py` is
  clean.
- The theme-persistence fix was verified by direct A/B reproduction,
  not just reasoned about: `git stash`'d the fix back to the old
  `useEffect`-based code, rebuilt, and confirmed 5/5 fresh launches
  showed the wrong (default) theme at a consistent capture point;
  restored the fix, rebuilt, and confirmed 5/5 launches showed the
  correct saved theme at the same capture point.
- The Preferences rename and the Debug logging toggle (including its
  default-No state) were both confirmed live in tmux.
- The Python-side debug-log additions were not exercised with a live
  agent run this pass (would need a real harness invocation) — verified
  by `py_compile` and code review only; the four insertion points
  (env snapshot at start, harness resolution, session-cap resolution,
  command argv, and final duration/exit summary) were each placed
  next to the existing `log(run_log, ...)` calls they parallel.

## Release artifacts

- Git tag `v0.9.92a` on `main`.
- npm: `@keshm/aplyx@0.9.92-alpha.0` under the `latest` dist-tag
  (`cd app && npm publish` — `publishConfig` sets `access: public` and
  the tag). Publish requires `npm login` (and, on this account, an OTP
  step in the browser).
- CI workflow `.github/workflows/tui.yml` runs on every push touching
  the TUI/core. `.github/workflows/desktop-release.yml` builds and
  attaches desktop app bundles to a tagged release (triggered on `v*`
  tag pushes, or manually via `workflow_dispatch` for an existing tag)
  — not relevant to this TUI/runtime-only release.

## Known gaps

- Debug logging's Python-side additions are unverified by an actual
  live agent run (see Verification above).
- Everything carried forward from 0.9.90a's Known Gaps still applies —
  see that entry in `CHANGELOG.md` for the full list (Automatic-run
  gate/sidebar reports awaiting re-confirmation on a fresh build, the
  80×20–22 terminal render glitch, Codex subagent registry-only status,
  desktop hosted-sync, Workday review-only, desktop locations-only
  filter).
