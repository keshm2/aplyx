import type { SchedulerStatus } from "../lib/bridge";
import "./dataList.css"; // .status-badge* classes, used below
import "./SchedulerStatusCard.css";

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function SchedulerStatusCard({ status }: { status: SchedulerStatus }) {
  const hb = status.heartbeat;

  return (
    <div className="scheduler-status-card">
      <div className="scheduler-status-header">
        <h2 className="scheduler-status-title">Scheduler</h2>
        <span className={`status-badge ${status.installed ? "status-badge-good" : "status-badge-muted"}`}>
          {status.installed ? `Running every ${status.interval_min} min` : "Not running"}
        </span>
      </div>

      {hb ? (
        <>
          <p className="scheduler-status-last-run">
            Last run <strong>{timeAgo(hb.last_run_completed_at)}</strong>
            {hb.last_run_exit_code !== 0 && <span className="scheduler-status-warn">, exited with an error</span>}
          </p>
          <div className="scheduler-status-counts">
            <span>
              <strong>{hb.last_run_counts.applied}</strong> applied
            </span>
            <span>
              <strong>{hb.last_run_counts.needs_review}</strong> review
            </span>
            <span>
              <strong>{hb.last_run_counts.failed}</strong> failed
            </span>
          </div>
          {hb.consecutive_nonzero_exits >= 3 && (
            <p className="scheduler-status-warn scheduler-status-alert">
              {hb.consecutive_nonzero_exits} runs in a row have failed. Check logs/run_job_agent.log.
            </p>
          )}
        </>
      ) : (
        <p className="field-help">No completed runs yet.</p>
      )}

      {!status.installed && (
        <p className="field-help scheduler-status-cta">
          Run <code>aplyx</code> and choose "always-on schedule" to keep this running in the background.
        </p>
      )}
    </div>
  );
}
