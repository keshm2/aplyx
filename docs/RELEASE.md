# Release notes — aplyx 0.9.93a

> **Build:** `0.9.93a` — alpha.
> **Branch:** `main`.
> **TUI in-app marker:** `packages/core/src/version.ts` →
> `BUILD_MARKER = "0.9.93a"` (re-exported from `app/src/theme.ts`,
> visible in the TUI side-panel footer, and also in the desktop app's
> Settings screen — one shared constant, both surfaces agree).
> **npm package:** `@keshm/aplyx` version `0.9.93-alpha.1` (republished
> same day — see "Republished as alpha.1" below), published to the
> default `latest` dist-tag — `npm install -g @keshm/aplyx` gets it. The
> unscoped npm name `aplyx` belongs to an unrelated package — never
> `npm install aplyx`. The npm semver bumped to `alpha.1` for the
> republish while the human-facing build marker/git tag stayed `0.9.93a`,
> per this file's own standing convention for a same-build re-publish.
> **Rollout:** this release specifically fixes `aplyx update` itself —
> see below. Any install still on this release or older, once it
> updates to 0.9.93a+, self-corrects permanently: the stale-in-memory
> bug this fixes can only happen when the *currently running* update.py
> predates the fix. From 0.9.93a onward, one `aplyx update` run is
> reliable regardless of how many versions behind it started.
> **Desktop app:** 0.1.0 internally (Tauri app version, not tied to the
> TUI's release cadence) — unaffected by this release, TUI-only.
> **Browser extension:** unchanged in this build — `0.8.2` / `0.8.2a`.
> **Previous releases:** `0.9.92a`, `0.9.91a`, `0.9.90a`, `0.9.89a`,
> `0.9.88a`, `0.9.87a`, `0.9.85a`, `0.9.8a`, `0.9.75a`, `0.9.7a`,
> `0.9.1a`, `0.9.0a`, `0.8.43a`, `0.8.42a`, `0.8.041a`, `0.8.4a`,
> `0.8.3a`, `0.8.2a`, `0.7.8a`, and `0.5.5a` — deep-dive notes live at
> this path under their git tags; the index is
> [`CHANGELOG.md`](./CHANGELOG.md).

## What's new in 0.9.93a

A critical fix for `aplyx update` itself — the previous "run it twice"
workaround is no longer needed — plus a new `aplyx version` command.

### Fixed: `aplyx update` could report success while changing nothing

Reported live: an update from `0.87a` straight to `0.92a` printed
"updated 0.87a -> 0.92a," but none of the actual changes showed up —
not the theme fixes, not the new Settings features, nothing.

Root cause: `update.py`'s `main()` pulls fresh source (`git pull` or a
tarball overlay), then calls `_post_update()` — the rebuild step — in
the *same, already-running Python process*. Python doesn't hot-reload a
module after its file changes on disk: `_post_update` (along with
everything else in `update.py`) was already imported into memory
*before* the pull overwrote `update.py`'s own source file, so that call
always ran whichever rebuild logic was current when the process
*started*, never whatever the update itself had just changed on disk a
moment earlier.

This made every `_post_update` fix effectively inert for exactly the
installs that needed it most: any install old enough to predate a given
`_post_update` fix would pull that fix's source correctly, report
success correctly, and then silently keep running the *old, broken*
rebuild logic anyway — forever, on a single run — because the process
computing "what to run next" had already decided before the new code
even arrived. Going from `.87a` (before 0.9.90a's core-rebuild-ordering
fix existed at all) to `.92a` in one hop hit this exactly: the
just-pulled, correct `_post_update` sat on disk the whole time, unused,
while the stale in-memory version kept skipping the `packages/core`
rebuild, `app`'s own `tsc` kept failing type-checking against a stale
core `dist/`, and `dist/cli.js` was never touched.

