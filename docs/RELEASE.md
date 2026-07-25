# Release notes — aplyx 0.9.94a

> **Build:** `0.9.94a` — alpha.
> **Branch:** `main`.
> **TUI in-app marker:** `packages/core/src/version.ts` →
> `BUILD_MARKER = "0.9.94a"` (re-exported from `app/src/theme.ts`,
> visible in the TUI side-panel footer, and also in the desktop app's
> Settings screen — one shared constant, both surfaces agree).
> **npm package:** `@keshm/aplyx` version `0.9.94-alpha.0`, published to
> the default `latest` dist-tag — `npm install -g @keshm/aplyx` gets it.
> The unscoped npm name `aplyx` belongs to an unrelated package — never
> `npm install aplyx`.
> **Rollout, read this first:** `0.9.93-alpha.1` shipped *source* fixes
> for the desktop app's Windows sign-in crash, but never actually
> produced a new desktop build — see "Fixed: the alpha.1 desktop fix
> never shipped" below. If you installed the desktop app before this
> release, `install_desktop.ps1`/`.sh` (re-run any time) or a fresh
> download from this release's assets is what actually gets you the fix;
> the TUI (npm/`aplyx update`) side of alpha.1 was live the whole time.
> **Desktop app:** 0.1.0 internally (Tauri app version, not tied to the
> TUI's release cadence) — this release DOES rebuild it (see rollout
> note above), unlike most TUI-only releases.
> **Browser extension:** unchanged in this build — `0.8.2` / `0.8.2a`.
> **Previous releases:** `0.9.93a`, `0.9.92a`, `0.9.91a`, `0.9.90a`,
> `0.9.89a`, `0.9.88a`, `0.9.87a`, `0.9.85a`, `0.9.8a`, `0.9.75a`,
> `0.9.7a`, `0.9.1a`, `0.9.0a`, `0.8.43a`, `0.8.42a`, `0.8.041a`,
> `0.8.4a`, `0.8.3a`, `0.8.2a`, `0.7.8a`, and `0.5.5a` — deep-dive notes
> live at this path under their git tags; the index is
> [`CHANGELOG.md`](./CHANGELOG.md).

## What's new in 0.9.94a

Both issues reported as "still there" after `0.9.93-alpha.1` turned out
to have real, distinct root causes — neither was "the fix was wrong" in
the way that phrase usually means. Full write-ups below.

### Fixed: the alpha.1 desktop fix never shipped (deployment gap, not a code bug)

`0.9.93-alpha.1`'s commit landed the actual Rust fix for the Windows
`EISDIR: lstat 'C:'` sign-in crash, but only pushed to `main` — no new
git tag. `.github/workflows/desktop-release.yml`, which compiles the
desktop app for macOS/Linux/Windows and attaches the installers to a
GitHub Release, triggers **only** on a `v*` tag push (or manual
`workflow_dispatch` against an existing tag). It does not run on a
plain push to `main`. Confirmed directly: `gh release view v0.9.93a`
shows that release (with its `aplyx_0.1.0_x64-setup.exe` Windows
installer — the exact asset `install_desktop.ps1`'s
`Try-PrebuiltInstall` downloads) was published *before* the alpha.1
fix commit existed, and no later tag was ever pushed to trigger a
rebuild. Every user who ran (or re-ran) `install_desktop.ps1` after
alpha.1 kept getting the byte-for-byte pre-fix binary — which is
exactly "the same error is still there," reported precisely.

This release exists specifically to cut the `v0.9.94a` tag so a real
rebuild happens. There is no npm-style "same version, different
content" escape hatch for GitHub Releases the way there is for npm's
`alpha.N` suffix — the only way to get new binaries out is a new tag,
which is also why this release bumps the human-facing version instead
of repeating the alpha-suffix trick.

### Fixed: a real defect found while re-checking the Rust fix itself

