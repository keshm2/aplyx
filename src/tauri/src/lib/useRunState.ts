import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { markersIn, parsePhaseChecklist, parseCurrentApplication, type PhaseInfo } from "@aplyx/core/runProgress.js";
import { startRun, stopRun, readActiveRunPid } from "./bridge";

/**
 * Module-level (not component-level) live-run state — the desktop app's
 * version of what the TUI's RunScreen.tsx does. A run is a long-lived
 * background process, not something tied to one screen's mount lifetime,
 * so its state has to survive navigating away and back. A plain useState
 * in a screen component would lose everything the moment you click over
 * to Jobs mid-run. Rust pushes progress via the "run:log"/"run:exit"
 * Tauri events (see src-tauri/src/lib.rs's spawn_run_watcher); this
 * module is the one place listening for them, and every screen that
 * cares (Run screen, Home's quick-action) reads through useRunState()
 * instead of setting up its own listener.
 */

// Raw tail is cosmetic (the toggle-able "show full log" view), so it's
// fine to drop old lines. The marker-line accumulator is different: it's
// what parsePhaseChecklist/parseCurrentApplication actually read, and it
// can't share that small cosmetic cap, or a long, chatty run could scroll
// a real phase transition out of the window before the checklist ever
// caught it. 200 marker lines is plenty; a full 25-job run only emits
// tens of them, not hundreds.
const RAW_TAIL_BUFFER = 400;
const MARKER_BUFFER = 200;

export type RunPhase = "idle" | "checking" | "foreign" | "running" | "stopping" | "done";

export interface RunStateSnapshot {
  phase: RunPhase;
  rawLines: string[];
  markerLines: string[];
  startedAt: number | undefined;
  exitCode: number | null | undefined;
  stderrTail: string[];
  pid: number | undefined;
  error: string | undefined;
}

let snapshot: RunStateSnapshot = {
  phase: "idle",
  rawLines: [],
  markerLines: [],
  startedAt: undefined,
  exitCode: undefined,
  stderrTail: [],
  pid: undefined,
  error: undefined,
};

const listeners = new Set<() => void>();

function setSnapshot(patch: Partial<RunStateSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const l of listeners) l();
}

let installed: Promise<void> | undefined;

/** Idempotent — safe to call from every consumer; only the first call
 *  actually registers the Tauri event listeners. */
function ensureListeners(): Promise<void> {
  installed ??= (async () => {
    await listen<{ chunk: string }>("run:log", (event) => {
      const incoming = event.payload.chunk.split("\n").filter((l) => l.length > 0);
      if (incoming.length === 0) return;
      setSnapshot({
        rawLines: [...snapshot.rawLines, ...incoming].slice(-RAW_TAIL_BUFFER),
        markerLines: [...snapshot.markerLines, ...markersIn(incoming)].slice(-MARKER_BUFFER),
      });
    });
    await listen<{ code: number | null; stderr: string[] }>("run:exit", (event) => {
      setSnapshot({
        phase: "done",
        exitCode: event.payload.code,
        stderrTail: event.payload.stderr ?? [],
      });
    });
  })();
  return installed;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): RunStateSnapshot {
  return snapshot;
}

/** Live-derived, not stored: cheap to recompute from the (small,
 *  marker-only) accumulator on every render, and this way there's only
 *  one source of truth for the underlying lines. */
export function deriveRunProgress(state: RunStateSnapshot): {
  checklist: PhaseInfo | null;
  currentApplication: { title: string; company: string } | null;
} {
  return {
    checklist: parsePhaseChecklist(state.markerLines),
    currentApplication: parseCurrentApplication(state.markerLines),
  };
}

export function useRunState(): RunStateSnapshot {
  useEffect(() => {
    void ensureListeners();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Guards checkForeignRun so the actual bridge call (which spawns a Node
// subprocess — see bridge.ts's run_bridge, there's no persistent bridge
// process for one-shot commands like this) only ever runs once per app
// session, not once per mount. The bug this fixes: "idle" was both the
// initial "never checked yet" state and the resting "checked, found
// nothing" state, so gating on phase alone re-triggered a fresh
// subprocess spawn every time Home or the Run screen remounted, i.e.
// every time you navigated back to Home, even though nothing had
// changed. That was the actual perf regression reported after the Run
// nav item shipped. A later foreign run (started elsewhere while the app
// stays open) still gets caught correctly, since clicking "Run now"
// always goes through run_job_agent.py's own lock — the real guard (see
// lib.rs's start_run comment). This check is only ever a head start on
// the "already running elsewhere" UI, never load-bearing.
let foreignCheck: Promise<void> | undefined;

/** Best-effort check for a run already in flight from some other surface
 *  (TUI, scheduler, another aplyx window) before offering "Run now". The
 *  real guard is run_job_agent.py's own lock (see lib.rs's comment) — this
 *  just keeps the button from inviting a spawn that's guaranteed to exit
 *  immediately via skipped_overlap. Call on mount of anything that shows
 *  a Run control. */
export function checkForeignRun(root: string): Promise<void> {
  if (snapshot.phase !== "idle" || foreignCheck) return foreignCheck ?? Promise.resolve();
  setSnapshot({ phase: "checking" });
  foreignCheck = (async () => {
    try {
      const pid = await readActiveRunPid(root);
      setSnapshot({ phase: pid !== undefined ? "foreign" : "idle", pid });
    } catch {
      setSnapshot({ phase: "idle" });
    }
  })();
  return foreignCheck;
}

export async function triggerRun(root: string, opts?: { sessionCap?: string; extraPrompt?: string }): Promise<void> {
  await ensureListeners();
  setSnapshot({
    phase: "running",
    rawLines: [],
    markerLines: [],
    exitCode: undefined,
    stderrTail: [],
    error: undefined,
    pid: undefined,
    startedAt: Date.now(),
  });
  try {
    const { pid } = await startRun(root, opts);
    setSnapshot({ pid });
  } catch (err) {
    setSnapshot({ phase: "done", error: err instanceof Error ? err.message : String(err) });
  }
}

export async function stopCurrentRun(): Promise<void> {
  if (snapshot.pid === undefined) return;
  const wasForeign = snapshot.phase === "foreign";
  setSnapshot({ phase: "stopping" });
  try {
    await stopRun(snapshot.pid);
  } finally {
    // A foreign run never sends us a run:exit event — we didn't spawn it,
    // so there's no watcher thread on our side. Reflect the stop request
    // immediately instead of sitting on "stopping" forever. A self-started
    // run's watcher thread still delivers the real run:exit shortly after,
    // and that update wins.
    if (wasForeign) setSnapshot({ phase: "idle", pid: undefined });
  }
}
