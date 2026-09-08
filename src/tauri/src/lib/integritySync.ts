import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { BUILD_MARKER } from "@aplyx/core/version.js";
import {
  findRoot,
  verifyIntegrity,
  readUnreportedIntegrityEvents,
  markIntegrityEventsReported,
} from "./bridge";

/** The canonical file hashes for this build, from the service-role-only
 *  `release_manifests` table (migration 0044). A client can't forge this;
 *  null when offline or the row isn't published yet (verify falls back to
 *  the bundled manifest). */
async function fetchCanonicalManifest(client: SupabaseClient): Promise<string | null> {
  try {
    const { data, error } = await client
      .from("release_manifests")
      .select("version, files, forbidden")
      .eq("version", BUILD_MARKER)
      .maybeSingle();
    if (error || !data) return null;
    return JSON.stringify(data);
  } catch {
    return null;
  }
}

/**
 * On sign-in: run the local integrity check, push any locally-recorded
 * violations to the account (migration 0044's INSERT-only
 * `integrity_events`), and stamp `profiles.integrity_status`. Fire-and-
 * forget — never allowed to block or fail sign-in.
 *
 * This is tamper-EVIDENCE, not prevention: a user who also patches the
 * local scripts can suppress the report, but then their
 * `integrity_checked_at` stops advancing, and any violation already
 * synced is permanent (no UPDATE/DELETE policy). The account, not the
 * client, is the record of record.
 */
export async function runIntegritySync(client: SupabaseClient, userId: string): Promise<void> {
  let root: string;
  try {
    root = await findRoot();
  } catch {
    // No local install (a pure hosted/web account): nothing to verify.
    return;
  }

  const canonical = await fetchCanonicalManifest(client);
  const result = await verifyIntegrity(root, canonical ?? undefined).catch(() => null);
  const unreported = await readUnreportedIntegrityEvents(root).catch(() => []);
  if (!result) return;

  const adapter = new SupabaseAdapter(client, userId);
  const synced = await adapter
    .syncIntegrityEvents(unreported, result.ok)
    .catch(() => [] as string[]);
  if (synced.length > 0) {
    await markIntegrityEventsReported(root, synced).catch(() => {});
  }
}