Re-auditing `desktop/src-tauri/src/lib.rs`'s `EISDIR` fix (rather than
assuming it was correct because it hadn't been proven wrong) surfaced a
second, independent problem: `PathBuf::canonicalize()` on Windows
always returns an extended-length path prefixed `\\?\` (documented Rust
std / Windows behavior, via `GetFinalPathNameByHandleW`). That prefix
opts a path *out* of normal Win32 path processing, and Microsoft's own
"Maximum Path Length Limitation" docs explicitly call out
`SetCurrentDirectory` (which underlies `CreateProcess`'s working-
directory argument, i.e. Rust's `Command::current_dir()`) as one of the
APIs that does **not** support it. The alpha.1 fix canonicalized the
bridge script path and then used *that same verbatim path's parent* as
the spawned Node process's `current_dir()` — a real, documented Windows
limitation, independent of whatever caused the original crash.

Verified what Node itself does with a `\\?\`-prefixed path is fine at
the path-string level — `path.win32.parse/resolve/dirname/isAbsolute`
all handle it correctly (checked directly, via Node's own `path.win32`
module, which is available and identical on any OS): the risk was
specifically the `current_dir()` use, not the script-path argument
itself. Fixed by stripping the `\\?\` prefix back off after
canonicalizing (a small `strip_verbatim_prefix` helper, the same
approach the `dunce` crate exists for) before the path is used
anywhere — keeps the actual benefit of canonicalizing (fully resolved,
unambiguous, no relative components or symlink indirection) without
handing any Windows API a path form it doesn't support.

### Fixed: TUI flicker (the actual cause — not the resize-burst fix from alpha.1)

The alpha.1 release debounced `resize` event handling on the theory
that Windows Terminal fires a burst of resize events during a maximize
animation. That's a real, legitimate thing to guard against and the
fix stays, but it wasn't the cause of the reported flicker — which is
why it didn't fix it. Root cause, found by reading Ink's actual
rendering code rather than continuing to guess: `node_modules/ink/
build/log-update.js` does a full terminal erase + full rewrite on
*every* render (`ansiEscapes.eraseLines(previousLineCount)` then write
the entire new frame) — there is no partial/line-level diffing in this
version of Ink. Any component that re-renders on its own timer, for as
long as it stays mounted, forces a full-screen repaint on every tick.

`TopStatusBar` (the app shell's header, mounted unconditionally for the
entire session on every tab) renders the user's greeting name through
`RainbowText`, which cycles its hue every 90ms *forever*, with no
gating beyond reduced-motion. That's roughly 11 full-terminal
erase-and-rewrite cycles per second, continuously, for as long as
aplyx is open — worse at a larger (fullscreen) terminal, since each
cycle has more rows to erase and redraw, and apparently more visible on
Windows Terminal's renderer than whatever terminal this went untested
against before. This fully explains "flickers when fullscreened, worst
at the control keys and the bottom half of the vertical bar": those are
literally the last-painted regions of every one of those ~11/s
full-frame rewrites.

Verified empirically, not just reasoned about: rendered the real
compiled `TopStatusBar` component through Ink with a mocked `stdout`
that counts writes instead of emitting them, with `FORCE_COLOR=3` so
the hue animation actually produces distinct output strings (the
default detection in a piped/mocked environment doesn't, which
initially produced misleading flat results before this was caught).
Unfixed baseline: a steady ~11 writes/sec, indefinitely. Fixed
(`RainbowText`'s new `stopAfterMs` prop, set to a 4-second flourish on
the header specifically — the other three call sites, a Settings tier
preview and two MAX-cap warnings and a live-run gauge, keep animating
indefinitely since they're only ever mounted during an actually-active,
temporary state): identical ~11/s during the first 4 seconds, then
**zero** additional writes for the remainder of an 8-second observation
window. Also stopped `TopStatusBar`'s separate 1 Hz clock tick — it
only displays hour:minute (no seconds), so 59 of every 60 ticks were
already redundant; rescheduled it to align with the next minute
boundary instead of a flat `setInterval(1000)`.

### Changed: fresh installs no longer pull the whole dev repo

Unchanged from `0.9.93-alpha.1` — carried forward here since this is
now the current release. `install.sh`/`install.ps1`'s bootstrap and
`update.py`'s tarball overlay downloaded and extracted the entire
tracked repo — CI workflow definitions, four generated per-harness
agent directories that `generate_agent_definitions.py` regenerates from
`agents/` on every install anyway, `supabase/` migrations relevant only
to whoever runs the hosted backend, and internal design/process notes.
Trimmed to only what install/build/run/update actually touch;
`update.py`'s change also retroactively cleans up installs that predate
this fix, not just new ones. Scoped to the downloaded-tarball path
only — never touches a real `git clone`.

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

- `npm run typecheck` and `npm run build` (`--workspace=app`) are
  clean; `npm run smoke` passes. `cargo check` on `desktop/src-tauri` is
  clean (no Windows cross-compiler available in this environment — the
  Windows-only `node_binary_uncached` branch and the `\\?\`-stripping
  logic were reviewed by hand and against Node's own cross-platform
  `path.win32` module rather than compiled for the target, since
  `rustup`/a Windows target weren't available here).
- The flicker fix was verified empirically (not just by typecheck): see
  the write-count methodology described above, run against the actual
  compiled `TopStatusBar`/`RainbowText` output.
- `path.win32.parse/resolve/dirname/isAbsolute` behavior on a
  `\\?\C:\...` input was checked directly against Node's real `path`
  module (available cross-platform) to confirm the verbatim prefix
  isn't itself mis-parsed at the string level — isolating the actual
  risk to the `current_dir()`/`SetCurrentDirectory` use specifically.
- Desktop `.exe`/`.msi`/`.dmg`/`.deb`/etc. builds themselves are
  produced by `.github/workflows/desktop-release.yml` on GitHub-hosted
  runners (this release's whole reason for existing) — not built or
  run here; correctness there rests on the `cargo check` pass plus the
  reasoning above, not a live Windows test.

## Release artifacts

- Git tag `v0.9.94a` on `main` — this time actually pushed, which is
  what makes this release's desktop builds real (see "Fixed: the
  alpha.1 desktop fix never shipped" above).
- npm: `@keshm/aplyx@0.9.94-alpha.0` under the `latest` dist-tag
  (`cd app && npm publish` — `publishConfig` sets `access: public` and
  the tag). Publish requires `npm login` (and, on this account, an OTP
  step in the browser).
- CI workflow `.github/workflows/tui.yml` runs on every push touching
  the TUI/core. `.github/workflows/desktop-release.yml` builds and
  attaches desktop app bundles to the `v0.9.94a` tag — relevant to
  *this* release, unlike most TUI-only releases.

## Known gaps

- Everything carried forward from 0.9.90a's Known Gaps still applies —
  see that entry in `CHANGELOG.md` for the full list (Automatic-run
  gate/sidebar reports awaiting re-confirmation on a fresh build, the
  80×20–22 terminal render glitch, Codex subagent registry-only status,
  desktop hosted-sync, Workday review-only, desktop locations-only
  filter).
- The Windows desktop-app fixes in this release (EISDIR crash, the
  `\\?\` current_dir defect) are reasoned + `cargo check`-verified but
  not confirmed on a real Windows machine, for the same reason alpha.1
  wasn't either: no Windows environment available here. Please
  re-verify on the real hardware that reported this.
