import { invoke } from "@tauri-apps/api/core";
import type { QueueEntry, FillRecord } from "@aplyx/core/stateDerive.js";
import type { ResumeFile } from "@aplyx/core/resumes.js";
import type { MasterResume, ExportResumePdfResult, PreviewTailoredResumeResult } from "@aplyx/core/masterResume.js";
import type { JobSource, SearchJob, SourceResult, SearchResult, FitResult, RecommendedJob, SchedulerStatus } from "@aplyx/core/jobs.js";

export type { ResumeFile, JobSource, SearchJob, SourceResult, SearchResult, FitResult, RecommendedJob, SchedulerStatus, PreviewTailoredResumeResult };

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

export async function readHarness(root: string): Promise<string | undefined> {
  const result = await invoke<{ harness: string | null }>("read_harness", { root });
  return result.harness ?? undefined;
}

export async function writeHarness(root: string, harness: string): Promise<void> {
  await invoke("write_harness", { root, harness });
}

/** Effective value of an APLYX_* setting: real env var wins, then
 *  src/config/env.json, then the fallback. The desktop-app counterpart of
 *  the TUI's effectiveEnv(), reading through the same env.json so both
 *  surfaces agree. */
export async function readEnvOverride(
  root: string,
  key: string,
  opts?: { legacyKeys?: string[]; fallback?: string },
): Promise<string> {
  const result = await invoke<{ value: string }>("read_env_override", {
    root,
    key,
    legacyKeys: opts?.legacyKeys,
    fallback: opts?.fallback,
  });
  return result.value;
}

export async function writeEnvOverride(root: string, key: string, value: string): Promise<void> {
  await invoke("write_env_override", { root, key, value });
}

/** Starts a live run_job_agent.py run (see src-tauri/src/lib.rs's
 *  start_run). Progress streams via the "run:log"/"run:exit" Tauri events
 *  (see useRunState.ts). This call just confirms the process launched;
 *  it doesn't wait for the run to finish. */
export async function startRun(
  root: string,
  opts?: { sessionCap?: string; extraPrompt?: string },
): Promise<{ pid: number }> {
  return invoke<{ pid: number }>("start_run", {
    root,
    sessionCap: opts?.sessionCap,
    extraPrompt: opts?.extraPrompt,
  });
}

export async function stopRun(pid: number): Promise<void> {
  await invoke("stop_run", { pid });
}

/** The pid of a run this window itself started, if any is still live. */
export async function getRunStatus(): Promise<{ pid: number | undefined }> {
  const result = await invoke<{ pid: number | null }>("get_run_status");
  return { pid: result.pid ?? undefined };
}

/** The pid of a run in progress from any surface (TUI, scheduler, another
 *  aplyx window), so the UI can show "already running elsewhere" instead
 *  of offering a Run button that would just exit immediately via
 *  run_job_agent.py's own single-flight lock. */
export async function readActiveRunPid(root: string): Promise<number | undefined> {
  const result = await invoke<{ pid: number | null }>("read_active_run_pid", { root });
  return result.pid ?? undefined;
}

export interface DiscordConfig {
  enabled: boolean;
  success: string;
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
    routes: { success: config.success, needs_review: config.needs_review, failed: config.failed, summary: config.summary },
  });
}

export async function listResumes(root: string): Promise<string[]> {
  const result = await invoke<{ files: string[] }>("list_resumes", { root });
  return result.files;
}

export async function importResumeFile(root: string, sourcePath: string, stem: string): Promise<void> {
  await invoke("import_resume_file", { root, sourcePath, stem });
}

export async function convertResume(root: string, stem: string, description = "", force = false): Promise<{ ok: boolean; error?: string }> {
  return invoke("convert_resume", { root, stem, description, force });
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
  sources: Partial<Record<JobSource, boolean>> = {},
): Promise<SearchResult> {
  return invoke<SearchResult>("search_jobs", { root, query, sources });
}

export async function checkJobFit(root: string, job: SearchJob): Promise<FitResult> {
  return invoke<FitResult>("check_job_fit", { root, job });
}

export async function checkJobFitBatch(root: string, jobs: SearchJob[]): Promise<Record<string, FitResult>> {
  return invoke<Record<string, FitResult>>("check_job_fit_batch", { root, jobs });
}

export async function fetchJobDescription(root: string, job: SearchJob): Promise<{ jd_text?: string; pay_text?: string }> {
  return invoke<{ jd_text?: string; pay_text?: string }>("fetch_job_description", { root, job });
}

export async function getRecommendedJobs(root: string, excludeJobIds: string[]): Promise<RecommendedJob[]> {
  return invoke<RecommendedJob[]>("get_recommended_jobs", { root, excludeJobIds });
}

export async function getSchedulerStatus(root: string): Promise<SchedulerStatus> {
  return invoke<SchedulerStatus>("get_scheduler_status", { root });
}

