/**
 * Pure, fs-free state shapes and derivations — split out of state.ts so the
 * desktop app's webview (which can't import node:fs) can use them directly
 * against a AplyxState it already loaded via the bridge, without pulling in
 * the fs-based readers too (same reason hostedFields.ts was split from
 * profile.ts). state.ts re-exports everything here for the TUI/Node side.
 */

export interface AppliedJob {
  job_id: string;
  company: string;
  title: string;
  url: string;
  apply_url?: string;
  date_applied: string;
  status: "applied" | "failed" | "needs_review";
  role_type?: string;
  source?: string;
  /** Free text — @resume-tailor's own short label for this application's
   *  tailoring emphasis (e.g. "backend + infra focus"), not a fixed
   *  category. "n/a" for a pre-tailoring needs_review where
   *  @resume-tailor never ran. "hosted" in hosted mode. */
  resume_used?: string;
  ats_score?: number;
  location_tier?: string;
  cover_letter_used?: boolean;
  reasoning?: string;
  /** The actual tailored resume bullets resume-tailor produced for this
   *  posting — previously computed and handed to the live form-fill, then
   *  discarded; now persisted so it can be reviewed/reused. */
  tailored_bullets?: string[];
  /** The actual tailored cover letter body, same persistence rationale as
   *  tailored_bullets — was pasted straight into the ATS form and never
   *  written to disk before. */
  cover_letter?: string;
  /** ATS keywords resume-tailor flagged as missing from the tailored
   *  resume — review context, not a blocker. */
  missing_keywords?: string[];
  /** Canonical doubt-signal vocabulary (see AGENTS.md "Doubt signals") that
   *  triggered a needs_review outcome — e.g. "ambiguous_dropdown",
   *  "verification_mismatch". Normally empty/absent for applied/failed. */
  doubt_signals?: string[];
  /** Path to the data/fill_records/<job_id>.json record written by
   *  src/scripts/state/record_fill.py — the durable, field-by-field snapshot of
   *  what was actually typed/attached. Absent when no field was ever filled
   *  for this job (e.g. Workday, or a pre-tailoring reject). Local-mode
   *  only — a hosted row can't point at a path on someone's laptop, see
   *  fill_record below. */
  fill_record_path?: string;
  /** Hosted-mode counterpart to fill_record_path: the fill record's actual
   *  CONTENT (same shape record_fill.py writes to
   *  data/fill_records/<job_id>.json — {job_id, recorded_at, fields}),
   *  not a filesystem path. Populated by SupabaseAdapter, never by
   *  LocalAdapter (which keeps using fill_record_path). */
  fill_record?: FillRecord;
  /** Local ready-to-submit artifact screenshot path. Read via the bridge,
   *  never directly by the webview. */
  screenshot_path?: string;
  /** Hosted ready-to-submit artifact screenshot URL. */
  screenshot_url?: string;
  /** Optional link back to the hosted apply_runs row that produced this
   *  queue/applied entry. */
  apply_run_id?: string;
  /** Application outcome tracking (docs/application-status-tracking-plan.md)
   *  — a genuinely different axis from `status` above: `status` means
   *  whether *aplyx* successfully submitted the application; `outcome_status`
   *  means what the *employer* has said since. Defaults to "applied" the
   *  moment `status` first becomes "applied" (before any reply, that's the
   *  accurate state) — undefined here for a job whose `status` is
   *  `failed`/`needs_review`, since those were never submitted and have
   *  no outcome to track. Hosted-only (2026-08-19 — matches
   *  docs/website.md's pricing page): written directly onto the hosted
   *  `applied_jobs` row by the email-tracking-worker Edge Function
   *  (src/supabase/functions/email-tracking-worker/), guarded by a DB
   *  trigger enforcing the terminal-state guard (once `rejected`/`offer`/
   *  `withdrawn` is reached, no later update can silently move it again
   *  — see migration 0007_hosted_email_tracking.sql). Always undefined
   *  for a local install, which has no equivalent feature. A best-effort
   *  SIGNAL, not a verified fact — `outcome_source` carries where it came
   *  from ("email:<subject snippet>") so the UI can show provenance
   *  rather than present it as ground truth. */
  outcome_status?: "applied" | "oa_sent" | "oa_completed" | "interview_requested" | "offer" | "rejected" | "withdrawn";
  outcome_updated_at?: string;
  outcome_source?: string;
  /** Only ever set alongside outcome_status === "oa_sent" — a link and a
   *  verbatim-matched duration phrase (e.g. "7 days", "August 30") pulled
   *  from the assessment email itself by email-tracking-worker. Not a
   *  parsed/structured deadline, same best-effort spirit as outcome_source
   *  — company phrasing is too inconsistent to compute a real one from. */
  outcome_assessment_url?: string;
  outcome_assessment_note?: string;
  /** Apply-run metadata (apply-foundation). Present when an apply run
   *  was started for this job — the UI/adapter reads it to show the
   *  run's state (confirm_before_submit, submitting, submitted, …)
   *  and to find runs awaiting human approval (Stage 1). Absent for a
   *  pre-tailoring needs_review or a manual triage outcome where no
   *  apply run was ever started. */
  apply_run?: ApplyRunSummary;
}

