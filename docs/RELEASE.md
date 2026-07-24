# Release notes — aplyx 0.9.87a

> **Build:** `0.9.87a` — alpha.
> **Branch:** `main`.
> **TUI in-app marker:** `packages/core/src/version.ts` →
> `BUILD_MARKER = "0.9.87a"` (re-exported from `app/src/theme.ts`,
> visible in the TUI side-panel footer, and also in the desktop app's
> Settings screen — one shared constant, both surfaces agree).
> **npm package:** `@keshm/aplyx` version `0.9.87-alpha.0`, published to
> the default `latest` dist-tag — `npm install -g @keshm/aplyx` gets it.
> The unscoped npm name `aplyx` belongs to an unrelated package — never
> `npm install aplyx`. If a re-publish is ever needed for this same
> build, the npm semver bumps to `alpha.1`/`alpha.2` while the
> human-facing build marker/git tag stay `0.9.87a`.
> **Rollout:** clients on the updater lineage self-update on their next
> scheduled run or `aplyx` launch; older installs update manually once
> (`bash scripts/install/update.sh` / `powershell scripts\install\
> update.ps1`).
> **Desktop app:** 0.1.0 internally (Tauri app version, not tied to the
> TUI's release cadence).
> **Browser extension:** unchanged in this build — `0.8.2` / `0.8.2a`.
> **Previous releases:** `0.9.85a`, `0.9.8a`, `0.9.75a`, `0.9.7a`,
> `0.9.1a`, `0.9.0a`, `0.8.43a`, `0.8.42a`, `0.8.041a`, `0.8.4a`,
> `0.8.3a`, `0.8.2a`, `0.7.8a`, and `0.5.5a` — deep-dive notes live at
> this path under their git tags; the index is
> [`CHANGELOG.md`](./CHANGELOG.md).

## What's new in 0.9.87a

Both surfaces this time: a redesigned desktop first-run onboarding flow
with real transitions, three new TUI Settings fields (Theme/24-hour
clock/Reduced motion) plus a pass fixing TUI color reactivity bugs the
new Theme field exposed, better Codex/Copilot CLI parity, and installer
download progress bars.

### Desktop: redesigned first-run onboarding

The wizard now opens with a short narrative beat instead of jumping
straight into questions: a full-bleed "Welcome to Aplyx." splash (logo
centered, auto-advances), then "Let's set up your preferences for your
app. Don't worry, these can be changed later." leading into a new
Preferences step (theme family/mode/font — the same controls Settings
already has, reused directly rather than reimplemented), then "Now,
let's get to know more about you." leading into the existing profile
questions. Each splash is its own component instance (`key`'d per
step) so React genuinely mounts/unmounts them instead of reconciling
three narrative beats into one stateful instance — an early version hit
exactly that bug: the second splash silently inherited the first one's
"already advanced" flag and stuck at `opacity: 0` indefinitely.

The wizard's page-to-page transitions now use the same two-phase
choreography the app shell's own route transitions use (freeze
displayed content → animate out → swap → animate in) instead of a
plain fade-on-mount, content is vertically centered instead of
top-aligned, and the Next button gained a trailing arrow to match
Back's. Whatever theme/font the user picks in the new Preferences step
applies immediately and carries through the rest of onboarding and the
app, via the existing `useUiPrefs()` hook.

### TUI: Theme, 24-hour clock, and Reduced motion preferences

Three new Settings → Environment fields, all applied in-session with
no restart:

- **Theme** (Dark/Light) — Light mode uses hand-tuned darker
  accent/status hex colors rather than the dark palette's named ANSI
  colors (`yellow` in particular is close to unreadable on a light
  background).
- **24-hour clock** — affects the header clock (`TopStatusBar`).
- **Reduced motion** — stops the AUTO-badge sparkle and gradient
  shimmer's color cycling. Deliberately does *not* freeze the spinner
  glyph itself (`SpinnerGlyph`), which exists specifically so "a run is
  live" reads without watching color shifts — freezing it would make a
  genuinely active run look stuck.

### TUI: theme-reactivity bug sweep

Building the Theme field surfaced four places where a color was
computed once from `theme.accent`/`good`/`warn`/`danger` at module-load
or component-mount time instead of being read fresh, so switching
Dark ⇄ Light left them silently stuck on whichever palette was active
at that earlier moment:

- `SPARKLE_GRADIENT` (theme.ts) — a frozen `[theme.accent, "#FFFFFF"]`
  tuple, the default gradient for the AUTO-mode badge and every
  default-gradient progress bar. Converted to a `sparkleGradient()`
  function.
- `statusColor` (theme.ts) — a frozen `Record` built once from
  `theme.good/warn/danger`, used by StatusScreen/HistoryScreen's
  outcome colors. Converted to a `statusColor(status)` function.
- `UpdateBox`'s `PURPLE` constant and its `blend()` helper, which had
  `0x8B5CF6` hardcoded directly into the interpolation math for the
  update-prompt box's traveling border wave, independent of `theme`
  entirely. Both now read `theme.accent` live.
- `Banner`'s `React.memo` was keyed on `{columns, rows}` only, but the
  wordmark variant (shown on narrow/short terminals) renders
  `theme.accent` directly — a theme switch doesn't change terminal
  size, so memo silently skipped the re-render. Fixed by threading
  `accent` through as an explicit prop so memo's own shallow-equality
  check catches the change.

