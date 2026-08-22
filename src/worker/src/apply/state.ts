import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseAdapter, type SaveReadyToSubmitOptions } from "@aplyx/core/adapters/supabase.js";
import type { AtsFamily } from "@aplyx/core/atsRegistry.js";
import type { QueueEntry } from "@aplyx/core/stateDerive.js";

/** Small worker-side helpers around SupabaseAdapter's new apply-run methods.
 *  The browser executor is intentionally separate; this file just turns the
 *  worker's existing canonical job / queue-entry data into the persisted
 *  confirm-before-submit state the desktop UI consumes. */

export interface WorkerJobRecord {
  job_key: string;
  job_id: string;
  company: string;
  title: string;
  url: string;
  internship_term?: string;
}

export interface ReadyToSubmitPayload {
  family: AtsFamily;
  record: WorkerJobRecord;
  entry: QueueEntry;
  screenshotUrl?: string;
  tailoredResumeArtifactPath?: string;
  aliasId?: string;
}

export async function saveReadyToSubmitForUser(
  adminClient: SupabaseClient,
  userId: string,
  payload: ReadyToSubmitPayload,
): Promise<string> {
  const adapter = new SupabaseAdapter(adminClient, userId);
  const options: SaveReadyToSubmitOptions = {
    family: payload.family,
    fillRecord: payload.entry.fill_record,
    screenshotUrl: payload.screenshotUrl,
    tailoredResumeArtifactPath: payload.tailoredResumeArtifactPath,
    aliasId: payload.aliasId,
  };
  const run = await adapter.saveReadyToSubmit(payload.record, payload.entry, options);
  return run.runId;
}

export async function failApplyRunForUser(
  adminClient: SupabaseClient,
  userId: string,
  runId: string,
  message: string,
): Promise<void> {
  const adapter = new SupabaseAdapter(adminClient, userId);
  await adapter.updateApplyRunStatus(runId, "failed", {
    error: message,
    finishedAt: new Date().toISOString(),
  });
}
