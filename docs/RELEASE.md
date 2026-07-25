# Release notes — aplyx 0.9.90a

> **Build:** `0.9.90a` — alpha.
> **Branch:** `main`.
> **TUI in-app marker:** `packages/core/src/version.ts` →
> `BUILD_MARKER = "0.9.90a"` (re-exported from `app/src/theme.ts`,
> visible in the TUI side-panel footer, and also in the desktop app's
> Settings screen — one shared constant, both surfaces agree).
> **npm package:** `@keshm/aplyx` version `0.9.90-alpha.0`, published to
> the default `latest` dist-tag — `npm install -g @keshm/aplyx` gets it.
> The unscoped npm name `aplyx` belongs to an unrelated package — never
> `npm install aplyx`. If a re-publish is ever needed for this same
> build, the npm semver bumps to `alpha.1`/`alpha.2` while the
> human-facing build marker/git tag stay `0.9.90a`.
> **Rollout — read this before relying on `aplyx update` for this one:**
> this release fixes a bug in the updater itself (see below). Anyone on
> an install that predates this fix should run `aplyx update` **twice**
> (the first run pulls this fix's source but still executes with the
> old, already-loaded broken rebuild order — Python doesn't hot-reload —
> so it won't actually take effect until the *second* run), or just
> re-run the full installer one-liner directly once, which sidesteps the
> issue entirely.
> **Desktop app:** 0.1.0 internally (Tauri app version, not tied to the
> TUI's release cadence).
> **Browser extension:** unchanged in this build — `0.8.2` / `0.8.2a`.
> **Previous releases:** `0.9.89a`, `0.9.88a`, `0.9.87a`, `0.9.85a`,
> `0.9.8a`, `0.9.75a`, `0.9.7a`, `0.9.1a`, `0.9.0a`, `0.8.43a`,
> `0.8.42a`, `0.8.041a`, `0.8.4a`, `0.8.3a`, `0.8.2a`, `0.7.8a`, and
> `0.5.5a` — deep-dive notes live at this path under their git tags; the
> index is [`CHANGELOG.md`](./CHANGELOG.md).

## What's new in 0.9.90a

A same-day fast-follow to 0.9.89a, triggered by live Windows testing: a
critical fix for the self-updater silently no-opping on releases that
touch the shared core, a Settings copy fix for a real point of user
confusion, and a transition-effects gap in the desktop onboarding
wizard's largest step.

### Fixed: `aplyx update` silently failing to rebuild the TUI

Reported live: after running `aplyx update` on Windows, several
0.9.89a features (the new "Install desktop app" Settings action, the
Automatic-run resume/agent gate) were simply absent — not broken, not
erroring, just not there at all, as if the update had only partially
landed.

Root cause, confirmed by direct reproduction: `update.py`'s
`_post_update()` step rebuilds `app`'s (and the browser extension's)
compiled output by running `npm run build` directly inside each
directory — but it never rebuilds `packages/core` first.
`packages/core` has no install/prepare hook that builds it
automatically (the installer scripts already know this — see
`install.sh`'s own comment on the exact same point), and `app`'s build
script is `tsc && npm run bundle`: `tsc` type-checks against
`@aplyx/core/*`'s `dist/*.d.ts` files. When core's *source* had changed
across the update (a new export like `desktopApp.ts`, a fixed function)
but its `dist/` was still the pre-update snapshot, that type-check
failed — and because of the `&&`, `npm run bundle` never ran. The net
effect: `git pull`/tarball-overlay updates `app`'s own TypeScript
source just fine, `VERSION` bumps just fine, but the actual compiled
`dist/cli.js` a user launches is left **completely untouched** — not
just missing the parts that depend on core, *nothing* from the update
took effect, because the build never got far enough to produce a new
artifact at all.

Verified directly: removed one of `packages/core/dist`'s compiled files
by hand and ran `app`'s own `npm run build` in isolation — reproduced
the exact `tsc` failure and confirmed `dist/cli.js` was never
regenerated. Fixed by rebuilding `packages/core` first in
`_post_update()`, matching the ordering already used by
`install.sh`/`install.ps1`/`install_desktop.sh`/`install_desktop.ps1`.
Re-simulated the corrected order afterward and confirmed both the core
rebuild and the subsequent `app` build succeed, with `dist/cli.js`
getting a fresh timestamp.

This had been silently broken for a while — anyone whose Windows (or
any-OS) install has been tracking releases purely via `aplyx update`
across a stretch that touched `packages/core` may be running a build
several versions stale without any error ever having been shown. See
the rollout note above for how to actually pick this fix up, given the
chicken-and-egg nature of a broken updater fixing itself.

### Fixed: "Theme → Light" explain text implied it repaints the terminal background

It never has — Light mode only recolors aplyx's own accent/status text
(so it stays readable against a light background), not the terminal's
actual background color, which is controlled entirely by the terminal
application's own profile/color-scheme setting, outside aplyx's reach.
The prior wording ("tuned for a light terminal background") read as a
promise to set one. Reworded to say explicitly that it does not change
the terminal's background.

### Fixed: desktop onboarding's profile step had no transition effects

The wizard's outer step-to-step transitions (Preferences → Environment
→ Agent → Profile → Resumes → …) all animate via `WizardShell`'s
freeze/fade-out/swap/fade-in choreography. But "Your profile" is a
self-contained mini-wizard with its own 8 internal sub-pages
(`ProfileStep.tsx`), and those swapped instantly with no effect at all
— a real, structurally-confirmed gap, not a guess. Since profile is by
far the largest step by page count, this likely read as "nothing after
the 'let's get to know more about you' splash has any effects," even
though the outer transitions between steps were (per React's own
type-based reconciliation rules, not just assumed) still firing
correctly the whole time. Added the same fade-in animation
(`wizard-step-in`, keyed per page so it replays fresh on every page
change) used everywhere else — a single-phase fade rather than
replicating the outer wizard's full freeze/out/in machinery, which
would have needed careful coordination with this component's own
independent `loaded`/data-fetch state and wasn't worth the added risk
for a lighter-weight sub-navigation.

### Investigated, not resolved this pass

- **Automatic-run resume/agent gate not appearing**, and **the sidebar
  disappearing after entering/exiting Automatic mode**, both reported
  on the same Windows machine. Given the confirmed updater bug above,
  it's likely both were symptoms of running a build from well before
  either feature/fix existed — the gate is new in 0.9.87a/0.9.88a work,
  and no code-level bug reproducing either symptom was found on review
  of the current source (the sidebar's visibility is a plain expression
  recomputed fresh every render, with nothing that could make it
  "stick," and `RunScreen` touches no terminal-dimension state at all).
  Needs re-testing on a genuinely fresh build (see the rollout note) —
  flagged as a known gap below rather than closed out on an assumption.

## Install / update / uninstall

```bash
# install (one command; puts `aplyx` on your PATH):
curl -fsSL https://raw.githubusercontent.com/keshm2/aplyx/main/scripts/install/install.sh | bash

# or via npm:
npm install -g @keshm/aplyx

# optionally also install the desktop app (or from TUI Settings > Desktop app):
bash scripts/install/install_desktop.sh        # macOS / Linux
powershell -ExecutionPolicy Bypass -File scripts\install\install_desktop.ps1   # Windows

# update now (also happens automatically on runs and launches) — see the
# rollout note above if you're updating FROM a pre-0.9.90a install:
aplyx update

# uninstall (removes the desktop app too, if installed):
aplyx uninstall          # add --keep-data to keep config/data/resumes
```

Windows: `powershell -ExecutionPolicy Bypass -File scripts\install\install.ps1`
(or `irm .../install.ps1 | iex`), native PowerShell, no WSL.

## Verification

- `npm run typecheck:app` (rebuilds `@aplyx/core` first), `npm run
  build`, and `npm run smoke` are all clean. `desktop`'s own `npm run
  typecheck` and `npm run build` are clean too.
- The `update.py` fix was verified by direct reproduction of the bug
  (deleting a compiled core file, confirming `app`'s isolated `npm run
  build` fails exactly as described) and by re-simulating the corrected
  rebuild order afterward, confirming both steps succeed and
  `dist/cli.js` regenerates with a fresh timestamp — not just reasoned
  about.
- The `ProfileStep` transition fix and Settings copy fix are both
  low-risk, localized changes verified via `tsc`/`vite build` only (no
  live desktop-app run this pass — the existing Tauri-IPC-mocked
  Playwright harness from earlier onboarding work would be the way to
  visually confirm, not exercised here given time).

## Release artifacts

- Git tag `v0.9.90a` on `main`.
- npm: `@keshm/aplyx@0.9.90-alpha.0` under the `latest` dist-tag
  (`cd app && npm publish` — `publishConfig` sets `access: public` and
  the tag). Publish requires `npm login` (and, on this account, an OTP
  step in the browser).
- CI workflow `.github/workflows/tui.yml` runs on every push touching
  the TUI/core. `.github/workflows/desktop-release.yml` builds and
  attaches desktop app bundles to a tagged release (triggered on `v*`
  tag pushes, or manually via `workflow_dispatch` for an existing tag).

## Known gaps

- Automatic-run gate and sidebar-visibility reports from a Windows
  session — investigated, no code bug found on the current source, most
  likely explained by the updater bug this release fixes; needs
  re-confirmation on a genuinely fresh build (see above).
- The `ProfileStep` transition fix wasn't verified with a live/visual
  desktop-app run this pass.
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
