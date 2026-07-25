# Release notes — aplyx 0.9.945a

> **Build:** `0.9.945a` — alpha.
> **Branch:** `main`.
> **TUI in-app marker:** `packages/core/src/version.ts` →
> `BUILD_MARKER = "0.9.945a"` (re-exported from `app/src/theme.ts`,
> visible in the TUI side-panel footer, and also in the desktop app's
> Settings screen — one shared constant, both surfaces agree).
> **npm package:** `@keshm/aplyx` version `0.9.945-alpha.0`, published to
> the default `latest` dist-tag — `npm install -g @keshm/aplyx` gets it.
> The unscoped npm name `aplyx` belongs to an unrelated package — never
> `npm install aplyx`.
> **Desktop app:** 0.1.0 internally (Tauri app version, not tied to the
> TUI's release cadence) — this release rebuilds it (three of the four
> fixes below are desktop-app-only).
> **Browser extension:** unchanged in this build — `0.8.2` / `0.8.2a`.
> **Previous releases:** `0.9.94a`, `0.9.93a`, `0.9.92a`, `0.9.91a`,
> `0.9.90a`, `0.9.89a`, `0.9.88a`, `0.9.87a`, `0.9.85a`, `0.9.8a`,
> `0.9.75a`, `0.9.7a`, `0.9.1a`, `0.9.0a`, `0.8.43a`, `0.8.42a`,
> `0.8.041a`, `0.8.4a`, `0.8.3a`, `0.8.2a`, `0.7.8a`, and `0.5.5a` —
> deep-dive notes live at this path under their git tags; the index is
> [`CHANGELOG.md`](./CHANGELOG.md).

## What's new in 0.9.945a

Three Windows-reported bugs, each traced to a real structural cause
rather than patched at the symptom, plus a new theme.

### Fixed: "update available" didn't actually update the desktop app

`aplyx update` (the TUI/core self-updater) only ever touches the
checkout it runs from — `scripts/`, `packages/core`, `config/`. The
desktop app's own binary and its bundled `core/bridge.js` resource are
baked in at *build* time (`desktop/src-tauri/tauri.conf.json`'s
`bundle.resources`) and never change after install, no matter how many
times the core updates. Reported live: a crash fix shipped in
`0.9.94a` "did nothing" for the desktop app until it was uninstalled
and reinstalled by hand — because nothing had ever told the user the
desktop app itself, specifically, was the thing out of date.

Fixed two ways, covering both places a user might trigger "update":

- `app/src/cli.tsx`'s `installUpdate()` (what runs when the TUI's
  update prompt is accepted, or `aplyx update` is run directly) now
  compares the desktop app's recorded install version
  (`~/.aplyx/desktop_installed`, written by `install_desktop.sh`/`.ps1`)
  against the core's just-updated `VERSION`. If they differ, it
  automatically re-runs `install_desktop.sh`/`.ps1` to refresh the
  desktop app too — never unconditionally, since that script always
  re-downloads and re-running it on every single `aplyx update` even
  when nothing changed would waste bandwidth for no reason.
