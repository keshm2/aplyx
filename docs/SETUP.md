# Setup

The live configs (`src/config/targets.json`, `src/config/discord_config.json`) are
gitignored — they hold personal data and secrets. Start from the shipped
examples before running the agent.

> **Build:** this document ships with release `0.9.85a`. Full release
> notes: [`RELEASE.md`](./RELEASE.md). Changelog: [`CHANGELOG.md`](./CHANGELOG.md).

## 0. Universal install (recommended)

One command from a fresh GitHub download detects your coding agent and
builds the optional TUI + browser extension. Your profile, job
targets, and resumes are filled in by a guided wizard the first time
you run `aplyx` — see section 1.

```bash
curl -fsSL https://raw.githubusercontent.com/keshm2/aplyx/main/src/scripts/install/install.sh | bash

# Or from an unpacked release archive (no git clone required):
bash src/scripts/install/install.sh

# Or via npm (installs the `aplyx` TUI command; on first run with no
# core checkout found it installs one automatically — opt out with
# --no-core or APLYX_SKIP_CORE=1):
npm install -g @keshm/aplyx
```

```powershell
# Windows PowerShell (native, no WSL):
irm https://raw.githubusercontent.com/keshm2/aplyx/main/src/scripts/install/install.ps1 | iex
# Or from an unpacked release archive:
powershell -ExecutionPolicy Bypass -File .\src\scripts\install\install.ps1
```

**Automatic updates.** Every scheduled run and `aplyx` launch checks
GitHub `main`'s `VERSION` file and self-updates on a newer build
(fail-open); `src/config/`/`data/`/`logs/` are never touched. Run one
manually with `aplyx update`, or opt out with `APLYX_AUTO_UPDATE=0`.
The installer also creates a `data/resumes/` folder for your base
resumes — everything you enter (wizard, Settings, or by hand) stays in
gitignored local files and never leaves your machine.

**Release archive:**

```bash
curl -L -o aplyx-0.9.85a.zip https://github.com/keshm2/aplyx/archive/refs/tags/0.9.85a.zip && \
  unzip aplyx-0.9.85a.zip && cd aplyx-0.9.85a   # or the release page's "Source code" assets
```

**Desktop app (early preview, optional).** Near the end of the install,
the installer offers to also install a native desktop app
(macOS/Linux/Windows) alongside the TUI — a graphical alternative
that's still catching up in features. It's opt-in and defaults to no.
Answer `y` when asked, or run it any time after the fact:

```bash
bash src/scripts/install/install_desktop.sh        # macOS / Linux
powershell -ExecutionPolicy Bypass -File src\scripts\install\install_desktop.ps1   # Windows
```

