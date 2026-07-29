import { execFileSync, spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import { py } from "./platform.js";
import type { AppliedJob } from "./state.js";

/**
 * Every state write goes through the repo's deterministic helpers — the
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
 * Best-effort Google Sheets internship-tracker sync — mirrors the agent
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
    // non-JSON stdout — fall through to the generic failure path
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
 *  human to close the browser — this must stay well short of that, or
 *  every "Open" would hang the caller for however long the review takes. */
const REPLAY_FILL_LAUNCH_GRACE_MS = 5_000;

/**
 * Reopen a needs_review application pre-filled from its saved fill record
 * (src/scripts/runtime/replay_fill.py — see AGENTS.md "Fill records") instead
 * of a bare URL. The script drives a real, visible Chrome and blocks until
 * the human closes it, so this never awaits that: it spawns the process
 * detached (own process group, survives this process exiting) and gives it
 * a short grace window to report a fast failure. If it's still running
 * after that window, it's treated as launched successfully and left to run
 * independently — never killed, never awaited further.
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
      // A fast exit before the grace timer is always a failure path here —
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
      settle({ ok: true, message: "Opened in your browser, pre-filled — review it, then submit yourself." });
      child.unref();
    }, REPLAY_FILL_LAUNCH_GRACE_MS);
  });
}

export interface ConvertResumeResult {
  ok: boolean;
  stem: string;
  mdPath?: string;
  chars?: number;
  error?: string;
}

/** Convert a resume/cover-letter PDF already in data/resumes/ to markdown
 *  via src/scripts/state/convert_resume.py (pypdf text extraction — Python
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
    // non-JSON stdout — fall through to the generic failure path
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

/** Message from a failed helper invocation, trimmed for display. */
export function helperError(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = String((err as { stderr: unknown }).stderr ?? "").trim();
    if (stderr) return stderr.split("\n").slice(-2).join(" ");
  }
  return err instanceof Error ? err.message : String(err);
}
