import { execFileSync, spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { py } from "./platform.js";
import { readSafeField, writeSafeField } from "./settings.js";
import type { AppliedJob } from "./state.js";

/**
 * Every state write goes through the repo's deterministic helpers; the
 * TUI never hand-writes JSON state files. This module is the only place
 * that invokes them.
 */

function run(root: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function appendAppliedJob(root: string, entry: AppliedJob): void {
  const { cmd, args } = py([
    "src/scripts/state/append_state_entry.py",
    "data/applied_jobs.json",
    JSON.stringify(entry),
  ]);
  run(root, cmd, args);
}

export function recordEvent(
  root: string,
  event: {
    job_key: string;
    status: string;
    reasoning?: string;
    company?: string;
    title?: string;
    url?: string;
  },
): void {
  const { cmd, args } = py(["src/scripts/state/job_state.py", "record-event", JSON.stringify(event)]);
  run(root, cmd, args);
}

export interface TrackerSyncResult {
  synced: boolean;
  skipped: boolean;
  message: string;
}

/**
 * Best-effort Google Sheets internship-tracker sync; it mirrors the agent
 * path's post-application step. Sends only the user-facing tracker fields
 * (company, title, date_applied, optional internship_term/notes); internal
 * fields never reach the sheet. Never throws: a disabled/unconfigured or
 * failed sync is returned as a non-synced result so the caller can surface
 * a warning without unwinding an already-recorded application.
 */
export function syncInternshipTracker(
  root: string,
  row: {
    company: string;
    title: string;
    date_applied?: string;
    internship_term?: string;
    notes?: string;
  },
): TrackerSyncResult {
  const sync = py(["src/scripts/jobs/sync_internship_tracker.py", JSON.stringify(row)]);
  const res = spawnSync(sync.cmd, sync.args, {
    cwd: root,
    encoding: "utf8",
  });
  const stdout = (res.stdout ?? "").trim();
  let parsed: { synced?: boolean; skipped?: boolean; reason?: string; error?: string } = {};
  try {
    parsed = stdout ? JSON.parse(stdout) : {};
  } catch {
    // non-JSON stdout; fall through to the generic failure path
  }
  if (res.status === 0) {
    if (parsed.synced) return { synced: true, skipped: false, message: "synced to internship tracker" };
    return { synced: false, skipped: true, message: parsed.reason ?? "tracker sync skipped" };
  }
  return {
    synced: false,
    skipped: false,
    message: `tracker sync failed: ${parsed.error ?? parsed.reason ?? stdout ?? `exit ${res.status}`}`,
  };
}

export interface ValidatorResult {
  ok: boolean;
  output: string;
}

export function runValidator(root: string): ValidatorResult {
  const val = py(["src/scripts/validate/validate_local_config.py"]);
  const res = spawnSync(val.cmd, val.args, {
    cwd: root,
    encoding: "utf8",
  });
  return {
    ok: res.status === 0,
    output: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim(),
  };
}

export function openUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`refusing to open unsupported URL protocol: ${parsed.protocol}`);
  }
  if (process.platform === "win32") {
    // `start` is a cmd.exe builtin, not an executable; the empty "" is the
    // window title so a quoted URL isn't mistaken for one.
    execFileSync("cmd", ["/c", "start", "", parsed.toString()], { stdio: "ignore" });
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  execFileSync(opener, [parsed.toString()], { stdio: "ignore" });
}

/** Open a local directory in the OS file manager (Finder/Explorer/whatever
 *  handles xdg-open on Linux). Creates the directory first if it doesn't
 *  exist yet, so a fresh install's empty data/resumes/ still opens cleanly
 *  instead of erroring. */