Fixed by running the post-update rebuild in a **fresh child process**
instead of the parent that just pulled — `update.py --post-update-only`,
spawned via `subprocess.run` right after the pull succeeds. A fresh
process re-imports the module from disk, so it always runs the version
that was *just* pulled, no matter how stale the parent's own in-memory
code is. This mirrors the identical self-re-exec pattern
`run_job_agent.py`'s own pre-run auto-update already uses, for the
exact same reason (`os.execv` after pulling, before continuing).

Verified directly, not just reasoned about: deleted a compiled file
from `packages/core/dist` by hand (reproducing the exact stale-dist
symptom), ran `update.py --post-update-only` in isolation, and
confirmed it rebuilt `packages/core` before `app` and restored the
missing file, producing a working `dist/cli.js`.

### Added: `aplyx version`

Prints the installed version, with `" (latest)"` appended when it
matches upstream `main` — e.g. `0.9.93a (latest)`. Shares its
remote-VERSION fetch with the existing launch-time update probe
(`detectUpdate`, extracted into a small shared `fetchRemoteVersion`
helper), but always actually checks — unlike that probe, it doesn't
skip the check for `APLYX_AUTO_UPDATE=0` or non-TTY output, since an
explicit `aplyx version` invocation should always get a real answer.
Fails open on a dead network: prints the local version with no
`(latest)` suffix rather than erroring.

## Republished as alpha.1 — Windows desktop app + install fixes

Same-day follow-up, reported live from Windows testing of `0.9.93-alpha.0`.
Build marker/VERSION stay `0.9.93a`; only the npm semver moved
(`alpha.0` → `alpha.1`), per the standing convention noted above.

### Fixed: desktop app sign-in crashed on Windows (`EISDIR: lstat 'C:'`)

Both the local and hosted sign-in screens failed with `Sign-in
couldn't start` / `Couldn't find a local aplyx installation`, the
error body reading `bridge produced non-JSON output: ... Error: EISDIR:
illegal operation on a directory, lstat 'C:'`. Both screens resolve
through the same `findRoot()` → Rust `run_bridge()` → `node
core/bridge.js` call, and the crash trace (pure `node:internal/modules`
frames, no application code) pins this as Node's own bootstrap failing
to resolve `argv[1]` before any of our code runs — a known Node-on-
Windows bug triggered by a script path that isn't clean and fully
qualified. `desktop/src-tauri/src/lib.rs`'s `bridge_script_path()`
resolved a path via Tauri's resource-dir API but never canonicalized
it, and `run_bridge()` let the spawned `node` process inherit whatever
working directory the OS happened to hand the GUI-launched `.exe`.

Fixed by canonicalizing the resolved script path and explicitly pinning
the spawned process's `current_dir()` to the script's own parent
directory, removing the dependency on ambient OS/launch state entirely
— the same category of fix `node_binary()` already applied for macOS's
Homebrew-PATH problem, now extended with real Windows-native probing
(`Program Files\nodejs`, Volta) instead of falling straight through to
a bare PATH lookup.

This was also the reason a fresh Windows install couldn't auto-locate
itself and fell back to the "browse for my aplyx folder" picker: the
crash happened *inside* `findRoot()`, before it ever got a chance to
read the `~/.aplyx/root` pin file `install.ps1`/`install_desktop.ps1`
already write unconditionally on every install. Fixing the crash was
the actual fix for that complaint too — no separate change needed.

### Fixed: installer progress bar inconsistent between steps

npm's own fetch-progress spinner — a rotating `-\|/` cursor, npm's
fallback on a Windows console without Unicode/Braille support — writes
to the same terminal line via `\r` as the installer's own bar, and the
two competing for that line is what looked like "the bar doesn't show,
it's back to a spinner" on the TUI/extension/desktop-frontend build
steps. Fixed in all four install scripts:

- `npm install --no-progress` on every `npm install` call disables
  npm's competing spinner (`--silent` only lowers its *log level*;
  progress is a separate switch).
- The indeterminate (no-byte-total) bar used for `npm install`/build
  steps now renders with the same `==>` arrowhead style as the
  byte-tracked download bar, instead of a plain dot-slide with no
  arrow — one consistent visual language across both.