- The desktop app's own Settings screen (new `desktop/src/lib/
  updateCheck.ts`) now checks the public `VERSION` file directly —
  a plain `fetch()`, no bridge/IPC needed — against its own bundled
  `BUILD_MARKER`, and shows a real "Update available: vX — Get the
  update" action when it's behind, linking to the GitHub Release. This
  covers the case where someone updates *inside* the desktop app rather
  than through the TUI, which previously had no update awareness of its
  own at all.

### Fixed: Windows flashing console windows + multi-second page transitions

Reported live, worst on the onboarding/Settings "Your info" pages:
"a bunch of command prompts that open and close in the background in
quick sub-second intervals" on every click, and pages taking several
seconds to advance. Two compounding, independently-confirmed causes:

1. `std::process::Command` on Windows allocates a **new, visible
   console window** for a spawned console subprocess (`node.exe`) by
   default when the parent (a GUI app) has none of its own to inherit —
   documented Windows behavior, not opt-out by default. Fixed with the
   `CREATE_NO_WINDOW` process creation flag in `run_bridge()`
   (`desktop/src-tauri/src/lib.rs`), Windows-only, a no-op elsewhere.
2. The onboarding `ProfileStep` and Settings' `ProfileScreen` fired
   **one separate bridge call — one separate cold-started node
   process — per field**, concurrently, both on page load (read) and on
   "Next"/"Save" (write). `ProfileScreen` was worst: it read *every*
   field across all 8 pages at once on mount. A page with 5 fields
   meant roughly 10 process spawns per click; opening Settings' Profile
   page alone could spawn dozens at startup. Window allocation (point 1)
   isn't free either, so this was the other half of the reported
   slowness, not just the visual flashing.

   Fixed with new batched `readProfileFields`/`writeProfileFields`
   bridge commands (`packages/core/src/bridge.ts`, wired through
   `desktop/src-tauri/src/lib.rs` and `desktop/src/lib/bridge.ts`) that
   take a whole page's field IDs (or values) in one call — one spawn
   instead of N. As a side benefit, the batched write is also more
   correct than before: each field write reads the *same* underlying
   `config/targets.json`, modifies one key, and writes it back, and the
   old per-field-concurrent `Promise.all` could race two writes against
   that file; the new batched version writes sequentially within a
   single process, which can't race with itself.

### Fixed: online sign-in was broken for every user except the maintainer

"Hosted sign-in isn't set up yet," asking for a hand-created
`config/supabase.json`, on every real install. Root cause:
`config/supabase.json` is gitignored and excluded from every
distribution channel — git tarball, npm package, and the desktop app's
bundled resources all exclude it — so literally no end user outside
this maintainer's own dev machine could ever have had it.

Fixed by baking in aplyx's own Supabase project
(`packages/core/src/supabaseConfig.ts`'s `DEFAULT_SUPABASE_CONFIG`) as
the default. An anon key is meant to be public — every Supabase web/
mobile app ships one in its client bundle; access control is Row Level
Security on the backend, not secrecy of the key — so this is the
normal, correct way to do this, not a leak. `config/supabase.json`
still works as a local override for anyone self-hosting a different
backend; `readSupabaseConfig()` checks it first and only falls back to
the default when it's missing or still holds the example placeholders.

Also fixed a related bug found in the same code path: hosted sign-in
required `findRoot()` (a local checkout) to succeed *before* it would
even try to read the Supabase config — meaning "Sign in," which is
offered as an *alternative* to "Run locally" on the entry screen, was
silently blocked for anyone without a local checkout at all, for a
reason that has nothing to do with hosted mode.
`desktop/src/lib/supabaseClient.ts`'s `getSupabaseClient()` now tries a
local override opportunistically and falls through to the baked-in
default on any failure — including `findRoot()` throwing — instead of
propagating it. `getSupabaseClient()` also no longer returns `undefined`
at all, since a config is now always available; the now-impossible
`"unconfigured"` auth status and its "isn't set up yet" screen were
removed from `AuthContext.tsx`/`AuthScreen.tsx`.

### Added: Ember Glow theme

A fifth desktop app theme family (Settings → Appearance, alongside
Calm Cobalt, Sage Slate, Aplyx Classic, and Graphite Cyan): warm and
inviting, a burnt orange-red accent on soft cream in light mode, a
glowing amber accent on deep charcoal-ash in dark mode — coals in a
fire rather than an open flame. Defined in `desktop/src/styles/
tokens.css` following the existing four-family token contract
(`--ground`/`--surface`/`--text`/`--accent`/etc, `good`/`warn`/`danger`
semantic colors unchanged and shared across all families), wired into
`desktop/src/lib/uiPrefs.ts`'s `ThemeFamily` type and both places that
list the options (Settings and the onboarding Preferences step).

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

- `npm run build --workspace=@aplyx/core`, `npm run typecheck`/`build`/
  `smoke` (`--workspace=app`), `npx tsc --noEmit` and `npm run build`
  in `desktop/`, and `cargo check`/`cargo clippy` in
  `desktop/src-tauri` are all clean.
- The batched `readProfileFields`/`writeProfileFields` bridge commands
  were exercised directly against the real compiled bridge
  (`node packages/core/dist/bridge.js readProfileFields '{...}'` /
  `writeProfileFields '{...}'`), not just typechecked: a multi-field
  read against this checkout's own profile returned the correct values
  in one call, and a write-then-readback round-trip against a throwaway
  checkout confirmed persistence.
- The hosted-auth fallback was verified directly against the compiled
  module: `readSupabaseConfig()` against a real, nonexistent root path
  correctly falls through to `DEFAULT_SUPABASE_CONFIG` rather than
  throwing or returning nothing.
- The Ember Glow palette was rendered and screenshotted (both light and
  dark) via a real browser against the actual `tokens.css`, not just
  written from computed contrast ratios — confirmed the accent reads
  clearly against both grounds and body text is comfortably legible in
  both modes.
- The Windows-specific fixes (`CREATE_NO_WINDOW`, the
  `node_binary_uncached` Windows branch, the `\\?\`-prefix stripping)
  are `cargo check`/`clippy`-clean and reasoned through against
  documented Windows/Node behavior, but — as with every release so
  far — not run on an actual Windows machine; no such environment is
  available here. Please confirm on the hardware that reported these.

## Release artifacts

- Git tag `v0.9.945a` on `main`.
- npm: `@keshm/aplyx@0.9.945-alpha.0` under the `latest` dist-tag
  (`cd app && npm publish` — `publishConfig` sets `access: public` and
  the tag). Publish requires `npm login` (and, on this account, an OTP
  step in the browser).
- CI workflow `.github/workflows/tui.yml` runs on every push touching
  the TUI/core. `.github/workflows/desktop-release.yml` builds and
  attaches desktop app bundles to the `v0.9.945a` tag.

## Known gaps

- Everything carried forward from 0.9.90a's Known Gaps still applies —
  see that entry in `CHANGELOG.md` for the full list (Automatic-run
  gate/sidebar reports awaiting re-confirmation on a fresh build, the
  80×20–22 terminal render glitch, Codex subagent registry-only status,
  desktop hosted-sync, Workday review-only, desktop locations-only
  filter).
- All three Windows-specific fixes in this release are reasoned +
  `cargo check`-verified but not confirmed on real Windows hardware,
  same caveat as every release touching `desktop/src-tauri` so far.