export function openPath(target: string): void {
  fs.mkdirSync(target, { recursive: true });
  if (process.platform === "win32") {
    execFileSync("cmd", ["/c", "start", "", target], { stdio: "ignore" });
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  execFileSync(opener, [target], { stdio: "ignore" });
}

export interface ReopenApplicationResult {
  ok: boolean;
  message: string;
}

/** How long to wait for src/scripts/runtime/replay_fill.py to report a fast
 *  failure (bad job_id, no fill record, playwright not installed, the
 *  user's Chrome already running against the profile) before treating the
 *  launch as successful. The script itself then waits indefinitely for the
 *  human to close the browser; this must stay well short of that, or
 *  every "Open" would hang the caller for however long the review takes. */
const REPLAY_FILL_LAUNCH_GRACE_MS = 5_000;

/**
 * Reopen a needs_review application pre-filled from its saved fill record
 * (src/scripts/runtime/replay_fill.py, see AGENTS.md "Fill records") instead
 * of a bare URL. The script drives a real, visible Chrome and blocks until
 * the human closes it, so this never awaits that: it spawns the process
 * detached (own process group, survives this process exiting) and gives it
 * a short grace window to report a fast failure. If it's still running
 * after that window, it's treated as launched successfully and left to run
 * independently, never killed, never awaited further.
 */
export function reopenApplicationFilled(root: string, jobId: string): Promise<ReopenApplicationResult> {
  const { cmd, args } = py(["src/scripts/runtime/replay_fill.py", jobId]);
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const settle = (result: ReopenApplicationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => settle({ ok: false, message: err.message }));
    child.on("exit", (code) => {
      // A fast exit before the grace timer is always a failure path here;
      // the success path never exits on its own within this window (it's
      // still waiting on the human), so exit-before-timer only happens via
      // one of replay_fill.py's die() calls.
      if (!settled) {
        settle({
          ok: false,
          message: (stderr || stdout || `replay_fill.py exited with code ${code}`).trim(),
        });
      }
    });

    const timer = setTimeout(() => {
      settle({ ok: true, message: "Opened in your browser, pre-filled. Review it, then submit yourself." });
      child.unref();
    }, REPLAY_FILL_LAUNCH_GRACE_MS);
  });
}

export interface SingleJobApplyResult {
  ok: boolean;
  message: string;
}

export interface ApproveSubmitResult {
  ok: boolean;
  message: string;
  /** Workday local runtime reports an explicit outcome so the caller can
   *  distinguish a confirmed submit ("submitted") from a progress
   *  checkpoint ("checkpoint") or a failure ("failed"). Other families
   *  leave this undefined; the caller treats presence of "submitted" as
   *  the only signal that a real application was confirmed. */
  outcome?: string;
  confirmationUrl?: string;
  /** Workday-only: the resumable checkpoint file path and the status the
   *  script paused at (awaiting_verification, verified, logged_in,
   *  page_filled, ready_to_submit, submitted, submit_outcome_unclear,
   *  …). Surfaced so the UI can show where the flow paused and the next
   *  continuation can resume from it. */
  checkpointPath?: string;
  checkpointStatus?: string;
  doubtSignals?: string[];
  filledFields?: number;
  resumeAttached?: boolean;
  /** Workday-only: whether the script actually consumed (navigated to /
   *  typed) the verification link/OTP it was passed. The UI uses this to
   *  mark the corresponding inbound_emails row consumed so a one-time
   *  link isn't re-handed to the next continuation run. */
  usedVerificationLink?: boolean;
  usedVerificationOtp?: boolean;
  /** Workday-only: when the runtime detected an MFA/SSO/security-key/push
   *  challenge it cannot safely automate, it checkpoints manual_required
   *  with this short label (totp/push_approval/security_key/sso/
   *  unsupported_mfa). The UI surfaces this as a queue-only awaiting-
   *  verification state, never as a verified/submitted outcome. */
  manualRequired?: string;
}

export interface WorkdayApprovalContext {
  /** Managed mail.aplyx.app alias, the legacy compatibility path. */
  aliasEmail?: string;
  aliasId?: string;
  /** Personal candidate email from a connected/verified Gmail profile or
   *  verification session (docs/workday-personal-inbox-plan.md). Preferred
   *  over aliasEmail when both are present. Never a silent fallback; the
   *  caller only passes this when the email came from an authenticated
   *  source. Exactly one of accountEmail/aliasEmail must be set. */
  accountEmail?: string;
  /** Path to a JSON file {"link":...,"otp":...} holding a one-time
   *  verification secret consumed from a verification session. Keeps the
    *  raw value out of argv/logs. */
  sessionSecretFile?: string;
  /** Short-lived credential handoff file created by the local Tauri app. */
  credentialFile?: string;
}

/** Same launch-grace-window reasoning as REPLAY_FILL_LAUNCH_GRACE_MS above,
 *  just longer: a real run (fit-gate + tailor + apply, a live LLM harness
 *  driving a real browser) routinely takes well over 5s before it's done
 *  anything, so a short grace window would misreport an in-progress launch
 *  as a failure. Failures this is actually meant to catch (bad harness
 *  config, missing targets.json, no python interpreter) surface fast, well
 *  under this. */
const SINGLE_JOB_APPLY_LAUNCH_GRACE_MS = 15_000;

