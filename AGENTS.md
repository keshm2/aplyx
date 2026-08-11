# aplyx — Job Application Agent — Core Rules

## Phase status (keep in sync with docs/PLAN.md's Phase Status Pointer)

**Compressed 2026-08-10** — see `docs/PLAN.md`'s Phase Status Pointer
for the fuller version and the reasoning behind each item; this block
mirrors it, kept short on purpose. Detailed shipped-work history lives
in each phase's own `docs/PLAN.md` §3.x section, not here.

- **Current phase: 17 (hosted `review_only` service) — IN PROGRESS.**
  First increment built and locally verified against the real
  `aplyx-users` Supabase project (2026-08-10): `hosted_runs` work queue
  (migration `0004`), `src/worker/` scheduled-worker package, two
  hosted-context tailoring scripts, new `SupabaseAdapter` write
  methods, `.github/workflows/hosted-worker.yml` (not yet relied
  upon — verified locally first, per plan). Live-verified against a
  real test account: 16,593 real postings fetched, 4,979
  `skipped_unfit` + 13 `needs_review` correctly written through to
  `review_queue`/`applied_jobs`/`job_events`/`jobs` and read back via
  the same `SupabaseAdapter.loadState()` the desktop Review screen
  uses. A real bug (nonzero-exit Python output being silently dropped
  instead of read) was found and fixed during this verification.
  **Not yet verified live: a successfully tailored job with real
  content** — the test run's Anthropic key had no usage credit, so
  every tailoring call correctly degraded to a `needs_review` row
  rather than producing tailored content; this is a real gap, not a
  formality. **Two more real bugs found and fixed via live
  re-verification (2026-08-11):** per-job subprocess spawning was the
  actual bottleneck at scale (added batched `canonicalize-batch`/
  `evaluate_job_fit.py --batch` subcommands, cut 16,590 jobs from the
  dominant cost to 2.7s), and `SupabaseAdapter.loadState()` never
  paginated past PostgREST's 1,000-row default — a **pre-existing bug
  in already-shipped code**, exposed once this test account's registry
  passed 1,000 rows, that had already produced one real duplicate
  `review_queue` row before being caught and fixed (`fetchAllRows` now
  pages properly for all three tables). Full details, scope cuts, and
  what's still missing before real users: `docs/PLAN.md` §3.18.
- **Previous phase: 16B (ATS/source expansion) — reached a natural
  pause.** Shipped:
  Greenhouse, Lever, Ashby, Workday (review-only), SmartRecruiters,
  **Workable (2026-08-10)**, **JazzHR (2026-08-10)**, Amazon, Oracle
  Recruiting Cloud, Eightfold, Apple, Google, Stripe, Gem, The Muse.
  **BambooHR — spiked 2026-08-10, deferred (operator-directed).** Its
  listing endpoint was real and stable; its JD-detail endpoint had no
  deterministic access path — moot either way, since BambooHR's own
  ToS §4.2 prohibits automated access outright (no public-content
  carve-out), same category of finding as the Workday ToS conflict
  below. Not revisitable without a real partner/API relationship.
  iCIMS/Jobvite/Rippling/Breezy are deferred behind real structural
  gates (partner-only APIs, no public API at all), not a research gap.
  Every originally-scoped platform is now shipped or deferred-for-cause;
  there is no queued "next adapter" right now. Full research:
  `docs/ATS.md`'s 2026-08-10 section.
- **Workday stays review-only — re-confirmed 2026-08-10, not a gap.**
  Workday's own ToS prohibits automated submission, candidate accounts
  are per-tenant with no shared identity, and even the best-resourced
  competitors researched stop at autofill-then-human-submits. Do not
  build full auto-submit for Workday.
- **Queued up**, each needing its own explicit go-ahead: the rest of
  Phase 17 itself (real hosted onboarding, quotas/abuse controls,
  encryption-at-rest + deletion path, wiring the GitHub Actions
  schedule for real), the paid-tier/`auto_apply`/cheaper-tier design
  docs (`docs/hosted-paid-tier-plan.md`, `docs/hosted-auto-apply-plan.md`,
  `docs/hosted-no-agent-tiers-plan.md`), Phase 12 (cost tiering),
  Phase 18 (security audit, beta ship gate), Phase 19 (opt-in email
  status tracking, scoped, not started). None have started.
- **Positioning research, ready when wanted:** `docs/beating-competitors.md`
  — evidence-graded competitive analysis (Tsenta and 20+ other
  auto-apply tools), concrete sourced differentiators. Read before any
  beta positioning/marketing work.
- **Rule:** whoever closes a phase or work item updates this block
  (keep it short) and the matching pointer in `docs/PLAN.md` before
  stopping.

## Single-user deployment (phase 9)

**aplyx runs as one user on one machine.** State files in `data/`,
live configs in `src/config/`, logs in `logs/`, and the resume folder
(`data/resumes/`) are all implicitly per-user — there is
no profile abstraction and none should be introduced without an
explicitly approved phase. Two people who want to run aplyx on the
same machine today do so via **two separate clones** with two
separate configs (see docs/SETUP.md "Two users on one machine");
profile-based multi-user is a deliberately deferred future migration.

### Per-user vs. project-owned files