- Each build step now reports its on-disk install size (e.g. `the TUI
  ready (312MB)`), the same way downloads already report MB fetched.

### Fixed: TUI fullscreen resize flicker on Windows Terminal

Maximizing/fullscreening on Windows Terminal fires a *burst* of
`resize` events for a single user action (the window-resize animation
reports several intermediate sizes), and both `altScreen.ts`'s resize
handler (a full-screen Ink `.clear()`) and `App.tsx`'s resize handler
(a React re-render) fired on every one of them — several full repaints
back-to-back, most visible tearing at the last-painted rows (hint bar,
sidebar divider). Debounced both handlers so a resize burst settles
into a single repaint.

### Changed: fresh installs no longer pull the whole dev repo

`install.sh`/`install.ps1`'s bootstrap and `update.py`'s tarball overlay
downloaded and extracted the entire tracked repo — CI workflow
definitions, four generated per-harness agent directories that
`generate_agent_definitions.py` regenerates from `agents/` on every
install anyway, `supabase/` migrations relevant only to whoever runs
the hosted backend, and internal design/process notes. Trimmed to only
what install/build/run/update actually touch; `update.py`'s change also
retroactively cleans up installs that predate this fix, not just new
ones. Scoped to the downloaded-tarball path only — never touches a real
`git clone`.

## Install / update / uninstall

```bash
# install (one command; puts `aplyx` on your PATH):
curl -fsSL https://raw.githubusercontent.com/keshm2/aplyx/main/scripts/install/install.sh | bash

# or via npm:
npm install -g @keshm/aplyx

# optionally also install the desktop app (or from TUI Settings > Desktop app):
bash scripts/install/install_desktop.sh        # macOS / Linux
powershell -ExecutionPolicy Bypass -File scripts\install\install_desktop.ps1   # Windows

# check the installed version:
aplyx version

# update now (also happens automatically on runs and launches):
aplyx update

# uninstall (removes the desktop app too, if installed):
aplyx uninstall          # add --keep-data to keep config/data/resumes
```

Windows: `powershell -ExecutionPolicy Bypass -File scripts\install\install.ps1`
(or `irm .../install.ps1 | iex`), native PowerShell, no WSL.

## Verification

- `npm run typecheck:app`, `npm run build`, and `npm run smoke` are all
  clean. `python3 -m py_compile scripts/install/update.py` is clean.
- The `update.py` fix was verified by direct reproduction: deleted
  `packages/core/dist/desktopApp.{js,d.ts}` by hand, ran `python3
  scripts/install/update.py --post-update-only` (the new child-process
  entry point) in isolation, and confirmed it correctly rebuilt
  `packages/core` first and restored the missing files, then confirmed
  `app`'s own build succeeded afterward with a fresh `dist/cli.js`
  timestamp.
- `aplyx version` was verified live against the real (not mocked)
  GitHub-hosted `VERSION` file in both states: printed the bare version
  with no suffix when ahead of upstream, and printed `X (latest)` when
  temporarily set to match upstream exactly.

## Release artifacts

- Git tag `v0.9.93a` on `main`.
- npm: `@keshm/aplyx@0.9.93-alpha.0` under the `latest` dist-tag
  (`cd app && npm publish` — `publishConfig` sets `access: public` and
  the tag). Publish requires `npm login` (and, on this account, an OTP
  step in the browser).
- CI workflow `.github/workflows/tui.yml` runs on every push touching
  the TUI/core. `.github/workflows/desktop-release.yml` builds and
  attaches desktop app bundles to a tagged release (triggered on `v*`
  tag pushes, or manually via `workflow_dispatch` for an existing tag)
  — not relevant to this TUI/runtime-only release.

## Known gaps

- Everything carried forward from 0.9.90a's Known Gaps still applies —
  see that entry in `CHANGELOG.md` for the full list (Automatic-run
  gate/sidebar reports awaiting re-confirmation on a fresh build, the
  80×20–22 terminal render glitch, Codex subagent registry-only status,
  desktop hosted-sync, Workday review-only, desktop locations-only
  filter).