export interface FillRecordField {
  field_name: string;
  filled_value: string;
  source: string;
  verified: boolean;
  note?: string;
}

export interface FillRecord {
  job_id: string;
  recorded_at: string;
  fields: FillRecordField[];
}

export interface QueueEntry extends Omit<AppliedJob, "status"> {
  status?: string;
}

export interface RegistryRecord {
  job_key: string;
  job_id: string;
  company?: string;
  title?: string;
  latest_status?: string;
  url?: string;
  internship_term?: string;
}

export interface AplyxState {
  applied: AppliedJob[];
  queue: QueueEntry[];
  registry: RegistryRecord[];
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Registry record for a queue/applied entry, matched by job_id. */
export function registryByJobId(
  registry: RegistryRecord[],
  jobId: string,
): RegistryRecord | undefined {
  return registry.find((r) => r.job_id === jobId);
}

/**
 * A queue entry is resolved when a later outcome exists for it: an
 * applied/failed entry in applied_jobs, or a registry latest_status that
 * moved past needs_review. The queue file itself is append-only (helper
 * discipline), so "resolved" is derived, never deleted.
 */
export function isResolved(state: AplyxState, entry: QueueEntry): boolean {
  const outcome = state.applied.find(
    (a) => a.job_id === entry.job_id && a.status !== "needs_review",
  );
  if (outcome) return true;
  const rec = registryByJobId(state.registry, entry.job_id);
  return (
    rec?.latest_status === "applied" ||
    rec?.latest_status === "failed" ||
    rec?.latest_status === "skipped_unfit"
  );
}

/**
 * A queue entry has a terminal applied/failed outcome when an
 * applied_jobs entry records that status, or the registry's
 * latest_status is applied or failed. Used to guard dismiss() from
 * overwriting a real outcome with skipped_unfit.
 */
export function hasAppliedOrFailed(state: AplyxState, entry: QueueEntry): boolean {
  const outcome = state.applied.find(
    (a) => a.job_id === entry.job_id && (a.status === "applied" || a.status === "failed"),
  );
  if (outcome) return true;
  const rec = registryByJobId(state.registry, entry.job_id);
  return rec?.latest_status === "applied" || rec?.latest_status === "failed";
}

/**
 * A queue entry is already dismissed when its registry latest_status is
 * skipped_unfit. Used by dismiss() to avoid re-dismissing (and recording a
 * duplicate skipped_unfit event for) an entry already resolved as dismissed.
 */
export function isDismissed(state: AplyxState, entry: QueueEntry): boolean {
  const rec = registryByJobId(state.registry, entry.job_id);
  return rec?.latest_status === "skipped_unfit";
}

export interface Heartbeat {
  last_run_completed_at: string;
  last_run_exit_code: number;
  last_run_counts: Record<string, number>;
  run_counter: number;
  consecutive_nonzero_exits: number;
}

// --- Apply-run metadata (apply-foundation) -----------------------------------
// Lightweight summary of an apply run (src/core/src/applyStateMachine.ts)
// that the UI/adapter can consume without importing the full state
// machine. Carried on AppliedJob.apply_run so a job in the review queue
// or applied list can show "where is this application" (initialized,
// confirm_before_submit, submitted, …) and the confirm-before-submit UI
// (docs/hosted-auto-apply-plan.md Stage 1) can find runs awaiting
// approval. Optional on both local and hosted rows — absent when no
// apply run was ever started for this job (e.g. a pre-tailoring
// needs_review, or a manual triage outcome).

export type ApplyRunStatus =
  | "initialized"
  | "package_assembled"
  | "fill_planned"
  | "filling"
  | "ready_to_submit"
  | "confirm_before_submit"
  | "submitting"
  | "submitted"
  | "needs_review"
  | "failed"
  | "canceled";

export interface ApplyRunSummary {
  /** The apply_runs row id (hosted) or a local stable id. */
  runId: string;
  status: ApplyRunStatus;
  /** The ATS family this run targets (greenhouse/lever/ashbyhq/workday). */
  family?: string;
  /** The managed alias used, when the run used a mail.aplyx.app alias
   *  for an account-required family. Absent for guest flows. */
  aliasId?: string;
  /** The application_accounts row (migration 0027/0028) this run is
   *  linked to, when the family requires an ATS account and one has
   *  been created or reused. Absent for guest flows and for
   *  account-required flows before the account is created. Never a
   *  credential — only the account's id. */
  accountId?: string;
  /** Whether a tailored resume artifact was attached. */
  tailoredResumeAttached?: boolean;
  /** Approval checkpoint state for confirm-before-submit flows. */
  approvalState?: "pending" | "approved" | "rejected";
  /** ISO timestamp of the last status change. */
  updatedAt?: string;
  /** Path (local) or content reference (hosted) to the fill plan, when
   *  one was produced. The UI loads it to render the confirm-before-
   *  submit review surface. */
  fillPlanRef?: string;
  /** Hosted/local screenshot artifact for the ready-to-submit review UI. */
  screenshotUrl?: string;
  tailoredResumeArtifactPath?: string;
}
