/**
 * Apply-run state machine, the lifecycle a single application
 * submission attempt moves through, from package assembly to a
 * terminal outcome. Framework-agnostic: the local apply loop
 * (src/agents/bodies/job-scraper.md Phase 3), the browser extension's
 * hybrid mode, and a future hosted auto-apply worker
 * (docs/hosted-auto-apply-plan.md) all drive the same states so the
 * UI/adapter can show "where is this application" without forking on
 * which surface started it.
 *
 * The states and their ordering reflect two load-bearing design
 * decisions from docs/hosted-auto-apply-plan.md:
 * - **confirm-before-submit** (Stage 1) is a first-class state, not a
 *   flag. A run that has filled the form and passed pre-submit
 *   verification pauses in `confirm_before_submit` until a human
 *   approves the submit. This is strictly safer than local's default
 *   (which submits directly) and is the trust-building rollout path
 *   for hosted auto-apply. A run in this state is NOT submitted: the
 *   UI must not render it as "applied".
 * - **ready_to_submit** is the state after pre-submit field-by-field
 *   verification passes but before the human (or, in Stage 2, the
 *   worker) clicks submit. It exists separately from
 *   confirm_before_submit so a non-Stage-1 (full-autonomy) flow can
 *   transition ready_to_submit → submitting without pausing, while a
 *   Stage-1 flow transitions ready_to_submit → confirm_before_submit
 *   → submitting. Same machine, different rollout stage.
 *
 * Terminal states (submitted, needs_review, failed, canceled) match
 * the existing AppliedJob.status taxonomy (applied/failed/needs_review)
 * plus `canceled` for an operator/timeout abort, a run that never
 * reached submit and was abandoned, distinct from `failed` (submit
 * attempted but errored/rejected).
 */

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

export const TERMINAL_STATUSES: readonly ApplyRunStatus[] = [
  "submitted",
  "needs_review",
  "failed",
  "canceled",
];

export function isTerminal(status: ApplyRunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Whether the run has paused for human approval before submit. The
 *  confirm-before-submit UI (Stage 1) surfaces runs in this state for
 *  the user to approve/reject. */
export function isAwaitingConfirmation(status: ApplyRunStatus): boolean {
  return status === "confirm_before_submit";
}

/** Whether the run has passed pre-submit verification and is ready to
 *  submit (either by the worker in full-autonomy, or after the human
 *  approves in Stage 1). */
export function isReadyToSubmit(status: ApplyRunStatus): boolean {
  return status === "ready_to_submit" || status === "confirm_before_submit";
}

/** Legal forward transitions. A state machine transition is only valid
 *  if it appears here; anything else is a bug (the caller tried to
 *  move backward, or skip a state). The graph is a DAG with two
 *  terminal-ish branches:
 *  - the happy path: initialized → package_assembled → fill_planned →
 *    filling → ready_to_submit → (confirm_before_submit)? → submitting
 *    → submitted
 *  - the abort path: any pre-submit state → needs_review | failed |
 *    canceled (a doubt signal, a CAPTCHA, a timeout, or an operator
 *    abort). Once submitting, only submitted/failed/canceled are
 *    reachable (submit either succeeded, errored, or was canceled
 *    mid-flight). */
const TRANSITIONS: Record<ApplyRunStatus, readonly ApplyRunStatus[]> = {
  initialized: ["package_assembled", "needs_review", "failed", "canceled"],
  package_assembled: ["fill_planned", "needs_review", "failed", "canceled"],
  fill_planned: ["filling", "needs_review", "failed", "canceled"],
  filling: ["ready_to_submit", "needs_review", "failed", "canceled"],
  ready_to_submit: ["confirm_before_submit", "submitting", "needs_review", "failed", "canceled"],
  confirm_before_submit: ["submitting", "needs_review", "failed", "canceled"],
  submitting: ["submitted", "failed", "canceled"],
  submitted: [],
  needs_review: [],
  failed: [],
  canceled: [],
};

export function canTransition(from: ApplyRunStatus, to: ApplyRunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: ApplyRunStatus,
    public readonly to: ApplyRunStatus,
  ) {
    super(`illegal apply-run transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/** Pure state-machine transition: validates the edge, returns the new
 *  status, throws IllegalTransitionError on an invalid move. The
 *  caller (the apply loop, the worker, the UI's approve/reject action)
 *  owns persistence; this function carries no I/O so it's testable
 *  in isolation and usable from both local and hosted contexts. */
export function transition(from: ApplyRunStatus, to: ApplyRunStatus): ApplyRunStatus {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

/** The set of doubt signals (AGENTS.md "Doubt signals") that, when
 *  present, force a run into needs_review rather than letting it
 *  proceed toward submit. The apply state machine consults this when
 *  deciding whether ready_to_submit may advance, or whether filling
 *  must abort. Re-exported from here so the apply modules have one
 *  import for the whole vocabulary; the canonical list stays in
 *  AGENTS.md (this array must track it). */
export const APPLY_DOUBT_SIGNALS: readonly string[] = [
  "ambiguous_dropdown",
  "verification_mismatch",
  "unrecognized_field",
  "unmapped_required_field",
  "low_ats_score",
  "unapproved_essay_answer",
  "cover_letter_over_limit",
  "captcha",
  "credential_or_payment_request",
  "non_candidate_fit",
  "workday_review_only",
  "submit_outcome_unclear",
];

/** Decide whether a run carrying the given doubt signals may proceed
 *  from filling → ready_to_submit. Any doubt signal present means the
 *  run must route to needs_review instead: never guess-and-continue.
 *  This is the state-machine encoding of AGENTS.md's "never accept an
 *  unconfirmed dropdown match" / "always verify before submitting"
 *  rules: the doubt signal is the machine-checkable reason, and the
 *  state machine refuses to advance past it. */
export function canAdvanceToFilled(doubtSignals: readonly string[]): boolean {
  return doubtSignals.every((s) => !APPLY_DOUBT_SIGNALS.includes(s));
}
