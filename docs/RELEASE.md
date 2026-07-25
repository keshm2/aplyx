# Release notes — aplyx 0.9.89a

> **Build:** `0.9.89a` — alpha.
> **Branch:** `main`.
> **TUI in-app marker:** `packages/core/src/version.ts` →
> `BUILD_MARKER = "0.9.89a"` (re-exported from `app/src/theme.ts`,
> visible in the TUI side-panel footer, and also in the desktop app's
> Settings screen — one shared constant, both surfaces agree).
> **npm package:** `@keshm/aplyx` version `0.9.89-alpha.0`, published to
> the default `latest` dist-tag — `npm install -g @keshm/aplyx` gets it.
> The unscoped npm name `aplyx` belongs to an unrelated package — never
> `npm install aplyx`. If a re-publish is ever needed for this same
> build, the npm semver bumps to `alpha.1`/`alpha.2` while the
> human-facing build marker/git tag stay `0.9.89a`.
> **Rollout:** clients on the updater lineage self-update on their next
> scheduled run or `aplyx` launch; older installs update manually once
> (`bash scripts/install/update.sh` / `powershell scripts\install\
> update.ps1`) — Windows installs still on 0.9.87a-or-earlier should
> re-run the one-liner directly rather than `aplyx update`, to pick up
> 0.9.88a's install-hang fix first.
> **Desktop app:** 0.1.0 internally (Tauri app version, not tied to the
> TUI's release cadence).
> **Browser extension:** unchanged in this build — `0.8.2` / `0.8.2a`.
> **Previous releases:** `0.9.88a`, `0.9.87a`, `0.9.85a`, `0.9.8a`,
> `0.9.75a`, `0.9.7a`, `0.9.1a`, `0.9.0a`, `0.8.43a`, `0.8.42a`,
> `0.8.041a`, `0.8.4a`, `0.8.3a`, `0.8.2a`, `0.7.8a`, and `0.5.5a` —
> deep-dive notes live at this path under their git tags; the index is
> [`CHANGELOG.md`](./CHANGELOG.md).

## What's new in 0.9.89a

A TUI-focused bug-fix + polish pass: a real fix for the Windows
desktop-app install offer going missing, a new "Install desktop app"
Settings action, a city-search ranking bug, a genuine selector-vanishing
bug found in three different list screens, more reliable onboarding
page navigation, and a rewrite of how the update-prompt box claims its
space so it renders as a complete box instead of colliding with the
sidebar.

### Fixed: Windows desktop-app install offer going missing

Reported live: after a fresh Windows install (`npm install -g
@keshm/aplyx` followed by the TUI's own first-run bootstrap, or the
`irm | iex` one-liner directly), the script went straight from "TUI
built" to "done" — the "aplyx also has an early-preview desktop app…"
offer never appeared at all, no prompt, no error.

Root cause: `install.ps1`'s step 8 (build the TUI from source) and step
8b (offer the desktop app) are both gated behind the same `Get-Command
npm -ErrorAction SilentlyContinue` check. `install.ps1` runs as its own
spawned subprocess — either via the npm-installed `aplyx` command's own
`bootstrapCore()` (`powershell -NoProfile -File ...`), or the `irm |
iex` one-liner — and that subprocess inherits a `$env:PATH` snapshot
from its parent's process start, which can be stale relative to the
registry even when `npm` clearly resolves in the user's own interactive
shell. `-NoProfile` compounds this: it also skips any PATH
customization a PowerShell profile script would normally contribute
(common for Node version managers on Windows). The TUI the user ended
up with had actually come from the separate `npm install -g
@keshm/aplyx` command, not from `install.ps1` at all — its own npm
detection had quietly failed and skipped both steps.

Fixed by refreshing `$env:PATH` from the registry (Machine + User,
appended rather than replacing so nothing already valid is lost) right
after each script sets its working directory — the exact same fix
already applied elsewhere in `install.ps1` for a freshly-winget-
installed Python, just never extended to Node/npm detection. Applied to
both `install.ps1` and `install_desktop.ps1` (the latter runs as its
own further-spawned subprocess with the identical exposure for its
`cargo`/`winget`/`rustup-init` checks).

### Added: "Install desktop app" in TUI Settings

A new Desktop app section in Settings lets anyone who skipped the
desktop app during setup install it later, without re-running the whole
installer or hunting for the right command. Selecting it leaves the TUI
and hands off to `install_desktop.sh` (or `.ps1` on Windows) on the
normal screen — the script keeps its own interactive prompts and
progress bars, prefers a prebuilt download, falls back to building from
source — then returns to a fresh `aplyx` launch when it's done, the
same exit-then-run-on-the-normal-screen handoff the existing
update-install flow already uses.

Already installed? The row renders dimmed with a green
"✓ app is already installed (vX.Y)" note on its own line beneath it,
and Enter is a no-op instead of a dead re-offer. Detection is via a
small marker file (`~/.aplyx/desktop_installed`, plain text — the aplyx
VERSION current at install time) that both installer scripts now write
on success (both the prebuilt-download and build-from-source paths),
read fresh on every render via a new `@aplyx/core/desktopApp.js` — no
caching, so installing it from Settings, or by hand outside aplyx
entirely, is picked up on the very next render with no restart needed.
A marker file rather than probing real install locations directly: the
actual path varies by OS and, on Linux, by which of three package
formats (`apt`/`dnf`/AppImage) ended up being used — the installer
already knows definitively whether it succeeded, so it just says so.

### Fixed: city search ranking

Searching "sea" in the onboarding wizard's location field returned
"Scottsdale, AZ" as the top result instead of "Seattle, WA". Traced the
exact scores: the fuzzy matcher's word-boundary bonus rewards a
character landing right after a space/hyphen/underscore, and
"Scottsdale, AZ" happens to hit that bonus twice for a "sea" query (once
at the city name's own start, once for the "a" right after the comma
into the state code) — two boundary hits (11 + 11 points-ish) edged out
"Seattle, WA"'s single boundary hit plus a long unbroken consecutive run
by a single point (22 vs 23). Added an explicit bonus for a genuine
prefix match (`text.startsWith(query)`) large enough to dominate any
combination of the other bonuses, so a real prefix always wins
regardless of what a scattered match elsewhere in a busier candidate
string might score.

### Fixed: selection marker vanishing in scrollable lists

Reported as "sometimes there's an empty entry the selector skips over —
you have to press down again." Root cause, found in three places
(`MultiEntryAutocomplete`'s city/company suggestion list, `ReviewScreen`'s
queue, and `SettingsScreen`'s checklist popup): each computed its
scroll-window offset in a `useEffect` reacting to the cursor position,
which only runs *after* the render where the cursor had already moved —
producing a real intermediate frame, actually painted to the terminal,
where the just-moved cursor had scrolled past the edge of the
still-stale window and nothing visible carried the selection marker.
Fixed all three by deriving the offset synchronously during render (via
a ref, not `useState`+`useEffect`) — React's own recommended pattern for
adjusting a value in response to a prop/state change without an extra
render pass — so the window rendered on any given pass is already
correct, with no lag possible.

### Fixed: onboarding back/forward navigation unreliable on Windows

Page navigation only listened for Shift+Left/Shift+Right. Several
Windows terminal hosts (legacy `conhost.exe`, and some Windows
Terminal/shell combinations) don't reliably emit the modifier-prefixed
escape sequence arrow keys need to report Shift — silently making
Shift+←/→ inert with no error. PageUp/PageDown are now the primary
back/forward keys (a dedicated, unambiguous escape sequence every
terminal sends the same way, no modifier-detection involved);
Shift+←/→ still works too, wherever it already did.

### Fixed: update-prompt box rendering incompletely / colliding with the sidebar

Reported as "only 3 sides display, the top is overtaken by the
sidebar." Root cause: neither the sidebar nor the main content column
actually enforced the row budget `contentRows` computed for them —
`overflow="hidden"` alone clips nothing unless the box's own layout
size is pinned to something concrete, and without a `height` prop both
just rendered at their natural content size instead. On any screen
whose content ran even slightly longer than its budget (confirmed live
with `WelcomeScreen`'s description text + option list), the whole
document grew past the terminal's actual height, and whatever didn't
fit got clipped from wherever the overflow physically landed — which
could be the update-prompt box below, even though it had done nothing
wrong itself. Fixed by pinning `height={contentRows}` (plus
`overflow="hidden"`) on both the sidebar and the main content column,
so neither can ever grow past its budget regardless of what a given
screen tries to render. Verified live in tmux: the box's all-4-sides
render restored, no more collision.

Also added: a clickable `[×]` close control in the box's top border
(mouse click or `Esc`), alongside the existing `y`/`n` keyboard and
mouse-click controls — declining and closing are the same outcome, just
two more ways in to it.

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

- `npm run typecheck:app` (rebuilds `@aplyx/core` first), `npm run
  build`, and `npm run smoke` are all clean. `desktop`'s own `npm run
  typecheck` is clean too (touched via `@aplyx/core`'s new
  `desktopApp.ts` export).
- The city-search ranking fix was verified by tracing the exact scores
  for "sea" against both "seattle, wa" and "scottsdale, az" before and
  after (22 vs 23 → 72 vs 23).
- The selector-vanishing fix's root cause was confirmed by reasoning
  through React's effect-timing model (`useEffect` runs after the
  commit it reacts to), not just inferred from the symptom.
- The update-box fix was verified live in a real tmux terminal session:
  reproduced the exact "top border missing" symptom against
  `WelcomeScreen`'s longer content, then confirmed the fix restores all
  4 sides and that `Esc` correctly dismisses the box and lets the
  underlying screen reclaim the freed space with no leftover gap.
- The "Install desktop app" Settings feature was verified live end to
  end for both states: the not-installed row renders actionable, and —
  after writing a test `~/.aplyx/desktop_installed` marker — the
  installed row renders dimmed with the green checkmark note, and Enter
  correctly no-ops with an explanatory message instead of re-triggering
  install.
- **Not verified by actual execution**: the Windows PATH-refresh fix and
  the "Install desktop app" action's real exit-and-run-install.ps1
  handoff — no PowerShell interpreter available in this environment.
  The PATH fix is reasoned through PowerShell's documented subprocess
  environment-inheritance behavior and mirrors an already-working
  pattern elsewhere in the same file; the install-handoff code mirrors
  the already-proven `onUpdateInstall` pattern exactly. Both are due a
  real Windows confirmation.

## Release artifacts

- Git tag `v0.9.89a` on `main`.
- npm: `@keshm/aplyx@0.9.89-alpha.0` under the `latest` dist-tag
  (`cd app && npm publish` — `publishConfig` sets `access: public` and
  the tag). Publish requires `npm login` (and, on this account, an OTP
  step in the browser).
- CI workflow `.github/workflows/tui.yml` runs on every push touching
  the TUI/core. `.github/workflows/desktop-release.yml` builds and
  attaches desktop app bundles to a tagged release (triggered on `v*`
  tag pushes, or manually via `workflow_dispatch` for an existing tag).

## Known gaps

- Windows execution of this release's `.ps1` changes remains
  unconfirmed by an actual run — flagged above, carried forward until
  someone reports back from a real Windows machine.
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
