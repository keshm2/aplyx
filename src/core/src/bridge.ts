#!/usr/bin/env node
import { findProjectRoot, isValidProjectRoot, writePinnedRoot } from "./project.js";
import {
  ensureTargetsFile,
  readDiscordEnabled,
  writeDiscordEnabled,
  readDiscordRoute,
  writeDiscordRoute,
  readOnboardingCompleted,
  writeOnboardingCompleted,
  effectiveEnv,
  writeEnvOverride,
  logDir,
} from "./settings.js";
import { runValidator, convertResumePdf, setResumeDescription, openPath, reopenApplicationFilled, triggerSingleJobApply, approveReadyToSubmit, syncGraduationFromResume } from "./helpers.js";
import { readHeartbeat, latestSessionLog, activeRunPid } from "./state.js";
import { pythonCmd } from "./platform.js";
import { LocalAdapter } from "./adapters/local.js";
import { readSupabaseConfig } from "./supabaseConfig.js";
import { detectAllHarnessesOnPath, readHarnessConfig, writeHarnessConfig, isKnownHarness } from "./harness.js";
import { loadCompanyDirectory } from "./data/companyDirectory.js";
import { searchJobs, checkJobFit, checkJobFitBatch, fetchJobDescription, getRecommendedJobs, getSchedulerStatus, setSchedulerInstalled, saveJobForReview, type JobSource, type SearchJob } from "./jobs.js";
import { markQueueEntryApplied, dismissQueueEntry } from "./reviewActions.js";
import { listResumeFiles, resumesDir } from "./resumes.js";
import { readMasterResume, writeMasterResume, initialMasterResume, importFromMarkdown, exportResumePdf, previewTailoredResume, type MasterResume } from "./masterResume.js";
import { startInMemoryCacheRefresh } from "./jobCache.js";
import type { QueueEntry } from "./stateDerive.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/**
 * Local-mode IPC bridge for the Tauri desktop app (docs/app-integration-plan.md
 * "Adapter seam"). The frontend never touches node:fs/child_process directly
 * (a Tauri webview can't), so the Rust shell (src/tauri/src-tauri) spawns this as
 * a subprocess (stdio, not a localhost server) and passes one command name
 * plus one JSON-args blob per invocation. This dispatcher reuses
 * @aplyx/core's existing functions verbatim; it adds no new business logic.
 *
 * Usage: aplyx-core-bridge <command> [jsonArgs]
 * Prints one JSON line to stdout: { ok: true, result } or { ok: false, error }.
 */

type Args = Record<string, unknown>;

function parseArgs(raw: string | undefined): Args {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("bridge args must be a JSON object");
  }
  return parsed as Args;
}

function resolveRoot(args: Args): string {
  if (typeof args.root === "string" && args.root) return args.root;
  return findProjectRoot();
}

