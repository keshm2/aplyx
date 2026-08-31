# Setup

The live configs (`src/config/targets.json`, `src/config/discord_config.json`) are
gitignored: they hold personal data and secrets. Start from the shipped
examples before running the agent.

> **Build:** this document ships with release `1.0.1b`. Full release
> notes: [`RELEASE.md`](./RELEASE.md). Changelog: [`CHANGELOG.md`](./CHANGELOG.md).

## 0. Universal install (recommended)

One command from a fresh GitHub download detects your coding agent,
builds the terminal UI + browser extension, and offers to install the
native **desktop app** too, the recommended way to use aplyx day to
day (§0.1). Your profile, job targets, and resumes are filled
in by a guided wizard the first time you open the app; see section 1.

```bash
curl -fsSL https://raw.githubusercontent.com/keshm2/aplyx/main/src/scripts/install/install.sh | bash

# Or from an unpacked release archive (no git clone required):
bash src/scripts/install/install.sh

# Or via npm (installs the `aplyx` TUI command; on first run with no
# core checkout found it installs one automatically; opt out with
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
resumes; everything you enter (wizard, Settings, or by hand) stays in
gitignored local files and never leaves your machine.

**Release archive:**

```bash
curl -L -o aplyx-1.0.1b.zip https://github.com/keshm2/aplyx/archive/refs/tags/v1.0.1b.zip && \
  unzip aplyx-1.0.1b.zip && cd aplyx-1.0.1b   # or the release page's "Source code" assets
```

### 0.1 Desktop app (recommended)

Near the end of the install, the installer offers to also install a
native desktop app (macOS/Linux/Windows) alongside the terminal UI
(the recommended way to run aplyx day to day), with Jobs, Review,
Status, Documents/Resumes, and Settings screens. It defaults to yes
when the installer can prompt you (a non-interactive `curl | bash`
install skips it, to avoid silently turning a few-second install into
a multi-minute compile with no one watching). Run it any time after
the fact:

```bash
bash src/scripts/install/install_desktop.sh        # macOS / Linux
powershell -ExecutionPolicy Bypass -File src\scripts\install\install_desktop.ps1   # Windows
```

It first checks this checkout's matching GitHub release for a prebuilt
bundle (built once on CI: `.github/workflows/desktop-release.yml`) and
just downloads + installs that: no Rust, no Xcode Command Line Tools, no
Visual C++ Build Tools, nothing beyond curl, the same as installing any
other compiled app. Only falls back to compiling from source (which
*does* need those, and a first build can take several minutes) if no
matching prebuilt bundle exists yet, e.g. running from an unreleased
checkout. Installs to `/Applications` (macOS, falling back to
`~/Applications` if that's not writable), via `apt`/`dnf`/an AppImage +
app-launcher entry (Linux), or a per-user installer with no admin prompt
(Windows). A failure here never affects the TUI. Retry any time with
the same command. `aplyx uninstall` removes it too, if present.

**Uninstall.** `aplyx uninstall` (or `bash src/scripts/install/uninstall.sh`)
removes the schedule and `aplyx` command, then asks before deleting
the install directory (`src/config/`, `data/`, resumes); `--keep-data` keeps it,
`--yes` skips the prompt. npm installs also run
`npm uninstall -g @keshm/aplyx`.

aplyx runs under your choice of coding agent: **opencode**,
**Claude Code** (full), **Codex CLI**, and **GitHub Copilot CLI**
(degraded; see §2.8). The installer detects what you have and asks
which you'd prefer if more than one is present, writing the choice to
`src/config/harness.json` (change any time by editing that file or setting
`APLYX_HARNESS=opencode|claude|codex|copilot`). Then set up your
profile (section 1, or just run `aplyx`) and start a run with
`bash src/scripts/runtime/run_job_agent.sh`. Per-harness specifics are in
§2.8; every harness's agent definitions are generated from `src/agents/`
(see `src/agents/README.md`); edit sources there, never the generated
files.

## 1. Set up your profile, job targets, and resumes

The easiest path: run `aplyx`. A fresh install auto-launches a guided
wizard covering personal info, work eligibility, job targets (roles,
locations, target companies), and resumes; each answer saves as you
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

**Resumes.** One generic resume, `data/resumes/resume.json`, rather
than a set of category-named files. Manage it from the desktop app's **Resume**
screen: add/edit/delete jobs, projects, education, skills, and
certifications directly, or use **"Import from an existing resume"** to
pull in content from an older `base_resume_*.md` file if you have one
from before this model existed. `@resume-tailor` reads this one file and
composes a tailored copy (reordering, rewriting, and selecting bullets)
per application; there's no category to pick or rename anymore.
`@resume-tailor`'s tailored output is rendered straight into a one-page
PDF (`src/scripts/state/render_resume_pdf.py`, Playwright-driven, a
deterministic shrink ladder guarantees it never bleeds to a second page)
and that's what gets attached to the application. The same screen has an
**Export PDF** button to render the current resume.json on demand for
your own use.

The TUI's **Resumes** screen (`aplyx resumes`, or press `7`) is the same
editor as the desktop app's, adapted for the terminal: drill into a
section (↑↓, enter), add/edit/delete/reorder entries and bullets (`a`/
enter/`x`/`[`/`]`), same **Import from an existing resume** and
**Export PDF** actions. Both surfaces read and write the exact same
`data/resumes/resume.json`, so editing in one is immediately visible in
the other. The one thing still resolved dynamically by name/description
(`src/scripts/state/resolve_resume.py`) is the optional cover-letter
voice/structure reference file (`base_cover_letter.md` by convention);
`cover-letter-tailor.md` reads whichever file matches, and simply writes
without a reference if none exists.

**Discord is optional.** The installer asks whether you want status
updates; declining leaves every outcome local. Opting in, choose one
webhook for everything or a separate one per outcome (success / needs
review / failed / summary; each needs its own webhook link). Set it
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

**Provenance.** The vetted lists are trust-bearing and project-owned:
every slug is hand-verified against the public board APIs on the
`verified_at` date in each file. Additions are code changes reviewed
in a PR; nothing is pulled remotely at run time.

### 2.2 TUI overlay (optional)

A terminal UI over the same configs and helpers, in `src/tui/`. Never
writes state JSON directly; every mutation goes through the repo's
helpers.

```bash
npm install --workspace=src/core && npm run build:core   # from the repo root; src/tui imports @aplyx/core's built dist/, which doesn't exist yet on a fresh clone
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

