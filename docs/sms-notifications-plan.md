# SMS via Twilio for aplyx

> **Status: planning only, not started.** This document captures a
> design worked out in conversation; no code has been written against
> it yet. Follow the repo's usual one-phase-at-a-time, explicit-go-ahead
> discipline (docs/PLAN.md §2) before implementing.

## Context

aplyx currently notifies only via Discord (per-job outcomes + a per-run
summary) and applies fully autonomously once the deterministic fit-gate
marks a job `candidate`: no human touches a normal apply. The operator
wants two additions, both opt-in and off by default so a normal run is
unaffected until configured:

1. **Mirror every existing Discord notification to SMS** (applied,
   needs_review, failed, summary).
2. **A new "confirm before apply" gate**: once candidates are found for
   the run, text a digest ("Found N jobs today: ... reply YES to apply,
   NO to skip") and hold the actual submit until the user replies.

Two hard constraints, settled during design discussion:
- **Universal, not Apple-only**: ruled out iMessage; Twilio (or
  equivalent) is required since aplyx is installed by many users on any
  OS.
- **No new server**: the scheduler runs the agent as a short-lived
  process every 30 min (launchd `StartInterval`, confirmed in
  `scheduler.py`/`run_job_agent.py`); there is no persistent process to
  hold a webhook open. So inbound replies are **polled** from Twilio's
  Messages API on each scheduled run, not pushed via webhook. A reply is
  therefore acted on within ~30 min, never instantly: accepted
  trade-off in exchange for zero new hosted infrastructure.
- **Bring-your-own-Twilio-account per user**: mirrors the existing
  per-user Discord-webhook model exactly (each user's own webhook/own
  Twilio number in their own gitignored config), not one aplyx-owned
  number relaying for every installer (that would need a permanently-running
  central service, cost borne by the maintainer, and real risk of the
  shared number being flagged for bulk-messaging).

The repo already solves "park a job across scheduler runs, wait for an
async human answer, resume later" for the motivation-essay case:
`src/scripts/state/interest_letter.py` + its `@interest-letter` agent
registration. Confirmed by direct read (interest_letter.py:1-251): parks
outside the `job_registry`/`can-apply` system entirely (parking is *not*
`needs_review`, since `needs_review` is a permanent block and parking must
stay retryable), atomic writes (temp file + `os.replace`), stdlib-only,
`0`/`2` exit-code contract for yes/no questions. This plan reuses that
exact shape for the SMS confirm-gate rather than inventing a new
mechanism.

## Recommended approach

### 1. New deterministic helper: `src/scripts/state/sms_confirm.py`

Same stdlib-only, atomic-write style as `interest_letter.py`. Owns
`data/sms_confirmations.json` (one non-terminal batch at a time) and is
the only place that talks to Twilio's REST API directly — plain
`urllib.request` with HTTP Basic Auth (`account_sid:auth_token`), no
`twilio` SDK dependency:

- **Send**: `POST /2010-04-01/Accounts/{sid}/Messages.json` (`From`,
  `To`, `Body`).
- **Poll**: `GET /2010-04-01/Accounts/{sid}/Messages.json?To={from_number}`,
  filtered client-side to inbound messages from `to_number` newer than
  the batch's `sent_at`.

Batch record schema (array in `data/sms_confirmations.json`):
```json
{
  "batch_id": "sms:2026-08-16T18:00:03Z",
  "status": "collecting | awaiting_reply | confirmed | declined | expired",
  "created_at": "", "sent_at": "", "expires_at": "", "resolved_at": "",
  "message_sid": "", "reply_message_sid": "", "reply_body": "",
  "unmatched_replies": [{"sid": "", "body": "", "received_at": ""}],
  "jobs": [
    {"job_key": "", "company": "", "title": "", "url": "", "apply_url": "",
     "source": "", "role_type": "", "location_tier": "", "resume_used": "",
     "ats_score": 0, "cover_letter_used": true, "tailored_bullets": [],
     "missing_keywords": [], "fill_record_path": "",
     "finalized": false, "outcome": ""}
  ]
}
```
Each job entry carries everything a later `needs_review`
`applied_jobs.json` write needs (captured once at park time), so a
declined/expired resolution can write that outcome without redoing the
browser fill — mirroring why `interest_letter.py`'s `request` payload
carries `jd_excerpt`/`question`.

CLI subcommands (mirroring `interest_letter.py`'s naming/exit-code style):
- `ensure-file` — bootstrap/validate, called from the pre-harness block.
- `park '<job-json>'` — idempotent append to the current `collecting`
  batch (creates one if none non-terminal exists); a job reaching the
  gate while a batch is already `awaiting_reply` joins the *next* batch
  rather than mutating an already-sent digest.
- `pending` — JSONL of job_keys in a `collecting`/`awaiting_reply` batch
  (new Phase 2 skip-set, same role as `interest_letter.py pending`).
- `resolved-non-confirmed` — JSONL of job_keys whose batch is
  `declined`/`expired` and not yet `finalized` (new Phase 2 resolve-set).
- `is-confirmed <job_key>` — **exit 0 confirmed / exit 2 otherwise**,
  same contract as `interest_letter.py approved-text` / `job_state.py
  can-apply`.
- `finalize <job_key> <outcome>` — marks the job entry finalized; once
  every job in a terminal batch is finalized, prune the batch.
- `close-and-send-digest` — if the `collecting` batch has ≥1 job,
  compose and send the digest, transition to `awaiting_reply`, stamp
  `sent_at`/`expires_at = sent_at + reply_timeout_hours`. No-op
  otherwise.
- `poll-replies` — fetch inbound messages since `sent_at`; match
  YES/NO by a permissive prefix test on the trimmed, lowercased body
  (`y...` → confirmed, `n...` → declined); anything else is logged to
  `unmatched_replies` and left `awaiting_reply` — **never guessed at**.
  Also expires the batch if `now > expires_at`, independent of whether a
  new message arrived.
- All subcommands honor `APLYX_SMS_DRY_RUN=1`: skip the real Twilio
  calls, print what would have been sent/fetched — the offline test path
  (see Verification).

### 2. Config: `src/config/sms_config.example.json` (committed) /
`sms_config.json` (gitignored)

```json
{
  "enabled": true,
  "account_sid": "REPLACE_ME",
  "auth_token": "REPLACE_ME",
  "from_number": "REPLACE_ME",
  "to_number": "REPLACE_ME",
  "notify": { "applied": true, "needs_review": true, "failed": true, "summary": true },
  "confirm_before_apply": { "enabled": false, "reply_timeout_hours": 24 }
}
```
`account_sid`/`auth_token`/`from_number`/`to_number` are per-user
(BYO-Twilio), E.164 numbers. `to_number` is the user's own cell — the
number they text back from, so `poll-replies`' inbound filter is correct
by construction.

**Naming note:** existing Discord code has a real inconsistency —
`bridge.ts` (readDiscordConfig/writeDiscordConfig return/args) uses key
`applied` for the same route `discord_config.json`/`discord-reporter.md`/
`SettingsScreen.tsx` call `success`. The new SMS schema uses **`applied`
everywhere** (JSON key, `sms-reporter.md`'s route table, every TS layer)
— matching `job_state.py`'s own `ALLOWED_STATUSES` vocabulary — and does
not replicate that inconsistency.

### 3. Confirm-gate state machine (job-scraper.md changes)

Confirmed placement: the gate sits **between Phase 3 step 6a (persist
fill record, job-scraper.md:737-745) and step 7 (Submit, line 746)** —
same slot as the existing motivation-essay park at step 3
(lines 641-666), after the form is fully filled/verified, withholding
only the final submit click. This means a parked job has already paid
for a real browser fill; accepted cost of this placement (submitting a
half-filled form isn't reviewable, so the gate can't sit earlier without
losing the pre-submit verification step's value).

**New Phase 2 step 0b** (parallel to existing step 0a for
`interest_letter.py pending`, after line 511), only when
`confirm_before_apply.enabled`:
- `sms_confirm.py pending` → skip these job_keys this run entirely (no
  tailor, no apply, no record) — same treatment as 0a.
- `sms_confirm.py resolved-non-confirmed` → for each, write the
  needs_review outcome directly from the stored batch entry (no
  browser/re-tailor): `applied_jobs.json` + `review_queue.json` entry
  using the stored fields, `record-event(needs_review)`, then
  `sms_confirm.py finalize <job_key> needs_review`, then the standard
  `@discord-reporter`/`@sms-reporter` needs_review invocation. Reasoning:
  `"user declined via SMS reply"` or `"no SMS reply within <N>h"`.

**New Phase 3 step 6b**, right after step 6a:
```
python3 src/scripts/state/sms_confirm.py is-confirmed '<job_key>'
```
- exit 0 → proceed to step 7 exactly as today; after step 9's
  `record-event`, also call `sms_confirm.py finalize '<job_key>' '<status>'`.
- exit 2 → do not submit. Call `sms_confirm.py park '<job-json>'` with
  the full needs_review-shaped payload. Print `[parked] <title> @
  <company> — awaiting SMS confirmation`. **Record nothing** (no
  `applied_jobs.json`, no `record-event`, no notification) — same
  reasoning as `interest_letter.py`'s park: recording anything sets a
  blocking status and `can-apply` would refuse the job_key forever.
- Defensive guard: if `source == "workday"` reaches step 6b (it
  shouldn't — Workday is diverted at Phase 2 step 0), route to
  needs_review with `doubt_signals: ["workday_review_only"]` instead of
  gating. Costs nothing, directly protects the "Workday has no
  auto-apply path" invariant.

**New Phase 4 step**, alongside the existing summary invocation:
```
python3 src/scripts/state/sms_confirm.py close-and-send-digest
```
No-op if nothing was newly parked or a batch is already
`awaiting_reply`. Digest composition must happen here, not per-job in
the Phase 3 loop, because the loop doesn't know the batch's final size
until every job in the run has been attempted.

**Pre-harness** (`run_job_agent.py`, alongside the existing
`interest_letter.py ensure-file` call in `_run()`'s pre-harness block):
```python
py_run([..., "sms_confirm.py", "ensure-file"])   # warn-only
py_run([..., "sms_confirm.py", "poll-replies"])  # warn-only — a missed poll just retries next tick
```
Both non-fatal — a run must never abort because Twilio is unreachable.

**Two new doubt-signals** (AGENTS.md "Doubt signals" section):
`user_declined_sms`, `sms_confirmation_expired`.

**Timeout default: 24 hours** (`confirm_before_apply.reply_timeout_hours`)
— long enough to survive a workday/overnight, short enough that a
posting isn't held in limbo for days. On expiry, same needs_review write
path as an explicit NO.

**`can-apply`/`record-event` are untouched** — parked jobs never call
`record-event`, so `job_state.py`'s `ALLOWED_STATUSES`/
`BLOCKING_STATUSES` need zero changes, exactly like `interest_letter.py`.

**Two invariants to explicitly re-verify once wired** (flagged risk, not
a known bug): the existing 25-per-run cap must still hold even if a
reply confirms more than 25 parked jobs at once (only up to 25 should
finalize in one run, the rest wait for a later run); and Workday's
review-only path must remain the only path for Workday jobs (the
defensive guard above is the safety net, but confirm this doesn't open a
second one).

**Concurrency**: `run_job_agent.py` already holds a single-flight
`mkdir`-based lock around the entire run, so two scheduler ticks never
run concurrently — no new locking needed beyond `sms_confirm.py`'s own
atomic read-modify-write.

### 4. New subagent: `src/agents/bodies/sms-reporter.md`

Structurally identical to `discord-reporter.md`: reads
`src/config/sms_config.json`; missing file or `enabled:false` → log one
line, continue (never abort the run); Basic-Auth curl POST to Twilio's
Messages endpoint instead of a Discord webhook; plain-text `Body` (no
embeds); one template per route (applied/needs_review/failed/summary),
gated per-route by `notify.<route>`; truncate reasoning text harder than
Discord's embed limit (~140 chars, leaving room for the outcome prefix,
since an SMS segment is ~160 GSM-7 chars).

Four new frontmatter files, mirroring `discord-reporter`'s /
`interest-letter`'s registration exactly:
`src/agents/frontmatter/{opencode,claude,copilot}/sms-reporter.yaml`,
`src/agents/frontmatter/codex/sms-reporter.toml`. Agent names are
auto-discovered from `src/agents/bodies/*.md` — no registry list to
edit. After adding these, run
`python3 src/scripts/validate/generate_agent_definitions.py` (no
`--check`) to emit the generated `.claude/agents/sms-reporter.md` etc. —
never hand-edit those.

**job-scraper.md wiring for notifications**: everywhere `@discord-reporter`
is invoked today (Phase 3 step 10, lines 798-807; Phase 4 step 1, lines
811-816), add a parallel `@sms-reporter` invocation with the identical
outcome payload, independently gated on `sms_config.json`'s
`notify.<route>` (so SMS and Discord can be on/off independently).

**AGENTS.md updates**: add `@sms-reporter` to the harness capability
matrix (~line 265) and the "no subagent registry" degraded-path list
(~line 295), matching exactly how `@interest-letter` was added there.

### 5. Settings/config UI (mirrors Discord's pattern, file by file)

- `src/core/src/settings.ts` — new block after the Discord functions
  (~line 175): `smsPath`, `readSmsEnabled`/`writeSmsEnabled`,
  `readSmsField`/`writeSmsField` (account_sid/auth_token/from_number/
  to_number), `readSmsNotifyRoute`/`writeSmsNotifyRoute` (booleans, not
  URLs), `readSmsConfirmEnabled`/`writeSmsConfirmEnabled`,
  `readSmsReplyTimeoutHours`/`writeSmsReplyTimeoutHours`.
- `src/core/src/bridge.ts` — new `readSmsConfig`/`writeSmsConfig` cases
  (~line 204), returning the shape from §2, using `applied` (not
  `success`) consistently.
- `src/tauri/src-tauri/src/lib.rs` — new `read_sms_config`/
  `write_sms_config` Tauri commands (~line 541-552), pure passthrough
  like Discord's; register in the invoke handler list (~line 729-730).
- `src/tui/src/ui/SettingsScreen.tsx` — new "SMS notifications" section
  after "Discord webhooks" (~line 221-231); extend the `Field.kind`
  union (~line 89-90) with `"sms-enabled"`/`"sms-field"`; update
  `currentValue()`, `isPlainTextField()`, the write path, and the
  toggle handler at their respective Discord-mirroring locations.
- `src/tauri/src/routes/onboarding/local/` — add a sibling `SmsStep.tsx`
  (SMS needs 4 credential fields + a distinct confirm-gate concept, not
  a fit for the Discord `ROUTES`-array shape): enable toggle, 4
  credential inputs, 4 notify toggles, confirm-gate toggle + timeout
  field. Locate wherever the onboarding wizard sequence is assembled and
  insert this step (not yet pinned down — first concrete step of
  implementation).

### 6. Validation: both `validate_local_config.py` and `.sh`

New block mirroring the Discord block exactly: existence/enabled check;
field checks — `account_sid` (`^AC[0-9a-fA-F]{32}$`), `auth_token`
(`^[0-9a-fA-F]{32}$`), `from_number`/`to_number` (E.164,
`^\+[1-9]\d{7,14}$`), `REPLACE_ME` placeholder rejection; warn (not
fail) if `confirm_before_apply.enabled` is true while `enabled` is false
(inert combination — gate would park forever with no digest ever sent);
warn if `reply_timeout_hours` isn't a positive number.

### 7. `.gitignore` — two explicit new lines (no wildcards exist to rely on)
```
/src/config/sms_config.json
/data/sms_confirmations.json
```
`sms_config.example.json` stays committed, like `discord_config.example.json`.

### 8. `docs/SETUP.md`

New subsection paralleling the existing "Discord is optional" text:
BYO-Twilio-account steps, the confirm-gate opt-in, and the caveats
below.

## Risks worth flagging up front (not blockers, but real)

- **A2P 10DLC / carrier filtering**: an unregistered/trial Twilio number
  texting US mobiles can be silently filtered or delayed by carriers —
  a Twilio account-provisioning issue each user hits independently, not
  an aplyx bug. Document "check Twilio Console → Messaging → Errors" in
  SETUP.md.
- **STOP keyword**: Twilio auto-intercepts a reply of "STOP" for
  opt-out compliance — it never reaches aplyx, and it unsubscribes the
  user from *all* future texts from that number until they text START.
  Put a one-line warning in the digest itself: "reply YES or NO — do not
  reply STOP unless you want to unsubscribe from all future texts."
- **Cost**: ~$1-2/month per user (Twilio number + per-segment SMS),
  ongoing, BYO — call this out once in SETUP.md.
- **Reply parsing is all-or-nothing in v1**: no per-job selection
  ("apply to the Google one only") — an ambiguous reply is logged
  unmatched, never guessed at. Known v1 limitation.
- **Wasted browser fill**: a job reaching the gate has already been
  fully filled before the park; if later declined/expired, that fill
  work is thrown away. Accepted cost of the specified gate placement
  (after pre-submit verification, not before the browser opens).

## Verification plan

No test framework exists in this repo (no pytest, no test_*.py) —
verification is manual/scripted CLI invocation, same as how
`interest_letter.py` itself would be checked:

1. **Offline state-machine test** (no network, no cost): hand-construct
   a `data/sms_confirmations.json` fixture, drive every `sms_confirm.py`
   subcommand directly, check exit codes and resulting file contents.
2. **Dry-run mode**: `APLYX_SMS_DRY_RUN=1` end-to-end
   (`bash src/scripts/runtime/run_job_agent.sh`), inspecting composed
   digest/outcome text before any real Twilio credential exists. Add a
   test-only `sms_confirm.py simulate-reply <YES|NO>` gated behind
   `APLYX_SMS_ALLOW_SIMULATE=1` to drive confirmed/declined transitions
   offline and verify the Phase 2 step 0b write path.
3. **Real Twilio trial-account smoke test** (notifications only, gate
   still off): free trial account, verified recipient, trigger each
   `sms-reporter` route once with fake data, confirm all four texts
   arrive correctly formatted.
4. **Real end-to-end confirm-gate test** (only after 1-3 pass): enable
   the gate, park a real/throwaway candidate, reply YES, confirm the
   next scheduled tick submits it; separately test NO; separately
   shrink `reply_timeout_hours` temporarily to observe the expire path,
   then restore the default.
5. **Validation coverage**: run both validate_local_config scripts
   across sms_config absent / present-disabled / present-enabled-bad-SID
   / present-enabled-valid, confirm pass/warn/fail parity with Discord's
   own coverage.
6. **Drift check**: `generate_agent_definitions.py --check` fails
   before the frontmatter files exist, passes after regeneration.
7. **Invariant re-check**: confirm the 25-per-run cap and Workday's
   no-auto-apply rule both still hold with the gate enabled — the one
   place a subtle regression could reintroduce an auto-apply bypass.

## Critical files
- `src/scripts/state/sms_confirm.py` (new)
- `src/config/sms_config.example.json` (new)
- `src/agents/bodies/job-scraper.md` (Phase 2 step 0b, Phase 3 steps 6b
  + finalize + notification, Phase 4 digest)
- `src/agents/bodies/sms-reporter.md` (new) + 4 frontmatter files (new)
- `src/scripts/runtime/run_job_agent.py` (pre-harness ensure-file/poll)
- `src/core/src/settings.ts`, `src/core/src/bridge.ts`,
  `src/tauri/src-tauri/src/lib.rs`, `src/tui/src/ui/SettingsScreen.tsx`,
  new `src/tauri/src/routes/onboarding/local/SmsStep.tsx`
- `src/scripts/validate/validate_local_config.py` + `.sh`
- `AGENTS.md` (subagent registry, doubt signals), `docs/SETUP.md`
- `.gitignore`