async function dispatch(command: string, args: Args): Promise<unknown> {
  switch (command) {
    case "findRoot":
      return { root: findProjectRoot() };

    case "validateRoot": {
      const dir = String(args.dir ?? "");
      if (!dir) throw new Error("validateRoot requires { dir }");
      const resolved = path.resolve(dir);
      if (!isValidProjectRoot(resolved)) {
        throw new Error(
          `"${resolved}" doesn't look like a aplyx checkout: expected to find src/scripts/state/job_state.py and AGENTS.md there.`,
        );
      }
      // A manual pick self-heals future launches (and reinstalls) the
      // same way an installer-written pin does; best-effort, never
      // blocks the caller from proceeding with the now-validated root.
      try {
        writePinnedRoot(resolved);
      } catch {
        // ignore; the caller's own localStorage cache still works
      }
      return { root: resolved };
    }

    case "ensureTargetsFile": {
      const root = resolveRoot(args);
      ensureTargetsFile(root);
      return { ok: true };
    }

    case "readProfileField": {
      const root = resolveRoot(args);
      const id = String(args.id ?? "");
      if (!id) throw new Error("readProfileField requires { id }");
      const adapter = new LocalAdapter(root);
      return { value: await adapter.readProfileField(id) };
    }

    case "writeProfileField": {
      const root = resolveRoot(args);
      const id = String(args.id ?? "");
      if (!id) throw new Error("writeProfileField requires { id }");
      const value = args.value as string | string[];
      const adapter = new LocalAdapter(root);
      await adapter.writeProfileField(id, value);
      return { ok: true };
    }

    // Batched siblings of readProfileField/writeProfileField: the desktop
    // app's onboarding ProfileStep and Settings' ProfileScreen used to fire
    // one bridge call per field (one per-call `node <script>` process spawn
    // each, since the Rust side has no long-lived bridge process, see
    // src/tauri/src-tauri/src/lib.rs's run_bridge), a page with 5 fields
    // meant 5 concurrent cold-started node processes just to load it, and
    // another 5 to save it. Reported live as multiple flashing console
    // windows per click and multi-second page transitions on Windows,
    // where process creation is heavier than on macOS/Linux. One call for
    // the whole page (or, for ProfileScreen's initial load, the whole
    // field set) collapses that down to a single spawn.
    case "readProfileFields": {
      const root = resolveRoot(args);
      const ids = args.ids;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
        throw new Error("readProfileFields requires { ids: string[] }");
      }
      const adapter = new LocalAdapter(root);
      const values: Record<string, unknown> = {};
      for (const id of ids as string[]) {
        values[id] = await adapter.readProfileField(id);
      }
      return { values };
    }

    case "writeProfileFields": {
      const root = resolveRoot(args);
      const values = args.values;
      if (typeof values !== "object" || values === null || Array.isArray(values)) {
        throw new Error("writeProfileFields requires { values: Record<string, string | string[]> }");
      }
      const adapter = new LocalAdapter(root);
      for (const [id, value] of Object.entries(values as Record<string, string | string[]>)) {
        await adapter.writeProfileField(id, value);
      }
      return { ok: true };
    }

    case "loadState": {
      const root = resolveRoot(args);
      const adapter = new LocalAdapter(root);
      return (await adapter.loadState()) ?? null;
    }

    case "runValidator": {
      const root = resolveRoot(args);
      return runValidator(root);
    }

    case "readSupabaseConfig": {
      const root = resolveRoot(args);
      return readSupabaseConfig(root);
    }

    case "detectHarnesses":
      return { detected: detectAllHarnessesOnPath() };

    case "listCompanies": {
      const root = resolveRoot(args);
      const seen = new Set<string>();
      const companies: string[] = [];
      for (const entry of loadCompanyDirectory(root)) {
        if (seen.has(entry.display)) continue;
        seen.add(entry.display);
        companies.push(entry.display);
      }
      return { companies };
    }

    case "readHarness": {
      const root = resolveRoot(args);
      return { harness: readHarnessConfig(root) ?? null };
    }

    case "writeHarness": {
      const root = resolveRoot(args);
      const harness = String(args.harness ?? "");
      if (!isKnownHarness(harness)) throw new Error(`unknown harness: ${harness}`);
      writeHarnessConfig(root, harness);
      return { ok: true };
    }

    case "readDiscordConfig": {
      const root = resolveRoot(args);
      return {
        enabled: readDiscordEnabled(root),
        success: readDiscordRoute(root, "success"),
        needs_review: readDiscordRoute(root, "needs_review"),
        failed: readDiscordRoute(root, "failed"),
        summary: readDiscordRoute(root, "summary"),
      };
    }

    case "writeDiscordConfig": {
      const root = resolveRoot(args);
      if (typeof args.enabled === "boolean") writeDiscordEnabled(root, args.enabled);
      const routes = (args.routes as Record<string, string> | undefined) ?? {};
      for (const [route, url] of Object.entries(routes)) {
        writeDiscordRoute(root, route, url);
      }
      return { ok: true };
    }

    case "listResumes": {
      const root = resolveRoot(args);
      const dir = path.join(root, "data", "resumes");
      try {
        return { files: fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf")) };
      } catch {
        return { files: [] };
      }
    }

    case "convertResume": {
      const root = resolveRoot(args);
      const stem = String(args.stem ?? "");
      if (!stem) throw new Error("convertResume requires { stem }");
      const description = String(args.description ?? "");
      const force = Boolean(args.force ?? false);
      return convertResumePdf(root, stem, description, force);
    }

    case "setResumeDescription": {
      const root = resolveRoot(args);
      const stem = String(args.stem ?? "");
      if (!stem) throw new Error("setResumeDescription requires { stem }");
      const description = String(args.description ?? "");
      return setResumeDescription(root, stem, description);
    }

    case "importResumeFile": {
      const root = resolveRoot(args);
      const sourcePath = String(args.sourcePath ?? "");
      const stem = String(args.stem ?? "");
      if (!sourcePath || !stem) throw new Error("importResumeFile requires { sourcePath, stem }");
      const dir = path.join(root, "data", "resumes");
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${stem}.pdf`);
      fs.copyFileSync(sourcePath, dest);
      // Resumes carry the user's full PII (name, address, phone, education
      // history); don't rely on ambient umask for a file living outside
      // data/'s otherwise-consistent handling.
      fs.chmodSync(dest, 0o600);
      return { ok: true, path: dest };
    }

    case "importResumeBytes": {
      // Counterpart to importResumeFile above for a resume that doesn't
      // exist as a local file yet; the hosted-to-local profile pull
      // (docs/web-onboarding-hosted-sync-plan.md Part B) downloads a PDF
      // from Supabase Storage in the webview and hands it here as base64
      // (JSON has no binary type; the Rust IPC layer round-trips it as a
      // plain string same as every other bridge arg).
      const root = resolveRoot(args);
      const stem = String(args.stem ?? "");
      const base64 = String(args.base64 ?? "");
      if (!stem || !base64) throw new Error("importResumeBytes requires { stem, base64 }");
      const dir = path.join(root, "data", "resumes");
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${stem}.pdf`);
      fs.writeFileSync(dest, Buffer.from(base64, "base64"));
      // Same PII-carrying-file reasoning as importResumeFile above.
      fs.chmodSync(dest, 0o600);
      return { ok: true, path: dest };
    }

    case "importDocumentFile": {
      // A generic single-file-per-kind store for documents that are
      // never parsed or tailored by aplyx: unlike resumes.ts's
      // multi-file, stem-keyed model, a "kind" (e.g. "transcript") has
      // exactly one current file, overwritten on re-upload, extension
      // preserved from the source pick.
      const root = resolveRoot(args);
      const sourcePath = String(args.sourcePath ?? "");
      const kind = String(args.kind ?? "");
      if (!sourcePath || !kind) throw new Error("importDocumentFile requires { sourcePath, kind }");
      if (!/^[a-z0-9_-]+$/i.test(kind)) throw new Error("invalid kind");
      const rawExt = path.extname(sourcePath) || ".pdf";
      const ext = /^\.[a-z0-9]+$/i.test(rawExt) ? rawExt : ".pdf";
      const dir = path.join(root, "data", "documents");
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${kind}${ext}`);
      fs.copyFileSync(sourcePath, dest);
      // A transcript can carry PII (DOB, student ID): same file-
      // permission discipline as resumes.
      fs.chmodSync(dest, 0o600);
      return { ok: true, path: dest };
    }

    case "getDocumentStatus": {
      const root = resolveRoot(args);
      const kind = String(args.kind ?? "");
      if (!kind) throw new Error("getDocumentStatus requires { kind }");
      if (!/^[a-z0-9_-]+$/i.test(kind)) throw new Error("invalid kind");
      const dir = path.join(root, "data", "documents");
      if (!fs.existsSync(dir)) return { exists: false };
      const match = fs.readdirSync(dir).find((f) => f.startsWith(`${kind}.`));
      if (!match) return { exists: false };
      const stat = fs.statSync(path.join(dir, match));
      return { exists: true, filename: match, uploadedAt: stat.mtime.toISOString() };
    }

    case "openExtensionFolder": {
      const root = resolveRoot(args);
      openPath(path.join(root, "src", "extension"));
      return { ok: true };
    }

    case "searchJobs": {
      const root = resolveRoot(args);
      const query = String(args.query ?? "");
      const sources = (args.sources as Partial<Record<JobSource, boolean>> | undefined) ?? {};
      return searchJobs(root, query, sources);
    }

    case "checkJobFit": {
      const root = resolveRoot(args);
      const job = args.job as SearchJob;
      if (!job) throw new Error("checkJobFit requires { job }");
      return checkJobFit(root, job);
    }

    case "checkJobFitBatch": {
      const root = resolveRoot(args);
      const jobs = args.jobs as SearchJob[];
      if (!jobs) throw new Error("checkJobFitBatch requires { jobs }");
      return checkJobFitBatch(root, jobs);
    }

    case "fetchJobDescription": {
      const root = resolveRoot(args);
      const job = args.job as SearchJob;
      if (!job) throw new Error("fetchJobDescription requires { job }");
      return fetchJobDescription(root, job);
    }

    case "getRecommendedJobs": {
      const root = resolveRoot(args);
      const excludeJobIds = Array.isArray(args.excludeJobIds) ? (args.excludeJobIds as string[]) : [];
      return getRecommendedJobs(root, excludeJobIds);
    }

    case "getSchedulerStatus": {
      const root = resolveRoot(args);
      return getSchedulerStatus(root);
    }

    case "setSchedulerInstalled": {
      const root = resolveRoot(args);
      return setSchedulerInstalled(root, Boolean(args.installed));
    }

    case "saveJobForReview": {
      const root = resolveRoot(args);
      const job = args.job as SearchJob;
      if (!job) throw new Error("saveJobForReview requires { job }");
      const result = await saveJobForReview(root, job);
      return { result };
    }

    case "markQueueEntryApplied": {
      const root = resolveRoot(args);
      const entry = args.entry as QueueEntry;
      if (!entry) throw new Error("markQueueEntryApplied requires { entry }");
      return markQueueEntryApplied(root, entry);
    }

    case "dismissQueueEntry": {
      const root = resolveRoot(args);
      const entry = args.entry as QueueEntry;
      if (!entry) throw new Error("dismissQueueEntry requires { entry }");
      return dismissQueueEntry(root, entry);
    }

    case "reopenApplicationFilled": {
      const root = resolveRoot(args);
      const jobId = String(args.jobId ?? "");
      if (!jobId) throw new Error("reopenApplicationFilled requires { jobId }");
      return reopenApplicationFilled(root, jobId);
    }

    // Confirm-before-submit "Approve" action (docs/hosted-auto-apply-plan.md
    // Stage 1): the agent ran the full pipeline through pre-submit
    // verification then paused with a filled-but-not-submitted form. For
    // local Greenhouse entries, this now runs a deterministic submit helper
    // (approve_submit_greenhouse.py) that replays the saved fill record and
    // clicks the final submit, then records an applied outcome on success.
    // Other families remain unsupported here until their own deterministic
    // submit helpers exist.
    case "approveSubmit": {
      const root = resolveRoot(args);
      const entry = args.entry as QueueEntry;
      if (!entry) throw new Error("approveSubmit requires { entry }");
      const workday = args.workday as { aliasEmail?: string; aliasId?: string; accountEmail?: string; sessionSecretFile?: string; credentialFile?: string } | undefined;
      const hasWdContext = Boolean(workday?.aliasEmail || workday?.accountEmail || workday?.sessionSecretFile);
      const result = approveReadyToSubmit(root, entry, hasWdContext ? {
        aliasEmail: workday?.aliasEmail,
        aliasId: workday?.aliasId,
        accountEmail: workday?.accountEmail,
        sessionSecretFile: workday?.sessionSecretFile,
        credentialFile: workday?.credentialFile,
      } : undefined);
      if (!result.ok) return result;
      // Workday's local runtime is resumable: most continuation runs pause
      // mid-flow (account created awaiting verification, page filled, etc.)
      // and must NOT be recorded as applied: only an explicit
      // outcome="submitted" from the script is a real application. Every
      // other Workday result (checkpoint, failed, or the verification/
      // account-creation branches with no outcome field) stays in the
      // review queue for the next continuation or manual triage.
      // Use the same source/host detection as approveReadyToSubmit
      // (helpers.ts) so a Workday-hosted entry whose source field isn't
      // "workday" (e.g. re-sourced from SimplifyJobs but applying on a
      // myworkdayjobs.com URL) is still caught by this guard and can't
      // be marked applied from a non-submitted checkpoint.
      const wdTargetUrl = entry.apply_url || entry.url;
      let wdHost = "";
      try { wdHost = new URL(wdTargetUrl).hostname; } catch { wdHost = ""; }
      const isWorkdayEntry = (entry.source ?? "").toLowerCase() === "workday" ||
        wdHost.toLowerCase().endsWith(".myworkdayjobs.com");
      if (isWorkdayEntry) {
        if (result.outcome !== "submitted") return result;
        // A confirmed Workday submit: record the applied outcome the same
        // way Greenhouse/Lever/Ashby do. Wrapped so a missing-field
        // failure on the (needs_review-shaped) entry can't lose the real
        // success message the script already returned: the application
        // WAS submitted; the state write is the recoverable part.
        try {
          const recorded = markQueueEntryApplied(root, entry);
          return { ...result, message: `${result.message} ${recorded.message}`.trim() };
        } catch (err) {
          return { ...result, message: `${result.message} (state record skipped: ${err instanceof Error ? err.message : String(err)})` };
        }
      }
      const recorded = markQueueEntryApplied(root, entry);
      return { ok: true, message: `${result.message} ${recorded.message}`.trim() };
    }

    // Reads a confirm-before-submit screenshot (the filled-form snapshot the
    // agent captures before pausing) as a base64 data URL for the webview to
    // render: the webview can't read local files directly. Same path-shape
    // validation posture as readFillRecord: screenshots live under
    // data/screenshots/ or logs/tmp/ (AGENTS.md's "PREFER logs/tmp/" rule),
    // never an arbitrary caller-supplied path.
    case "readScreenshot": {
      const root = resolveRoot(args);
      const relPath = String(args.path ?? "");
      if (!/^(data\/screenshots|logs\/tmp)\/[^/\\]+\.(png|jpg|jpeg|webp)$/i.test(relPath)) {
        throw new Error(`readScreenshot: unexpected path shape ${JSON.stringify(relPath)}`);
      }
      try {
        const buffer = fs.readFileSync(path.join(root, relPath));
        const ext = path.extname(relPath).slice(1).toLowerCase();
        const mime = ext === "webp" ? "webp" : ext === "jpg" || ext === "jpeg" ? "jpeg" : "png";
        return { dataUrl: `data:image/${mime};base64,${buffer.toString("base64")}` };
      } catch {
        return { dataUrl: null };
      }
    }

    case "triggerSingleJobApply": {
      const root = resolveRoot(args);
      const job = args.job as { company: string; title: string; url: string; source: string } | undefined;
      if (!job || !job.company || !job.title || !job.url || !job.source) {
        throw new Error("triggerSingleJobApply requires { job: { company, title, url, source } }");
      }
      return triggerSingleJobApply(root, job);
    }

    case "listResumeDetails": {
      const root = resolveRoot(args);
      return { files: listResumeFiles(root) };
    }

    case "openResumesFolder": {
      const root = resolveRoot(args);
      openPath(resumesDir(root));
      return { ok: true };
    }

    case "getMasterResume": {
      const root = resolveRoot(args);
      const existing = readMasterResume(root);
      return { resume: existing ?? initialMasterResume(root), isNew: existing === null };
    }

    case "setMasterResume": {
      const root = resolveRoot(args);
      const resume = args.resume as MasterResume;
      if (!resume) throw new Error("setMasterResume requires { resume }");
      writeMasterResume(root, resume);
      // The resume is the source of truth for the graduation date: keep
      // safe_fields.graduation_date (fit gate + form-fill + Settings) in
      // step with what the candidate just saved.
      const graduation = syncGraduationFromResume(root);
      return { ok: true, graduation };
    }

    case "readFillRecord": {
      // AppliedJob.fill_record_path (stateDerive.ts): always exactly
      // "data/fill_records/<job_id>.json", written once by
      // record_fill.py and never elsewhere. Validated against that exact
      // shape (not just "resolves under root") before reading, same
      // defensive posture as every other path this bridge accepts from
      // state-file content rather than a direct caller argument.
      const root = resolveRoot(args);
      const relPath = String(args.path ?? "");
      if (!/^data\/fill_records\/[^/\\]+\.json$/.test(relPath)) {
        throw new Error(`readFillRecord: unexpected path shape ${JSON.stringify(relPath)}`);
      }
      try {
        const text = fs.readFileSync(path.join(root, relPath), "utf8");
        return { record: JSON.parse(text) };
      } catch {
        return { record: null };
      }
    }

    case "readWorkdayCheckpoint": {
      const root = resolveRoot(args);
      const jobId = String(args.jobId ?? "").trim();
      if (!jobId || !/^[A-Za-z0-9_.:-]+$/.test(jobId)) {
        throw new Error(`readWorkdayCheckpoint: unexpected job id ${JSON.stringify(jobId)}`);
      }
      const relPath = path.join("data", "workday_apply_runs", `${jobId}.json`);
      try {
        const text = fs.readFileSync(path.join(root, relPath), "utf8");
        return { checkpoint: JSON.parse(text) };
      } catch {
        return { checkpoint: null };
      }
    }

    // Writes a one-time verification secret (link and/or OTP) consumed from
    // a hosted verification session to logs/tmp/session_secret_<jobId>.json
    // so the Workday runtime can read it via --session-secret-file instead
    // of argv: the raw value never appears in a process argument list, shell
    // history, or log snapshot. The file is a transient handoff channel; the
    // runtime reads and uses the value, and the secret is already redacted
    // server-side by the consume RPC, so the file's contents are stale after
    // one use. Returns the absolute path the caller passes to approveSubmit.
    case "writeSessionSecretFile": {
      const root = resolveRoot(args);
      const jobId = String(args.jobId ?? "").trim();
      if (!jobId || !/^[A-Za-z0-9_.:-]+$/.test(jobId)) {
        throw new Error(`writeSessionSecretFile: unexpected job id ${JSON.stringify(jobId)}`);
      }
      const secret = args.secret as { link?: string; otp?: string } | undefined;
      if (!secret || (!secret.link && !secret.otp)) {
        throw new Error("writeSessionSecretFile requires { secret: { link?, otp? } } with at least one value");
      }
      const dir = path.join(root, "logs", "tmp");
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `session_secret_${jobId}.json`);
      // 0600: the file holds a one-time verification credential, even
      // though it's stale after one use; same posture as the password
      // sidecar.
      fs.writeFileSync(filePath, JSON.stringify({ link: secret.link ?? null, otp: secret.otp ?? null }), { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
      return { path: filePath };
    }

    case "readResumeMarkdown": {
      const root = resolveRoot(args);
      const stem = String(args.stem ?? "");
      if (!stem) throw new Error("readResumeMarkdown requires { stem }");
      try {
        const text = fs.readFileSync(path.join(resumesDir(root), `${stem}.md`), "utf8");
        return { text };
      } catch {
        return { text: null };
      }
    }

    case "importMasterResumeFromMarkdown": {
      const root = resolveRoot(args);
      const markdown = String(args.markdown ?? "");
      if (!markdown) throw new Error("importMasterResumeFromMarkdown requires { markdown }");
      const base = readMasterResume(root) ?? initialMasterResume(root);
      return { resume: importFromMarkdown(markdown, base) };
    }

    case "exportResumePdf": {
      const root = resolveRoot(args);
      const resume = args.resume as MasterResume;
      if (!resume) throw new Error("exportResumePdf requires { resume }");
      return exportResumePdf(root, resume);
    }

    case "previewTailoredResume": {
      const root = resolveRoot(args);
      const title = String(args.title ?? "");
      const company = String(args.company ?? "");
      const jdText = String(args.jdText ?? "");
      const resume = args.resume as MasterResume;
      if (!title) throw new Error("previewTailoredResume requires { title }");
      if (!jdText) throw new Error("previewTailoredResume requires { jdText }");
      if (!resume) throw new Error("previewTailoredResume requires { resume }");
      return previewTailoredResume(root, title, company, jdText, resume);
    }

    case "readOnboardingCompleted": {
      const root = resolveRoot(args);
      return { completed: readOnboardingCompleted(root) };
    }

    case "writeOnboardingCompleted": {
      const root = resolveRoot(args);
      writeOnboardingCompleted(root, Boolean(args.completed));
      return { ok: true };
    }

    // Generic src/config/env.json override read/write. Same mechanism the
    // TUI's Settings screen uses for APLYX_SESSION_CAP, APLYX_24_HOUR_CLOCK,
    // APLYX_REDUCED_MOTION, etc. (theme.ts, SettingsScreen.tsx). Kept generic
    // instead of one bridge case per key, so a new env-backed setting just
    // needs a field in the desktop app's Settings screen, nothing here.
    case "readEnvOverride": {
      const root = resolveRoot(args);
      const key = String(args.key ?? "");
      const legacyKeys = Array.isArray(args.legacyKeys) ? (args.legacyKeys as unknown[]).map(String) : [];
      const fallback = typeof args.fallback === "string" ? args.fallback : "";
      return effectiveEnv(root, [key, ...legacyKeys], fallback);
    }

    case "writeEnvOverride": {
      const root = resolveRoot(args);
      const key = String(args.key ?? "");
      const value = String(args.value ?? "");
      writeEnvOverride(root, key, value);
      return { ok: true };
    }

    // Live-run support for the desktop app's Run screen, mirroring the
    // TUI's RunScreen.tsx/run.ts. The long-lived spawn and log-tail have to
    // happen in Rust (src-tauri/src/lib.rs) since this bridge is one-shot
    // request/response. But the lookups below are cheap and already exist,
    // and they need to match run_job_agent.py's contract exactly, so it's
    // easier to reuse them here than reimplement in Rust.
    case "activeRunPid": {
      const root = resolveRoot(args);
      return { pid: activeRunPid(root) ?? null };
    }

    case "readHeartbeat": {
      const root = resolveRoot(args);
      return readHeartbeat(root) ?? null;
    }

    case "latestSessionLog": {
      const root = resolveRoot(args);
      return { path: latestSessionLog(root) ?? null };
    }

    // Which interpreter run_job_agent.py should be spawned with. Reuses
    // pythonCmd()'s existing candidate probing (it prefers whichever
    // candidate actually has Playwright installed, see platform.ts), so
    // a Rust-side spawn doesn't end up picking a different, Playwright-less
    // python than everything else already agreed on.
    case "resolvePython": {
      const p = pythonCmd();
      return { cmd: p.cmd, args: p.prefix };
    }

    // Resolved log directory. Defaults to root/logs, but it's overridable
    // via APLYX_LOG_DIR/env.json and can even be absolute (settings.ts's
    // logDir()). The Rust-side log tailer needs this exact value, not a
    // hardcoded "root/logs" guess, or a custom log dir would just never
    // get tailed.
    case "resolveLogDir": {
      const root = resolveRoot(args);
      return { dir: logDir(root) };
    }

    default:
      throw new Error(`unknown bridge command: ${command}`);
  }
}

/**
 * The 4 sources readJobCache() can serve from a shared, curated
 * company list (see jobCache.ts's header): the same set searchJobs()
 * already treats as cache-eligible via maybeCached()'s union logic.
 * Kept here rather than imported from jobs.ts to avoid a cross-module
 * "list of sources" duplicating what maybeCached's own call sites
 * already encode implicitly; this is only used to seed the in-memory
 * warm loop, not to gate anything correctness-sensitive.
 */
const IN_MEMORY_CACHE_SOURCES: JobSource[] = ["ashbyhq", "lever", "greenhouse", "smartrecruiters"];

/**
 * Persistent daemon mode (`aplyx-core-bridge --serve`): the process
 * this file's default `main()` normally is (spawn, run one command,
 * exit) stays completely unchanged and is still what every command
 * OTHER than search uses. This mode exists for exactly one reason:
 * jobCache.ts's in-memory browse-all snapshot only means anything
 * inside a process that stays alive across searches; a one-shot
 * spawn-per-command process throws that state away on exit before a
 * second search could ever benefit from it. src/tauri/src-tauri/src/
 * lib.rs spawns this once (lazily, on first search) and keeps its
 * stdin/stdout piped open for the rest of the app session instead of
 * spawning fresh each time, falling back to the normal one-shot path
 * on any failure; this mode is purely additive, never load-bearing
 * for correctness.
 *
 * Protocol: one JSON object per line in both directions,
 * `{ id, command, args }` in, `{ id, ok, result }` or
 * `{ id, ok: false, error }` out. Requests are NOT processed one at a
 * time: dispatch() is invoked as soon as a line arrives and its
 * response is written whenever it resolves, independent of arrival
 * order, so concurrent callers (e.g. the desktop app's two-phase
 * search firing both searchJobs() calls at once, see JobsScreen.tsx)
 * are never serialized behind each other the way they would be if
 * this read one line, awaited fully, then read the next.
 */
async function serve(): Promise<void> {
  const root = findProjectRoot();
  startInMemoryCacheRefresh(root, IN_MEMORY_CACHE_SOURCES);

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    void handleServeLine(line);
  });
  // Nothing left to read from stdin (the Rust parent dropped its
  // handle, e.g. on app quit): exit cleanly rather than idle forever
  // as an orphaned process.
  rl.on("close", () => process.exit(0));
}

async function handleServeLine(line: string): Promise<void> {
  let id: unknown;
  try {
    const parsed = JSON.parse(line) as { id: unknown; command: string; args?: Args };
    id = parsed.id;
    const result = await dispatch(parsed.command, parsed.args ?? {});
    process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${JSON.stringify({ id, ok: false, error: message })}\n`);
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "--serve") {
    return serve();
  }
  const [command, rawArgs] = process.argv.slice(2);
  if (!command) {
    process.stderr.write("usage: aplyx-core-bridge <command> [jsonArgs]\n");
    process.exit(2);
  }
  try {
    const result = await dispatch(command, parseArgs(rawArgs));
    // Exit right after the write flushes rather than letting Node idle
    // until every promise/timer settles naturally. Commands like
    // searchJobs race each source against a hard deadline (see jobs.ts's
    // withDeadline) so one slow/hung board can't block the whole search:
    // but a still-pending fetch() or spawned Python process left running
    // in the background would otherwise keep this process (and the Rust
    // caller's blocking wait on it) alive for as long as that straggler
    // takes, defeating the deadline entirely.
    //
    // The write callback is the flush signal for a pipe (Rust captures
    // stdout via Command::output), but if it never fires (broken pipe,
    // unusual OS condition) the Rust caller would hang forever, so a
    // short unref'd fallback timer caps the wait. The timer is moot in
    // the normal path since process.exit() fires first.
    exitWith(`${JSON.stringify({ ok: true, result })}\n`, 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    exitWith(`${JSON.stringify({ ok: false, error: message })}\n`, 1);
  }
}

function exitWith(payload: string, code: number): void {
  const fallback = setTimeout(() => process.exit(code), 2_000);
  fallback.unref?.();
  process.stdout.write(payload, () => process.exit(code));
}

main();
