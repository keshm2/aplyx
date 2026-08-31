import type { SupabaseClient } from "@supabase/supabase-js";
import { HOSTED_PROFILE_FIELD_IDS, HOSTED_PREFERENCE_FIELD_IDS } from "@aplyx/core/onboarding/hostedFields.js";
import { writeProfileFields, importResumeBytes, convertResume } from "./bridge";

/**
 * Hosted-to-local profile pull (docs/web-onboarding-hosted-sync-plan.md
 * Part B); the direction nothing in this codebase built before: reading
 * an already-filled-in hosted `profiles` row (from the web dashboard, or
 * a previous sign-in on another device) into a local install's own config
 * files. ImportOrFreshStep.tsx's "Import from this machine" is the exact
 * opposite direction (local → hosted); this is its mirror.
 */

export interface HostedProfileSnapshot {
  values: Record<string, string | string[]>;
  hasResume: boolean;
  resumeFileName?: string;
}

/** One row fetch instead of SupabaseAdapter.readProfileField's per-field
 *  readRow() (which would mean 21 round trips for a full pull); same
 *  field routing (18 plain columns + 3 preference-array fields folded
 *  into the jsonb `preferences` column) as that method, just batched. */
export async function readHostedProfileSnapshot(
  client: SupabaseClient,
  userId: string,
): Promise<HostedProfileSnapshot | undefined> {
  const { data: row, error } = await client.from("profiles").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!row) return undefined;

  const values: Record<string, string | string[]> = {};
  for (const id of HOSTED_PROFILE_FIELD_IDS) {
    const value = (row as Record<string, unknown>)[id];
    values[id] = value != null ? String(value) : "";
  }
  const preferences = ((row as Record<string, unknown>).preferences as Record<string, string[]> | undefined) ?? {};
  for (const id of HOSTED_PREFERENCE_FIELD_IDS) {
    values[id] = Array.isArray(preferences[id]) ? preferences[id] : [];
  }

  // Best-effort: a resume-listing failure shouldn't fail the whole
  // snapshot read; the profile fields are still worth offering on their
  // own, same "degrade, don't break" contract as readHostedReadiness.
  let hasResume = false;
  let resumeFileName: string | undefined;
  try {
    const { data: files, error: listError } = await client.storage.from("resumes").list(userId);
    if (listError) throw listError;
    const entry = (files ?? []).find((f) => f.name && !f.name.startsWith("."));
    if (entry) {
      hasResume = true;
      resumeFileName = entry.name;
    }
  } catch {
    hasResume = false;
  }

  return { values, hasResume, resumeFileName };
}

/** Writes a snapshot's profile fields into the local install's own config
 *  (safe_fields + targets.json arrays) via the same batched multi-field
 *  bridge call the local wizard's own ProfileStep page-saves use,
 *  identical routing, just all fields at once instead of one page's
 *  worth. Overwrites unconditionally; the caller is responsible for any
 *  "this will replace what's already here" confirmation before calling
 *  this. */
export async function writeProfileSnapshotLocally(root: string, snapshot: HostedProfileSnapshot): Promise<void> {
  await writeProfileFields(root, snapshot.values);
}

/** Downloads the hosted resume PDF and runs it through the same local
 *  conversion pipeline the local wizard's own ResumesStep calls after a
 *  manual upload (convertResume); no new resume-parsing code, only the
 *  missing download-and-save step. Throws on failure; callers should treat
 *  a resume-pull failure as non-fatal to the overall profile pull (the
 *  profile fields land regardless, see call sites). */
export async function pullHostedResume(
  client: SupabaseClient,
  userId: string,
  root: string,
  resumeFileName: string,
): Promise<void> {
  const { data, error } = await client.storage.from("resumes").download(`${userId}/${resumeFileName}`);
  if (error || !data) throw error ?? new Error("resume download returned no data");
  const bytes = new Uint8Array(await data.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  const stem = resumeFileName.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9_-]+/g, "_") || "general";
  await importResumeBytes(root, stem, base64);
  const result = await convertResume(root, stem);
  if (!result.ok) throw new Error(result.error ?? "resume text extraction failed");
}
