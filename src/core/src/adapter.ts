import type { AplyxState } from "./state.js";

export type FieldValue = string | string[];

/**
 * Storage-adapter seam (docs/app-integration-plan.md "Adapter seam"):
 * the desktop app's local mode and hosted mode read/write profile fields
 * and pipeline state through the same interface, so no screen forks its
 * behavior on account mode directly. LocalAdapter shells out to the
 * Python helpers exactly as the TUI does; SupabaseAdapter talks to the
 * hosted schema for the signed-in user. Both are async because
 * SupabaseAdapter is inherently network-bound; LocalAdapter's methods
 * simply resolve immediately.
 */
export interface Adapter {
  readonly mode: "local" | "hosted";

  /** Read one onboarding-schema field (see onboarding/fields.ts) by id. */
  readProfileField(id: string): Promise<FieldValue>;

  /** Write one onboarding-schema field by id. */
  writeProfileField(id: string, value: FieldValue): Promise<void>;

  /**
   * Pipeline state (applied jobs, review queue, registry) for the Home
   * screen. Returns undefined when there is no local install to read from
   * (e.g. a hosted-only session with no local aplyx installation
   * configured yet) — Phase 14B wires this up for real dashboard use;
   * Phase 14A's Home screen only needs a presence/absence signal.
   */
  loadState(): Promise<AplyxState | undefined>;
}
