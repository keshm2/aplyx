import { FIELD_IDS } from "./fields.js";

/**
 * Pure field-id classification for hosted-mode routing (SupabaseAdapter),
 * deliberately split from profile.ts, which also holds the fs-backed
 * local-mode read/write functions. SupabaseAdapter runs directly in the
 * Tauri webview (no Node APIs available there), so anything it imports
 * must stay free of node:fs/node:child_process: importing profile.ts
 * itself would pull those in transitively even though only these two
 * constant lists are needed.
 *
 * HOSTED_PROFILE_FIELD_IDS: the safe_fields-shaped subset of the 18
 * onboarding fields, the PII the operator has explicitly approved
 * syncing to the hosted Supabase `profiles` table (2026-07-16 decision, a
 * deliberate override of phase 11's original local-only-PII default).
 * HOSTED_PREFERENCE_FIELD_IDS: job-search preferences (role_keywords,
 * preferred_locations, target_companies), not PII, stored in a separate
 * jsonb column since they only become meaningful once synced into a local
 * install's src/config/targets.json for the Python fit-gate engine (Phase 14B).
 */
const HOSTED_PREFERENCE_FIELD_IDS_INTERNAL = ["role_keywords", "preferred_locations", "target_companies", "levels"];

export const HOSTED_PROFILE_FIELD_IDS: string[] = FIELD_IDS.filter(
  (id) => !HOSTED_PREFERENCE_FIELD_IDS_INTERNAL.includes(id),
);

export const HOSTED_PREFERENCE_FIELD_IDS: string[] = [...HOSTED_PREFERENCE_FIELD_IDS_INTERNAL];
