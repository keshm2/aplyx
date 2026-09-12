#!/usr/bin/env node
/**
 * aplyx MCP server: read-only local pipeline visibility for any MCP
 * client (Claude Desktop, Claude Code, Cursor, etc.), see
 * docs/mcp-integration-plan.md "Part 2".
 *
 * Deliberately exposes NO mutating tool (no approve_submit, no
 * dismiss_queue_entry, no triggering a run, no profile edits) — those
 * carry a materially different safety commitment (a real job application
 * going out on the user's behalf) that hasn't had its own confirmation/
 * rate-limit/audit-trail design pass yet. This server only ever reads
 * from an existing aplyx checkout's data/ and logs/ files, via the same
 * @aplyx/core functions the Tauri desktop bridge and TUI already call —
 * no new business logic, just a fourth thin frontend over the shared
 * core (see CLAUDE.md's repo map).
 *
 * Root resolution: APLYX_ROOT env var first (same convention as every
 * other aplyx entry point), then @aplyx/core's own findProjectRoot()
 * auto-detection (pinned-root file, then cwd, then this file's own
 * location). An MCP client can also pass `root` per-call to point at a
 * specific checkout, which always wins over both.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadState } from "@aplyx/core/state.js";
import { findProjectRoot } from "@aplyx/core/project.js";
import { isResolved, registryByJobId } from "@aplyx/core/stateDerive.js";
import { listResumeFiles } from "@aplyx/core/resumes.js";
import { getSchedulerStatus } from "@aplyx/core/jobs.js";

const ROOT_ARG = { root: z.string().optional().describe("Path to an aplyx checkout. Defaults to $APLYX_ROOT, then auto-detection.") };

function resolveRoot(root?: string): string {
  if (root) return root;
  if (process.env.APLYX_ROOT) return process.env.APLYX_ROOT;
  return findProjectRoot();
}

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function errorText(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const server = new McpServer({ name: "aplyx", version: "0.1.0" });

server.registerTool(
  "list_review_queue",
  {
    title: "List review queue",
    description:
      "Pending review-queue entries: applications aplyx tailored but held for a manual decision before they go out. Excludes already-resolved entries (applied/failed elsewhere, or superseded), same filter the Review queue screen uses.",
    inputSchema: ROOT_ARG,
  },
  async ({ root }) => {
    try {
      const state = loadState(resolveRoot(root));
      const pending = state.queue.filter((e) => !isResolved(state, e));
      return text(pending);
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "list_applied_jobs",
  {
    title: "List applied jobs",
    description: "Full applied-jobs history (status applied/failed/needs_review), each with company, title, url, date applied, and outcome.",
    inputSchema: {
      ...ROOT_ARG,
      status: z.enum(["applied", "failed", "needs_review"]).optional().describe("Filter to one outcome status; omit for all."),
    },
  },
  async ({ root, status }) => {
    try {
      const state = loadState(resolveRoot(root));
      const jobs = status ? state.applied.filter((j) => j.status === status) : state.applied;
      return text(jobs);
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "get_pipeline_status",
  {
    title: "Get pipeline status",
    description:
      "Registry breakdown: how many scraped jobs landed in each fit-gate outcome (applied / needs_review / skipped_unfit / other), same counts the Home dashboard's pipeline-breakdown widget shows.",
    inputSchema: ROOT_ARG,
  },
  async ({ root }) => {
    try {
      const state = loadState(resolveRoot(root));
      const counts: Record<string, number> = {};
      for (const rec of state.registry) {
        const key = rec.latest_status || "unknown";
        counts[key] = (counts[key] || 0) + 1;
      }
      return text({ total_seen: state.registry.length, by_status: counts });
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "get_job_detail",
  {
    title: "Get job detail",
    description: "Look up a single job's registry record (latest fit-gate status, company, title, url) by job_id.",
    inputSchema: { ...ROOT_ARG, job_id: z.string().describe("The job_id to look up.") },
  },
  async ({ root, job_id }) => {
    try {
      const state = loadState(resolveRoot(root));
      const rec = registryByJobId(state.registry, job_id);
      if (!rec) return errorText(new Error(`no registry record for job_id "${job_id}"`));
      return text(rec);
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "get_scheduler_status",
  {
    title: "Get scheduler status",
    description:
      "The local 30-minute background scheduler's last-run heartbeat: exit code, per-outcome counts, consecutive-failure streak, and whether the last failure was a provider usage-limit wall rather than a real error.",
    inputSchema: ROOT_ARG,
  },
  async ({ root }) => {
    try {
      return text(await getSchedulerStatus(resolveRoot(root)));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "list_resumes",
  {
    title: "List resumes",
    description: "Base resume files (by category: SWE, AI/ML, Cyber, etc.) and their markdown/PDF conversion status.",
    inputSchema: ROOT_ARG,
  },
  async ({ root }) => {
    try {
      return text(listResumeFiles(resolveRoot(root)));
    } catch (err) {
      return errorText(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("aplyx-mcp: fatal:", err);
  process.exit(1);
});
