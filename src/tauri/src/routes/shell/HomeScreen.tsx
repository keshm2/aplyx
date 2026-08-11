import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AplyxState, AppliedJob, QueueEntry } from "@aplyx/core/state.js";
import { isResolved } from "@aplyx/core/stateDerive.js";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { useAuth } from "../../lib/AuthContext";
import { readProfileField } from "../../lib/bridge";
import { useAplyxState, type StateSource } from "../../lib/useAplyxState";
import { SkeletonStatCards, SkeletonNextCard, SkeletonRows } from "../../components/Skeleton";
import "../../components/formFields.css";
import "../../components/dataList.css";
import "../../components/Skeleton.css";
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
    to: "/app/status",
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

/** The single most useful thing to do right now. Priority: an unreviewed
 *  queue always wins (it's time-sensitive, and both local and hosted
 *  review-queue triage are real now — see ReviewScreen), then connecting a
 *  local install for a hosted-only session (job search/applying still run
 *  through a local install, unaffected by hosted pipeline-state sync),
 *  then a first search, then a quiet "you're caught up" — the last two
 *  are local-only states since a hosted-only session's "connect a local
 *  install" case already covers it. */
function nextAction(
  source: StateSource,
  display: AplyxState | undefined,
): { title: string; detail: string; cta: string; to: string } | undefined {
  if (display && display.queue.length > 0) {
    return {
      title: `${display.queue.length} waiting for review`,
      detail: "Applications that need a manual decision before they go out.",
      cta: "Open review queue",
      to: "/app/review",
    };
  }
  if (source === "hosted") {
    return {
      title: "Connect your local install",
      detail: "Job search and applying run through a local install on this machine.",
      cta: "Open settings",
      to: "/app/settings",
    };
  }
  if (source === "local" && display && display.applied.length === 0) {
    return {
      title: "Start your first search",
      detail: "Browse live postings and fit-check them against your profile.",
      cta: "Open Jobs",
      to: "/app/jobs",
    };
  }
  if (source === "local") {
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
  const { state, loaded, source, root, hosted } = useAplyxState();
  const [preferredName, setPreferredName] = useState<string | undefined>(undefined);
  const signedIn = status === "signed-in";

  useEffect(() => {
    if (source !== "local" || !root) return;
    readProfileField(root, "preferred_name")
      .then((name) => {
        if (typeof name === "string" && name.trim()) setPreferredName(name.trim());
      })
      // A bridge failure just leaves the greeting name-less — the
      // no-name copy below already covers that case.
      .catch(() => {});
  }, [source, root]);

  // Hosted-profile fallback for the greeting name: only consulted when no
  // local install already supplied one above, so a user with both a local
  // install and a hosted sign-in isn't sent on a second, redundant lookup.
  useEffect(() => {
    if (preferredName || source !== "hosted" || !hosted) return;
    let cancelled = false;
    new SupabaseAdapter(hosted.client, hosted.userId)
      .readProfileField("preferred_name")
      .then((value) => {
        if (!cancelled && typeof value === "string" && value.trim()) setPreferredName(value.trim());
      })
      .catch(() => {
        // No preferred name on file — the greeting falls back to the
        // name-less copy below, same as a fresh local install.
      });
    return () => {
      cancelled = true;
    };
  }, [source, hosted, preferredName]);

  const next = loaded ? nextAction(source, state) : undefined;
  const activity = useMemo(() => (state ? recentActivity(state) : []), [state]);
  const greeting = state?.applied?.length
    ? preferredName
      ? `Welcome back, ${preferredName}`
      : "Welcome back"
    : "You're set up";

  return (
    <div style={{ maxWidth: "44rem", margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <div className="aplyx-fade-in" style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: "var(--text-3xl)", marginBottom: "var(--space-2)" }}>{greeting}</h1>
        {/* margin: "0 auto" overrides the global `p { margin: 0 }` reset
           (base.css) — without it, this <p>'s own `p { max-width: 65ch }`
           reset makes it a narrower box than the heading above, and a
           narrower block with margin:0 sits flush against the left edge
           of its container instead of centered, regardless of the
           inherited text-align — the text inside looked centered *within
           that box*, but the box itself wasn't centered under the
           heading. */}
        <p style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)", margin: "0 auto" }}>
          {signedIn ? (
            <>
              Signed in as <strong>{session?.user.email}</strong>.
            </>
          ) : (
            "Running locally — your data stays on this machine."
          )}
        </p>
      </div>

      {!loaded && (
        <>
          <SkeletonStatCards />
          <SkeletonNextCard />
          <SkeletonRows count={3} />
        </>
      )}

      {loaded && state && (
        <div className="home-stats">
          <div className="home-stat-card aplyx-fade-rise">
            <span className="home-stat-value" style={{ color: "var(--good)" }}>
              {state.applied.length}
            </span>
            <span className="home-stat-label">Applications sent</span>
          </div>
          <div className="home-stat-card aplyx-fade-rise">
            <span className="home-stat-value" style={{ color: state.queue.length > 0 ? "var(--warn)" : "var(--text)" }}>
              {state.queue.length}
            </span>
            <span className="home-stat-label">Waiting in review queue</span>
          </div>
          <div className="home-stat-card aplyx-fade-rise">
            <span className="home-stat-value">{state.registry.length}</span>
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

      {loaded && source === "none" && (
        <p className="field-help aplyx-fade-in">No activity yet — head to Jobs to start searching.</p>
      )}
    </div>
  );
}
