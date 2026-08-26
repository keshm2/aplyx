<p align="center">
  <img src="docs/assets/aplyx-banner.png" alt="aplyx" width="600" />
</p>

# aplyx

[![npm version](https://img.shields.io/npm/v/%40keshm%2Faplyx?label=npm&color=cb3837)](https://www.npmjs.com/package/@keshm/aplyx)
[![License: MIT](https://img.shields.io/github/license/keshm2/aplyx?color=blue)](LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](docs/SETUP.md)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](docs/SETUP.md)
[![Last commit](https://img.shields.io/github/last-commit/keshm2/aplyx)](https://github.com/keshm2/aplyx/commits/main)

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](src/core)
[![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)](src/tauri/src-tauri)
[![Tauri](https://img.shields.io/badge/Tauri-24C8DB?logo=tauri&logoColor=white)](src/tauri)
[![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black)](src/tui)
[![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)](src/scripts)
[![Playwright](https://img.shields.io/badge/Playwright-2EAD33?logo=playwright&logoColor=white)](src/scripts/runtime)
[![Supabase](https://img.shields.io/badge/Supabase-3FCF8E?logo=supabase&logoColor=white)](src/supabase)

A local job-application agent for internship and new-grad roles.
It scrapes public boards, skips anything you've already seen,
tailors a resume and cover letter, applies on your behalf, pings
Discord with the outcome, and appends successful applications to
a Google Sheet tracker.

It's built on top of a coding agent — aplyx is the workflow, the
agent is the executor.

> **Build 1.0.1b** — see [Release notes](docs/RELEASE.md) and
> [Changelog](docs/CHANGELOG.md).

## You need a coding agent

aplyx doesn't work without one. It drives whichever you already
have installed. Full capability (browser-automated applies
included) with **[opencode](https://opencode.ai)** or
**[Claude Code](https://claude.com/claude-code)**.
[Codex CLI](https://developers.openai.com/codex/cli) and
[GitHub Copilot CLI](https://docs.github.com/copilot) work too,
but on a smaller path: API-fed boards only, with browser-only
applications routed to your review queue. The installer picks
up whatever you have and asks if you have more than one.

## Install

One installer sets up everything, including the **desktop app** —
the recommended way to run aplyx day to day. A terminal UI (`aplyx`)
comes with it either way, for anyone who'd rather stay in a shell.

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/keshm2/aplyx/main/src/scripts/install/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/keshm2/aplyx/main/src/scripts/install/install.ps1 | iex
```

Answer `y` when it asks about the desktop app (the default) and
it installs to `/Applications` (macOS), via your package manager
or an AppImage (Linux), or a per-user installer (Windows) — no
Rust toolchain needed for a released build, just the installer
itself. Open it from Applications/Start Menu when it's done.

**Just the terminal UI, via npm:**

```bash
npm install -g @keshm/aplyx
aplyx
```

**Or from a release archive** — see [docs/SETUP.md §1.4](docs/SETUP.md)
for the full curl/PowerShell snippets.

The installer drops aplyx in `~/aplyx` (or `%USERPROFILE%\aplyx`
on Windows; override with `APLYX_HOME`), asks for your coding
agent, your profile (kept **locally only** — gitignored files on
your machine, never uploaded), and whether you want Discord
status updates, creates the `data/resumes/` folder (add your base
resumes there — see [docs/SETUP.md](docs/SETUP.md) for the expected
filenames), and puts `aplyx` on your PATH. When it finishes, open
the desktop app, or just type `aplyx` for the terminal UI.

You'll also need `python3`, `jq`, and `node` ≥ 22 with `npm` (both
the desktop app and the terminal UI build on Node). No `git`
required.

## What it does each run

Scrape the configured boards → dedupe against your local history
→ fit-gate each posting (role/level, years, location) → tailor a
resume and cover letter for the survivors → apply through a
Playwright-controlled browser → record the outcome locally, send
the matching Discord webhook, and (on success) append a row to
the Sheet. Each run is capped at **25 applications** to stay
polite to upstream boards.

Workday is review-only on purpose — promising postings land in
your review queue, and you apply by hand.

## Using it

**Desktop app (recommended):** open aplyx from Applications (macOS),
your Start Menu (Windows), or your app launcher (Linux). It walks
you through a guided setup wizard, then gives you Jobs, Review,
Status, Documents/Resumes, and Settings screens — including turning
the 30-minute background schedule on or off with a switch.

**Terminal UI**, for anyone who'd rather not leave a shell:

```bash
aplyx                    # open the TUI (press ? for keys)
aplyx status             # one-shot pipeline overview
aplyx run                # one agent run in this terminal
aplyx setup [--check]    # config wizard / validate only
aplyx review | history   # jump straight to a screen

bash src/scripts/runtime/scheduler.sh install    # 30-minute always-on schedule (launchd)
```

Both surfaces read and write the exact same local files — nothing
about your setup, resumes, or history depends on which one you use,
and you can switch between them freely.

Updates happen automatically — each run and terminal-UI launch
checks for a newer build and installs it before continuing (your
config, data, logs, and resumes are never touched); the desktop app
checks for its own updates the same way and prompts from Settings
when one's available. Opt out with `APLYX_AUTO_UPDATE=0`, force one
with `aplyx update`. To uninstall: `aplyx uninstall`.

## Safety & privacy

These are how aplyx is wired, not suggestions:

- **Personal data stays local.** Live configs, `data/` (incl.
  resumes), and `logs/` are gitignored and never leave your machine.
- **Form fields are filled only from `src/config/targets.json`
  `"safe_fields"`.** Passwords, SSNs, and payment info are
  never stored. A form asking for something outside safe_fields
  sends the job to review instead.
- **The browser extension never submits a form.** Autofill stops
  at a filled form; you click submit.
- **Discord is optional.** If you don't set it up, outcomes stay
  local — missing config is a warning, not an error.
- **Only successful applications sync to the Google Sheet.** A
  sync hiccup never turns a successful application into a
  failure.
- **Workday has no auto-apply path.** No workaround exists, and
  none is planned.

For the full walkthrough — boards, Discord webhooks, the Google
Sheets sync, per-agent quickstarts, the scheduler, and the
browser extension — see **[docs/SETUP.md](docs/SETUP.md)**.

## Repository layout

Everything code- and config-related lives under `src/`, one folder per
concern; the repo root stays to this file, the license, and the
canonical behavioral docs every coding agent reads first.

| Path | What it is |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | Canonical behavioral rules for any agent operating in this repo |
| [`docs/SETUP.md`](docs/SETUP.md) | Full install/config walkthrough |
| [`docs/RELEASE.md`](docs/RELEASE.md) / [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Release notes / changelog |
| `src/tauri/` | The desktop app (Tauri) — the recommended way to use aplyx |
| `src/tui/` | The `aplyx` terminal UI (Ink/React) |
| `src/core/` | Shared TypeScript core (`@aplyx/core`) used by both apps |
| `src/scripts/` | Deterministic Python/bash helpers — the only things allowed to write state |
| `src/agents/` | Source of truth for agent prompts (generated into `.claude/`, `.opencode/`, `.github/`, `.codex/`) |
| `src/extension/` | The browser extension (user-driven hybrid mode) |
| `src/config/` | Committed config templates (live, per-user configs are gitignored) |
| `data/`, `logs/` | Runtime state and logs — gitignored, stay at the repo root, hold your PII |

## License

[MIT](LICENSE).
