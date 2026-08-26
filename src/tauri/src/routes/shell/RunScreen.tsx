import { useEffect, useRef, useState } from "react";
import type { PhaseInfo } from "@aplyx/core/runProgress.js";
import { useAplyxState } from "../../lib/useAplyxState";
import { useRunState, deriveRunProgress, checkForeignRun, triggerRun, stopCurrentRun } from "../../lib/useRunState";
import "../../components/formFields.css";
import "../../components/dataList.css"; // .status-badge*
import "./RunScreen.css";

const SESSION_CAP_MAX = 25;
const EXTRA_PROMPT_MAX = 500;

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function RunChecklist({ checklist }: { checklist: PhaseInfo | null }) {
  if (!checklist) return <p className="field-help">Starting…</p>;
  return (
    <div className="run-checklist" role="list" aria-label="Run progress">
      {checklist.slots.map((slot) => (
        <div key={slot.label} className={`run-checklist-slot run-checklist-${slot.state}`} role="listitem">
          <span className="run-checklist-dot" aria-hidden="true" />
          <span>{slot.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Trigger and watch a live run without leaving the app — the desktop
 * app's counterpart to the TUI's RunScreen.tsx. Rust owns the actual
 * spawn + log-tail (src-tauri/src/lib.rs's start_run/spawn_run_watcher);
 * this screen just renders whatever useRunState() has accumulated from
 * the "run:log"/"run:exit" events, so it reflects a run in progress even
 * if it was started before this screen was last mounted.
 */
export function RunScreen() {
  const { root, source } = useAplyxState();
  const run = useRunState();
  const [sessionCap, setSessionCap] = useState("");
  const [sessionCapError, setSessionCapError] = useState<string | undefined>(undefined);
  const [extraPrompt, setExtraPrompt] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (source !== "local" || !root) return;
    void checkForeignRun(root);
  }, [source, root]);

  useEffect(() => {
    if (run.phase !== "running" || !run.startedAt) return;
    const started = run.startedAt;
    setElapsed(Math.floor((Date.now() - started) / 1000));
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [run.phase, run.startedAt]);

  useEffect(() => {
    if (showRaw && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run.rawLines, showRaw]);

  if (source !== "local" || !root) {
    return (
      <div style={{ maxWidth: "42rem", margin: "0 auto" }}>
        <h1 style={{ fontSize: "var(--text-3xl)" }}>Run</h1>
        <p className="field-help">Connect a local install (Settings) to trigger runs from here.</p>
      </div>
    );
  }

  const { checklist, currentApplication } = deriveRunProgress(run);
  const localRoot = root;

  async function handleRun() {
    const trimmed = sessionCap.trim();
    if (trimmed) {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 1 || n > SESSION_CAP_MAX) {
        setSessionCapError(`Enter a whole number from 1 to ${SESSION_CAP_MAX}, or leave it blank.`);
        return;
      }
    }
    setSessionCapError(undefined);
    await triggerRun(localRoot, { sessionCap: trimmed || undefined, extraPrompt: extraPrompt.trim() || undefined });
  }

  return (
    <div style={{ maxWidth: "48rem", margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <h1 style={{ fontSize: "var(--text-3xl)" }}>Run</h1>

      {(run.phase === "idle" || run.phase === "checking") && (
        <section className="settings-section">
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Start a run</h2>
          <p className="field-help">
            Scrapes your configured boards, fit-gates, tailors a resume and cover letter, and applies —
            up to {SESSION_CAP_MAX} applications this cycle.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", margin: "var(--space-4) 0" }}>
            <div className="field">
              <label className="field-label" htmlFor="run-session-cap">
                Session cap (optional)
              </label>
              <input
                id="run-session-cap"
                type="text"
                inputMode="numeric"
                placeholder={String(SESSION_CAP_MAX)}
                value={sessionCap}
                onChange={(e) => setSessionCap(e.currentTarget.value)}
                style={{ maxWidth: "6rem" }}
              />
              <p className="field-help">Lowers this run's cap below your default in Settings. Never raises it.</p>
              {sessionCapError ? <p className="field-help" style={{ color: "var(--danger)" }}>{sessionCapError}</p> : null}
            </div>
            <div className="field">
              <label className="field-label" htmlFor="run-extra-prompt">
                Extra instruction (optional)
              </label>
              <input
                id="run-extra-prompt"
                type="text"
                maxLength={EXTRA_PROMPT_MAX}
                placeholder="Focus this run without overriding the standard workflow"
                value={extraPrompt}
                onChange={(e) => setExtraPrompt(e.currentTarget.value)}
              />
            </div>
          </div>
          <button type="button" className="settings-action-btn" disabled={run.phase === "checking"} onClick={() => void handleRun()}>
            {run.phase === "checking" ? "Checking…" : "Run now"}
          </button>
        </section>
      )}

      {run.phase === "foreign" && (
        <section className="settings-section">
          <div className="check-row">
            <span className="check-icon check-icon-pending">–</span>
            <div style={{ flex: 1 }}>
              <div className="check-label">A run is already active{run.pid ? ` (pid ${run.pid})` : ""}</div>
              <div className="check-detail">
                Started from the terminal UI, the background scheduler, or another aplyx window — only
                one run goes at a time.
              </div>
            </div>
            <button type="button" className="settings-action-btn settings-action-btn-danger" onClick={() => void stopCurrentRun()}>
              Stop it
            </button>
          </div>
        </section>
      )}

      {(run.phase === "running" || run.phase === "stopping") && (
        <section className="settings-section">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-3)" }}>
            <h2 style={{ fontSize: "var(--text-lg)" }}>Running</h2>
            <span className="status-badge status-badge-info">{formatElapsed(elapsed)}</span>
          </div>
          <RunChecklist checklist={checklist} />
          {currentApplication && (
            <p className="field-help">
              Applying to <strong>{currentApplication.title}</strong> @ {currentApplication.company}
            </p>
          )}
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
            {confirmStop ? (
              <>
                <span className="field-help" style={{ alignSelf: "center" }}>
                  Stop this run?
                </span>
                <button
                  type="button"
                  className="settings-action-btn settings-action-btn-danger"
                  onClick={() => {
                    setConfirmStop(false);
                    void stopCurrentRun();
                  }}
                >
                  Yes, stop
                </button>
                <button type="button" className="settings-action-btn" onClick={() => setConfirmStop(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="settings-action-btn settings-action-btn-danger"
                disabled={run.phase === "stopping"}
                onClick={() => setConfirmStop(true)}
              >
                {run.phase === "stopping" ? "Stopping…" : "Stop"}
              </button>
            )}
            <button type="button" className="settings-action-btn" onClick={() => setShowRaw((s) => !s)}>
              {showRaw ? "Hide raw log" : "Show raw log"}
            </button>
          </div>
          {showRaw && (
            <div ref={logRef} className="run-log-tail">
              {run.rawLines.length === 0 ? "(no output yet)" : run.rawLines.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
        </section>
      )}

      {run.phase === "done" && (
        <section className="settings-section">
          <div className="check-row">
            {/* exitCode is `null`, not 0, when the process was killed by a
             * signal (e.g. Stop) rather than exiting on its own — treat
             * that as neutral ("stopped"), not success or failure. */}
            <span
              className={`check-icon ${
                run.error || (run.exitCode !== null && run.exitCode !== 0 && run.exitCode !== undefined)
                  ? "check-icon-fail"
                  : run.exitCode === null
                    ? "check-icon-pending"
                    : "check-icon-ok"
              }`}
            >
              {run.error || (run.exitCode !== null && run.exitCode !== 0 && run.exitCode !== undefined)
                ? "!"
                : run.exitCode === null
                  ? "–"
                  : "✓"}
            </span>
            <div style={{ flex: 1 }}>
              <div className="check-label">
                {run.error
                  ? "Couldn't start the run"
                  : run.exitCode === null
                    ? "Run stopped"
                    : run.exitCode === 0
                      ? "Run complete"
                      : `Run exited with code ${run.exitCode}`}
              </div>
              {run.error && <div className="check-detail">{run.error}</div>}
              {!run.error && run.exitCode !== null && run.exitCode !== 0 && run.stderrTail.length > 0 && (
                <div className="check-detail" style={{ fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap" }}>
                  {run.stderrTail.slice(-10).join("\n")}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
            <button type="button" className="settings-action-btn" onClick={() => void handleRun()}>
              Run again
            </button>
            <button type="button" className="settings-action-btn" onClick={() => setShowRaw((s) => !s)}>
              {showRaw ? "Hide log" : "Show log"}
            </button>
          </div>
          {showRaw && (
            <div className="run-log-tail">
              {run.rawLines.length === 0 ? "(no output captured)" : run.rawLines.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
