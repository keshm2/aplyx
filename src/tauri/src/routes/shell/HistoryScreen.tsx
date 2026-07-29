import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AplyxState, AppliedJob } from "@aplyx/core/state.js";
import { findRoot, loadLocalState } from "../../lib/bridge";
import "../../components/formFields.css";
import "../../components/dataList.css";

const STATUS_BADGE: Record<string, string> = {
  applied: "status-badge-good",
  needs_review: "status-badge-warn",
  failed: "status-badge-danger",
};

const STATUS_LABEL: Record<string, string> = {
  applied: "Applied",
  needs_review: "Needs review",
  failed: "Failed",
};

export function HistoryScreen() {
  const [state, setState] = useState<AplyxState | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | undefined>(undefined);

  useEffect(() => {
    findRoot()
      .then(async (root) => setState((await loadLocalState(root)) as AplyxState))
      .catch(() => setState(undefined))
      .finally(() => setLoaded(true));
  }, []);

  const jobs = useMemo(() => [...(state?.applied ?? [])].reverse(), [state]);
  const totals = { applied: 0, needs_review: 0, failed: 0 };
  for (const job of jobs) {
    if (job.status in totals) totals[job.status as keyof typeof totals] += 1;
  }
  const selectedJob = jobs.find((j) => j.job_id === selected);

  // Land on the newest record rather than a blank detail pane.
  useEffect(() => {
    if (jobs.length > 0 && !jobs.some((j) => j.job_id === selected)) setSelected(jobs[0]!.job_id);
  }, [jobs, selected]);

  const open = async (job: AppliedJob) => {
    try {
      await openUrl(job.apply_url || job.url);
      setMessage({ text: `Opened ${job.apply_url || job.url}` });
    } catch (err) {
      setMessage({ text: `Could not open: ${err instanceof Error ? err.message : String(err)}`, error: true });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <div>
        <h1 style={{ fontSize: "var(--text-3xl)", marginBottom: "var(--space-2)" }}>History</h1>
        <div className="data-toolbar">
          <span style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
            {jobs.length} outcome{jobs.length === 1 ? "" : "s"}, newest first
          </span>
          {jobs.length > 0 && (
            <>
              <span className="status-badge status-badge-good">{totals.applied} applied</span>
              <span className="status-badge status-badge-warn">{totals.needs_review} review</span>
              <span className="status-badge status-badge-danger">{totals.failed} failed</span>
            </>
          )}
        </div>
      </div>

      {message ? (
        <div className={message.error ? "message-banner message-banner-error" : "message-banner"}>{message.text}</div>
      ) : null}

      <div className="data-screen">
        <div className="data-list-col">
          {!loaded ? (
            <div className="data-empty">Loading…</div>
          ) : jobs.length === 0 ? (
            <div className="data-empty">No applications recorded yet — outcomes from runs appear here.</div>
          ) : (
            <div className="data-list">
              {jobs.map((job) => (
                <button
                  key={job.job_id}
                  type="button"
                  className={job.job_id === selected ? "data-row selected" : "data-row"}
                  onClick={() => setSelected(job.job_id)}
                  onDoubleClick={() => void open(job)}
                >
                  <div className="data-row-main">
                    <span className="data-row-title">
                      {job.company} — {job.title}
                    </span>
                    <span className="data-row-sub">
                      {job.date_applied}
                      {typeof job.ats_score === "number" ? ` · ats ${job.ats_score}` : ""}
                    </span>
                  </div>
                  <span className={`status-badge ${STATUS_BADGE[job.status] ?? "status-badge-muted"}`}>
                    {STATUS_LABEL[job.status] ?? job.status}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {selectedJob ? (
          <div className="detail-col">
            <div className="detail-title">
              {selectedJob.company} — {selectedJob.title}
            </div>
            <span className={`status-badge ${STATUS_BADGE[selectedJob.status] ?? "status-badge-muted"}`} style={{ alignSelf: "flex-start" }}>
              {STATUS_LABEL[selectedJob.status] ?? selectedJob.status}
            </span>
            <div className="detail-row">
              <span className="detail-row-label">Date applied</span>
              <span className="detail-row-value">{selectedJob.date_applied}</span>
            </div>
            {typeof selectedJob.ats_score === "number" ? (
              <div className="detail-row">
                <span className="detail-row-label">ATS score</span>
                <span className="detail-row-value">
                  {selectedJob.ats_score} · {selectedJob.source ?? "?"}
                </span>
              </div>
            ) : null}
            {selectedJob.resume_used ? (
              <div className="detail-row">
                <span className="detail-row-label">Resume used</span>
                <span className="detail-row-value">{selectedJob.resume_used}</span>
              </div>
            ) : null}
            <div className="detail-row">
              <span className="detail-row-label">URL</span>
              <span className="detail-row-value">{selectedJob.url}</span>
            </div>
            {selectedJob.reasoning ? (
              <>
                <hr className="detail-rule" />
                <div className="detail-row">
                  <span className="detail-row-label">Why</span>
                  <span className="detail-row-value">{selectedJob.reasoning}</span>
                </div>
              </>
            ) : null}
            <hr className="detail-rule" />
            <div className="detail-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void open(selectedJob)}>
                Open posting
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
