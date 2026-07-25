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
} from "./settings.js";
import { runValidator, convertResumePdf, openPath } from "./helpers.js";
import { LocalAdapter } from "./adapters/local.js";
import { readSupabaseConfig } from "./supabaseConfig.js";
import { detectAllHarnessesOnPath, readHarnessConfig, writeHarnessConfig, isKnownHarness } from "./harness.js";
import { loadCompanyDirectory } from "./data/companyDirectory.js";
import { searchJobs, checkJobFit, saveJobForReview, type JobSource, type SearchJob } from "./jobs.js";
import { markQueueEntryApplied, dismissQueueEntry } from "./reviewActions.js";
import { listResumeFiles, resumesDir } from "./resumes.js";
import type { QueueEntry } from "./stateDerive.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Local-mode IPC bridge for the Tauri desktop app (docs/app-integration-plan.md
 * "Adapter seam"). The frontend never touches node:fs/child_process directly —
 * a Tauri webview can't — so the Rust shell (desktop/src-tauri) spawns this as
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
          `"${resolved}" doesn't look like a aplyx checkout — expected to find scripts/state/job_state.py and AGENTS.md there.`,
        );
      }
      // A manual pick self-heals future launches (and reinstalls) the
      // same way an installer-written pin does — best-effort, never
      // blocks the caller from proceeding with the now-validated root.
      try {
        writePinnedRoot(resolved);
      } catch {
        // ignore — the caller's own localStorage cache still works
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
    // each, since the Rust side has no long-lived bridge process — see
    // desktop/src-tauri/src/lib.rs's run_bridge) — a page with 5 fields
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
        applied: readDiscordRoute(root, "applied"),
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
      return convertResumePdf(root, stem, description);
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
      return { ok: true, path: dest };
    }

    case "openExtensionFolder": {
      const root = resolveRoot(args);
      openPath(path.join(root, "extension"));
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

    case "listResumeDetails": {
      const root = resolveRoot(args);
      return { files: listResumeFiles(root) };
    }

    case "openResumesFolder": {
      const root = resolveRoot(args);
      openPath(resumesDir(root));
      return { ok: true };
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

    default:
      throw new Error(`unknown bridge command: ${command}`);
  }
}

async function main(): Promise<void> {
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
    // withDeadline) so one slow/hung board can't block the whole search —
    // but a still-pending fetch() or spawned Python process left running
    // in the background would otherwise keep this process (and the Rust
    // caller's blocking wait on it) alive for as long as that straggler
    // takes, defeating the deadline entirely.
    //
    // The write callback is the flush signal for a pipe (Rust captures
    // stdout via Command::output), but if it never fires (broken pipe,
    // unusual OS condition) the Rust caller would hang forever — so a
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