It first checks this checkout's matching GitHub release for a prebuilt
bundle (built once on CI — `.github/workflows/desktop-release.yml`) and
just downloads + installs that: no Rust, no Xcode Command Line Tools, no
Visual C++ Build Tools, nothing beyond curl — the same as installing any
other compiled app. Only falls back to compiling from source (which
*does* need those, and a first build can take several minutes) if no
matching prebuilt bundle exists yet, e.g. running from an unreleased
checkout. Installs to `/Applications` (macOS, falling back to
`~/Applications` if that's not writable), via `apt`/`dnf`/an AppImage +
app-launcher entry (Linux), or a per-user installer with no admin prompt
(Windows). A failure here never affects the TUI — retry any time with
the same command. `aplyx uninstall` removes it too, if present.

**Uninstall.** `aplyx uninstall` (or `bash src/scripts/install/uninstall.sh`)
removes the schedule and `aplyx` command, then asks before deleting
the install directory (`src/config/`, `data/`, resumes); `--keep-data` keeps it,
`--yes` skips the prompt. npm installs also run
`npm uninstall -g @keshm/aplyx`.

aplyx runs under your choice of coding agent — **opencode**,
**Claude Code** (full), **Codex CLI**, and **GitHub Copilot CLI**
(degraded — see §2.8). The installer detects what you have and asks
which you'd prefer if more than one is present, writing the choice to
`src/config/harness.json` (change any time by editing that file or setting
`APLYX_HARNESS=opencode|claude|codex|copilot`). Then set up your
profile (section 1, or just run `aplyx`) and start a run with
`bash src/scripts/runtime/run_job_agent.sh`. Per-harness specifics are in
§2.8; every harness's agent definitions are generated from `src/agents/`
(see `src/agents/README.md`) — edit sources there, never the generated
files.

## 1. Set up your profile, job targets, and resumes

The easiest path: run `aplyx`. A fresh install auto-launches a guided
wizard covering personal info, work eligibility, job targets (roles,
locations, target companies), and resumes — each answer saves as you
go, so quitting partway through and relaunching resumes right where
you left off, at the same completion percentage. Reopen it any time
with `aplyx setup`. (The wizard creates `src/config/targets.json` from
`src/config/targets.example.json` for you; copy
`src/config/discord_config.example.json` to `src/config/discord_config.json`
by hand only if you want to configure Discord before ever opening the
TUI.)

Everything the wizard writes stays editable afterward from the
running app's **Config** tab (`aplyx` → tab 5, see §2.9): personal
info, company targets (`role_keywords`, `level_keywords`,
`season_keywords`, `preferred_locations`, Ashby/Lever slugs,
`workday_tenants`), Discord webhooks, and environment overrides. Prefer
hand-editing `src/config/targets.json` directly? `src/config/targets.example.json`
carries an inert `_help` object with doc strings for the less obvious
fields, right next to the fields themselves.

**Resumes.** Drop any file into `data/resumes/` — no required filename
anymore. The TUI's **Resumes** screen (`aplyx resumes`, or press `5`)
lists everything and converts a PDF to markdown on the spot (press
`c`), prompting for an optional short description so non-standard
resumes stay distinguishable later. `resume-tailor.md`'s category
matcher still auto-recognizes five conventional base-resume names plus
a cover-letter reference file; anything else just needs a description.
Extraction is text-only, not OCR — a scanned PDF with no text layer
needs a hand-written `.md`.

**Discord is optional.** The installer asks whether you want status
updates; declining leaves every outcome local. Opting in, choose one
webhook for everything or a separate one per outcome (success / needs
review / failed / summary — each needs its own webhook link). Set it
up during install, or later from the Config tab's Discord section.

## 2. Validate

```bash
bash src/scripts/validate/validate_local_config.sh
```

Prints `validate_local_config: OK` on success; any `ERROR` line names
the file/field to fix (exit 1). Placeholder Ashby/Lever/Greenhouse/
SmartRecruiters slugs are auto-seeded (2.1); other placeholder state
(e.g. `simplify_feeds`) warns but doesn't block the run.

### 2.1 Vetted slug auto-seeding

When `ashby_company_slugs`/`lever_company_slugs`/
`greenhouse_company_slugs`/`smartrecruiters_company_slugs` is unset,
empty, or placeholder-only, the validator seeds it from the
project-owned vetted lists (`src/config/ashby_vetted_slugs.json`,
`src/config/lever_vetted_slugs.json`, `src/config/greenhouse_vetted_slugs.json`,
`src/config/smartrecruiters_vetted_slugs.json`) so a fresh clone has real
coverage on the first run. Never overwrites
a non-placeholder value; deterministic and idempotent (one atomic
write, a second run does nothing); prints a visible `WARNING` so
you're not surprised. Run directly with
`python3 src/scripts/validate/seed_vetted_slugs.py`.

**Provenance.** The vetted lists are trust-bearing and project-owned —
every slug hand-verified against the public board APIs on the
`verified_at` date in each file. Additions are code changes reviewed
in a PR; nothing is pulled remotely at run time.

### 2.2 TUI overlay (optional)

A terminal UI over the same configs and helpers, in `src/tui/`. Never
writes state JSON directly — every mutation goes through the repo's
helpers.

```bash
cd src/tui
npm install
npm run build
node dist/cli.js help      # or: npm link && aplyx help
```

Commands: `aplyx setup` (reopens the guided wizard that auto-launches
on a fresh run, then validates; `--check` validates only), `aplyx
status` (outcome counts, review queue, last run), `aplyx review`
(triage: open posting, mark applied, or dismiss), `aplyx history`
(browse outcomes), `aplyx run` (trigger a run, stream the session log).

The app opens on a **welcome menu** (`w` returns any time, `?` shows
the full key reference). The Jobs screen always opens **browsing,
never typing**: `/` types a search query (`e` for the run cap in
automatic mode), `Esc` stops typing (never quits); quit with `q`
(confirms mid-run).

**Modes.** Always launches in **manual mode**; `m` toggles to
automatic (shown in the shell).

- **Manual** — Search screen fetches live postings, filters by typed
  query, opens a posting in the browser, runs the fit gate, saves to
  the review queue (the only state write).
- **Automatic** — agent-driven: before a run starts you set this
  cycle's cap (1–25, `APLYX_SESSION_CAP`), which can only lower, never
  raise, the 25-per-session max (`run_job_agent.sh` clamps/falls back
  accordingly); tier-colored by cost, with an animated **MAX** warning
  at 25. `p` adds an optional extra prompt (`APLYX_EXTRA_PROMPT`,
  500-char cap) that focuses a run without overriding `AGENTS.md` or
  the session cap.

**Small test cycle (recommended first run):** `aplyx` → any key → `2`
(Jobs) → `m` (AUTO) → `e` → `5` → `enter` → optionally `p` → `s`.
Outcomes land in Status/Review/History and Discord as usual.

## 2.5 Always-on schedule (optional)

Runs the agent every 30 minutes, 24/7, via a launchd user agent
(macOS). Overlap protection lives in `run_job_agent.sh`: a tick landing
mid-run logs `skipped_overlap` and exits 0; a dead holder's lock is
reclaimed immediately; a hung run older than 60 minutes
(`APLYX_LOCK_MAX_AGE_MIN`) is terminated and reclaimed.

```bash
bash src/scripts/runtime/scheduler.sh install     # write + load the plist (runs immediately)
bash src/scripts/runtime/scheduler.sh status      # loaded? + heartbeat
bash src/scripts/runtime/scheduler.sh uninstall   # stop the schedule
bash src/scripts/runtime/scheduler.sh plist       # print the plist without installing
```

On Linux, create the equivalent systemd user timer by hand
(`OnUnitActiveSec=30min`, repo root as `WorkingDirectory=`, command
`/bin/bash src/scripts/runtime/run_job_agent.sh`).

**What to check first:** `logs/heartbeat.json` (timestamp, exit code,
outcome counts, restart-loop signal); `logs/run_job_agent.log` (one
line per tick, incl. the `complete <ISO> applied=<n> needs_review=<n>
failed=<n> skipped_unfit=<n>` marker plus `skipped_overlap`/
`stale_lock_reclaimed`/`FAILED`); `logs/session_<timestamp>.log` (full
transcript, newest 30 kept).

The 25-per-session cap is unchanged — the schedule changes how often
runs happen, never how much one run may apply.

## 2.6 Browser extension — hybrid mode (optional)

A Chrome (Manifest V3) extension for user-driven applications: you
browse postings yourself; the extension autofills forms from your
`safe_fields`, shows the deterministic fit verdict as a badge, and
records outcomes into the same local state as the agent, so manual and
automatic applications dedupe against each other.

**Safety model:** never submits a form (you click submit yourself);
values come only from `safe_fields` (unanswerable fields amber, never
invented); reads/writes go through a **localhost-only bridge**
(`src/scripts/runtime/extension_bridge.py`), token-authenticated, shelling
out only to the repo's standard state helpers.

```bash
# 1. Start the bridge:
python3 src/scripts/runtime/extension_bridge.py     # or: py -3 scripts\extension_bridge.py

# 2. Build and load the extension:
cd extension && npm install && npm run build
```

First bridge start generates `src/config/extension_bridge.json`
(gitignored, `chmod 600`, token + default port `8377`; print it with
`--show-token`). In Chrome: `chrome://extensions` → **Developer mode**
→ **Load unpacked** → `extension/dist/`. Then open the extension's
**Options** page, paste the token, and click **Test connection**.

**Use it:** on a Greenhouse/Lever/Ashby/Workday posting, a small
**aplyx** panel appears (bottom-right) — **Fit check** (verdict +
score + duplicate warning), **Autofill from profile** (fills mapped
empty fields, amber for unanswerable ones, never overwrites), **Save
for review** (`needs_review` entry), and **I submitted this — record
it** (`applied` outcome, dedup-guarded, syncs the Sheet tracker).
"Bridge unreachable" means the bridge isn't running.

## 2.7 Two users on one machine

aplyx is **single-user by design**: everything personal lives in the
clone (`src/config/`, `data/` incl. resumes, `logs/`, `.playwright-mcp/`).
For two people on one machine, use **two separate clones** (e.g.
`~/aplyx-alice`, `~/aplyx-bob`), pointing the TUI at the right one
with `APLYX_ROOT`. Caveat: the launchd schedule (§2.5) uses the fixed
label `com.aplyx.job-agent`, so only **one** clone per macOS user
account can have it installed — run the second on demand or under
another OS user account. Profile-based multi-user is deferred — see
`AGENTS.md`'s "Single-user deployment" section.

## 2.8 Per-agent quickstarts

Pick one of the four agents, install it, run
`bash src/scripts/install/install.sh` — the installer detects it and
writes `src/config/harness.json` (asking if more than one is present).
Change any time via that file or
`APLYX_HARNESS=opencode|claude|codex|copilot`. Business logic is
identical under every agent — only the thin adapter in
`src/scripts/runtime/run_job_agent.sh` differs; see `AGENTS.md`'s "Harness
capability matrix" for the degraded paths.

- **opencode** (full) — install per opencode.ai. Agents in
  `.opencode/agents/`, models from `opencode.jsonc`. Runs `opencode run
  --agent job-scraper`.
- **Claude Code** (full) — install per claude.com/claude-code. Agents
  in `.claude/agents/`, Playwright MCP from `.mcp.json`. Headless runs
  need pre-approved `.claude/settings.json` permissions (installer
  offers to create it, asks first). Runs `claude -p`.
- **Codex CLI** / **GitHub Copilot CLI** (both degraded) — install per
  developers.openai.com/codex/cli / docs.github.com/copilot. Both read
  `AGENTS.md` natively with no subagent registry (roles run inline
  from `src/agents/bodies/`) and no browser automation by default —
  API-fed boards only, browser-only applications route to review.
  Codex needs a `~/.codex/config.toml` sandbox policy (e.g.
  workspace-write) to run `src/scripts/` (runs `codex exec`); Copilot's
  `-p … --allow-all-tools` does the equivalent for headless runs
  (review what that grants before scheduling it).

### Conformance results (src/scripts/validate/run_conformance.py)

Pushes a golden job batch through canonicalize → fit gate → state
writes against temp files (13 deterministic checks, no LLM);
`--harness <name>` additionally drives that CLI headlessly and asserts
the golden `job_key` lands in the transcript. A missing CLI reports
`SKIP`, never a false pass.

```bash
python3 src/scripts/validate/run_conformance.py                 # deterministic core
python3 src/scripts/validate/run_conformance.py --harness all   # + installed CLIs (1 small LLM call each)
```

| Leg | Result | Date |
| --- | --- | --- |
| Deterministic core (13 checks) | PASS 13/13 | 2026-07-13 |
| Harness: opencode | PASS | 2026-07-13 |
| Harness: Claude Code | PASS | 2026-07-13 |
| Harness: Codex CLI | PENDING — CLI not installed on the verification machine | — |
| Harness: Copilot CLI | PENDING — CLI not installed on the verification machine | — |

## 2.9 Settings screen (TUI Config tab)

`aplyx` → tab 5 (**Config**) shows every setting's current value
before you change it, in four sections:

- **Personal info** — the `safe_fields` in `src/config/targets.json`, plus
  **Preferred name** (sidebar greeting; falls back to first name).
- **Company targets** — `role_keywords`, `level_keywords`,
  `season_keywords`, `preferred_locations`, Ashby/Lever slugs,
  `workday_tenants` — the job-matching fields that used to be
  hand-edit-only, now live-editable the same way as personal info.
- **Discord webhooks** — the enabled switch (enter toggles) and the
  four per-outcome webhook URLs.
- **Environment** — persisted `APLYX_*` overrides saved to
  `src/config/env.json` (gitignored) and exported by every run; a real
  shell env var always wins, clearing returns to default. Includes
  `APLYX_LOG_DIR`, `APLYX_SESSION_CAP`, `APLYX_KEEP_SESSION_LOGS`,
  `APLYX_LOCK_MAX_AGE_MIN`, `APLYX_AUTO_UPDATE`, `APLYX_HARNESS`.

## 3. Google Sheets sync (optional)

The agent can append every successful application to a Google Sheet
internship tracker. Optional: unconfigured, the agent skips the sync
and local job state (`data/applied_jobs.json`, `data/job_registry.json`)
stays the source of truth.

### 3.1 Configure

```bash
cp src/config/google_sheets_config.example.json src/config/google_sheets_config.json
pip3 install -r requirements.txt
```

`src/config/google_sheets_config.json` is gitignored — edit `spreadsheet_id`
(from your sheet URL), `worksheet_title` (default `Internship Tracker`),
`service_account_key_path` (default `src/config/service-account-key.json`),
and `enabled` (`false` turns sync off without deleting the file).
`header_range`, `value_input_option`, `insert_data_option` are optional
append params with sensible defaults — leave as-is unless needed.

### 3.2 Service account

Cloud Console → **APIs & Services → Library** → enable **Google
Sheets API** → **Credentials → Create credentials → Service account**
(any name) → open it → **Keys → Add key → Create new key → JSON**
(downloads), then:

```bash
mv ~/Downloads/<downloaded-key>.json src/config/service-account-key.json
chmod 600 src/config/service-account-key.json
```

Copy `client_email` from that JSON. Sheet → **Share** → paste it →
**Editor** access — the helper can't write until the sheet is shared.

### 3.3 Validate and test

```bash
bash src/scripts/validate/validate_local_config.sh
python3 src/scripts/jobs/sync_internship_tracker.py '{"title":"Test Role","company":"Test Co","date_applied":"2026-07-01","internship_term":"Summer 2026"}'
```

If the config file is absent, the validator warns and continues
(job-board runs aren't blocked); if `enabled: true`, required fields
and the key path shape are checked (missing key/placeholder values
warn, don't block). A successful sync test prints `"synced": true` and
the appended row; disabled/unconfigured prints `"skipped": true` and
exits 0 so the run continues.

## 3.4 Reopening a flagged application, pre-filled (phase 16C)

Every `needs_review` application that reached the form-fill step (see
AGENTS.md "Fill records") gets a durable `data/fill_records/<job_id>.json`
snapshot of exactly what was typed/attached. `src/scripts/runtime/replay_fill.py`
replays that snapshot into your real, already-installed Google Chrome —
fields, resume, cover letter — and stops without ever submitting, so you
can review it as a normal filled-in form instead of a blank one:

```bash
pip3 install -r requirements.txt   # installs the playwright driver
python3 src/scripts/runtime/replay_fill.py <job_id>
```

Requires Google Chrome installed (uses your actual default profile —
no separate setup, but if Chrome is already running when you run this,
close it first: Chrome refuses to let a second automated instance attach
to a profile that's already open, and the script will tell you so rather
than silently failing). Jobs with no `fill_record_path` (e.g. Workday,
which is review-only and never reaches the fill step) have nothing to
replay — this is a CLI-only capability for now; TUI/desktop wiring for
the review queue's "Open" action is a separate, not-yet-started phase.
