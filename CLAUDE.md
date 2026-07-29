# aplyx — Claude Code project guide

aplyx (formerly Ares) is a single-user, local-first job-application
agent: it scrapes public job boards, deduplicates against local
history, fit-gates each posting deterministically, tailors a resume +
cover letter, applies through a Playwright-driven browser or public
APIs, and reports outcomes to Discord (plus an optional Google Sheet
row per success). An LLM harness (opencode or Claude Code)
orchestrates; deterministic Python/bash helpers own all state.

**`AGENTS.md` is the canonical behavioral ruleset for this repo.** Read
it before doing anything; everything there binds any agent operating in
this repo, regardless of harness. For project history, phase roadmap,
and the current status pointer, read `docs/PLAN.md` (gitignored,
local-only).

## Operator rules (restated from docs/PLAN.md §2 — these bind you)

- Work **one phase at a time**. Do not start a phase (or the next one)
  without the operator's explicit go-ahead; stop after printing the
  phase summary.
- **All state writes go through the helpers** (`src/scripts/state/job_state.py`,
  `src/scripts/state/append_state_entry.sh`). Never hand-write or hand-edit
  `data/*.json` / `data/*.jsonl`.
- **Gitignored files stay uncommitted**: live configs in
  `src/config/*.json`, everything in `data/`, `logs/`, `docs/PLAN.md`, and
  `data/resumes/` hold PII/secrets and never enter git.
- Do not introduce a new model name, MCP server, or permission surface
  without explicit operator approval.
- Whoever closes a phase or work item MUST update the Phase Status
  Pointer at the top of `docs/PLAN.md` **and** the "Phase status" block
  in `AGENTS.md` before stopping.

## Repo map

Everything code/config-related lives under `src/`, one folder per concern;
the repo root stays to README/LICENSE/canonical-ruleset docs and the
harness dot-directories (which can't move — each harness hardcodes looking
for its own at the repo root).

| Path | What it is |
| --- | --- |
| `AGENTS.md` | Canonical behavioral rules (fetch methods, fit gate, write discipline) |
| `docs/PLAN.md` | Phase roadmap + handoff (gitignored — read first when resuming) |
| `docs/SETUP.md` | User-facing install/config walkthrough |
| `src/agents/` | **Source of truth** for agent prompts: `bodies/` + `frontmatter/<harness>/` |
| `.claude/agents/`, `.opencode/agents/` | **Generated** from `src/agents/` — never hand-edit |
| `src/scripts/` | Deterministic helpers — the only things allowed to write state |
| `src/tui/` | The `aplyx` TUI (TypeScript/Ink overlay; shells out to the helpers) |
| `src/tauri/` | The Tauri desktop app |
| `src/core/` | Shared TypeScript core (`@aplyx/core`) used by both apps |
| `src/extension/` | The browser extension (user-driven hybrid mode) |
| `src/config/` | `*.example.json` templates (committed) + live configs (gitignored) |
| `data/`, `logs/` | Runtime state and logs (gitignored, PII) — stay at the repo root |

## Common commands

```bash
bash src/scripts/install/install.sh                    # universal first-run installer
bash src/scripts/validate/validate_local_config.sh      # config check (expect "OK")
python3 src/scripts/state/job_state.py ensure-files  # bootstrap/validate state files
bash src/scripts/runtime/run_job_agent.sh              # trigger one agent run
bash src/scripts/runtime/scheduler.sh status           # 30-min launchd schedule state
python3 src/scripts/validate/generate_agent_definitions.py --check   # agent-def drift check

cd src/tui && npm install && npm run build     # build the TUI
npm link                                   # exposes the `aplyx` command
aplyx                                     # open the TUI (press ? for keys)
npm run typecheck && npm run smoke         # TUI CI checks
```

## Harness notes

- The agent definitions in `.claude/agents/` and `.opencode/agents/`
  are **generated** from `src/agents/bodies/` +
  `src/agents/frontmatter/<harness>/` by
  `src/scripts/validate/generate_agent_definitions.py`. Edit the sources, then
  regenerate — never the generated files.
- Runtime runs go through `src/scripts/runtime/run_job_agent.sh`, which selects the
  harness (opencode or Claude Code) via `src/config/harness.json`,
  `$APLYX_HARNESS` (legacy `$ARES_HARNESS` still honored), or
  auto-detection. Claude Code is both a supported runtime driver and a
  development harness here.
- Playwright MCP for this project is configured in `.mcp.json`;
  headless permissions in `.claude/settings.json`.
- Env vars use the `APLYX_*` prefix (`APLYX_SESSION_CAP`,
  `APLYX_HARNESS`, `APLYX_LOCK_MAX_AGE_MIN`,
  `APLYX_KEEP_SESSION_LOGS`, `APLYX_ROOT`); the legacy `FLUX_*` and
  `ARES_*` names remain as fallbacks for pre-rename setups.

## Conventions that trip people up

- `skipped_unfit` outcomes are **local-only**: never routed to Discord,
  `data/applied_jobs.json`, or the Google Sheet.
- The review-queue file is append-only; "resolved" is derived from
  later outcomes, never by deleting entries.
- Max 25 applications per session — the TUI can lower this per run via
  `APLYX_SESSION_CAP`, never raise it.
- Workday is review-only: no auto-apply path exists, by design.
- The TUI renders and orchestrates; Python owns state. Do not port
  helper logic into TypeScript without an explicitly approved decision.