- **Manual**: Search screen fetches live postings, filters by typed
  query, opens a posting in the browser, runs the fit gate, saves to
  the review queue (the only state write).
- **Automatic**, agent-driven: before a run starts you set this
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

The 25-per-session cap is unchanged; the schedule changes how often
runs happen, never how much one run may apply.

## 2.6 Browser extension: hybrid mode (optional)

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
python3 src/scripts/runtime/extension_bridge.py     # or: py -3 src\scripts\runtime\extension_bridge.py

# 2. Build and load the extension:
cd src/extension && npm install && npm run build
```

First bridge start generates `src/config/extension_bridge.json`
(gitignored, `chmod 600`, token + default port `8377`; print it with
`--show-token`). In Chrome: `chrome://extensions` → **Developer mode**
→ **Load unpacked** → `src/extension/dist/`. Then open the extension's
**Options** page, paste the token, and click **Test connection**.

**Use it:** open a real application form on Greenhouse, Lever, Ashby,
or Workday (not a listing or search page, an actual form) and aplyx
notices it and asks, top-center: **"Autofill this application with
aplyx?"**. It stays invisible everywhere else, including listing pages
on those same sites. Say yes (or "Not now," which still reveals the
rest without autofilling) to get to: **Fit check** (verdict + score +
duplicate warning), **Autofill** (fills mapped empty fields, amber for
unanswerable ones, never overwrites), **Save for review**
(`needs_review` entry), and **I submitted this: record it** (`applied`
outcome, dedup-guarded, syncs the Sheet tracker). "Bridge unreachable"
means the bridge isn't running. See `aplyx.app/extension.html` for what
this looks like.

## 2.7 Two users on one machine

aplyx is **single-user by design**: everything personal lives in the
clone (`src/config/`, `data/` incl. resumes, `logs/`, `.playwright-mcp/`).
For two people on one machine, use **two separate clones** (e.g.
`~/aplyx-alice`, `~/aplyx-bob`), pointing the TUI at the right one
with `APLYX_ROOT`. Caveat: the launchd schedule (§2.5) uses the fixed
label `com.aplyx.job-agent`, so only **one** clone per macOS user
account can have it installed; run the second on demand or under
another OS user account. Profile-based multi-user is deferred; see
`AGENTS.md`'s "Single-user deployment" section.

## 2.8 Per-agent quickstarts

