import fs from "node:fs";
import path from "node:path";
import { logDir } from "./settings.js";
import { pidAlive } from "./platform.js";
import type { AppliedJob, QueueEntry, RegistryRecord, AplyxState, Heartbeat, ApplyRunSummary, ApplyRunStatus } from "./stateDerive.js";

// Re-exported for existing importers (the TUI, the desktop bridge), the
// actual definitions live in stateDerive.ts, which has no fs import so the
// desktop webview can use the pure derivations directly against a AplyxState
// it already loaded, without pulling in this module's fs-based readers too.
export type { AppliedJob, QueueEntry, RegistryRecord, AplyxState, Heartbeat, ApplyRunSummary, ApplyRunStatus } from "./stateDerive.js";
export { todayIso, registryByJobId, isResolved, hasAppliedOrFailed, isDismissed } from "./stateDerive.js";

function readJsonArray<T>(file: string): T[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// Inbox status detection (outcome_status/outcome_updated_at/outcome_source
// on AppliedJob; see stateDerive.ts's own doc comment on that field) is
// hosted-only (2026-08-19, matches docs/website.md's pricing page, which
// already lists it as a Pro-tier feature): email-tracking-worker
// (src/supabase/functions/) writes those columns directly onto the hosted
// applied_jobs row, guarded by a DB trigger (migration
// 0007_hosted_email_tracking.sql), so SupabaseAdapter's loadState() just
// reads them off the row: no local derivation step. Local installs have
// no equivalent: a local AppliedJob's outcome_status is always undefined,
// which StatusScreen.tsx already renders as the plain "Applied" badge.

export function loadState(root: string): AplyxState {
  return {
    applied: readJsonArray<AppliedJob>(path.join(root, "data", "applied_jobs.json")),
    queue: readJsonArray<QueueEntry>(path.join(root, "data", "review_queue.json")),
    registry: readJsonArray<RegistryRecord>(path.join(root, "data", "job_registry.json")),
  };
}

/** The user's first name from src/config/targets.json safe_fields, undefined
 *  until setup has filled it in (placeholders don't count). Read-only:
 *  config writes stay with the wizard/installer. */
export function userFirstName(root: string): string | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(root, "src", "config", "targets.json"), "utf8"),
    ) as { safe_fields?: { first_name?: string } };
    const name = (parsed.safe_fields?.first_name ?? "").trim();
    return name && name.toUpperCase() !== "REPLACE_ME" ? name : undefined;
  } catch {
    return undefined;
  }
}

export function readHeartbeat(root: string): Heartbeat | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(logDir(root), "heartbeat.json"), "utf8"),
    ) as Heartbeat;
  } catch {
    return undefined;
  }
}

export function lastRunLine(root: string): string {
  try {
    const log = fs.readFileSync(path.join(logDir(root), "run_job_agent.log"), "utf8");
    const lines = log.trim().split("\n");
    return lines[lines.length - 1] ?? "";
  } catch {
    return "(no runs recorded yet)";
  }
}

export function latestSessionLog(root: string): string | undefined {
  try {
    const dir = logDir(root);
    const sessions = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("session_") && f.endsWith(".log"))
      .sort();
    const last = sessions[sessions.length - 1];
    return last ? path.join(dir, last) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * PID of the run currently holding the runner's single-flight lock, or
 * undefined when nothing is in flight. `src/scripts/runtime/run_job_agent.py`
 * writes this file when it acquires the lock; reading it is the only way
 * the TUI can see (and stop) a run it did not spawn itself: a scheduler
 * tick, or a run left alive after the user quit the TUI with `q`.
 *
 * A pid file whose process is gone means a crashed run left the lock
 * behind (the runner self-heals this on its next attempt), so it is
 * reported as "no run in flight" rather than a stoppable PID.
 */
export function activeRunPid(root: string): number | undefined {
  try {
    const raw = fs.readFileSync(
      path.join(logDir(root), ".run_job_agent.lock", "pid"),
      "utf8",
    );
    const pid = Number.parseInt(raw.trim(), 10);
    return pidAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}
