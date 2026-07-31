# aplyx — Security Analysis

**Audit type:** Full-repository standing security audit (explicit user request via `/security-audit`), **not** a diff-gated pre-push review. Scope is the entire repository as it exists on `main` at the time of this audit, not a specific changeset. The verdict below should be read as "current state of the repo," not "safe to merge this PR."

**Date:** 2026-07-29 (original audit and remediation both completed in the same working session).
**Auditor discipline:** Every finding below is either (a) a **CONFIRMED** issue with a complete, cited source→sink trace, (b) ruled out as **CLEAN** with the specific code that proves it, or (c) parked as **UNVERIFIED** naming the exact missing piece. Nothing is asserted from assumption.

---

## VERDICT (RE-AUDIT): SHIP — the BLOCKER is fixed; every fix independently verified

The original BLOCKER (spreadsheet formula injection) and all 6 actionable WARNINGS have been fixed and functionally verified (not just read — each fix was exercised against a real malicious/adversarial input and confirmed to behave correctly; each finding below is annotated inline with a **"Implemented"**/**"Verified"** note). Two items remain open by design, not oversight: a dependency WARN with no fully-clean version available yet (react-router, detailed below, residual risk confirmed unreachable), and the curl|bash distribution model's lack of commit pinning (an accepted architectural tradeoff, not a code defect). Neither blocks shipping. The original verdict and full finding text are preserved below for history; each item is annotated `[FIXED ...]` or `[NOT ACTIONED ...]` with its resolution.

```
SCOPE: Full repository audit (~150k LOC across TS/Python/Rust), not diff-based.
  Dependency ecosystems audited: npm (root workspace + browser extension),
  Python (requirements.txt), Rust (Cargo.lock, src-tauri).
  Audit tools run: npm audit --omit=dev (root: 5 findings, all traced below),
  npm audit --omit=dev (extension: 0 findings), pip-audit (0 findings, 25
  packages resolved/scanned), cargo-audit (0 vulnerabilities, 17 unmaintained/
  unsound advisories, all traced below — 482 crates scanned).
  Source-to-sink tracing: browser extension + localhost bridge, Tauri Rust
  IPC backend, Python job-scraping/install/state scripts, Google Sheets sync,
  Discord webhook path, LLM agent prompt-injection surface, PII storage and
  file-permission inventory, git history secrets sweep.

BLOCKERS (1)
[FIXED 2026-07-29] [VULN] src/scripts/jobs/sync_internship_tracker.py:192,208
  Issue: Spreadsheet formula injection (CWE-1236). Scraped, externally-
    controlled job-posting `company`/`title` text is written into the
    user's Google Sheet with valueInputOption defaulting to "USER_ENTERED",
    which Sheets parses as live formulas when a cell value starts with
    =, +, -, or @. A crafted job/company name like
    `=HYPERLINK("http://evil.example/phish","details")` becomes a live,
    clickable formula in the user's own tracker sheet.
  Trace: third-party job-board posting's company/title field (attacker/
    job-poster controlled, anyone can name a company/listing anything) →
    scraped by src/scripts/jobs/fetch_*.py adapters → job-scraper agent
    passes it verbatim as the row payload to
    `python3 src/scripts/jobs/sync_internship_tracker.py '<row-json>'`
    (per src/agents/bodies/job-scraper.md Phase 3 step 10's documented
    contract: "company (required) — the applied job's company. title
    (required) — the applied job's title.") →
    sync_internship_tracker.py:125-147 `build_row()` maps `title`/`company`
    into the row array with only `.strip()`, no leading-character
    neutralization → sync_internship_tracker.py:192 `value_input_option =
    cfg.get("value_input_option", "USER_ENTERED")` (unsafe default) →
    sync_internship_tracker.py:200-209 `body = {"values": [row]}` /
    `.values().append(..., valueInputOption=value_input_option, ...)`.
  Fix: In `build_row()`, prefix any of `title`, `company`, `internship_term`,
    `notes` with a literal apostrophe (`'`) if the first character is in
    `=+-@` (Sheets treats a leading apostrophe as "force text," the
    standard mitigation for this exact class) — apply this unconditionally,
    regardless of `value_input_option`, as defense-in-depth. Additionally,
    change the *default* for `value_input_option` from `"USER_ENTERED"` to
    `"RAW"` (RAW never interprets formulas; a user who explicitly wants
    USER_ENTERED behavior for date/number auto-formatting can still opt
    into it via config, now knowingly).
  **Implemented:** added `_defang_formula()` (sync_internship_tracker.py,
    new `_FORMULA_TRIGGER_CHARS = ("=", "+", "-", "@", "\t", "\r")`
    constant), applied to all four untrusted fields in `build_row()`'s
    return list. **Deviation from the suggested fix, deliberate:**
    `value_input_option` was left defaulting to `"USER_ENTERED"` rather
    than switched to `"RAW"` — the apostrophe-defang is unconditional and
    complete on its own (this is the actual OWASP-documented mitigation
    for CWE-1236, not a supplement to a valueInputOption change), and
    switching to RAW would have cost real functionality: `date_applied`
    would stop being auto-parsed into a native, sortable Sheets date type
    for no additional security benefit, since defanging already neutralizes
    the injection regardless of which valueInputOption is in effect.
    **Verified:** functional test with real malicious payloads —
    `=HYPERLINK("http://evil.example/phish","Click here")`,
    `+cmd|"/c calc"!A1`, `-2+3`, `@SUM(A1:A10)` — confirms each is
    apostrophe-prefixed in the resulting row; a benign payload
    ("Software Engineer Intern" / "Acme Corp") passes through byte-for-byte
    unchanged.

WARNINGS (8)
[FIXED 2026-07-29] [CONFIG] data/resumes/*, src/config/discord_config.json — no file-permission
  hardening is applied to any PII-bearing file except one. Only
  src/config/extension_bridge.json gets an explicit os.chmod 0600
  (extension_bridge.py:138); every other sensitive file — src/config/
  targets.json (full name, address, DOB, phone, gender, ethnicity),
  src/config/discord_config.json (webhook URLs act as bearer credentials),
  data/applied_jobs.json, data/review_queue.json, and critically
  data/resumes/*.pdf|*.md (the most PII-dense files in the app — full
  name, address, phone, complete work/education history) — is created
  with the ambient OS umask default (0644 on this machine, world-readable
  to any other local account). No application-level encryption at rest
  exists anywhere; the only protection is OS file permissions, and that
  protection is applied inconsistently. On a genuinely single-user machine
  this is low real-world risk; on any shared/multi-user machine it's a
  real local information-disclosure gap. Fix: chmod 0600 explicitly
  wherever these files are created/written (convert_resume.py, the
  resume-import path in bridge.ts, append_state_entry.py/.sh, the
  settings.ts writeTargetsJsonFile-style writers).
  **Implemented:** added explicit `chmod`/`os.chmod`/`fs.chmodSync` 0600 at
    every write site found across the whole tree, not just the ones named
    above: `src/core/src/settings.ts` (`writeJson` — the shared choke point
    for targets.json/discord_config.json/env.json — plus
    `ensureTargetsFile`'s template copy), the TUI's own duplicate
    `OnboardingWizard.tsx` writer (same two functions, separately
    implemented), `src/core/src/bridge.ts`'s `importResumeFile` (resume
    PDF copy), `src/scripts/state/convert_resume.py` (the converted `.md`
    and `.resume_meta.json`), `src/scripts/state/append_state_entry.sh`
    (both first-creation via `ensure_file` and the atomic tmp-then-`mv`
    in `append_entry` — applied_jobs.json/review_queue.json),
    `src/scripts/state/job_state.py`'s `save_json_array`/`append_jsonl`/
    `ensure_files` (job_registry.json + the events log — a bonus beyond
    the original finding's exact file list, same helper layer), and two
    installer paths that were the actual root cause of the observed 0644 on
    a fresh install: `src/scripts/install/install.sh`'s targets.json `cp`
    and all three discord_config.json write branches, plus
    `src/scripts/install/update.py`'s one-time `_migrate_live_config`
    (which used `shutil.copy2`, preserving whatever mode the pre-hardening
    file had — now force-chmod'd after the copy so an update from an old
    install doesn't carry the permissive mode forward).
  **Verified:** functional test under a deliberately permissive `umask 022`
    confirms every one of these paths produces a `0600` file on disk —
    tested directly for the bash/Python state writers (append_state_entry.sh,
    job_state.py's save_json_array/append_jsonl) and for the compiled
    TS path (settings.ts's writeJson/ensureTargetsFile via the built
    `dist/settings.js`). `npm run typecheck`/`build` clean on core, TUI,
    and tauri workspaces after the change.
  **Not touched, deliberately:** `install.ps1` (Windows) — NTFS ACLs are a
    different permission model than POSIX chmod bits and weren't part of
    this finding, which was based on `ls -la` observations on macOS;
    Windows installs already inherit per-user-profile ACL isolation by
    default in a typical single-user setup.
[FIXED 2026-07-29] [VULN] src/scripts/runtime/replay_fill.py:116 (resolve_resume_path) — the
  function returns ANY absolute path that exists on disk with no allowlist
  restricting it to data/resumes/. In the intended flow, record_fill.py's
  stored `filled_value` for a resume_upload field is always a bare
  filename per job-scraper.md's own documented convention, and
  record_fill.py performs no content validation on `filled_value` at all
  (record_fill.py:56-78 validates field_name/source/verified, not the
  value). If this value were ever anything other than a bare filename —
  whether through a bug or a successful prompt-injection against the
  orchestrating LLM agent (see the UNVERIFIED prompt-injection item
  below) — this code would upload that arbitrary local file (e.g., an SSH
  key, a tax document) to whatever third-party ATS application form is
  being replayed, with zero validation. Fix: resolve the path, then
  verify it's actually inside the resolved data/resumes/ directory
  (`os.path.commonpath` check) before returning it, regardless of caller
  trust.
  **Implemented:** added `_within_resumes_dir()` — `os.path.realpath` +
    `os.path.commonpath` anchored to `data/resumes/` — applied to all
    three resolution branches (the absolute-path passthrough, the
    basename-in-resumes-dir candidate, and the PROJECT_ROOT-relative
    candidate). **Verified:** functional test confirms `/etc/hosts`
    (a real, existing, out-of-tree file) is now rejected (returns `None`
    — surfaces as "unmatched" to the caller, never uploaded), while both
    a bare resume filename (`base_resume_swe.pdf`) and an absolute in-tree
    path still resolve correctly. `py_compile` clean.
[FIXED 2026-07-29] [DEP] Root workspace — `next@16.2.12` (high, via postcss/sharp CVEs) is
  pulled in ONLY as a `peerDependency` of the `geist` font package
  (src/tauri's font bundle), which the app uses exclusively for static
  woff2 font files via CSS `@font-face` — confirmed the app's source
  never imports `geist`'s JS module or `next` anywhere
  (`grep` across src/tauri, src/tui, src/core returned zero hits).
  Confirmed unreachable: Vite resolves its OWN nested, patched
  `postcss@8.5.21` at build time (verified via `require.resolve`), not
  the vulnerable hoisted `postcss@8.4.31` that `next` pulls in; `sharp`
  is never invoked by anything this app runs. Recorded as WARN (not
  BLOCKER) purely because it's genuinely unreachable dead weight, not
  because the CVEs themselves are minor. Fix: consider replacing `geist`
  with self-hosted font files directly (already partially the pattern
  used for other bundled fonts) to drop this dependency entirely.
  **Implemented (defense-in-depth, since the chain was already confirmed
    unreachable):** rather than removing `geist` (a larger, unrelated
    change), added root `package.json` npm `overrides` forcing
    `postcss@^8.5.25` and `sharp@^0.35.3` tree-wide. `next` itself
    disappears from `npm audit` entirely as a result (its only flagged
    issues were inherited from these two transitive deps); `sharp`'s
    vulnerable copy is actually dropped from the tree altogether rather
    than bumped, since `next`'s dependency on it is optional and couldn't
    be satisfied under the forced version. **Verified:** `npm ci` exits 0
    (CI-safe), and `npm audit` no longer lists `next`, `postcss`, or
    `sharp` at all. One collateral issue surfaced and was fixed in the same
    pass: the fresh dependency reinstall this required flipped
    `@types/react` hoisting (root ended up with the React 19 types tauri
    wants, breaking `ink`'s own type resolution in the TUI workspace —
    TS2786 errors). Fixed with an additional `@types/react`/
    `@types/react-dom` override pinned to `^18.3.x` repo-wide; verified
    tauri's own code has zero dependency on React-19-only types
    (typecheck + build both pass clean on all three workspaces).
[FIXED 2026-07-29 — upgraded major version, residual risk documented below] [DEP] Root workspace — `react-router`/`react-router-dom@6.30.4` (moderate,
  open-redirect + SSR-hydration-constructor-injection CVEs) — this
  package IS actually used (HashRouter, real client-side navigation).
  Confirmed unreachable for the open-redirect class specifically: every
  `navigate(...)` call site in the desktop app (grepped exhaustively) uses
  either a hardcoded literal path or an internally-defined route string
  (HomeScreen.tsx's `to:` values are all literals like "/app/jobs"); the
  app never uses `<Link>` at all (the other named vector); there is no
  code path where user-controlled or external data reaches a navigation
  target. The SSR-hydration CVE is inapplicable outright — this is a
  Tauri client app with no server-side rendering. Still recommend
  upgrading past 7.17.0 as routine hygiene since the package IS in active
  use, even though today's usage pattern doesn't reach the vulnerable
  code paths.
  **Implemented:** upgraded `react-router-dom` 6.30.4 → 7.18.2 (clears the
    open-redirect/SSR-hydration range `>=6.0.0 <7.18.0` entirely). App only
    uses classic declarative routing (`HashRouter`/`Routes`/`Route`/
    `useNavigate`/`useLocation`/`NavLink` — confirmed zero
    `createBrowserRouter`/`RouterProvider`/loader/action usage anywhere),
    which v7 kept API-compatible; **verified** via clean typecheck + build
    on the tauri workspace with no code changes needed.
    **Residual risk, confirmed unreachable, no clean version exists yet:**
    upgrading surfaced a *different* high-severity advisory — "RSC Mode
    CSRF Bypass" (GHSA-qwww-vcr4-c8h2, range `>=7.12.0 <8.3.0`) — which
    only affects React Router's "RSC Mode" (React Server Components /
    data-router framework mode with loaders+actions). This app has zero
    code in that mode (same grep as above), so it's unreachable the same
    way the original open-redirect CVE was. No `react-router-dom` version
    currently clears both this and the original open-redirect range at
    once (react-router 8.x, which would, doesn't exist yet) — `7.18.2` is
    the best available today and is a strict improvement (trades a real,
    if unreachable, CVE for a different, also-unreachable one, while
    actually closing the open-redirect gap).
[NOT ACTIONED — accepted, out of scope for this platform] [DEP] Rust (src-tauri) — 17 RUSTSEC "unmaintained"/"unsound" advisories
  (gtk-rs GTK3 bindings: gdkx11, gtk, gtk-sys, gtk3-macros, plus
  proc-macro-error, 5 unic-* crates, and one real "unsound" advisory on
  `glib` iterator implementations). Confirmed via `cargo tree --target
  aarch64-apple-darwin -i gtk` → "nothing to print": the entire GTK3
  chain is a Linux-only conditional dependency of tao/wry/tauri's
  webkit2gtk backend and is not compiled into the macOS binary at all.
  Relevant to future Linux builds (this repo's install_desktop.sh does
  support Linux .deb/.rpm/AppImage) but not to the artifact actually
  shipped/run on this platform today. cargo-audit itself exited 0 (no
  blocking vulnerabilities, only maintenance-status warnings).
[FIXED 2026-07-29] [VULN] src/scripts/jobs/fetch_eightfold_listings.py:86-92,142,148 — the
  Eightfold ATS adapter's tenant-string validation (`parse_tenant`) only
  requires `"." in parts[0]`, unlike every sibling adapter (Workday
  requires `.myworkday` in the host, Oracle requires `.oraclecloud.com`).
  A tenant string containing a raw IP like `169.254.169.254/x.y` in the
  user's own src/config/targets.json would satisfy this weak check and
  produce a request to that address (SSRF-shaped, though the practical
  severity is low since it requires the user's own config to already be
  attacker-influenced — a much higher bar than a remote/network attacker).
  Fix: anchor the host check the same way the other adapters do (e.g.
  require a `.` not immediately preceded/followed by only digits, or an
  explicit denylist of RFC 1918/link-local ranges).
  **Implemented:** Eightfold genuinely can't suffix-anchor the way
    Workday/Oracle do (its own module docstring documents tenants living
    on arbitrary custom domains with no shared suffix — Microsoft's
    apply.careers.microsoft.com vs. Netflix's explore.jobs.netflix.net).
    Instead, added `_is_safe_host()`: rejects raw IP literals (via
    `ipaddress.ip_address`), bracketed/colon IPv6 forms, `"localhost"`,
    and numeric-shorthand loopback shapes like `"127.1"` (rejected via an
    all-digit-TLD-label check, since some resolvers still expand that to
    127.0.0.1) — an allowlist-shaped check (must look like a real
    multi-label DNS name) rather than a denylist. **Verified:** functional
    test confirms all 3 real tenant formats (Microsoft, Netflix, with/
    without an `https://` prefix) still parse correctly, and 9
    SSRF-shaped payloads (127.0.0.1, the 169.254.169.254 cloud-metadata
    address, localhost, 0.0.0.0, 127.1, `[::1]`, `::1`, a single-label
    host, and a malformed label) are all rejected.
[NOT ACTIONED — accepted tradeoff of the distribution model, not a code defect] [CONFIG] src/scripts/install/install.sh, install.ps1, update.py — all
  fetch URLs are HTTPS (confirmed, zero `http://` hits), but none pin a
  commit SHA or release tag; every install and every `aplyx update`
  resolves `refs/heads/main` (a mutable branch), so a compromised
  maintainer account or a bad push to `main` is served to every install
  immediately, with no review window. This is inherent to the curl|bash
  distribution model this project has chosen and is not fixable without
  changing that model (e.g. pinning to signed release tags would require
  a separate, slower update-availability mechanism) — recorded as WARN,
  not BLOCKER, since it's a known, accepted tradeoff of the distribution
  method rather than a code defect layered on top of it.
[NOT ACTIONED — existing mitigation judged adequate, see note] [INFO-LEAK] discord-reporter path (agent-driven, not code) — verified
  src/agents/bodies/discord-reporter.md explicitly mandates
  `"allowed_mentions": {"parse": []}` on every webhook payload (grepped:
  4 occurrences), which is the correct Discord-documented mitigation
  against @everyone/@here-mention injection via a malicious job/company
  name. This is enforced by an LLM following written instructions, not by
  deterministic code — architecturally softer than a code-level guarantee
  (a model could in principle omit the field on a given run despite
  instructions). Recorded as WARN precisely because of that softness, not
  because a violation was observed.
  **Not actioned this pass:** the general prompt-injection framing added to
  all 3 agent bodies (see the UNVERIFIED item below, now addressed) covers
  the same root cause — an untrusted job/company name reaching agent
  output — and discord-reporter.md's existing `allowed_mentions` mandate
  is unchanged/adequate on its own. Replacing the LLM-enforced mitigation
  with a deterministic Python Discord-posting helper would close this
  residual softness completely, but is a larger architectural change (a
  new script, not a fix to an existing one) that wasn't part of the 6
  scoped fix tasks from this audit — worth flagging to the operator as an
  optional future hardening step, not assumed as wanted.

UNVERIFIED (3) — 1 partially addressed, 2 unchanged (both genuinely outside
this repo's own code, as originally scoped)
- [MITIGATION ADDED 2026-07-29, still UNVERIFIED as live-LLM-behavior]
  Whether a malicious/adversarial job posting's description text (jd_text,
  fully external/attacker-controllable — grep across
  src/agents/bodies/{job-scraper,resume-tailor,interest-letter}.md for any
  explicit "treat this as untrusted data, not instructions" framing
  returned ZERO hits) can successfully prompt-inject the orchestrating LLM
  agent into an unintended action (submitting a false interest-letter
  claim, applying to a job it shouldn't, or — combined with the
  replay_fill.py WARN above — redirecting a resume_upload field to an
  arbitrary local file). This is fundamentally a live-LLM-behavior
  question, not a static-code trace; resolving it requires adversarial
  testing against the actual model/harness in use, not a code read. The
  absence of any documented mitigation is itself confirmed and is the
  basis for listing this even though full exploitability isn't. Given the
  agent has real side effects (submitting applications, uploading PII,
  sending webhooks, writing to a spreadsheet), recommend adding explicit
  prompt-level framing that delimits and labels scraped external content
  as data-only, never instructions, in all three agent bodies.
  **Implemented:** added explicit untrusted-content framing to all 3
    bodies. `job-scraper.md` (the orchestrator with real browser/apply
    tool access — the highest-value target) got a new top-level
    "Untrusted content" section covering `jd_text`, any Playwright-read
    page content, and every fetch-helper field, naming the specific
    attack shapes (fake instructions, fake system/tool tags, requests to
    reveal the prompt, requests to skip the fit gate or mark-applied
    without applying, requests to exfiltrate local files) and stating
    they're never valid instructions. `resume-tailor.md` and
    `interest-letter.md` got equivalent paragraphs scoped to the specific
    fields they receive (`jd_text`; `jd_excerpt` + the free-text
    `question` field, since both are site-controlled). Regenerated all
    derived per-harness files via `generate_agent_definitions.py` (drift
    check now clean) and spot-checked that `.claude`/`.opencode`/`.github`
    outputs all carry the new sections. **What remains genuinely
    unverified, unchanged from the original finding:** this is still
    prompt-level guidance, not a code-enforced boundary — its actual
    resistance to a sufficiently creative adversarial JD is a live-model
    behavior question that static reading (before or after this change)
    cannot settle. The fix closes the "zero mitigation, not even
    documented" gap; it does not (and structurally cannot) convert this
    into a CONFIRMED-clean item.
- Whether the OAuth PKCE deep-link handler (src/tauri/src/lib/
  AuthContext.tsx:150-169, `onOpenUrl` extracting a `code` param and
  calling `exchangeCodeForSession`) is resistant to an authorization-code-
  injection attempt (an attacker sending the victim their own
  `aplyx://auth-callback?code=...` link, hoping the victim's client
  completes the exchange bound to the attacker's session). PKCE was
  designed specifically to prevent this exact attack via a
  server-side code_verifier/code_challenge match, but confirming it holds
  here requires knowing Supabase JS SDK's internal code_verifier storage/
  matching behavior, which is outside this repository's own code.
- [MOOT as of 2026-07-29] Whether `data/resumes/`'s current 0644-on-disk
  permission (observed on this specific development machine) reflects
  what a genuinely fresh install would produce, or is itself an artifact
  of manual intervention on this machine — the umask-default reasoning
  held either way (no code set permissions explicitly). Superseded by the
  permission-hardening fix above: every write path now sets 0600
  explicitly and deterministically regardless of ambient umask or prior
  on-disk state, so the original question (was 0644 the fresh-install
  default?) no longer matters going forward — confirmed via a functional
  test under `umask 022` (the most permissive common default) reproducing
  0600 output on every path.

CLEAN — VERIFIED
- Secrets sweep: full grep suite (AWS/GitHub/OpenAI/Stripe/Slack/Google
  key patterns, private-key headers, hardcoded JWTs, password/secret/
  token literal assignments, embedded-credential connection strings)
  across every .ts/.tsx/.py/.json/.md/.sh/.ps1/.toml/.rs file in the repo
  — zero hits. Cross-checked `git ls-files` for every sensitive live
  config/data filename pattern (targets.json, discord_config.json,
  google_sheets_config.json, service-account-key.json, supabase.json,
  anthropic_key.json, data/*, resumes/) — none are git-tracked; .gitignore
  explicitly enumerates every one. Checked full git history
  (`--diff-filter=A` across all refs) for any of these filenames ever
  having been added and later removed — none found.
- Browser extension + localhost bridge (src/extension/*, src/scripts/
  runtime/extension_bridge.py) — read in full. manifest.json requests
  only `storage` + `http://127.0.0.1/*` (no `<all_urls>`), content script
  matches a closed 5-host allowlist, no `externally_connectable`. Bearer
  token lives only in the background service-worker's chrome.storage.local,
  never reachable from the content-script/page context (verified: content
  script only exchanges structured messages, never touches
  chrome.storage). content.ts's one `innerHTML` use (line 167) is 100%
  static markup with zero interpolated variables — confirmed no DOM-XSS
  sink exists for scraped page text anywhere in the file. Server binds
  127.0.0.1 only; token comparison uses `hmac.compare_digest` (constant-
  time); token generated via `secrets.token_hex(32)` (CSPRNG); no
  Access-Control-Allow-Origin header is ever set (confirmed via grep) —
  combined with the token never being page-accessible, this closes
  cross-origin attack from any other website the user has open; every
  subprocess call uses argv-list form, never shell=True; state-file paths
  are hardcoded, never client-supplied.
- Tauri Rust IPC backend (src/tauri/src-tauri/src/lib.rs, main.rs) — read
  in full. Every subprocess spawn (`run_bridge`, `spawn_search_daemon`)
  uses discrete `Command::arg()` calls, no shell string ever built from
  untrusted data. Confirmed via tauri.conf.json that the webview never
  loads remote/attacker-reachable content (no
  `dangerousRemoteDomainIpcAccess`, frontendDist is the local bundle,
  devUrl is localhost-only) — so frontend-supplied IPC params are
  legitimately trusted UI input, not an external trust boundary. Zero
  `unsafe` blocks in either file. Bridge script path resolution only uses
  the Tauri-managed bundle resource dir or a compile-time-baked dev path
  — never environment-influenced. `node_binary()` resolution has one
  bounded weakness (recorded, not a finding on its own): it only falls
  back to bare-PATH search after checking well-known install dirs, which
  is a real but low-severity local-attacker-only risk (already requires
  code execution on the machine to plant a fake `node` binary).
- Python job-state/install layer (job_state.py, append_state_entry.{py,
  sh}, update.py's tarball overlay, convert_resume.py,
  generate_interest_letter.py, all fetch_*.py adapters except Eightfold)
  — read/traced in full. Tarball path-traversal guard confirmed present
  and correct (normpath + startswith(ROOT + sep) check, update.py:298-301,
  independently re-verified after the tracing subagent's report) and
  symlink members are never materialized (extractfile returns None for
  them). No subprocess/jq calls with unsanitized interpolation anywhere
  in the state-write layer. convert_resume.py's output filename is
  regex-validated (`[A-Za-z0-9_-]+`) against path traversal (though page-
  count/size resource-exhaustion has no guard — noted but judged too low
  severity for a single-user local tool to list as a WARN on its own).
  Anthropic API key is read from env or a gitignored config file, placed
  only in a request header, never logged. Workday/Oracle/Gem/
  SmartRecruiters/Apple/Amazon/Google/Stripe/Simplify adapters all either
  anchor their host validation to the real ATS domain or use hardcoded
  literal hostnames with only path/query segments user-derived.
- Dependency audit ran with real tool output (not skipped) across all 4
  ecosystems present in this repo: npm (root + extension), pip-audit
  (installed for this audit), cargo-audit (installed for this audit).
  Every advisory surfaced was individually checked for reachability
  against the resolved (lockfile) version, not just the advisory's
  affected range — see the WARNINGS section for the specific reasoning
  per package.

RE-AUDIT (COMPLETE, 2026-07-29): the BLOCKER fix was verified — confirmed
`_defang_formula()` is applied to all four row fields (title, company,
internship_term, notes), not just one, via a functional test with real
malicious payloads for every trigger character (=, +, -, @), plus a
benign-payload passthrough check. Every WARNING with an "Implemented" note
above was independently re-verified the same way: functional tests against
real adversarial inputs (not just a read-through), plus a full typecheck +
build sweep across all three npm workspaces (core, TUI, tauri) and a
`npm ci` dry run to confirm the dependency changes don't break CI. The fix
diff itself was swept for new issues (16 files touched, all small/additive,
+172/-17 lines total) — one real regression was caught and fixed during
this sweep: the dependency reinstall required for the npm overrides fix
flipped `@types/react` hoisting order, breaking `ink`'s type resolution in
the TUI workspace; this is now pinned via an additional override and
re-verified clean. `generate_agent_definitions.py --check` and
`validate_local_config.sh` both pass. No new findings surfaced during the
re-audit sweep.
```

---

## Appendix — PII inventory (for the "PII leaks" question specifically)

**Fields collected and stored locally** (`src/config/targets.json`'s `safe_fields`, gitignored): `first_name`, `last_name`, `preferred_name`, `email`, `phone`, `address_line1`, `address_line2`, `zip_code`, `location`, `linkedin_username`/`linkedin_url`, `github_username`/`github_url`, `graduation_date`, `gpa`, `authorized_to_work`, `require_sponsorship`, `citizenship_status`, `currently_enrolled`, `ethnicity`, `hispanic_or_latino`, `date_of_birth`, `gender`. This includes protected-class demographic data (ethnicity, gender, date of birth) alongside standard contact/identity PII.

**Where it goes:**
- **Stored, never transmitted by default:** `data/applied_jobs.json`, `data/review_queue.json`, `data/job_registry.json`, `data/interest_letters.json`, `data/resumes/*` — all local-only, all gitignored, all confirmed absent from git history.
- **Transmitted, opt-in, HTTPS-verified:** Discord webhooks (opt-in; mention-injection mitigated at the prompt level, see WARN above), Google Sheets sync (opt-in; **the one BLOCKER lives here**), Supabase (opt-in "hosted" auth mode; URL is hardcoded HTTPS, `src/core/src/supabaseConfig.ts:26`), Anthropic API (interest-letter drafting; HTTPS, key never logged).
- **Encryption at rest: none, anywhere.** This is a plain-JSON/PDF/Markdown local-first design with no application-level encryption layer — the only protection is OS file permissions. **[FIXED 2026-07-29]** That protection was inconsistently applied (0644/world-readable on `data/resumes/*` and `src/config/discord_config.json`); every write path across the TS core, the TUI's duplicate onboarding writer, the Python state helpers, and both installer scripts now sets 0600 explicitly, verified under a permissive `umask 022`. The absence of an encryption-at-rest layer itself remains a reasonable, stated design tradeoff for the threat model ("your data never leaves your machine" is about not trusting third parties, not about surviving a stolen/shared laptop) — not something this pass added, since that would be a much larger architectural change outside the scope of what this audit's findings called for.
- **Encryption in transit:** every outbound HTTP call found in this repo uses HTTPS (Anthropic, Google Sheets/Sheets scopes, Supabase, Discord, every ATS fetch adapter) — confirmed via a repo-wide grep for hardcoded `http://` URLs, with the only matches being either an inert XML DTD reference in a launchd plist template or defensive scheme-stripping code in three adapters that unconditionally re-prepends `https://` regardless of what a user pasted.