| Class | Files | Notes |
| --- | --- | --- |
| Per-user: live config | `src/config/targets.json`, `src/config/discord_config.json`, `src/config/google_sheets_config.json`, `src/config/service-account-key.json`, `src/config/harness.json`, `src/config/extension_bridge.json`, `.claude/settings.json` | All gitignored; hold PII/secrets/per-machine choices |
| Per-user: runtime state | `data/applied_jobs.json`, `data/review_queue.json`, `data/job_registry.json`, `data/job_events.jsonl` | Written only by the `src/scripts/` helpers |
| Per-user: personal documents | `data/resumes/` (markdown resumes + cover letter, each with a matching PDF) | Gitignored PII |
| Per-user: logs + heartbeat | `logs/` (`run_job_agent.log`, `session_*.log`, `heartbeat.json`, `launchd.{out,err}.log`, `tmp/`) | Retention pruned by the runner |
| Per-user: browser artifacts | `.playwright-mcp/` | Playwright profile/session state |
| Per-user: schedule | `~/Library/LaunchAgents/com.aplyx.job-agent.plist` | Lives outside the repo; label is fixed (see seams) |
| Project-owned | `src/scripts/`, `src/agents/` (+ generated `.claude/agents/`, `.opencode/agents/`), `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/SETUP.md`, `docs/RELEASE.md`, `docs/CHANGELOG.md`, `src/config/*.example.json`, `src/config/{ashby,lever}_vetted_slugs.json`, `requirements.txt`, `opencode.jsonc`, `.mcp.json`, `src/tui/`, `src/extension/`, `.github/`, `.gitignore` | Committed; identical across users |
| Project-owned, local-only | `docs/PLAN.md` | Gitignored by design (plan/handoff doc), but not per-user data |

### Future multi-user seams (documented only — do NOT parameterize now)

A future profile-based migration would need exactly these paths to
become parameters; every one is read from a single, mechanical place
today:

- **Config paths** — `src/config/*.json`, read directly by
  `validate_local_config.sh`, the agent prompts, `install.sh`, and
  the TUI wizard/state readers.
- **Runtime data directory** — `data/`; `job_state.py` defaults are
  module constants overridable per-call via `--registry` / `--events`
  / `--applied` CLI flags, and `append_state_entry.sh` takes the
  target file as its first argument.
- **Log directory + heartbeat** — `logs/` in `run_job_agent.sh` and
  the `HEARTBEAT = "logs/heartbeat.json"` constant in
  `write_heartbeat.py`.
- **Playwright profile directory** — `.playwright-mcp/`.
- **Google service-account key path** — the
  `service_account_key_path` field inside
  `src/config/google_sheets_config.json`.
- **Resume folder** — `data/resumes/`.
- **launchd label** — `com.aplyx.job-agent` is fixed in
  `scheduler.sh`, so two clones cannot both install the 30-minute
  schedule today; a second install would need a per-clone label.
- **TUI root** — already parameterized: `$APLYX_ROOT` (legacy
  `$ARES_ROOT`) selects the project root, the ready-made pattern for
  the other seams.

## Critical rules (never break these)
- ALWAYS read data/applied_jobs.json before starting any application run.
  Never apply to a job whose URL or job_id already exists in that file.
- ALWAYS read src/config/targets.json for role_keywords, level_keywords, and
  locations before scraping.
- ALWAYS write a result entry to data/applied_jobs.json after each
  application attempt — success OR failure — before moving to the next
  job. This also covers user-visible needs_review outcomes that occur
  before a real application submission (e.g. ATS score below threshold
  during tailoring): append a needs_review entry so future runs do not
  re-tailor the same job forever. skipped_unfit is local-only and must
  never be written to applied_jobs.json.