/**
 * Runs the exact same job-application agent a scheduled run does (same
 * harness, same job-scraper.md prompt, same AGENTS.md safety rules: fit
 * gate, exact-match dropdowns, pre-submit verification, doubt signals) for
 * one already-known job (picked from a manual search) instead of the
 * agent's own board search, via the existing APLYX_EXTRA_PROMPT operator-
 * instruction hook (run_job_agent.py already supports this; nothing new
 * on the agent side). APLYX_SESSION_CAP=1 is a code-enforced backstop
 * independent of whether the agent actually honors the "just this one job"
 * instruction; it physically cannot tailor+apply to more than one this
 * run either way.
 *
 * Spawned detached and never awaited to completion, same reasoning as
 * reopenApplicationFilled above: a real run can take minutes. The eventual
 * outcome shows up the normal way: data/applied_jobs.json or
 * review_queue.json (useAplyxState's 60s poll already picks either up) and
 * a Discord notification if configured. If the fit gate rejects the job,
 * that's a skipped_unfit outcome, local-only by design (AGENTS.md), so it
 * produces no visible record anywhere, same as it already doesn't for a
 * scheduled run; the caller's UI copy sets that expectation up front so a
 * silent non-appearance doesn't read as a bug.
 */
export function triggerSingleJobApply(
  root: string,
  job: { company: string; title: string; url: string; source: string },
): Promise<SingleJobApplyResult> {
  const detail = `${job.company} - ${job.title} (${job.url}) [source=${job.source}]`;
  const extraPrompt =
    `Process ONLY this job, skip your own board search entirely: ${detail}. ` +
    "Still run the fit gate, tailoring, and apply phases with every normal " +
    "AGENTS.md safety rule (exact-match dropdowns, pre-submit verification, " +
    "doubt signals). If the fit gate rejects it, report why instead of forcing " +
    "an apply. Stop after this one job.";

  const { cmd, args } = py(["src/scripts/runtime/run_job_agent.py"]);
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        APLYX_SESSION_CAP: "1",
        APLYX_EXTRA_PROMPT: extraPrompt,
      },
    });

    const settle = (result: SingleJobApplyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => settle({ ok: false, message: err.message }));
    child.on("exit", (code) => {
      // A fast exit before the grace timer is always a failure path here;
      // the success path never exits this quickly (fit-gate + tailor +
      // apply always takes longer), so exit-before-timer only happens via
      // a startup error (bad config, missing interpreter, etc.).
      if (!settled) {
        settle({
          ok: false,
          message: (stderr || stdout || `run_job_agent.py exited with code ${code}`).trim(),
        });
      }
    });

    const timer = setTimeout(() => {
      settle({
        ok: true,
        message:
          "Started: aplyx is tailoring and applying to this job now. Check Status or the review queue for the outcome in a bit. If the fit gate ends up rejecting it, that's a local-only skip and nothing will show up, same as any other unfit job.",
      });
      child.unref();
    }, SINGLE_JOB_APPLY_LAUNCH_GRACE_MS);
  });
}

/** Deterministic approve-submit for a ready_to_submit Greenhouse entry.
 *  Replays the saved fill record into a real visible Chrome, attempts the
 *  final submit, and returns a structured success/failure result. Unlike
 *  triggerSingleJobApply, this never re-runs the LLM-driven fit/tailor/apply
 *  pipeline; it is a narrow submit of an already-reviewed, already-filled
 *  form. Greenhouse, Lever, and Ashby are implemented in v1; other families
 *  surface a clear message so the caller never mistakes a missing executor
 *  for success. */