Pick one of the four agents, install it, run
`bash src/scripts/install/install.sh`; the installer detects it and
writes `src/config/harness.json` (asking if more than one is present).
Change any time via that file or
`APLYX_HARNESS=opencode|claude|codex|copilot`. Business logic is
identical under every agent; only the thin adapter in
`src/scripts/runtime/run_job_agent.sh` differs; see `AGENTS.md`'s "Harness
capability matrix" for the degraded paths.

- **opencode** (full): install per opencode.ai. Agents in
  `.opencode/agents/`, models from `opencode.jsonc`. Runs `opencode run
  --agent job-scraper`.
- **Claude Code** (full): install per claude.com/claude-code. Agents
  in `.claude/agents/`, Playwright MCP from `.mcp.json`. Headless runs
  need pre-approved `.claude/settings.json` permissions (installer
  offers to create it, asks first). Runs `claude -p`.
- **Codex CLI** / **GitHub Copilot CLI** (both degraded): install per
  developers.openai.com/codex/cli / docs.github.com/copilot. Both read
  `AGENTS.md` natively with no subagent registry (roles run inline
  from `src/agents/bodies/`) and no browser automation by default;
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
| Harness: Codex CLI | PENDING: CLI not installed on the verification machine | N/A |
| Harness: Copilot CLI | PENDING: CLI not installed on the verification machine | N/A |

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

## 3.5 Inbox status detection (hosted only, optional)

aplyx can flag likely application-status changes (interview, rejected,
offer) right on the Status screen — but **this is a hosted-account
feature only**. Local installs have no access to it at all (matches the
aplyx.app pricing page, which lists this as a Pro-tier hosted feature) —
if you're running fully local, skip this section.

The reason it's hosted-only: this needs a real IMAP credential to your
inbox, and there's no way to hand that to an arbitrary local install
safely. A signed-in hosted account already has real authentication and
row-level security backing it, so the credential can live server-side,
scoped to your account, and never touch a local machine at all.

**How it works:** during the hosted onboarding wizard's "Track
application status" step (or later from Settings), you provide your
email address, IMAP server, and an **app-specific password** — not your
real account password. This is submitted directly to a `SECURITY
DEFINER` database function that stores the password via [Supabase
Vault](https://supabase.com/docs/guides/database/vault) (encrypted at
rest); it is never written to a plain, readable column. A scheduled
job (`pg_cron`, every 30 minutes) invokes aplyx's own Edge Function,
which connects **read-only** to your inbox over IMAP, looks for replies
to companies you've actually applied to, and updates that job's status
directly. Nothing here is read by an LLM — deterministic keyword
matching only, same as every other aplyx classification step.

This is a **best-effort keyword signal, not a verified fact** — every
detected status carries its source (the matched email's subject line) so
you can judge it yourself rather than take it as ground truth. Once a
job reaches Rejected, Offer, or Withdrawn, it's treated as final — no
later, possibly-misclassified email can flip it back.

**Setting it up:**

1. Generate an app-specific password with your email provider (Gmail:
   Google Account → Security → App passwords. Outlook: Account →
   Security → App passwords. Most providers have an equivalent) — never
   use your real account password.
2. In the desktop app's hosted onboarding wizard (or Settings, once
   signed in), open "Track application status," enable it, and enter
   your email address, IMAP server (auto-filled for Gmail/Outlook/
   Yahoo/iCloud), and the app password.
3. That's it — the next scheduled worker run picks it up automatically.
   Disable the toggle at any time to turn this off again.

Company-name matching against your applied jobs is a plain
case-insensitive substring check on the sender/subject, so a very short
or generic company name could occasionally mismatch — this is a signal
to help you notice status changes faster, not a replacement for actually
reading the email yourself.

## 3.6 Gmail OAuth for hosted inbox connection (operator setup)

The hosted onboarding wizard's "Track application status" step offers a
**Gmail** choice that runs a real Google OAuth consent flow instead
of asking for an IMAP app password. The flow lives in two Edge
Functions — `mail-oauth-start` (builds the consent URL, signed state)
and `mail-oauth-callback` (exchanges the code, persists tokens in Vault
via the `service_upsert_mail_connection_oauth` RPC). Both read their
credentials from `Deno.env`, which Supabase surfaces from
`supabase secrets set`.

This is a **one-time operator setup** (not per-user): the secrets belong
to the aplyx-users Supabase project, not to any individual hosted
account. Each hosted user's tokens are still scoped to their own
`auth.uid()` by the RPC and RLS — the secrets here are just the app's
own OAuth client credentials.