- Max 25 applications per session (rate limit protection). The TUI's
  automatic mode may lower this per run via APLYX_SESSION_CAP (1–25;
  the legacy ARES_SESSION_CAP name is honored as a fallback);
  the cap can never exceed 25. src/scripts/runtime/run_job_agent.sh reads
  APLYX_SESSION_CAP (default 25), clamps values above 25 down to 25,
  and falls back to 25 on invalid or below-1 input, then injects the
  effective cap into the run prompt so the orchestrator is explicitly
  told the per-session limit. The runner may also append an optional
  operator instruction (APLYX_EXTRA_PROMPT, truncated to 500 chars,
  set from the TUI's automatic-mode prompt field) to the run prompt.
  That instruction can narrow or focus a run but NEVER overrides this
  file, the session cap, or the state-write discipline — if it
  conflicts with a rule here, the rule wins.
- NEVER accept an unconfirmed dropdown/combobox match, and ALWAYS verify a
  form before submitting it. Typing into an ATS location/school/degree
  widget only *highlights* an option — pressing Enter or tabbing away
  commits whatever happened to be highlighted (typing "Seattle" has
  selected "Settle", or simply the first entry starting with "Se"). For
  every `<select>` / combobox / typeahead: choose the option whose visible
  text matches the intended value EXACTLY (case-insensitive, trimmed),
  never by index, position, or "closest match"; then read the committed
  value back and confirm it. If no exact option exists, or several match
  equally, route the job to needs_review ("dropdown '<field>' has no exact
  option for '<value>'; user to apply manually") — never guess. Before
  every submit, snapshot the form and verify each filled value equals the
  safe_fields value it came from and that no field the user left blank has
  acquired a value; on any mismatch, do not submit — needs_review instead.
  A wrong answer on a submitted application is irreversible. See
  job-scraper.md Phase 3 steps 3 and 6 for the full protocol.
- NEVER write a free-text motivation answer ("Why do you want to work at
  X?", "Why this role?") yourself, and never leave it blank when required.
  Ask `src/scripts/state/interest_letter.py approved-text '<job_key>'`: exit 0
  means the user approved an answer — paste stdout verbatim and apply. Exit
  2 means park the job via `interest_letter.py request '<json>'`, print
  `[parked] <title> @ <company> — awaiting interest letter`, and move on.
  A parked job records NOTHING — no record-event, no applied_jobs.json row,
  no review_queue row, no Discord. Parking is not an outcome; the job is
  unfinished. This is the one deliberate exception to "record every job you
  touch", and it is load-bearing: a needs_review entry would make
  `can-apply` block the job permanently, so the user's answer could never
  be used. `interest_letter.py pending` is read once at the start of
  tailoring so parked jobs aren't re-tailored every run. An invented reason
  is a claim the applicant gets asked to defend in an interview — that
  asymmetry is why drafting is a user-reviewed TUI action
  (`generate_interest_letter.py` saves a DRAFT, never an approval), not
  something the apply loop does.
- Never store passwords, SSNs, or payment info anywhere. If a form requests
  these and they aren't in src/config/targets.json under "safe_fields", skip the
  job, log it to data/review_queue.json via the state helper (see File
  write discipline), and record a needs_review event via record-event.
- After every applied, needs_review, or failed outcome, call the
  @discord-reporter subagent to send a per-outcome notification (success,
  needs_review, or failed webhook respectively). After every batch, call
  @discord-reporter to send the summary (summary webhook, or success
  webhook as fallback). Never invoke @discord-reporter for skipped_unfit.
  Discord is OPTIONAL: when src/config/discord_config.json is missing or has
  "enabled": false, the reporter logs one skip line and outcomes stay
  local (state files + TUI). Never treat a disabled reporter as a failed
  outcome.
- ALWAYS canonicalize every raw job that survives the deterministic
  role/level prefilter into one internal record via the canonical helper
  (src/scripts/state/job_state.py) before any dedup or fit decision. A
  deterministic raw-title prefilter (the role/level keyword rule plus
  the fetch-efficiency shortlist bound below) MUST run before
  canonicalization to bound work — prefiltered-out jobs are never
  recorded, acted on, or mentioned to the user.
- Fetch efficiency (bounded transcript, bounded work — every run):
  - Redirect EVERY board fetch and fetch-helper output to a file under
    logs/tmp/ (mkdir -p logs/tmp first; the runner clears it each run).
    NEVER print raw posting dumps into the session transcript — after
    each fetch print only the board name and a line count.
  - Prefilter deterministically (python/grep over the raw files, using
    the role/level keyword rule) into logs/tmp/prefiltered.jsonl; only
    survivors are canonicalized and upserted.
  - Bound the shortlist: stop adding candidates once the prefiltered
    shortlist reaches 5x the session cap (minimum 10). Unprocessed raw
    jobs simply wait for the next scheduled run.
  - Print at most ~30 shortlist lines (company · title · url) into the
    transcript when reviewing candidates.
- ALWAYS upsert each canonical record into data/job_registry.json via the
  canonical helper — never hand-write the registry.
- ALWAYS run the deterministic JD fit gate on every canonical job after
  role filtering and before tailoring:
  `python3 src/scripts/jobs/evaluate_job_fit.py '<canonical-job-json>'`
  The helper returns fit_status of skipped_unfit, needs_review, or
  candidate (plus fit_score, reasoning, fit_reasons,
  matched_role_keyword, matched_level_keyword, matched_level_source,
  years_required, decision_version). Only candidate jobs proceed to
  @resume-tailor. skipped_unfit is local-only (record via record-event,
  never Discord/applied_jobs.json/sheet). needs_review from the fit gate
  is a user-visible manual-review outcome before application: append to
  data/applied_jobs.json and data/review_queue.json, record a
  needs_review event, and send the needs_review Discord notification. Do
  not tailor skipped_unfit or needs_review jobs.
- ALWAYS re-check can-apply via the canonical helper immediately before
  any application attempt, even if the job passed earlier filtering. If
  can-apply refuses, skip the job and record a skipped_unfit event.
- ALWAYS re-run the deterministic fit gate immediately before applying
  (pre-apply fit confirmation). If the fit gate no longer yields
  candidate, do not apply — handle skipped_unfit/needs_review the same
  way as the pre-tailoring gate.
- skipped_unfit events are local-only: record them via the canonical
  helper's record-event, but never route them to Discord or
  data/applied_jobs.json.
- ALWAYS record an internal event via record-event for every applied,
  needs_review, or failed outcome.
- ONLY successful applications (status "applied") are synced to the
  Google Sheet internship tracker via src/scripts/jobs/sync_internship_tracker.py
  — exactly one row per successful application, and only after the
  applied_jobs.json entry and internal event are recorded. needs_review,
  failed, and skipped_unfit outcomes must never be written to the sheet.
  The sheet is user-facing: pass only the current visible tracker fields,
  never internal-only fields. See "Internship tracker (Google Sheets)
  sync" below.

## Harness capability matrix (phase 16)

aplyx runs under four coding agents. Business logic is identical
everywhere — the only harness-specific code is the adapter block in
`src/scripts/runtime/run_job_agent.sh` (never add harness branches anywhere
else). Capabilities differ; the degraded paths below are behavioral
rules that keep the least-capable harness honest without weakening
the helpers or prompts.

| Capability | opencode | Claude Code | Codex CLI | Copilot CLI |
| --- | --- | --- | --- | --- |
| Subagent registry (`@resume-tailor`, `@cover-letter-tailor`, `@discord-reporter`, `@interest-letter`) | yes (`.opencode/agents/`) | yes (`.claude/agents/`) | no → inline fallback (`.codex/agents/*.toml` generated for forward-compat, but `codex exec` cannot spawn a named subagent from it — [openai/codex#15250](https://github.com/openai/codex/issues/15250)) | conditional (`.github/agents/`, `copilot --agent <name>`) — probed at runtime (`_copilot_has_agent_flag`); an older CLI without `--agent` falls back to inline the same as Codex |
| Interest-letter drafting (pure text, no browser) | yes | yes | yes (inline) | yes (registry or inline, per the probe above) |
| Browser automation (Playwright MCP) | yes (`opencode.jsonc`) | yes (`.mcp.json`) | no by default → API-boards path | no by default → API-boards path |
| Shell / helper execution | yes | yes | yes (user's sandbox/approval config) | yes (`--allow-all-tools`) |
| File read/write | yes | yes | yes | yes |
| Project instructions | `AGENTS.md` (native) | `CLAUDE.md` → `AGENTS.md` | `AGENTS.md` (native) | prompt-passed; read `AGENTS.md` |

**All harness-specific argv lives in `src/scripts/runtime/harness_adapter.py`**
(`agent_command`) — the only module allowed to branch per harness. Both
`run_job_agent.py` and `generate_interest_letter.py` go through it, so a new
agent works on all four harnesses by construction rather than by remembering
four call sites. Do not add a harness branch anywhere else.

**On the subagent-registry gap (2026-07-24 update):** Codex CLI and
Copilot CLI both gained real custom-agent/subagent support after this
matrix was first written, and `src/scripts/validate/generate_agent_definitions.py`
now generates `.codex/agents/*.toml` and `.github/agents/*.md` alongside
the existing `.opencode/agents/`/`.claude/agents/` output — same sources
(`src/agents/bodies/`, `src/agents/frontmatter/<harness>/`), same drift-check
discipline. Copilot's registry is actually wired into `agent_command`
(behind the `--agent`-support probe above); Codex's is generated but
deliberately **not** wired in, because `codex exec` — the non-interactive
mode this project actually uses — has no working way to invoke a named
subagent from `.codex/agents/` yet. Revisit `_HAS_REGISTRY` /
`agent_command`'s codex branch once that ships upstream; don't assume it
has just because the TOML files exist.

**Degraded paths (mandatory when the capability is missing):**

- **No subagent registry** — when the workflow delegates to
  `@resume-tailor`, `@cover-letter-tailor`, `@discord-reporter` or
  `@interest-letter`, read `src/agents/bodies/<name>.md` and perform that
  role inline, following it exactly. Helper calls, routing rules, and
  state writes are unchanged. `harness_adapter.agent_command` builds this
  preamble automatically for Codex, and for Copilot when the `--agent`
  probe fails.
- **No browser automation** — fetch and process **API-fed boards
  only** (Ashby, Lever, SimplifyJobs, Workday CXS). Any job whose
  application would require a browser is routed to `needs_review`
  with reasoning "harness lacks browser automation: <title> at
  <company>; user to apply manually" — the same
  applied_jobs/review-queue/record-event/Discord flow as every
  other needs_review outcome. **Never** silently skip such a job,
  never attempt a browser apply without browser tools, and never
  fork the business logic to compensate. Deliberately not attempted
  for Codex/Copilot even though both can now reach external MCP
  servers in principle: Codex's non-interactive MCP tool calls are
  auto-cancelled unless launched with
  `--dangerously-bypass-approvals-and-sandbox` (a flag whose name is
  reason enough to not use it for a tool that submits real
  applications), and Copilot CLI has an open bug where a custom/sub
  agent invoked headlessly doesn't receive its configured MCP tool
  connections at all — the API-boards degraded path is the actually
  safer and more reliable choice today, not a shortcut.
- A degraded harness must not degrade the core: if a capability gap
  cannot be routed to `needs_review`, stop and report rather than
  improvising a weaker flow.

## Session start checklist
1. Run `python3 src/scripts/state/job_state.py ensure-files` — create/validate the
   canonical registry (data/job_registry.json) and local event log.
2. Read data/applied_jobs.json — build your dedup set.
3. Read data/job_registry.json — build your canonical dedup set.
4. Read src/config/targets.json — load role_keywords, level_keywords, locations.
5. Confirm Playwright MCP is available before starting browser-based steps.

## Board-specific fetch method
- Ashby and Lever: use bash/curl to call the public JSON API directly.
  No authentication required. Do not use Playwright for these two boards.
    - Ashby: GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
      for each slug in src/config/targets.json "ashby_company_slugs".
    - Lever: GET https://api.lever.co/v0/postings/{slug}?mode=json
      for each slug in src/config/targets.json "lever_company_slugs".
  Note: neither API supports server-side filtering — apply the role/level
  filter below client-side after fetching.
- If "ashby_company_slugs" or "lever_company_slugs" in src/config/targets.json
  is empty, missing, or contains only placeholder values (e.g.
  "REPLACE_ME"), skip that board for this run and log a single warning to
  the session output — do not abort the run. Other boards continue
  normally. Note this state is normally short-lived: the config
  validator auto-seeds placeholder-only slug arrays from the
  project-owned vetted lists (src/config/ashby_vetted_slugs.json,
  src/config/lever_vetted_slugs.json) via src/scripts/validate/seed_vetted_slugs.py —
  it never overwrites an array containing any real slug. Never edit
  the vetted lists at run time; additions are reviewed code changes.
- SimplifyJobs: use the deterministic fetch helper — never scrape GitHub
  with Playwright:
  `python3 src/scripts/jobs/fetch_simplify_listings.py`
  The helper reads src/config/targets.json "simplify_feeds" (known feeds:
  "summer_internships", "new_grad"), fetches the project-owned
  SimplifyJobs listings JSON from raw.githubusercontent.com, filters to
  active + visible postings, and prints one raw-job JSON object per line
  on stdout (source "simplify"), ready for canonicalize.
  - If "simplify_feeds" is missing, empty, or placeholder-only
    ("REPLACE_ME"), the helper warns on stderr, prints nothing, and
    exits 0 — skip the board for this run and continue with the other
    boards. A non-zero exit means every configured feed failed to
    fetch: log one warning, skip the board, continue the run.
  - SimplifyJobs listings carry NO JD text. After role filtering and
    BEFORE running the fit gate, fetch the JD body from the listing's
    `url`: if the URL is an Ashby/Lever posting use those public JSON
    APIs, otherwise open the URL with Playwright and extract the JD
    text. Re-canonicalize/upsert the record with the fetched jd_text.
    Never run the fit gate on a SimplifyJobs job with empty jd_text —
    an empty JD skips every deterministic hard-reject check.
  - The helper's `sponsorship` field is informational/audit-only. Do
    not filter on it — the phase 4 fit gate is the only classifier.
- Workday (phase 7, REVIEW-ONLY): tenants are configured in
  src/config/targets.json "workday_tenants" as "<host>/<site>" strings —
  the tenant is the unit of configuration; board URLs follow
  `https://<company>.wd<n>.myworkdayjobs.com/<site>` (each company
  tenant differs in subdomain and site name). Use the deterministic
  fetch helper — it calls the tenant's public, auth-free CXS JSON
  endpoints; only fall back to Playwright on a posting when the helper
  fails for it:
  `python3 src/scripts/jobs/fetch_workday_listings.py --search "intern" --limit 200`
  One raw-job JSON object per line (source "workday"), ready for
  canonicalize.
  - Missing/empty/placeholder "workday_tenants" → helper warns, prints
    nothing, exits 0; skip the board, continue the run. Non-zero exit
    (every tenant failed) → one warning, skip, continue.
  - Listings carry NO JD text. After role filtering and BEFORE the fit
    gate, fetch the JD per surviving candidate with
    `python3 src/scripts/jobs/fetch_workday_listings.py --jd-url '<posting-url>'`
    and re-canonicalize/upsert with the fetched jd_text. Never fit-gate
    a Workday job with empty jd_text.
  - **No auto-apply path exists for Workday.** A Workday job whose fit
    gate returns "candidate" routes to needs_review (applied_jobs +
    review_queue + record-event + needs_review Discord notification)
    with reasoning "Workday review-only path: <title> at <company>;
    user to apply manually". Never tailor, never form-fill, never
    submit a Workday application. needs_review items are not
    applications and do not count against the 25-per-session cap.
- LinkedIn, Indeed, Handshake, Greenhouse, Wellfound: use Playwright MCP for
  browser-based scraping.

## Role filtering (apply to all boards, regardless of fetch method)
- A job title is a candidate if it contains AT LEAST ONE term from
  src/config/targets.json "role_keywords" AND AT LEAST ONE term from
  "level_keywords" — case-insensitive substring match, not exact match.
- If a title matches role_keywords but NONE of level_keywords, check the JD
  body text for level_keywords terms before rejecting — some postings put
  seniority only in the description, not the title.
- Hard rejects (3+ years required with no new-grad language, out of US
  scope) are enforced deterministically by the fit gate — see
  "Deterministic JD fit gate" below. Role filtering only does the
  keyword screen; it does not manual-heuristic reject.
- SEASON IS NOT A FILTER. Internships and co-ops in ANY season (summer,
  fall, spring, winter, off-cycle, year-round) are in scope. Do not skip
  or deprioritize a posting because it says "Fall 2026 Intern" or
  "Off-Cycle Internship" instead of "Summer". Use src/config/targets.json
  "season_keywords" only as a reference list of terms that should NOT
  cause rejection — never as a list to filter for or require.
- There is no company exclusion list — every company is in scope as long
  as the role/level keyword match passes.
- For new-grad (non-internship) roles, ignore season language entirely —
  it doesn't apply to full-time postings.

## Deterministic JD fit gate
- After role filtering and before tailoring, run the deterministic fit
  helper on every canonical job:
  `python3 src/scripts/jobs/evaluate_job_fit.py '<canonical-job-json>'`
  Pass the canonical job JSON (the same object upserted into the
  registry). The helper returns a JSON object with at least fit_status,
  fit_score, reasoning, fit_reasons, matched_role_keyword,
  matched_level_keyword, matched_level_source, years_required, and
  decision_version.
- The fit gate makes the status choice deterministically: use
  skipped_unfit for explicit hard rejects or clearly too-low fit,
  needs_review for borderline or ambiguous-but-promising jobs, and
  candidate otherwise.
- If the fit helper exits non-zero, returns invalid JSON, or returns an
  unexpected fit_status, treat the job as needs_review: append to
  data/applied_jobs.json and data/review_queue.json, record a
  needs_review event, and send the needs_review Discord notification.
  Do not proceed to tailoring or application when the helper result is
  unusable.
- Handle the helper output:
  - skipped_unfit — the job is clearly unfit (the helper's deterministic
    hard reject, e.g. 3+ years required, out of US scope). Record a
    local-only skipped_unfit event via record-event using the helper's
    reasoning. Do not send to Discord, do not append to
    data/applied_jobs.json, do not sync to the Google Sheet, and do not
    tailor. This replaces the manual 3+ years / out of US hard-reject
    check — the fit helper is the deterministic gate.
  - needs_review — the job is ambiguous and needs manual review before
    application. This is a user-visible manual-review outcome that
    occurs before any application submission. Do not tailor. Append a
    needs_review entry to data/applied_jobs.json (File write discipline
    schema; reasoning from the helper), append to
    data/review_queue.json, record a needs_review event via
    record-event, and invoke @discord-reporter with the needs_review
    route.
  - candidate — the job passes the fit gate. Proceed to @resume-tailor.
- The fit gate runs BEFORE resume-tailoring. Never send a skipped_unfit
  or needs_review job into tailoring — the fit gate is the deterministic
  cutoff that keeps low-quality candidates out of the review queue and
  out of tailoring.

## Handshake-specific handling
- Handshake requires a student login session. If Playwright cannot
  authenticate, skip Handshake and log one "handshake_auth_needed" entry to
  data/review_queue.json via the state helper (see File write discipline) —
  do not retry in a loop.

## Location handling
- "preferred_locations" in src/config/targets.json is a PRIORITY list, not a
  filter. Any job matching role_keywords + level_keywords is in scope
  regardless of location, as long as it's within "fallback_scope"
  (United States, including remote-US roles).
- Process and apply to preferred_locations matches first within each
  scraping batch. After preferred matches are exhausted for a board,
  continue processing remaining US-based matches normally — do not skip
  them and do not stop the batch early.
- Reject only if the posting is explicitly located outside the United
  States with no remote-US option (e.g. "London, UK" with no remote
  flexibility for US-based candidates).
- When logging to data/applied_jobs.json, record `location_tier` for each
  entry: "preferred" if the job's location matched a preferred_locations
  entry, or "fallback" if it was applied to under the US-wide fallback
  scope. This field is required by the File write discipline schema.

## Canonical registry and event log
- The canonical helper (src/scripts/state/job_state.py) is the single source of truth
  for canonical job records and internal events. Never hand-write
  data/job_registry.json or the local event log — always go through the
  helper.
- Canonicalize every scraped raw job into one internal record before any
  dedup or filtering decision:
  `python3 src/scripts/state/job_state.py canonicalize '<raw-job-json>'`
  Pass the raw job (company, title, url, source, jd_text, location, etc.)
  as a single JSON object string. The helper returns a canonical job JSON
  with a stable job_key (the canonical identity) and a job_id. job_id is
  "{source}-{external_job_id}" when an external id is available, otherwise
  the job_key.
- The canonical record also carries `apply_url` and `normalized_apply_url`
  — the ATS's direct application-form link (e.g. Ashby's `.../application`
  page), distinct from the generic job-listing `url`. Whenever you write a
  needs_review/applied/failed entry to data/applied_jobs.json or
  data/review_queue.json (see "File write discipline"), or populate a
  Discord "Apply URL" field, carry `apply_url` forward from the canonical
  record: use `normalized_apply_url` if non-empty, else fall back to `url`.
  Keep the existing `url` field on those entries too — it still records
  where the posting was found; `apply_url` is additive, not a replacement.
- Upsert each canonical record into the registry:
  `python3 src/scripts/state/job_state.py upsert-job '<canonical-job-json>'`
  The helper merges by job_key — existing records are updated, new records
  are inserted. Never append duplicates manually.
- Before any application attempt, re-check eligibility:
  `python3 src/scripts/state/job_state.py can-apply '<canonical-job-json>'`
  This is the dedupe recheck against the registry and applied history. If
  the helper refuses (returns non-zero or prints "no"), skip the job and
  record a skipped_unfit event. Do not attempt the application.
- Record internal events for every outcome:
  `python3 src/scripts/state/job_state.py record-event '<event-json>'`
  Status values and when to use them:
    - skipped_unfit — a hard reject during filtering (3+ years, out of US
      scope, etc.), a skipped_unfit from the deterministic fit gate
      (pre-tailoring or pre-apply), or a can-apply refusal right before
      applying. Local-only: never route to Discord or
      data/applied_jobs.json.
    - applied — application submitted successfully.
    - needs_review — application could not be completed (CAPTCHA, missing
      form fields, ATS score too low, etc.), or a needs_review from the
      deterministic fit gate (ambiguous job, pre-tailoring or pre-apply).
      Every user-visible needs_review outcome — including ones that occur
      before a real application submission, such as an ATS score below
      threshold during tailoring or a needs_review from the fit gate —
      must also be appended to data/applied_jobs.json so future runs do
      not re-tailor the same job forever. skipped_unfit is local-only and
      never written to applied_jobs.json.
    - failed — application submitted but errored or was rejected by the
      form.
  The event JSON must include: job_key and status (applied, needs_review,
  failed, or skipped_unfit). Include company, title, url, and reasoning
  (for needs_review, failed, skipped_unfit) for auditability. The helper
  stamps recorded_at if omitted.
- skipped_unfit is local-only. It exists for auditability of hard rejects
  but must never appear in Discord notifications or data/applied_jobs.json.
  The @discord-reporter subagent must not be invoked for skipped_unfit
  events.

## Doubt signals (apply-time review triggers)
- A "doubt signal" is any concrete, machine-checkable reason to distrust an
  automatic submission. This is the canonical vocabulary — use these exact
  strings in a `doubt_signals` array (see "File write discipline") instead of
  inventing new ones per call site, so the review queue is filterable and the
  taxonomy stays enumerable in one place:
  - `ambiguous_dropdown` — a dropdown/combobox/typeahead had no unique exact
    match for the intended value (Phase 3 step 3d).
  - `verification_mismatch` — the mandatory pre-submit field-by-field
    verification found a filled value that didn't match its intended source
    (Phase 3 step 6).
  - `unrecognized_field` — the form contains a field with no mapping in
    `safe_fields` and no constructed equivalent (resume, cover letter, essay
    answer). Never skip this silently — a required field could be left
    unfilled with no record of it.
  - `unmapped_required_field` — a required field maps to an empty
    `safe_fields` value (the user declined to answer).
  - `low_ats_score` — @resume-tailor's ats_score fell below the Phase 2
    threshold (60).
  - `unapproved_essay_answer` — a free-text motivation question has no
    user-approved interest letter yet (Phase 3 step 3, interest_letter.py).
  - `cover_letter_over_limit` — the application form stated a word/
    character limit on its cover-letter field and @cover-letter-tailor's
    output still exceeds it even after being re-invoked with that limit
    (Phase 3 step 5e), or a pre-submit recheck of the live field found it
    over the limit despite the pre-paste word_count looking compliant
    (Phase 3 step 6).
  - `captcha` — a CAPTCHA was detected on the board.
  - `credential_or_payment_request` — the form asks for a password, SSN, or
    payment info not present in `safe_fields`.
  - `non_candidate_fit` — the deterministic fit gate did not return
    `candidate`.
  - `workday_review_only` — the job is on Workday, which has no auto-apply
    path by design (see "Board-specific fetch method").
  A single job may carry more than one doubt signal; list every one that
  applies rather than picking the first.

## File write discipline
- applied_jobs.json entries must include: job_id, company, title, url,
  apply_url, date_applied, status (applied|failed|needs_review), role_type
  (internship|new_grad), source (linkedin|indeed|greenhouse|lever|
  wellfound|handshake|ashbyhq|simplify|workday|smartrecruiters|workable|
  jazzhr|amazon|oracle), resume_used
  (swe|ai_ml|balanced|cyber|networking_cyber),
  ats_score (number), location_tier (preferred|fallback),
  cover_letter_used (bool). review_queue.json entries must also include
  apply_url alongside url. `apply_url` is the canonical record's
  `normalized_apply_url` (falling back to `url` when empty) — the direct
  application-form link, not just the job listing; see "Canonical
  registry and event log" above. When status is "failed" or "needs_review",
  a "reasoning" field is also required — a specific, one-sentence
  explanation of why the application failed or needs review (e.g.
  "ATS score 38/100 — requires CISSP certification not present in
  resume"). Never leave this field empty or generic. The "reasoning"
  field is optional when status is "applied".
- When status is "needs_review", also include `doubt_signals` — a non-empty
  array drawn from the canonical vocabulary in "Doubt signals" above (every
  triggering signal, not just one) — and `fill_record_path` when
  `src/scripts/state/record_fill.py` was called for this job (see "Fill records"
  below); omit `fill_record_path` (do not send an empty string) when no
  fields were ever filled for this job, e.g. a Workday entry or a Phase
  1/Phase 2 pre-tailoring reject. `doubt_signals` is optional (and normally
  empty/omitted) when status is "applied" or "failed".
- Never overwrite the file — always append new entries.
- Use the deterministic state helper for all JSON state writes — never
  hand-write jq one-liners to mutate state files directly. The helper
  handles atomic write, array append, and dedup guard.
  - Append to applied_jobs.json:
    `bash src/scripts/state/append_state_entry.sh data/applied_jobs.json '<entry-json>'`
  - Append to review_queue.json:
    `bash src/scripts/state/append_state_entry.sh data/review_queue.json '<entry-json>'`
  - Pass the entry as a single JSON object string. Do not construct tmp
    files or mv commands yourself.
- Canonical registry and event log writes go through the canonical helper
  (src/scripts/state/job_state.py), not append_state_entry.sh:
  `python3 src/scripts/state/job_state.py upsert-job '<canonical-job-json>'`
  `python3 src/scripts/state/job_state.py record-event '<event-json>'`
  See "Canonical registry and event log" above for the full flow.

## Fill records (phase 16C)
- `src/scripts/state/record_fill.py` is the canonical helper for persisting
  exactly what was typed/attached into an application form — a durable,
  provenance-tagged record, not just an in-context comparison that's
  forgotten once the run ends. Never hand-write `data/fill_records/`.
- Call it once per job, immediately after the mandatory pre-submit
  verification (Phase 3 step 6), for **every** application that reached the
  point of filling at least one field — whether the outcome ends in a real
  submit or a `needs_review` abort. This is what lets a later "reopen this
  application" action replay precisely what was already verified, instead of
  re-deciding anything.
  `python3 src/scripts/state/record_fill.py record '<job_id>' '<fields-json>'`
  where `<fields-json>` is a JSON array of
  `{field_name, filled_value, source, verified}` objects — `source` is one
  of `safe_fields:<key>` (naming the config key it came from), `constructed`
  (e.g. a linkedin/github URL built from a username), `resume_upload`, or
  `cover_letter`; `verified` is the boolean result of the Phase 3 step 6
  check for that field.
  Writes `data/fill_records/<job_id>.json` and prints its path — pass that
  path as `fill_record_path` in the applied_jobs.json/review_queue.json
  entry (see "File write discipline").
- Do not call this for a job where no field was ever filled (e.g. a Phase
  1/Phase 2 pre-tailoring reject, or a Workday entry while
  `workday_prefill_for_review` is false) — there is nothing to record, and
  `fill_record_path` should simply be omitted for those entries.

## Scheduler (phase 8)
- The production cadence is a launchd user agent (macOS) running
  src/scripts/runtime/run_job_agent.sh every 30 minutes, 24/7 — managed by
  src/scripts/runtime/scheduler.sh (install|uninstall|status|plist); Linux
  equivalent documented in docs/SETUP.md 2.5. The runner owns overlap
  protection (skip-on-overlap, dead-lock reclaim, 60-min hung-run
  threshold), writes the machine-parseable
  "run_job_agent: complete ..." health marker, and updates
  logs/heartbeat.json after every run. The 25-per-session cap is
  unchanged by the cadence.

## TUI surface (phase 13)
- The TypeScript TUI in src/tui/ is a rendering/orchestration overlay only.
  The Python/bash helpers remain the sole authoritative state writers:
  the TUI shells out to append_state_entry.sh and job_state.py for every
  state mutation and never edits state JSON directly. A TypeScript port
  of the core is a separate, explicitly-approved future decision.
- The review-queue file stays append-only: TUI triage records outcomes
  (applied_jobs append + record-event) and derives "resolved" from
  them — it never deletes queue entries.

## Browser extension surface (phase 10)
- The Manifest V3 extension in src/extension/ is the user-driven hybrid
  mode: the USER browses postings and submits forms; the extension only
  autofills, shows the fit verdict, and records outcomes.
- The extension NEVER submits a form. Autofill stops at a filled form;
  the user reviews and clicks submit themselves. This is the defining
  safety property of hybrid mode — never weaken it.
- Autofill values come ONLY from src/config/targets.json "safe_fields". A
  field the profile cannot answer is highlighted for the user, never
  invented. The bridge serves only the specific keys a page's form
  mapped — never the whole safe_fields map.
- All extension reads/writes flow through src/scripts/runtime/extension_bridge.py
  (localhost-only, per-install bearer token in the gitignored
  src/config/extension_bridge.json). The bridge itself only shells out to
  the standard helpers (job_state.py, evaluate_job_fit.py,
  append_state_entry.sh, sync_internship_tracker.py) — the same write
  discipline as the agent and the TUI, so hybrid-mode and agent-mode
  applications dedupe against each other in the same job_key space.
- Extension-recorded outcomes are "applied" (after the user confirms
  they submitted) and "needs_review" (save for later). The applied
  path re-checks can-apply before writing and syncs the tracker
  best-effort, mirroring the agent path.
- ATS selector fixups live in src/extension/src/ats.ts only — one
  reviewable module for all four families (Greenhouse, Lever, Ashby,
  Workday). Web-store distribution is out of scope (load unpacked).

## Internship tracker (Google Sheets) sync
- The Google Sheet internship tracker is a user-facing record of
  successful applications. Sync is one-way (agent → sheet) and
  append-only: each successful application adds exactly one row.
- Sync ONLY outcomes with status "applied". needs_review, failed, and
  skipped_unfit must never be written to the sheet — those are internal
  or review-only outcomes.
- Sync happens exactly once per successful application, and only AFTER
  the applied_jobs.json entry is appended and the internal "applied"
  event is recorded via record-event. Do not sync before those writes
  succeed.
- The sheet is user-facing: the sync payload must contain only the
  current visible tracker fields. Never send internal-only fields
  (job_key, external_job_id, normalized_url, normalized_apply_url,
  ats_system, ats_score, resume_used, location_tier, cover_letter_used,
  reasoning, sources, first_seen_at, last_seen_at, latest_status,
  role_type) to the sheet.
- Invoke the helper with a single JSON payload describing one successful
  application:
  `python3 src/scripts/jobs/sync_internship_tracker.py '<row-json>'`
  The payload carries the visible tracker row fields (JSON keys match
  the helper's accepted payload fields):
    - company (required) — the applied job's company.
    - title (required) — the applied job's title.
    - date_applied (optional) — the actual application date (see
      below). Defaults to today if omitted.
    - internship_term (optional) — derived per the rules below.
    - notes (optional, user-facing only) — a short note for the Notes
      column. Leave blank unless there is something specific worth
      surfacing to the human reader; never put internal reasoning here.
  The helper auto-fills the remaining visible columns (Status, Response
  Received, Date of Response) — do not send those. Source and URL are
  not visible tracker columns and the helper does not read them; do not
  include them in the payload.
- Internship Term population (in priority order):
    1. Use the canonical job record's `internship_term` if it is
       non-empty.
    2. Otherwise, infer a term from the job title and JD text ONLY when
       a clear term is present (e.g. "Summer 2026", "Fall 2026 Intern",
       "Spring Co-op"). Use src/config/targets.json "season_keywords" as
       the reference set of recognizable terms. Do not guess or
       fabricate a term.
    3. Otherwise, leave Internship Term blank.
- Date Applied is the actual application submission date — the
  `date_applied` value written to the applied_jobs.json entry —
  formatted as YYYY-MM-DD (a format Google Sheets recognizes as a
  date). Never use the sync timestamp in place of the real application
  date.
- If the helper reports that sync is disabled or unconfigured (e.g.
  missing credentials or sheet id), or exits non-zero for any reason,
  log a single warning to the session output and continue. The
  application run is still successful — do not treat a disabled,
  unconfigured, or non-zero-exit sync as a failed outcome, and do not
  retry in a loop.
- Out of scope (do not add): reverse sync (sheet → agent), extra machine
  or internal tabs, backfilling Notes or Status into existing rows, or
  any future-phase behavior beyond appending one row per successful
  application.
