# Release notes — aplyx 0.9.91a

> **Build:** `0.9.91a` — alpha.
> **Branch:** `main`.
> **TUI in-app marker:** `packages/core/src/version.ts` →
> `BUILD_MARKER = "0.9.91a"` (re-exported from `app/src/theme.ts`,
> visible in the TUI side-panel footer, and also in the desktop app's
> Settings screen — one shared constant, both surfaces agree).
> **npm package:** `@keshm/aplyx` version `0.9.91-alpha.0`, published to
> the default `latest` dist-tag — `npm install -g @keshm/aplyx` gets it.
> The unscoped npm name `aplyx` belongs to an unrelated package — never
> `npm install aplyx`. If a re-publish is ever needed for this same
> build, the npm semver bumps to `alpha.1`/`alpha.2` while the
> human-facing build marker/git tag stay `0.9.91a`.
> **Rollout — still applies from 0.9.90a:** if your install predates
> 0.9.90a's `update.py` fix, run `aplyx update` **twice** (the first run
> pulls the fix's source but still executes with the old, already-loaded
> broken rebuild order — Python doesn't hot-reload — so it won't take
> effect until the *second* run), or just re-run the full installer
> one-liner directly once.
> **Desktop app:** 0.1.0 internally (Tauri app version, not tied to the
> TUI's release cadence) — unaffected by this release, TUI-only.
> **Browser extension:** unchanged in this build — `0.8.2` / `0.8.2a`.
> **Previous releases:** `0.9.90a`, `0.9.89a`, `0.9.88a`, `0.9.87a`,
> `0.9.85a`, `0.9.8a`, `0.9.75a`, `0.9.7a`, `0.9.1a`, `0.9.0a`,
> `0.8.43a`, `0.8.42a`, `0.8.041a`, `0.8.4a`, `0.8.3a`, `0.8.2a`,
> `0.7.8a`, and `0.5.5a` — deep-dive notes live at this path under their
> git tags; the index is [`CHANGELOG.md`](./CHANGELOG.md).

## What's new in 0.9.91a

The Dark/Light binary is replaced with four named, color-identified
themes, and the update-prompt box's "glow" highlight is now correctly
theme-aware instead of hardcoded to blend toward white. (This entry
folds together three same-day iterations under one tag, before any
wider rollout — a brighter-but-still-violet banner pass, then a
blue-identity pass, then this full four-theme rework — replacing each
prior version rather than sitting alongside it, still under 0.9.91a.)

### Changed: four named themes instead of Dark/Light

"Dark"/"Light" described a terminal background, not a color identity —
once there was reason for more than one palette per background, a mode
name stopped meaning anything on its own. `theme.ts` now defines four:

| Theme | Identity | Terminal background |
| --- | --- | --- |
| **Aplyx Default** | violet → maroon (unchanged from the original palette) | dark |
| **Cloud Surf** | blue → white | light |
| **Ember Dusk** *(new)* | amber → deep ember | dark |
| **Mint Frost** *(new)* | teal → white | light |

Every consumer that already reads the shared `theme` object live —
sidebar border, tab/option selection, titles, the ASCII banner — picks
up all four with zero call-site changes, the same mechanism that
already carried the Dark/Light split. `good`/`warn`/`danger` stay their
outcome colors (green/amber/red) regardless of theme — they carry
meaning (applied/needs-review/failed), not brand identity. Old installs
with `APLYX_TUI_THEME=dark`/`light` still resolve correctly — mapped to
Aplyx Default/Cloud Surf respectively in both the actual palette
resolution (`resolveThemeMode`) and the Settings popup's checkmark
display (`currentOptionValue`), rather than silently losing a saved
preference or showing nothing checked.

### Fixed: update-box "glow" hardcoded to blend toward white

UpdateBox's traveling border highlight blended `theme.accent` toward a
literal `#FFFFFF` — fine for a dark-background theme (a bright pop
against both the accent and the terminal), but for a light-background
theme (Cloud Surf, Mint Frost) that blend fades the highlight into an
already-white terminal until it's unreadable at the wave's peak. Added
`glow` as a fourth color on the `Palette` interface — white for the two
dark-terminal themes, a deep near-black shade of the theme's own hue for
the two light-terminal ones (`#1E3A8A` navy for Cloud Surf, `#134E4A`
teal for Mint Frost) — and changed `UpdateBox`'s `blend()` to
interpolate `theme.accent` → `theme.glow` instead of a hardcoded white.
`sparkleGradient()` (the AUTO-badge sparkle and default-gradient
progress bars) had the identical hardcoded-white exposure and got the
same fix.

### Also carried in this pass

- Fixed a second instance of the `React.memo` staleness bug found
  earlier for the banner's *wordmark* variant: `Banner` memoizes on
  props, so its gradient has to be threaded through as an explicit
  `gradient` prop (like `accent` already is) rather than read from a
  theme.js function inside the component — otherwise switching themes
  would leave the art variant frozen at whichever gradient was live at
  the banner's last resize.
- Each new theme's banner gradient mirrors its dark/light counterpart's
  shape (Ember Dusk fades light-amber-to-deep-ember like Aplyx Default
  fades light-violet-to-maroon; Mint Frost fades teal-to-near-white like
  Cloud Surf fades blue-to-near-white) so all four read as one coherent
  system rather than four unrelated palettes.

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
  clean.
- Verified live in tmux across every theme, not just spot-checked one:
  captured raw ANSI codes for all 6 banner rows in Aplyx Default, Cloud
  Surf, Ember Dusk, and Mint Frost, confirming each against its
  respective `BANNER_GRADIENT_*` constant's exact hex stops. Confirmed
  the Settings popup's checkmark correctly resolves a legacy
  `APLYX_TUI_THEME=light` value to "Cloud Surf" (both before and after
  the `currentOptionValue` back-compat fix — reproduced the "nothing
  checked" gap first, then confirmed it resolved). Triggered the actual
  update-prompt box (temporarily lowering local `VERSION`) and captured
  its border-wave ANSI codes for Mint Frost and Ember Dusk specifically
  — confirmed the wave's endpoints exactly match `theme.accent` and
  `theme.glow` for each (Mint Frost's dark-teal glow for a
  light-terminal theme; Ember Dusk's white glow for a dark-terminal
  theme), not just that the box renders at all.
- One clipping artifact hit during testing (a 4-option Theme popup plus
  the update box both open at once, at a 30-row terminal, made the
  cursor seem to "skip" an option) was confirmed to be the terminal
  simply being too short for everything simultaneously — re-tested at
  45 rows with all four options visible at once and no update box open,
  confirmed it was never a real navigation bug.

## Release artifacts

- Git tag `v0.9.91a` on `main`.
- npm: `@keshm/aplyx@0.9.91-alpha.0` under the `latest` dist-tag
  (`cd app && npm publish` — `publishConfig` sets `access: public` and
  the tag). Publish requires `npm login` (and, on this account, an OTP
  step in the browser).
- CI workflow `.github/workflows/tui.yml` runs on every push touching
  the TUI/core. `.github/workflows/desktop-release.yml` builds and
  attaches desktop app bundles to a tagged release (triggered on `v*`
  tag pushes, or manually via `workflow_dispatch` for an existing tag)
  — not relevant to this TUI-only release.

## Known gaps

- Everything carried forward from 0.9.90a's Known Gaps still applies —
  see that entry in `CHANGELOG.md` for the full list (Automatic-run
  gate/sidebar reports awaiting re-confirmation on a fresh build, the
  80×20–22 terminal render glitch, Codex subagent registry-only status,
  desktop hosted-sync, Workday review-only, desktop locations-only
  filter).