export function approveReadyToSubmit(
  root: string,
  entry: { job_id: string; source?: string; url: string; apply_url?: string; status?: string },
  workday?: WorkdayApprovalContext,
): ApproveSubmitResult {
  const targetUrl = entry.apply_url || entry.url;
  const source = (entry.source ?? "").toLowerCase();
  let host = "";
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    host = "";
  }
  const isGreenhouse = source === "greenhouse" || /(?:^|\.)greenhouse\.io$/i.test(host);
  const isLever = source === "lever" || host.toLowerCase() === "jobs.lever.co";
  const isAshby = source === "ashbyhq" || host.toLowerCase() === "jobs.ashbyhq.com";
  const isWorkday = source === "workday" || host.toLowerCase().endsWith(".myworkdayjobs.com");
  if (!isGreenhouse && !isLever && !isAshby && !isWorkday) {
    return { ok: false, message: "Approve submit is only implemented for Greenhouse, Lever, Ashby, and Workday scaffolding right now." };
  }
  if (
    entry.status !== "ready_to_submit" &&
    !(isWorkday && (entry.status === "needs_review" || entry.status === "awaiting_verification"))
  ) {
    return { ok: false, message: `Approve submit expects a ready_to_submit entry (got ${entry.status ?? "<missing>"}).` };
  }
  const script = isGreenhouse
    ? "src/scripts/runtime/approve_submit_greenhouse.py"
    : isLever
      ? "src/scripts/runtime/approve_submit_lever.py"
      : isAshby
        ? "src/scripts/runtime/approve_submit_ashby.py"
        : "src/scripts/runtime/approve_submit_workday.py";
  const extraArgs = isWorkday
    ? [
        // accountEmail is preferred when supplied; aliasEmail is the
        // managed-alias compatibility path. The runtime enforces that at
        // least one is present and normalizes the effective email.
        ...(workday?.accountEmail ? ["--account-email", workday.accountEmail] : []),
        ...(workday?.aliasEmail ? ["--alias-email", workday.aliasEmail] : []),
        ...(workday?.aliasId ? ["--alias-id", workday.aliasId] : []),
        ...(workday?.sessionSecretFile ? ["--session-secret-file", workday.sessionSecretFile] : []),
        ...(workday?.credentialFile ? ["--credential-file", workday.credentialFile] : []),
        ...(fs.existsSync(path.join(root, "logs/tmp", `resume_${entry.job_id}.pdf`))
          ? ["--resume-pdf", path.join(root, "logs/tmp", `resume_${entry.job_id}.pdf`)]
          : []),
        ...(fs.existsSync(path.join(root, "logs/tmp", `cover_letter_${entry.job_id}.txt`))
          ? ["--cover-letter", path.join(root, "logs/tmp", `cover_letter_${entry.job_id}.txt`)]
          : []),
      ]
    : [];
  const { cmd, args } = py([script, entry.job_id, ...extraArgs]);
  const res = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
  });
  if (res.error) {
    return { ok: false, message: res.error.message };
  }
  const stdout = (res.stdout ?? "").trim();
  const stderr = (res.stderr ?? "").trim();
  let parsed: {
    ok?: boolean;
    message?: string;
    outcome?: string;
    confirmation_url?: string;
    confirmationUrl?: string;
    checkpoint?: string;
    checkpoint_status?: string;
    doubt_signals?: string[];
    filled_fields?: number;
    resume_attached?: boolean;
    used_verification_link?: boolean;
    used_verification_otp?: boolean;
    manual_required?: string;
  } = {};
  try {
    parsed = stdout ? JSON.parse(stdout) : {};
  } catch {
    // fall through to generic error message below
  }
  if (res.status === 0 && parsed.ok) {
    return {
      ok: true,
      message: parsed.message ?? "Submitted successfully.",
      outcome: parsed.outcome,
      confirmationUrl: parsed.confirmation_url ?? parsed.confirmationUrl,
      checkpointPath: parsed.checkpoint,
      checkpointStatus: parsed.checkpoint_status,
      doubtSignals: parsed.doubt_signals,
      filledFields: parsed.filled_fields,
      resumeAttached: parsed.resume_attached,
      usedVerificationLink: parsed.used_verification_link,
      usedVerificationOtp: parsed.used_verification_otp,
      manualRequired: parsed.manual_required,
    };
  }
  return {
    ok: false,
    message: parsed.message ?? (stderr || stdout || `${script.split("/").pop()} exited with code ${res.status}`),
    outcome: parsed.outcome,
    confirmationUrl: parsed.confirmation_url ?? parsed.confirmationUrl,
    checkpointPath: parsed.checkpoint,
    checkpointStatus: parsed.checkpoint_status,
    doubtSignals: parsed.doubt_signals,
    filledFields: parsed.filled_fields,
    resumeAttached: parsed.resume_attached,
    usedVerificationLink: parsed.used_verification_link,
    usedVerificationOtp: parsed.used_verification_otp,
    manualRequired: parsed.manual_required,
  };
}

export interface ConvertResumeResult {
  ok: boolean;
  stem: string;
  mdPath?: string;
  chars?: number;
  error?: string;
}

/** Convert a resume/cover-letter PDF already in data/resumes/ to markdown
 *  via src/scripts/state/convert_resume.py (pypdf text extraction; Python
 *  owns this, not a TS PDF-parsing dependency). Never throws; failures
 *  come back as { ok: false, error }. */
