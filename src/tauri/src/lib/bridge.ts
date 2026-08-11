import { invoke } from "@tauri-apps/api/core";
import type { QueueEntry } from "@aplyx/core/stateDerive.js";
import type { ResumeFile } from "@aplyx/core/resumes.js";
import type { JobSource, SearchJob, SourceResult, SearchResult, FitResult } from "@aplyx/core/jobs.js";

export type { ResumeFile, JobSource, SearchJob, SourceResult, SearchResult, FitResult };

/**
 * Thin typed wrappers around the Rust IPC commands defined in
 * src/tauri/src-tauri/src/lib.rs, which themselves shell out to the shared
 * @aplyx/core bridge CLI (src/core/src/bridge.ts). This is the only
 * module in the frontend that calls invoke() directly — every screen goes
 * through here instead, so the IPC surface stays in one place.
 */

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

/** Persisted across launches — a Finder/Dock-launched app has no shell
 *  env vars, no meaningful working directory, and (now that the bridge is
 *  bundled as a Tauri resource so a downloaded install works at all — see
 *  src/tauri/src-tauri/src/lib.rs) a compiled bridge that lives inside the
 *  app bundle, nowhere near the user's actual checkout. Auto-detection
 *  (findProjectRoot in @aplyx/core/project.js) only ever succeeds when
 *  launched from a terminal inside the repo (`tauri dev`); everyone else
 *  picks their folder once via setLocalRoot() and this remembers it. */
const LOCAL_ROOT_STORAGE_KEY = "aplyx.localRoot";