export async function setSchedulerInstalled(root: string, installed: boolean): Promise<SchedulerStatus> {
  return invoke<SchedulerStatus>("set_scheduler_installed", { root, installed });
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

/** Confirm-before-submit "Approve" action (docs/hosted-auto-apply-plan.md
 *  Stage 1): the agent paused with a filled-but-not-submitted form, and the
 *  user is now approving the actual submission. Local-only — hosted mode
 *  calls SupabaseAdapter.approveSubmit(entry) directly (same local/hosted
 *  split as markQueueEntryApplied). Resolves once the run has launched, not
 *  once it's finished — same launch-grace shape as triggerSingleJobApply.
 *
 *  Workday continuation runs return richer fields (checkpointPath,
 *  checkpointStatus, outcome, filledFields, resumeAttached,
 *  usedVerificationLink/Otp) so the UI can show where the resumable flow
 *  paused and mark consumed verification mails. Other families populate
 *  only ok/message (and confirmationUrl on a real submit). */
export interface WorkdayApprovalContext {
  aliasEmail: string;
  aliasId?: string;
  verificationLink?: string;
  verificationOtp?: string;
}

export interface ApproveSubmitResult {
  ok: boolean;
  message: string;
  outcome?: string;
  confirmationUrl?: string;
  checkpointPath?: string;
  checkpointStatus?: string;
  doubtSignals?: string[];
  filledFields?: number;
  resumeAttached?: boolean;
  usedVerificationLink?: boolean;
  usedVerificationOtp?: boolean;
}

export async function approveSubmit(
  root: string,
  entry: QueueEntry,
  workday?: WorkdayApprovalContext,
): Promise<ApproveSubmitResult> {
  return invoke<ApproveSubmitResult>("approve_submit", { root, entry, workday });
}

/** Reads a confirm-before-submit screenshot (the filled-form snapshot the
 *  agent captures before pausing) as a base64 data URL for the webview to
 *  render — the webview can't read local files directly. null when the
 *  file is missing or the path doesn't match the expected shape. Hosted
 *  entries carry a screenshot_url instead and never need this call. */
export async function readScreenshot(root: string, path: string): Promise<string | null> {
  const result = await invoke<{ dataUrl: string | null }>("read_screenshot", { root, path });
  return result.dataUrl;
}

/** "Apply with aplyx" on a manual-search result — runs the same agent a
 *  scheduled run does (fit gate, tailoring, apply, every AGENTS.md safety
 *  rule) for this one job instead of the agent's own board search. Resolves
 *  once the run has launched (or failed to), not once it's finished — a
 *  real run keeps going detached; check Status/the review queue afterward
 *  for the actual outcome. */
export async function triggerSingleJobApply(
  root: string,
  job: { company: string; title: string; url: string; source: string },
): Promise<{ ok: boolean; message: string }> {
  return invoke<{ ok: boolean; message: string }>("trigger_single_job_apply", { root, job });
}

export async function listResumeDetails(root: string): Promise<ResumeFile[]> {
  const result = await invoke<{ files: ResumeFile[] }>("list_resume_details", { root });
  return result.files;
}

export async function openResumesFolder(root: string): Promise<void> {
  await invoke("open_resumes_folder", { root });
}

export async function getMasterResume(root: string): Promise<{ resume: MasterResume; isNew: boolean }> {
  return invoke("get_master_resume", { root });
}

export async function setMasterResume(root: string, resume: MasterResume): Promise<void> {
  await invoke("set_master_resume", { root, resume });
}

/** Raw extracted text for a resume stem's .md, used both by "import from
 *  an existing resume" (structured parse) and the PDF-extraction reference
 *  panel (plain display, no parsing) — null if that stem has no .md yet. */
export async function readResumeMarkdown(root: string, stem: string): Promise<string | null> {
  const result = await invoke<{ text: string | null }>("read_resume_markdown", { root, stem });
  return result.text;
}

/** The actual field-by-field record of what was typed/attached for a local
 *  application (record_fill.py's data/fill_records/<job_id>.json) — the
 *  file AppliedJob.fill_record_path points at. null if the record is
 *  missing (e.g. an old application from before fill records existed). A
 *  hosted-mode row carries this same shape inline as fill_record instead
 *  (SupabaseAdapter) and never needs this call. */
export async function readFillRecord(root: string, fillRecordPath: string): Promise<FillRecord | null> {
  const result = await invoke<{ record: FillRecord | null }>("read_fill_record", { root, path: fillRecordPath });
  return result.record;
}

export interface WorkdayCheckpoint {
  job_id?: string;
  alias_email?: string;
  alias_id?: string;
  status?: string;
  updated_at?: string;
  screenshot_path?: string;
  last_fill?: {
    step_title?: string;
    next_step_title?: string;
    url?: string;
    next_url?: string;
    filled_labels?: string[];
    unmatched_keys?: string[];
    resume_attached?: boolean;
    advance_error?: string;
  };
}

export async function readWorkdayCheckpoint(root: string, jobId: string): Promise<WorkdayCheckpoint | null> {
  const result = await invoke<{ checkpoint: WorkdayCheckpoint | null }>("read_workday_checkpoint", { root, jobId });
  return result.checkpoint;
}

export async function importMasterResumeFromMarkdown(root: string, markdown: string): Promise<MasterResume> {
  const result = await invoke<{ resume: MasterResume }>("import_master_resume_from_markdown", { root, markdown });
  return result.resume;
}

/** Renders the master resume to a guaranteed one-page PDF at
 *  data/resumes/resume.pdf — read-only with respect to resume.json, purely
 *  a rendering artifact. `notes` (if non-empty) lists what the one-page-fit
 *  shrink ladder had to cut. */
export async function exportResumePdf(root: string, resume: MasterResume): Promise<ExportResumePdfResult> {
  return invoke("export_resume_pdf", { root, resume });
}

/** Previews what @resume-tailor (including the humanizer skill pass)
 *  would produce for a job title/JD — a direct model call via
 *  preview_resume.py, no live application, nothing written to
 *  resume.json or any other state. `resume` is the current in-editor
 *  resume (including unsaved edits, same as exportResumePdf) — the
 *  script never re-reads resume.json itself for this call. Requires an
 *  Anthropic API key configured (ANTHROPIC_API_KEY or
 *  src/config/anthropic_key.json); its own {ok:false, error} surfaces
 *  clearly when one isn't set. */
export async function previewTailoredResume(
  root: string, title: string, company: string, jdText: string, resume: MasterResume,
): Promise<PreviewTailoredResumeResult> {
  return invoke("preview_tailored_resume", { root, title, company, jdText, resume });
}