export function convertResumePdf(root: string, stem: string, description = "", force = false): ConvertResumeResult {
  const args = ["src/scripts/state/convert_resume.py", stem];
  if (description) args.push("--description", description);
  if (force) args.push("--force");
  const conv = py(args);
  const res = spawnSync(conv.cmd, conv.args, { cwd: root, encoding: "utf8" });
  const stdout = (res.stdout ?? "").trim();
  let parsed: { ok?: boolean; md_path?: string; chars?: number; error?: string } = {};
  try {
    parsed = stdout ? JSON.parse(stdout) : {};
  } catch {
    // non-JSON stdout; fall through to the generic failure path
  }
  if (res.status === 0 && parsed.ok) {
    return { ok: true, stem, mdPath: parsed.md_path, chars: parsed.chars };
  }
  return {
    ok: false,
    stem,
    error: parsed.error ?? (res.stderr ?? "").trim() ?? `exit ${res.status}`,
  };
}

export interface SetResumeDescriptionResult {
  ok: boolean;
  stem: string;
  description?: string;
  error?: string;
}

/** Set/update a resume's .resume_meta.json description without converting
 *  anything, for a resume that already has its .md (so convertResumePdf's
 *  conversion flow never runs) but still needs a description, either so
 *  resolve_resume.py's dynamic matching can find a non-conventionally-named
 *  cover-letter reference file, or just for a readable label in the
 *  Resumes screen's "import from an existing resume" picker. Requires the
 *  stem to already have a .md or .pdf in data/resumes/, never throws;
 *  failures come back as { ok: false, error }. */
export function setResumeDescription(root: string, stem: string, description: string): SetResumeDescriptionResult {
  const args = ["src/scripts/state/convert_resume.py", stem, "--describe-only", "--description", description];
  const conv = py(args);
  const res = spawnSync(conv.cmd, conv.args, { cwd: root, encoding: "utf8" });
  const stdout = (res.stdout ?? "").trim();
  let parsed: { ok?: boolean; description?: string; error?: string } = {};
  try {
    parsed = stdout ? JSON.parse(stdout) : {};
  } catch {
    // non-JSON stdout; fall through to the generic failure path
  }
  if (res.status === 0 && parsed.ok) {
    return { ok: true, stem, description: parsed.description };
  }
  return {
    ok: false,
    stem,
    error: parsed.error ?? (res.stderr ?? "").trim() ?? `exit ${res.status}`,
  };
}

export interface GraduationSyncResult {
  /** true when safe_fields.graduation_date was changed to match the resume. */
  updated: boolean;
  /** the value read from the resume ("December 2027"), or "" if none. */
  value: string;
  /** "high" | "low" | "none" — only "high" ever triggers an update. */
  confidence: string;
  /** human-readable explanation, for surfacing in the Resumes/Settings UI. */
  note: string;
}

/** Keep safe_fields.graduation_date in step with the candidate's resume.
 *  Called right after the master resume is saved. When the resume parses to
 *  a confident graduation date that differs from what's stored, update the
 *  config so the fit gate, the form-fill, and the Settings screen all agree
 *  with the PDF that actually gets attached. A low-confidence or unreadable
 *  resume date changes nothing and comes back with `updated: false` plus a
 *  note the UI can show ("couldn't read a clear graduation date — set it in
 *  Settings"). Never throws. */
export function syncGraduationFromResume(root: string): GraduationSyncResult {
  const conv = py(["src/scripts/state/resume_graduation.py"]);
  const res = spawnSync(conv.cmd, conv.args, { cwd: root, encoding: "utf8" });
  let parsed: { ok?: boolean; graduation_date?: string; confidence?: string; note?: string } = {};
  try {
    parsed = JSON.parse((res.stdout ?? "").trim() || "{}");
  } catch {
    return { updated: false, value: "", confidence: "none", note: "could not read graduation date from resume" };
  }
  const value = String(parsed.graduation_date ?? "");
  const confidence = String(parsed.confidence ?? "none");
  const note = String(parsed.note ?? "");
  if (confidence !== "high" || !value) {
    return { updated: false, value, confidence, note };
  }
  const current = readSafeField(root, "graduation_date");
  if (current === value) {
    return { updated: false, value, confidence, note: "graduation date already matches the resume" };
  }
  writeSafeField(root, "graduation_date", value);
  return { updated: true, value, confidence, note: `graduation date set to ${value} from your resume` };
}

/** Message from a failed helper invocation, trimmed for display. */
export function helperError(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = String((err as { stderr: unknown }).stderr ?? "").trim();
    if (stderr) return stderr.split("\n").slice(-2).join(" ");
  }
  return err instanceof Error ? err.message : String(err);
}
