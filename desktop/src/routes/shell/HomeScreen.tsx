import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AplyxState, AppliedJob, QueueEntry } from "@aplyx/core/state.js";
import { isResolved } from "@aplyx/core/stateDerive.js";
import { useAuth } from "../../lib/AuthContext";
import { findRoot, loadLocalState, hasLocalInstall } from "../../lib/bridge";
import "../../components/formFields.css";
import "../../components/dataList.css";
import "./HomeScreen.css";

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

interface ActivityRow {
  key: string;
  company: string;
  title: string;
  date: string;
  badgeClass: string;
  badgeLabel: string;
  to: string;
}

/** Most-recent applied jobs and still-pending review items, merged into one
 *  reverse-chronological feed by date_applied — the "what's happened
 *  lately" half of the dashboard, alongside `nextAction`'s "what's next". */
function recentActivity(state: AplyxState): ActivityRow[] {
  const applied: ActivityRow[] = state.applied.map((job: AppliedJob) => ({
    key: `applied-${job.job_id}`,
    company: job.company,
    title: job.title,
    // Older review_queue.json entries predate a field rename and still use
    // date_added instead of date_applied — real local data on this machine
    // hits that, so this can't assume the field is always present.
    date: job.date_applied ?? "",
    badgeClass: STATUS_BADGE[job.status] ?? "status-badge-muted",
    badgeLabel: STATUS_LABEL[job.status] ?? job.status,
    to: "/app/history",
  }));
  const pending: ActivityRow[] = state.queue
    .filter((entry: QueueEntry) => !isResolved(state, entry))
    .map((entry) => ({
      key: `queue-${entry.job_id}`,
      company: entry.company,
      title: entry.title,
      date: entry.date_applied ?? (entry as { date_added?: string }).date_added ?? "",
      badgeClass: "status-badge-warn",
      badgeLabel: "Pending review",
      to: "/app/review",
    }));
  return [...applied, ...pending].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
}

/** The single most useful thing to do right now, derived from local state
 *  alone (no new backend surface — Phase 14C is a layout/motion pass, not
 *  a data-plumbing one). Priority: an unreviewed queue always wins (it's
 *  time-sensitive), then connecting a local install, then a first search,
 *  then a quiet "you're caught up". */
function nextAction(
  hosted: boolean,
  local: AplyxState | undefined,
): { title: string; detail: string; cta: string; to: string } | undefined {
  if (local && local.queue.length > 0) {
    return {
      title: `${local.queue.length} waiting for review`,
      detail: "Applications that need a manual decision before they go out.",
      cta: "Open review queue",
      to: "/app/review",
    };
  }
  if (hosted && !local) {
    return {
      title: "Connect your local install",
      detail: "Job search and applying run through a local install on this machine.",
      cta: "Open settings",
      to: "/app/settings",
    };
  }
  if (local && local.applied.length === 0) {
    return {
      title: "Start your first search",
      detail: "Browse live postings and fit-check them against your profile.",
      cta: "Open Jobs",
      to: "/app/jobs",
    };
  }
  if (local) {
    return {
      title: "You're caught up",
      detail: "Nothing waiting on you right now — search again whenever you're ready.",
      cta: "Open Jobs",
      to: "/app/jobs",
    };
  }
  return undefined;
}

export function HomeScreen() {
  const { status, session } = useAuth();
  const navigate = useNavigate();
  const [local, setLocal] = useState<AplyxState | undefined>(undefined);
  const [checkedLocal, setCheckedLocal] = useState(false);

  useEffect(() => {
    hasLocalInstall()
      .then(async (has) => {
        if (has) {
          const root = await findRoot();
          const state = (await loadLocalState(root)) as AplyxState | null;
          setLocal(state ?? undefined);
        }
      })
      // A bridge failure reads the same as "no local activity" — the
      // no-activity copy below already covers that case.
      .finally(() => setCheckedLocal(true));
  }, []);

  const hosted = status === "signed-in";
  const next = checkedLocal ? nextAction(hosted, local) : undefined;
  const activity = useMemo(() => (local ? recentActivity(local) : []), [local]);

  return (
    <div style={{ maxWidth: "44rem", margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <div className="aplyx-fade-in" style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: "var(--text-3xl)", marginBottom: "var(--space-2)" }}>
          {local?.applied?.length ? "Welcome back" : "You're set up"}
        </h1>
        <p style={{ color: "var(--text-muted)" }}>
          {hosted ? (
            <>
              Signed in as <strong>{session?.user.email}</strong>.
            </>
          ) : (
            "Running locally — your data stays on this machine."
          )}
        </p>
      </div>

      {checkedLocal && local && (
        <div className="home-stats aplyx-fade-in">
          <div className="home-stat-card">
            <span className="home-stat-value" style={{ color: "var(--good)" }}>
              {local.applied.length}
            </span>
            <span className="home-stat-label">Applications sent</span>
          </div>
          <div className="home-stat-card">
            <span className="home-stat-value" style={{ color: local.queue.length > 0 ? "var(--warn)" : "var(--text)" }}>
              {local.queue.length}
            </span>
            <span className="home-stat-label">Waiting in review queue</span>
          </div>
          <div className="home-stat-card">
            <span className="home-stat-value">{local.registry.length}</span>
            <span className="home-stat-label">Jobs seen</span>
          </div>
        </div>
      )}

      {next && (
        <div className="home-next aplyx-fade-in">
          <div className="home-next-copy">
            <h2>{next.title}</h2>
            <p>{next.detail}</p>
          </div>
          <button type="button" className="home-next-cta" onClick={() => navigate(next.to)}>
            {next.cta}
          </button>
        </div>
      )}

      {activity.length > 0 && (
        <div className="aplyx-fade-in">
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>Recent activity</h2>
          <div className="data-list">
            {activity.map((row) => (
              <button key={row.key} type="button" className="data-row" onClick={() => navigate(row.to)}>
                <div className="data-row-main">
                  <span className="data-row-title">
                    {row.company} — {row.title}
                  </span>
                  <span className="data-row-sub">{row.date}</span>
                </div>
                <span className={`status-badge ${row.badgeClass}`}>{row.badgeLabel}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {checkedLocal && !local && !hosted && (
        <p className="field-help aplyx-fade-in">No activity yet — head to Jobs to start searching.</p>
      )}
    </div>
  );
}
