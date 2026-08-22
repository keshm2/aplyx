/**
 * Fill plan — the structured field-mapping an apply run produces before
 * it types anything into the form. This is the core-level counterpart
 * to the extension's field-mapping (src/extension/src/ats.ts
 * FIELD_PATTERNS / matchField), lifted out of the DOM so a hosted
 * auto-apply worker (docs/hosted-auto-apply-plan.md "Narrowed to
 * forced-tool-use, single-purpose calls") can produce the same plan
 * from a deterministic DOM-read step + a forced-tool-use classification
 * call, without a live browser.
 *
 * A fill plan is an array of FillField entries, one per form control the
 * run will touch. Each entry carries: the field's descriptor (label/
 * aria/placeholder/name — what the form called it), the resolved
 * safe_fields key (or an explicit "unmapped" classification), the
 * value to type, the source of that value, and whether the pre-submit
 * verification confirmed it. This mirrors the shape
 * src/scripts/state/record_fill.py persists to
 * data/fill_records/<job_id>.json (FillRecord in stateDerive.ts), so a
 * fill plan and a persisted fill record are the same shape — the plan
 * is what gets verified, the record is what gets persisted after.
 *
 * The conservative-default fill policy (AGENTS.md) and the doubt-signal
 * vocabulary (applyStateMachine.ts APPLY_DOUBT_SIGNALS) are encoded
 * here as classifications on unresolved fields, so the state machine
 * can refuse to advance a plan with any blocking doubt signal to
 * ready_to_submit.
 */

import type { AtsFamily } from "./atsRegistry.js";
import { canAdvanceToFilled } from "./applyStateMachine.js";

/** The safe_fields key a form control resolved to, or an explicit
 *  classification for fields that don't map to a safe_field. Mirrors
 *  the extension's FieldKey plus the unmapped classifications from
 *  AGENTS.md "Conservative-default fill policy" and "Doubt signals". */
export type FillFieldKey =
  | "first_name"
  | "last_name"
  | "preferred_name"
  | "email"
  | "phone"
  | "linkedin_url"
  | "github_url"
  | "location"
  | "zip_code"
  | "address_line1"
  | "address_line2"
  | "graduation_date"
  | "gpa"
  | "authorized_to_work"
  | "require_sponsorship"
  | "citizenship_status"
  | "currently_enrolled"
  | "full_name"
  // --- unmapped classifications (not a safe_field) ---
  /** A free-text motivation/essay question — always parks via the
   *  interest-letter flow, never auto-answered (AGENTS.md). */
  | "essay"
  /** A required field with no safe_fields mapping and no conservative
   *  default — routes to needs_review (doubt signal
   *  unmapped_required_field). */
  | "unmapped_required"
  /** An optional field with no safe_fields mapping — left blank, not a
   *  doubt signal. */
  | "unmapped_optional"
  /** A field filled by a conservative-default policy category (a–d,
   *  AGENTS.md). Carries a `note` explaining which category applied. */
  | "conservative_default"
  /** A resume upload field — filled by uploading the resume artifact,
   *  not by typing a value. */
  | "resume_upload"
  /** A cover-letter field — filled by pasting the tailored cover
   *  letter body. */
  | "cover_letter";

/** The source of the value typed into a field. Mirrors
 *  record_fill.py's `source` vocabulary exactly (see AGENTS.md "Fill
 *  records") so a fill plan entry round-trips into a persisted fill
 *  record without translation. */
export type FillValueSource =
  | `safe_fields:${string}`
  | "constructed"
  | "resume_upload"
  | "cover_letter"
  | "conservative_default";

export interface FillField {
  /** The form control's label/aria/placeholder/name — what the form
   *  called this field. Used for auditability in the fill record. */
  fieldDescriptor: string;
  /** The resolved safe_fields key or unmapped classification. */
  key: FillFieldKey;
  /** The value to type/paste/upload. Empty string for an unmapped
   *  optional field left blank. */
  filledValue: string;
  /** The source of filledValue — a safe_fields:<key>, constructed,
   *  resume_upload, cover_letter, or conservative_default. */
  source: FillValueSource;
  /** True once the pre-submit field-by-field verification (AGENTS.md
   *  Phase 3 step 6) confirmed the committed DOM value matches
   *  filledValue. False until that check runs; stays false if the
   *  check found a mismatch (doubt signal verification_mismatch). */
  verified: boolean;
  /** Required for conservative_default fills (AGENTS.md "Fill
   *  records" — record_fill.py enforces a non-empty note). States
   *  which category (a–d) applied and what value was chosen. */
  note?: string;
}

export interface FillPlan {
  family: AtsFamily;
  /** The job_id this plan was built for. */
  jobId: string;
  fields: FillField[];
  /** ISO timestamp the plan was produced. */
  plannedAt: string;
}

/** The doubt signals a fill plan emits, derived from its fields. This
 *  is what the state machine consults (via canAdvanceToFilled) to
 *  decide whether filling → ready_to_submit is legal, or whether the
 *  run must route to needs_review. Mirrors the AGENTS.md "Doubt
 *  signals" vocabulary — every field-level signal the plan carries
 *  maps to one canonical string. */
export function doubtSignalsForPlan(plan: FillPlan): string[] {
  const signals = new Set<string>();
  for (const f of plan.fields) {
    if (f.key === "unmapped_required") signals.add("unmapped_required_field");
    else if (f.key === "essay") signals.add("unapproved_essay_answer");
    else if (!f.verified && f.key !== "unmapped_optional") signals.add("verification_mismatch");
    // unrecognized_field is the superset of unmapped_required — only
    // emit the more specific one when both would apply.
  }
  return [...signals];
}

/** Whether the plan has any field that blocks advancement to
 *  ready_to_submit. Convenience wrapper around doubtSignalsForPlan +
 *  applyStateMachine.canAdvanceToFilled, for the fill step that just
 *  wants a boolean. */
export function isPlanSubmittable(plan: FillPlan): boolean {
  return canAdvanceToFilled(doubtSignalsForPlan(plan));
}