**Prerequisites (Google Cloud Console):**

1. Go to [Google Cloud Console → Credentials → Create OAuth client ID](https://console.cloud.google.com/apis/credentials).
   - **Application type:** "Web application".
   - **Name:** `aplyx Gmail hosted inbox` (or similar).
2. Under **Authorized redirect URIs**, add this URI (the deployed callback function):
   ```
   https://aedejjesqcbndphkldfs.supabase.co/functions/v1/mail-oauth-callback
   ```
   (Replace the project ref if you are not on the `aplyx-users` project. Note:
   this is `<ref>.supabase.co/functions/v1/...`, not the
   `<ref>.functions.supabase.co/...` form `supabase functions deploy`
   mentions — that's a legacy domain; supabase-js 2.111.0+ actually invokes
   functions via `/functions/v1/`, and `_shared/mail_oauth.ts`'s
   `callbackUrl()` builds the redirect_uri to match. A mismatch here fails
   silently as a generic "invalid request" on Google's consent screen.)
3. Click **Create**. Copy the **Client ID** and **Client secret** immediately
   — the secret is shown only once during creation.

**Set the secrets** (run from the repo root):

```bash
bash src/scripts/setup/set_mail_oauth_secrets.sh \
  --google-client-id <google-client-id> \
  --google-client-secret <google-client-secret>
```

The script also generates `MAIL_OAUTH_STATE_SECRET` (32 random bytes)
the first time it runs — this signs the OAuth `state` parameter so the
callback can verify the redirect came from our own start function, not a
CSRF. Never rotate it without coordinating a redeploy of both functions
(in-flight consent flows signed with the old secret would fail
verification).

**Secrets set on the project** (verify with `supabase secrets list`):

| Secret | Required | Notes |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | yes | Google Cloud Console OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | yes | Google OAuth client secret value |
| `MICROSOFT_CLIENT_ID` | no | Set if you also want Microsoft OAuth; defaults to empty |
| `MICROSOFT_CLIENT_SECRET` | no | Set if you also want Microsoft OAuth |
| `MICROSOFT_TENANT_ID` | no | Defaults to `common` in code; set for single-tenant Microsoft |
| `MAIL_OAUTH_STATE_SECRET` | yes | Auto-generated by the setup script; signs OAuth state |
| `MAIL_CALLBACK_URL` | no | Where the callback redirects the browser *after* success. Defaults to `aplyx://mail-callback` (the desktop deep link). Set to a real URL only for a web-only deployment. |

**Deploy the functions** (the setup script reminds you, but for
reference):

```bash
cd src/supabase
supabase functions deploy mail-oauth-start            # JWT-verified (called by the signed-in client)
supabase functions deploy mail-oauth-callback --no-verify-jwt  # browser redirect target, no JWT
```

`mail-oauth-callback` is deployed `--no-verify-jwt` on purpose: Google
redirects the user's browser to it with `?code=…&state=…`, so there is
no Supabase session JWT to verify. Auth is the signed `state` parameter
(HMAC-SHA-256 over the user id + provider + timestamp), which the
callback verifies before exchanging the code or touching any row.

**Verifying the flow end-to-end:**

1. Confirm all relevant secrets appear in `supabase secrets list`.
2. Confirm both functions are `ACTIVE` in `supabase functions list`.
3. From the desktop app's hosted onboarding (or Settings), choose
   **Gmail**, enter the inbox email, and click "Connect Gmail inbox."
   The start function returns a consent URL and the app opens it.
4. Complete Google consent in the browser. Google redirects to the
   callback, which exchanges the code, fetches the profile, and
   calls `service_upsert_mail_connection_oauth` — a row appears in
   `mail_connections` with `status='connected'` and the tokens stored as
   Vault secrets (never in a readable column).
5. The callback redirects the browser to `MAIL_CALLBACK_URL` (default
   `aplyx://mail-callback`) with `status=connected` and the connected
   email as query params; the desktop app listens for that deep link and
   advances the onboarding step.

**What still needs the operator** (cannot be automated): the Google Cloud
Console OAuth client ID and secret are real credentials that only the
operator can create. Until they are set, `providerEnabled("gmail")`
returns false and the start function returns HTTP 501 ("gmail inbox
OAuth is not enabled on this build yet") rather than attempting a
consent URL it cannot complete.
