# Release notes — aplyx 0.9.88a

> **Build:** `0.9.88a` — alpha.
> **Branch:** `main`.
> **TUI in-app marker:** `packages/core/src/version.ts` →
> `BUILD_MARKER = "0.9.88a"` (re-exported from `app/src/theme.ts`,
> visible in the TUI side-panel footer, and also in the desktop app's
> Settings screen — one shared constant, both surfaces agree).
> **npm package:** `@keshm/aplyx` version `0.9.88-alpha.0`, published to
> the default `latest` dist-tag — `npm install -g @keshm/aplyx` gets it.
> The unscoped npm name `aplyx` belongs to an unrelated package — never
> `npm install aplyx`. If a re-publish is ever needed for this same
> build, the npm semver bumps to `alpha.1`/`alpha.2` while the
> human-facing build marker/git tag stay `0.9.88a`.
> **Rollout:** clients on the updater lineage self-update on their next
> scheduled run or `aplyx` launch; older installs update manually once
> (`bash scripts/install/update.sh` / `powershell scripts\install\
> update.ps1`) — **except this release**, which fixes the Windows
> installer itself; existing broken Windows installs need to re-run the
> one-liner (see below), not `aplyx update`.
> **Desktop app:** 0.1.0 internally (Tauri app version, not tied to the
> TUI's release cadence).
> **Browser extension:** unchanged in this build — `0.8.2` / `0.8.2a`.
> **Previous releases:** `0.9.87a`, `0.9.85a`, `0.9.8a`, `0.9.75a`,
> `0.9.7a`, `0.9.1a`, `0.9.0a`, `0.8.43a`, `0.8.42a`, `0.8.041a`,
> `0.8.4a`, `0.8.3a`, `0.8.2a`, `0.7.8a`, and `0.5.5a` — deep-dive notes
> live at this path under their git tags; the index is
> [`CHANGELOG.md`](./CHANGELOG.md).

## What's new in 0.9.88a

A same-day fast-follow to 0.9.87a: a critical fix for a Windows install
that hung completely (every time, both installer entry points), plus a
small consistency polish to the installer progress UI.

### Fixed: Windows install hung completely at the resumes step

Reported live: a fresh Windows install via `irm ... | iex` got through
config setup, harness detection, and the resumes-folder message, then
died with `The script failed due to call depth overflow` inside a
function called `Py`. `npm install -g @keshm/aplyx` hit the identical
failure, since the npm-installed `aplyx` command's own bootstrap (no
core checkout found) shells out to the exact same `install.ps1`.

Root cause: `install.ps1` defined a helper

```powershell
function Py { param([string[]]$a) & $py[0] @($py[1..($py.Length-1)] + $a) }
```

where `$py` is `Find-Python`'s result — `@("py", "-3")` when Python was
found via the Python Launcher (`py.exe`), which is the standard outcome
for anyone who installed Python from python.org or via `winget`, i.e.
most Windows users. `$py[0]` is then the literal string `"py"`, and
`& "py"` asks PowerShell to resolve a command named `py` — but
PowerShell's command-name resolution is **case-insensitive** and
**prefers functions over external executables** with the same name.
Since a function literally named `Py` was already in scope, `& "py"`
called that function instead of the real `py.exe` launcher — which
itself calls `& $py[0] ...` again, calling itself again, forever, until
the interpreter's call-depth limit tripped. This reproduced
deterministically for any Windows user whose Python was found via the
launcher (the common case), at the first call site
(`Py @("scripts\validate\generate_agent_definitions.py")`, step 6 —
exactly where the reported hang occurred) — there was no way past it
from inside the script; only closing the terminal worked.

Fixed by renaming the helper to `Invoke-Python`, a verb-noun name that
cannot collide with a real Windows command, and updating both call
sites. Also audited every other function name defined across all four
installer scripts (`Say`, `Warn`, `Fail`, `Spin`, `Find-Python`,
`Format-DownloadBar`, `Get-FileWithProgress`, `Write-DisabledDiscord`,
`Build-NodeSurface`, `Install-DesktopBundle`, `Try-PrebuiltInstall`,
`Refresh-Path`, ...) against real Windows/PowerShell command names —
none of the others collide; `Py` was the only one short enough and
common enough to hit this.