All four were verified live in a running terminal (tmux): switching
Settings' Theme field between Dark and Light now visibly repaints the
tab row, sidebar, status colors, update-prompt box, and the
previously-frozen wordmark banner title, without restarting.

### Codex / Copilot CLI parity

- **GitHub Copilot CLI** gets real subagent support:
  `.github/agents/*.md` are generated the same way `.claude/agents/`
  already was, and `scripts/runtime/harness_adapter.py` now probes
  `copilot --help` at runtime and invokes `copilot --agent <name>
  --prompt ... --allow-all-tools` when the installed CLI supports it,
  falling through to the existing inlined-prompt path otherwise.
- **Codex CLI** gets `.codex/agents/*.toml` subagent-registry files,
  generated for forward-compat, but they are **not** wired into actual
  invocation yet: `codex exec` (non-interactive mode) has no supported
  way to spawn a named subagent from a registry file in headless mode,
  confirmed via a live open upstream issue (openai/codex#15250).
  `AGENTS.md`'s harness capability matrix documents the full
  per-harness breakdown, including why browser automation stays
  degraded on both (Codex's non-interactive MCP tool-call
  auto-cancellation short of `--dangerously-bypass-approvals-and-sandbox`,
  deliberately not used; Copilot's own open MCP-in-subagent bug).
- `scripts/validate/generate_agent_definitions.py` was rewritten to
  support both the existing Markdown-frontmatter harnesses
  (opencode/Claude/Copilot) and a new TOML-output path for Codex in
  one script, verified via `--check` (no drift) and by parsing every
  generated `.codex/agents/*.toml` file with Python's `tomllib`.

### Installer download progress

`scripts/install/install.sh` / `install_desktop.sh` (and their
PowerShell equivalents, `install.ps1` / `install_desktop.ps1`) now show
a real byte-tracked `[====>.......]  10MB/149MB` progress bar for file
downloads (source tarball, desktop app bundles) instead of a silent
multi-minute pause, and a rotating spinner for indefinite steps
(`npm install` / builds) that have no byte total to track.

### Removed

- A stale, superseded rebrand-strategy planning doc
  (`docs/product-positioning-and-rebrand-plan.md`) proposing name
  candidates ("Proffer", "Forth", "Vouch"...) that were never adopted —
  the actual chosen name doesn't even appear in it.

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

## Verification

- `npm run typecheck:app` (which also rebuilds `@aplyx/core` first) and
  `npm run build` are clean.
- `npm run smoke` (`node dist/cli.js status`) runs correctly against
  live local state.
- The theme-reactivity fixes were verified live in tmux, not just by
  reading the code: switched Settings' Theme field between Dark/Light
  repeatedly and confirmed via raw ANSI-escape capture
  (`tmux capture-pane -e`) that the tab row, sidebar, and — specifically
  — the wordmark banner variant (which needed a real narrow/short
  terminal session, 80×22, to even render) all repaint to the correct
  palette's exact hex values without restarting the process.
- The desktop onboarding splash-stuck bug (three narrative beats
  reconciled into one stateful component instance for lack of a `key`)
  was root-caused through a disciplined process of elimination — ruled
  out a timing fluke, terminal/tab throttling, and Vite HMR corruption
  (full dev-server restart) before `console.log` tracing inside the
  component proved the real cause — then verified fixed with the same
  Tauri-IPC-mocked Playwright harness used to drive the rest of the
  flow.
- A character-garbling render glitch was found in the Settings field
  list at the exact 80×20–22 terminal-size boundary during this pass;
  confirmed via `git stash` that it reproduces identically against the
  pre-existing codebase with none of this release's changes applied —
  a pre-existing Ink/terminal redraw quirk at edge-case heights, not a
  regression. Left unfixed; flagged below.
- Not exercised this pass: real PowerShell execution of the installer
  progress-bar changes (no PowerShell available in this environment;
  verified by code review only), and Codex/Copilot live conformance
  runs (still pending a machine with those CLIs installed).

## Release artifacts

- Git tag `v0.9.87a` on `main`.
- npm: `@keshm/aplyx@0.9.87-alpha.0` under the `latest` dist-tag
  (`cd app && npm publish` — `publishConfig` sets `access: public` and
  the tag). Publish requires `npm login`.
- CI workflow `.github/workflows/tui.yml` runs on every push touching
  the TUI/core. `.github/workflows/desktop-release.yml` builds and
  attaches desktop app bundles to a tagged release (triggered on `v*`
  tag pushes, or manually via `workflow_dispatch` for an existing tag).

## Known gaps

- The 80×20–22 terminal-size Settings-field-list render glitch
  described above (pre-existing, not a regression, not yet root-caused
  beyond confirming it isn't in the theme/reactivity code touched this
  pass).
- PowerShell installer changes (this release and prior ones) remain
  unverified by actual execution — code-reviewed only.
- Codex CLI subagents remain registry-only, not invokable in headless
  mode, pending upstream openai/codex#15250.
- Desktop app: hosted↔local pipeline-state sync doesn't exist yet —
  `SupabaseAdapter.loadState()` returns `undefined`.
- Workday remains review-only by design.
- The "preferred locations only" filter is still offline on desktop,
  pending a redesign now that pagination has landed (unchanged from
  0.9.8a).
