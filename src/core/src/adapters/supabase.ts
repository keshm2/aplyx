import type { SupabaseClient } from "@supabase/supabase-js";
import type { Adapter, FieldValue } from "../adapter.js";
import type { AplyxState } from "../state.js";
import { HOSTED_PROFILE_FIELD_IDS, HOSTED_PREFERENCE_FIELD_IDS } from "../onboarding/hostedFields.js";

type Row = Record<string, unknown>;

/**
 * Hosted-mode adapter: talks directly to Supabase (HTTPS to supabase.co,
 * no local server involved) via @supabase/supabase-js, scoped to the
 * signed-in user by `user_id` — enforced twice over, by this adapter's
 * queries and by the `profiles` table's row-level security policy.
 *
 * Field routing: the safe_fields-shaped PII (HOSTED_PROFILE_FIELD_IDS) maps
 * one column per field on `profiles`, per the operator's explicit decision
 * to sync profile PII for signed-in users (2026-07-16, overriding phase
 * 11's original local-only-PII default — see onboarding/profile.ts).
 * Job-search preferences (HOSTED_PREFERENCE_FIELD_IDS — role_keywords,
 * preferred_locations, target_companies) live in a single `preferences`
 * jsonb column instead: they aren't PII, and they only become meaningful
 * once synced into a local install's src/config/targets.json for the Python
 * fit-gate engine to read (Phase 14B), so a flexible column avoids a
 * schema migration once that sync direction is built.
 */
export class SupabaseAdapter implements Adapter {
  readonly mode = "hosted" as const;

  constructor(
    private readonly client: SupabaseClient,
    private readonly userId: string,
  ) {}

  private async readRow(): Promise<Row | undefined> {
    const { data, error } = await this.client
      .from("profiles")
      .select("*")
      .eq("user_id", this.userId)
      .maybeSingle();
    if (error) throw error;
    return (data as Row | null) ?? undefined;
  }

  async readProfileField(id: string): Promise<FieldValue> {
    const row = await this.readRow();
    if (HOSTED_PREFERENCE_FIELD_IDS.includes(id)) {
      const prefs = (row?.preferences as Record<string, string[]> | undefined) ?? {};
      return prefs[id] ?? [];
    }
    if (!HOSTED_PROFILE_FIELD_IDS.includes(id)) {
      throw new Error(`unknown profile field: ${id}`);
    }
    return String(row?.[id] ?? "");
  }

  async writeProfileField(id: string, value: FieldValue): Promise<void> {
    if (HOSTED_PREFERENCE_FIELD_IDS.includes(id)) {
      const row = await this.readRow();
      const prefs = { ...((row?.preferences as Record<string, string[]> | undefined) ?? {}), [id]: value };
      const { error } = await this.client
        .from("profiles")
        .upsert({ user_id: this.userId, preferences: prefs }, { onConflict: "user_id" });
      if (error) throw error;
      return;
    }
    if (!HOSTED_PROFILE_FIELD_IDS.includes(id)) {
      throw new Error(`unknown profile field: ${id}`);
    }
    const { error } = await this.client
      .from("profiles")
      .upsert({ user_id: this.userId, [id]: value }, { onConflict: "user_id" });
    if (error) throw error;
  }

  /** Whether this signed-in user has finished the hosted onboarding wizard
   *  before — drives the desktop app's post-sign-in landing (dashboard vs
   *  wizard) so a returning sign-in doesn't repeat it every time. */
  async readOnboardingCompleted(): Promise<boolean> {
    const row = await this.readRow();
    return Boolean(row?.onboarding_completed);
  }

  async writeOnboardingCompleted(completed: boolean): Promise<void> {
    const { error } = await this.client
      .from("profiles")
      .upsert({ user_id: this.userId, onboarding_completed: completed }, { onConflict: "user_id" });
    if (error) throw error;
  }

  async loadState(): Promise<AplyxState | undefined> {
    // Hosted pipeline-state sync (jobs/job_events/applied_jobs/review_queue
    // tables) is Phase 14B scope — until then a hosted-only session has no
    // dashboard data of its own; the Home screen shows a "connect a local
    // install" placeholder rather than a fabricated empty state.
    return undefined;
  }
}