### Installer progress-bar consistency

The npm-install/build steps in all four installer scripts (core, TUI,
browser extension, desktop-from-source builds) have no byte total to
track, so they can't show a real percentage-based bar the way file
downloads do. They previously fell back to a bare rotating `|/-\`
spinner character next to the message; now they show an indeterminate
sliding bar instead — `[..===..........]`, the highlighted segment
bouncing back and forth — so every long-running step in the installer
reads as one consistent bar-based visual system instead of two
different progress idioms (a real bar for downloads, a spinner
elsewhere).

## Install / update / uninstall

```bash
# install (one command; puts `aplyx` on your PATH):
curl -fsSL https://raw.githubusercontent.com/keshm2/aplyx/main/scripts/install/install.sh | bash

# or via npm:
npm install -g @keshm/aplyx

# optionally also install the desktop app:
bash scripts/install/install_desktop.sh        # macOS / Linux
powershell -ExecutionPolicy Bypass -File scripts\install\install_desktop.ps1   # Windows

# update now (also happens automatically on runs and launches):
aplyx update

# uninstall (removes the desktop app too, if installed):
aplyx uninstall          # add --keep-data to keep config/data/resumes
```

Windows: `powershell -ExecutionPolicy Bypass -File scripts\install\install.ps1`
(or `irm .../install.ps1 | iex`), native PowerShell, no WSL.

**If you hit the 0.9.87a-or-earlier Windows hang:** close the terminal
and re-run the one-liner above (or `aplyx update` from a shell where
`aplyx` already resolves, e.g. if the TUI itself built successfully
before the hang) — a fresh `install.ps1` fetch picks up this fix.

## Verification

- `install.sh` / `install_desktop.sh`: `bash -n` clean on both. The new
  `_indeterminate_bar` / `spin()` were verified live in a real tmux TTY
  session — confirmed the bar visibly slides back and forth over a
  3-second background job and clears cleanly on completion, leaving
  just the caller's own output behind.
- `install.ps1` / `install_desktop.ps1`: no PowerShell interpreter
  available in this environment, so these were verified by careful
  manual review only — brace/paren balance checked programmatically
  (the pre-existing 3-paren imbalance in `install.ps1` was confirmed,
  via `git show HEAD~1`, to already exist before this release's edits;
  not introduced by them), and the `Py` → `Invoke-Python` root-cause
  analysis was confirmed against PowerShell's documented command
  resolution order (functions before external executables,
  case-insensitive name matching), not just guessed at. **A real
  Windows run of this fix is still owed** — flagged below, same caveat
  as every prior release's PowerShell changes.
- `npm run typecheck:app` and `npm run build` still clean (this
  release touches no TypeScript).

## Release artifacts

- Git tag `v0.9.88a` on `main`.
- npm: `@keshm/aplyx@0.9.88-alpha.0` under the `latest` dist-tag
  (`cd app && npm publish` — `publishConfig` sets `access: public` and
  the tag). Publish requires `npm login`.
- CI workflow `.github/workflows/tui.yml` runs on every push touching
  the TUI/core. `.github/workflows/desktop-release.yml` builds and
  attaches desktop app bundles to a tagged release (triggered on `v*`
  tag pushes, or manually via `workflow_dispatch` for an existing tag).

## Known gaps

- **Real Windows execution of this exact fix is still unverified** —
  the root-cause analysis is thorough and the fix is minimal/mechanical
  (a rename plus two call-site updates), but no PowerShell interpreter
  was available to actually run it this pass. Please confirm on a real
  Windows machine and report back if it still hangs anywhere.
- The 80×20–22 terminal-size Settings-field-list render glitch noted in
  0.9.87a (pre-existing, not a regression, not yet root-caused).
- Codex CLI subagents remain registry-only, not invokable in headless
  mode, pending upstream openai/codex#15250.
- Desktop app: hosted↔local pipeline-state sync doesn't exist yet —
  `SupabaseAdapter.loadState()` returns `undefined`.
- Workday remains review-only by design.
- The "preferred locations only" filter is still offline on desktop,
  pending a redesign now that pagination has landed (unchanged from
  0.9.8a).
