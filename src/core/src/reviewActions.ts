import { loadState } from "./state.js";
import { registryByJobId, hasAppliedOrFailed, isDismissed, todayIso } from "./stateDerive.js";
import type { QueueEntry, AppliedJob } from "./stateDerive.js";
import { appendAppliedJob, recordEvent, syncInternshipTracker } from "./helpers.js";

/**
 * Review-queue triage actions shared by the TUI's ReviewScreen and the
 * desktop app's bridge — the queue file is append-only, so triage records
 * outcomes through the same helpers every other write path uses and derives
 * "resolved" (see stateDerive.ts) instead of deleting entries.
 */

export interface QueueActionResult {
  message: string;
}

/** Throws on missing registry linkage or missing required fields — callers
 *  surface the message, they never fabricate the missing values. */
export function markQueueEntryApplied(root: string, entry: QueueEntry): QueueActionResult {
  const state = loadState(root);
  const reg = registryByJobId(state.registry, entry.job_id);
  if (!reg?.job_key) {
    throw new Error(
      `Cannot mark applied: no registry record / job_key for "${entry.company} — ${entry.title}" (job_id=${entry.job_id}). Canonicalize the job first.`,
    );
  }
  const missing: string[] = [];
  if (!entry.job_id) missing.push("job_id");
  if (!entry.company) missing.push("company");
  if (!entry.title) missing.push("title");
  if (!entry.url) missing.push("url");
  if (!entry.role_type) missing.push("role_type");
  if (!entry.source) missing.push("source");
  if (!entry.resume_used) missing.push("resume_used");
  if (typeof entry.ats_score !== "number") missing.push("ats_score");
  if (!entry.location_tier) missing.push("location_tier");
  if (missing.length > 0) {
    throw new Error(
      `Cannot mark applied: missing required field(s) ${missing.join(", ")} for "${entry.company ?? entry.job_id}". Refusing to fabricate values.`,
    );
  }
  const reasoning = "Marked applied manually via review-queue triage";
  const record: AppliedJob = {
    job_id: entry.job_id,
    company: entry.company,
    title: entry.title,
    url: entry.url,
    date_applied: todayIso(),
    status: "applied",
    role_type: entry.role_type,
    source: entry.source,
    resume_used: entry.resume_used,
    ats_score: entry.ats_score,
    location_tier: entry.location_tier,
    cover_letter_used: entry.cover_letter_used ?? false,
    reasoning,
  };
  // Append the applied_jobs entry first — it is the dedup set the agent
  // reads before every run, so it must be durable even if the event write
  // that follows fails. A missing event is recoverable; a missing
  // applied_jobs entry risks re-applying to the same job.
  appendAppliedJob(root, record);
  recordEvent(root, {
    job_key: reg.job_key,
    status: "applied",
    reasoning,
    company: entry.company,
    title: entry.title,
    url: entry.url,
  });
  // Best-effort Sheets sync — mirrors the agent path. Only the user-facing
  // tracker fields are sent; internal-only fields stay local. A disabled/
  // unconfigured/failed sync is a warning, not an error: the application is
  // already recorded above and must stand regardless.
  const sync = syncInternshipTracker(root, {
    company: entry.company,
    title: entry.title,
    date_applied: record.date_applied,
    internship_term: reg.internship_term,
  });
  const base = `Recorded applied: ${entry.company} — ${entry.title}`;
  return { message: sync.synced ? `${base} (synced to tracker)` : `${base} — ${sync.message}` };
}

/** Never throws — every failure mode (already resolved, already dismissed,
 *  no registry record) comes back as a message the caller displays. */
export function dismissQueueEntry(root: string, entry: QueueEntry): QueueActionResult {
  const fresh = loadState(root);
  if (hasAppliedOrFailed(fresh, entry)) {
    return {
      message: `Cannot dismiss: "${entry.company} — ${entry.title}" already has an applied/failed outcome; dismiss would overwrite it with skipped_unfit.`,
    };
  }
  if (isDismissed(fresh, entry)) {
    return { message: `Already dismissed: "${entry.company} — ${entry.title}" is already marked skipped_unfit.` };
  }
  const reg = registryByJobId(fresh.registry, entry.job_id);
  if (!reg?.job_key) {
    return { message: "Cannot dismiss: no registry record for this job (no job_key to record against)." };
  }
  recordEvent(root, {
    job_key: reg.job_key,
    status: "skipped_unfit",
    reasoning: "Dismissed by operator in review-queue triage",
    company: entry.company,
    title: entry.title,
    url: entry.url,
  });
  return { message: `Dismissed: ${entry.company} — ${entry.title}` };
}
