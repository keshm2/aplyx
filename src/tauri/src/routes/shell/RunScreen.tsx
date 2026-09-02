import { useEffect, useRef, useState } from "react";
import type { PhaseInfo } from "@aplyx/core/runProgress.js";
import { todayIso } from "@aplyx/core/stateDerive.js";
import { useAplyxState } from "../../lib/useAplyxState";
import { useRunState, deriveRunProgress, checkForeignRun, triggerRun, stopCurrentRun } from "../../lib/useRunState";
import { WeeklyActivityChart } from "../../components/WeeklyActivityChart";
import "../../components/formFields.css";
import "../../components/dataList.css"; // .status-badge*, .metric-bar*
import "./RunScreen.css";

const SESSION_CAP_MAX = 25;
const EXTRA_PROMPT_MAX = 500;
const SESSION_CAP_PRESETS = [5, 10, 15, SESSION_CAP_MAX];

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
 * Trigger and watch a live run without leaving the app: the desktop
 * app's counterpart to the TUI's RunScreen.tsx. Rust owns the actual
 * spawn + log-tail (src-tauri/src/lib.rs's start_run/spawn_run_watcher);
 * this screen just renders whatever useRunState() has accumulated from
 * the "run:log"/"run:exit" events, so it reflects a run in progress even
 * if it was started before this screen was last mounted.
 */
export function RunScreen() {
  const { root, source, state, loaded } = useAplyxState();
  const run = useRunState();
  // 0 = no override (use the default cap from Settings); 1..SESSION_CAP_MAX
  // is an explicit lower cap for this run only. A slider can't represent
  // "leave blank" the way the old text input did, so 0 is its own position
  // on the track rather than an empty string.
  const [sessionCapValue, setSessionCapValue] = useState(0);
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
  const appliedToday = state ? state.applied.filter((j) => j.date_applied === todayIso()).length : 0;
  const todayLabel = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  async function handleRun() {
    await triggerRun(localRoot, {
      sessionCap: sessionCapValue > 0 ? String(sessionCapValue) : undefined,
      extraPrompt: extraPrompt.trim() || undefined,
    });
  }

  return (
    <div style={{ maxWidth: "54rem", margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <header className="run-header">
        <div className="run-header-text">
          <h1>Run</h1>
          <p>{todayLabel}</p>
        </div>
      </header>

      {/* A live run is the one thing you watch moment-to-moment, so it sits
          right under the header; the history metrics + charts + the
          start-a-run "menu" only render when a run isn't actively going. */}
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

      {loaded && state && run.phase !== "running" && run.phase !== "stopping" && (
        <div className="metric-bar aplyx-fade-rise">
          <div className="metric">
            <div className="metric-top">
              <span className="metric-icon metric-icon-good" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </span>
              <span className="metric-label">Applied today</span>
            </div>
            <span className="metric-value" style={{ color: "var(--good)" }}>
              {appliedToday}
            </span>
          </div>
          <div className="metric">
            <div className="metric-top">
              <span className="metric-icon metric-icon-neutral" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v9M8 3h8" />
                </svg>
              </span>
              <span className="metric-label">Session cap</span>
            </div>
            <span className="metric-value">{sessionCapValue > 0 ? sessionCapValue : SESSION_CAP_MAX}</span>
            <span className="metric-caption">{sessionCapValue > 0 ? "This run's cap" : "Max applications per run"}</span>
          </div>
          <div className="metric">
            <div className="metric-top">
              <span className="metric-icon metric-icon-neutral" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </span>
              <span className="metric-label">All-time applications</span>
            </div>
            <span className="metric-value">{state.applied.length}</span>
          </div>
        </div>
      )}

      {loaded && state && state.applied.length > 0 && run.phase !== "running" && run.phase !== "stopping" && (
        <div className="run-charts">
          <WeeklyActivityChart applied={state.applied} metric="sent" title="Applications per day" compact logScale />
          <WeeklyActivityChart applied={state.applied} metric="cumulative" title="Cumulative total" compact logScale />
        </div>
      )}

      {(run.phase === "idle" || run.phase === "checking") && (
        <section className="settings-section run-start-card">
          <div className="run-start-header">
            <span className="run-start-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 4l14 8-14 8V4z" />
              </svg>
            </span>
            <div>
              <h2>Start a run</h2>
              <p className="field-help">Scrapes your configured boards, fit-gates, tailors a resume and cover letter, and applies.</p>
            </div>
          </div>

          <div className="run-slider-block">
            <div className="run-slider-label-row">
              <span className="field-label">Session cap</span>
              <span className="run-slider-value">{sessionCapValue === 0 ? "Default" : sessionCapValue}</span>
            </div>
            <input
              type="range"
              className="aplyx-slider"
              min={0}
              max={SESSION_CAP_MAX}
              value={sessionCapValue}
              aria-label="Session cap"
              style={{ ["--slider-fill" as string]: `${(sessionCapValue / SESSION_CAP_MAX) * 100}%` }}
              onChange={(e) => setSessionCapValue(Number(e.currentTarget.value))}
            />
            <div className="run-slider-presets">
              <button
                type="button"
                className={sessionCapValue === 0 ? "run-preset-btn run-preset-btn-active" : "run-preset-btn"}
                onClick={() => setSessionCapValue(0)}
              >
                Default
              </button>
              {SESSION_CAP_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={sessionCapValue === n ? "run-preset-btn run-preset-btn-active" : "run-preset-btn"}
                  onClick={() => setSessionCapValue(n)}
                >
                  {n === SESSION_CAP_MAX ? "Max" : n}
                </button>
              ))}
            </div>
            <p className="field-help">Lowers this run's cap below your default in Settings. Never raises it.</p>
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

          <button
            type="button"
            className="btn btn-primary run-start-cta"
            disabled={run.phase === "checking"}
            onClick={() => void handleRun()}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M6 4l14 8-14 8V4z" />
            </svg>
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
                Started from the terminal UI, the background scheduler, or another aplyx window. Only
                one run goes at a time.
              </div>
            </div>
            <button type="button" className="settings-action-btn settings-action-btn-danger" onClick={() => void stopCurrentRun()}>
              Stop it
            </button>
          </div>
        </section>
      )}

      {run.phase === "done" && (
        <section className="settings-section">
          <div className="check-row">
            {/* exitCode is `null`, not 0, when the process was killed by a
             * signal (e.g. Stop) rather than exiting on its own: treat
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