function readStoredRoot(): string | undefined {
  try {
    return localStorage.getItem(LOCAL_ROOT_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

let cachedRoot: string | undefined;

/** The local aplyx installation root: a remembered manual pick first, then
 *  auto-detection, resolved once per app session. */
export async function findRoot(): Promise<string> {
  if (cachedRoot) return cachedRoot;
  const stored = readStoredRoot();
  if (stored) {
    cachedRoot = stored;
    return cachedRoot;
  }
  const result = await invoke<{ root: string }>("find_root");
  cachedRoot = result.root;
  return cachedRoot;
}

/** Validates `dir` as a real aplyx checkout (same check findProjectRoot
 *  does) and remembers it in localStorage so future launches use it
 *  directly instead of relying on auto-detection — the recovery path
 *  when findRoot() fails. Throws with a clear message when `dir` doesn't
 *  look like a checkout. */
export async function setLocalRoot(dir: string): Promise<string> {
  const result = await invoke<{ root: string }>("validate_root", { dir });
  cachedRoot = result.root;
  try {
    localStorage.setItem(LOCAL_ROOT_STORAGE_KEY, result.root);
  } catch {
    // best-effort persistence — the current session still works via
    // cachedRoot even if localStorage is unavailable.
  }
  return result.root;
}

/** Forgets the remembered root (Settings' "change installation folder",
 *  or recovering from a moved/deleted checkout) so the next findRoot()
 *  re-runs auto-detection / prompts the picker again. */
export function forgetLocalRoot(): void {
  cachedRoot = undefined;
  try {
    localStorage.removeItem(LOCAL_ROOT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function ensureTargetsFile(root: string): Promise<void> {
  await invoke("ensure_targets_file", { root });
}

export async function readProfileField(root: string, id: string): Promise<string | string[]> {
  const result = await invoke<{ value: string | string[] }>("read_profile_field", { root, id });
  return result.value;
}

export async function writeProfileField(root: string, id: string, value: string | string[]): Promise<void> {
  await invoke("write_profile_field", { root, id, value });
}

/** Batched siblings of readProfileField/writeProfileField — one bridge
 *  call (one spawned node process) for a whole page/set of fields instead
 *  of one per field. Each bridge call is its own process spawn (see
 *  src/tauri/src-tauri/src/lib.rs's run_bridge); a page with several fields
 *  firing that many concurrently was reported live as flashing console
 *  windows and multi-second page transitions on Windows. Prefer these over
 *  Promise.all-ing the singular versions for any multi-field read/write. */
export async function readProfileFields(root: string, ids: string[]): Promise<Record<string, string | string[]>> {
  const result = await invoke<{ values: Record<string, string | string[]> }>("read_profile_fields", { root, ids });
  return result.values;
}

export async function writeProfileFields(root: string, values: Record<string, string | string[]>): Promise<void> {
  await invoke("write_profile_fields", { root, values });
}

export async function loadLocalState(root: string): Promise<unknown> {
  return invoke("load_local_state", { root });
}

export async function runValidator(root: string): Promise<{ ok: boolean; output: string }> {
  return invoke("run_validator", { root });
}

/** Falls back to aplyx's own baked-in hosted-auth project when
 *  src/config/supabase.json is missing or still holds the example
 *  placeholders (see @aplyx/core/supabaseConfig.ts's
 *  DEFAULT_SUPABASE_CONFIG) — a local override still wins when present. */
export async function readSupabaseConfig(root: string): Promise<SupabaseConfig> {
  return invoke<SupabaseConfig>("read_supabase_config", { root });
}

/** True when a local aplyx installation was found — i.e. findRoot()
 *  resolved instead of throwing. Used to decide whether "Run locally" can
 *  proceed straight to onboarding or needs an install-location step first. */
export async function hasLocalInstall(): Promise<boolean> {
  try {
    await findRoot();
    return true;
  } catch {
    return false;
  }
}

export async function readOnboardingCompleted(root: string): Promise<boolean> {
  const result = await invoke<{ completed: boolean }>("read_onboarding_completed", { root });
  return result.completed;
}

export async function writeOnboardingCompleted(root: string, completed: boolean): Promise<void> {
  await invoke("write_onboarding_completed", { root, completed });
}

/** Deduped company display names from the local install's vetted slug
 *  lists — the autocomplete pool for target-company tags. */
export async function listCompanies(root: string): Promise<string[]> {
  const result = await invoke<{ companies: string[] }>("list_companies", { root });
  return result.companies;
}

export async function detectHarnesses(): Promise<string[]> {
  const result = await invoke<{ detected: string[] }>("detect_harnesses");
  return result.detected;
}

export async function writeHarness(root: string, harness: string): Promise<void> {
  await invoke("write_harness", { root, harness });
}

export interface DiscordConfig {
  enabled: boolean;
  applied: string;
  needs_review: string;
  failed: string;
  summary: string;
}

export async function readDiscordConfig(root: string): Promise<DiscordConfig> {
  return invoke<DiscordConfig>("read_discord_config", { root });
}

export async function writeDiscordConfig(root: string, config: DiscordConfig): Promise<void> {
  await invoke("write_discord_config", {
    root,
    enabled: config.enabled,
    routes: { applied: config.applied, needs_review: config.needs_review, failed: config.failed, summary: config.summary },
  });
}

export async function listResumes(root: string): Promise<string[]> {
  const result = await invoke<{ files: string[] }>("list_resumes", { root });
  return result.files;
}

export async function importResumeFile(root: string, sourcePath: string, stem: string): Promise<void> {
  await invoke("import_resume_file", { root, sourcePath, stem });
}

export async function convertResume(root: string, stem: string, description = ""): Promise<{ ok: boolean; error?: string }> {
  return invoke("convert_resume", { root, stem, description });
}

/** Set/update a resume's description without converting anything — for a
 *  resume that already has its .md (convertResume's re-extraction would
 *  otherwise be the only way to attach one). See setResumeDescription in
 *  src/core/src/helpers.ts for the full reasoning. */
export async function setResumeDescription(root: string, stem: string, description: string): Promise<{ ok: boolean; error?: string }> {
  return invoke("set_resume_description", { root, stem, description });
}

export async function openExtensionFolder(root: string): Promise<void> {
  await invoke("open_extension_folder", { root });
}

export async function searchJobs(
  root: string,
  query: string,
  sources: Partial<Record<JobSource, boolean>>,
): Promise<SearchResult> {
  return invoke<SearchResult>("search_jobs", { root, query, sources });
}

export async function checkJobFit(root: string, job: SearchJob): Promise<FitResult> {
  return invoke<FitResult>("check_job_fit", { root, job });
}

export async function saveJobForReview(root: string, job: SearchJob): Promise<"saved" | "already_saved"> {
  const result = await invoke<{ result: "saved" | "already_saved" }>("save_job_for_review", { root, job });
  return result.result;
}

export async function markQueueEntryApplied(root: string, entry: QueueEntry): Promise<{ message: string }> {
  return invoke<{ message: string }>("mark_queue_entry_applied", { root, entry });
}

export async function dismissQueueEntry(root: string, entry: QueueEntry): Promise<{ message: string }> {
  return invoke<{ message: string }>("dismiss_queue_entry", { root, entry });
}

export async function reopenApplicationFilled(root: string, jobId: string): Promise<{ ok: boolean; message: string }> {
  return invoke<{ ok: boolean; message: string }>("reopen_application_filled", { root, jobId });
}

export async function listResumeDetails(root: string): Promise<ResumeFile[]> {
  const result = await invoke<{ files: ResumeFile[] }>("list_resume_details", { root });
  return result.files;
}

export async function openResumesFolder(root: string): Promise<void> {
  await invoke("open_resumes_folder", { root });
}
