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

A small, focused follow-up to 0.9.90a: the TUI's ASCII-art banner is
now genuinely brighter in Light mode instead of secretly rendering
identical colors to Dark mode.

### Changed: brighter banner gradient in Light mode

The banner (`Banner.tsx`) was never theme-reactive at all — same
violet→maroon `BANNER_GRADIENT` regardless of the Settings Theme field,
by original design ("the one loud element," deliberately static). That
gradient's lower half (plum → maroon, tuned for contrast against a
*black* background) reads muddy and low-contrast against a light/white
terminal background instead. Added a real Light-mode variant —
`BANNER_GRADIENT_LIGHT`, violet → purple → fuchsia → pink → rose → red,
every stop fully saturated (no pale end that would wash out on white,
no near-black end that would go muddy) — and a `bannerGradient()`
function that picks between the two based on the current Theme setting.

Threading it into the actual component needed the same fix already
applied once this week for the banner's *wordmark* variant (the
narrow/short-terminal fallback): `Banner` is wrapped in `React.memo`,
which only re-renders on a shallow prop change — `theme.accent` and
`bannerGradient()`'s result are both invisible to that check unless
passed down as plain props, since neither is itself a "new" prop value
memo would notice otherwise. `accent` was already fixed this way;
`gradient` had the identical exposure and gets the same treatment here,
so it doesn't remain frozen at whichever gradient was live at the
banner's last resize.

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
- Verified live in a real tmux terminal session: captured the raw ANSI
  color codes for all 6 banner rows in Dark mode (matching
  `BANNER_GRADIENT` exactly), switched Settings' Theme field to Light,
  re-captured, and confirmed all 6 rows changed to the exact new
  `BANNER_GRADIENT_LIGHT` hex values — not just that *something*
  changed, the precise stops.

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
