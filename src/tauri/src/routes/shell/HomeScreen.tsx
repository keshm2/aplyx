import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AplyxState } from "@aplyx/core/state.js";
import { SupabaseAdapter, type HostedReadiness, type VerificationSessionRow } from "@aplyx/core/adapters/supabase.js";
import { useAuth } from "../../lib/AuthContext";
import { readProfileField, getRecommendedJobs, getSchedulerStatus, type RecommendedJob, type SchedulerStatus } from "../../lib/bridge";
import { useAplyxState, type StateSource } from "../../lib/useAplyxState";
import { useBoolEnvPref } from "../../lib/useEnvPref";
import { useRunState, checkForeignRun, triggerRun } from "../../lib/useRunState";
import { useOnlineAppliedJobs } from "../../lib/useOnlineAppliedJobs";
import { OUTCOME_LABEL, outcomeDotClass } from "../../lib/outcomeStatus";
import { isResolved } from "@aplyx/core/stateDerive.js";
import { SkeletonStatCards, SkeletonNextCard, SkeletonRows } from "../../components/Skeleton";
import { DigitalClock } from "../../components/DigitalClock";
import { RecommendedJobsMarquee } from "../../components/RecommendedJobsMarquee";
import { WeeklyActivityChart } from "../../components/WeeklyActivityChart";
import { PipelineBreakdown } from "../../components/PipelineBreakdown";
import { SchedulerStatusCard } from "../../components/SchedulerStatusCard";
import "../../components/formFields.css";
import "../../components/dataList.css"; // .stat-cards/.stat-card (shared with StatusScreen)
import "../../components/Skeleton.css";
import "./HomeScreen.css";

/** The single most useful thing to do right now. Priority: an unreviewed
 *  queue always wins (it's time-sensitive, and both local and hosted
 *  review-queue triage are real now, see ReviewScreen), then connecting a
 *  local install for a hosted-only session (job search/applying still run
 *  through a local install, unaffected by hosted pipeline-state sync),
 *  then a first search, then a quiet "you're caught up": the last two
 *  are local-only states since a hosted-only session's "connect a local
 *  install" case already covers it. */
function nextAction(
  source: StateSource,
  display: AplyxState | undefined,
  hostedReadiness?: HostedReadiness,
): { title: string; detail: string; cta: string; to: string } | undefined {
  // Not display.queue.length: the queue is append-only and never shrinks
  // on its own (AGENTS.md), so a raw length still counts entries already
  // applied/dismissed/failed after being queued. Same isResolved filter
  // ReviewScreen's own pending count uses.
  const pendingQueue = display?.queue.filter((e) => !isResolved(display, e)) ?? [];
  if (pendingQueue.length > 0) {
    return {
      title: `${pendingQueue.length} waiting for review`,
      detail: "Applications that need a manual decision before they go out.",
      cta: "Open review queue",
      to: "/app/review",
    };
  }
  if (source === "hosted") {
    if (hostedReadiness && !hostedReadiness.inboxConnected) {
      return {
        title: "Connect your inbox",
        detail: "Hosted plans require inbox access for Workday and other gated ATS verification.",
        cta: "Open settings",
        to: "/app/settings",
      };
    }
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
      detail: "Nothing waiting on you right now. Search again whenever you're ready.",
      cta: "Open Jobs",
      to: "/app/jobs",
    };
  }
  return undefined;
}

/** Short "Aug 28"-style label for a date-only ISO string (date_applied
 *  has no time component); falls back to the raw string if unparseable. */
function formatShortDate(iso: string): string {
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function HomeScreen() {
  const { status, session } = useAuth();
  const navigate = useNavigate();
  const { state, loaded, source, root, hosted } = useAplyxState();
  const [preferredName, setPreferredName] = useState<string | undefined>(undefined);
  const [recommended, setRecommended] = useState<RecommendedJob[] | undefined>(undefined);
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | undefined>(undefined);
  const [hostedReadiness, setHostedReadiness] = useState<HostedReadiness | undefined>(undefined);
  const [verificationSessions, setVerificationSessions] = useState<VerificationSessionRow[] | undefined>(undefined);
  const [quickQuery, setQuickQuery] = useState("");
  const signedIn = status === "signed-in";
  // Independent of `source` (which prefers local whenever a local install
  // exists), same reasoning as Application Statuses: the tracking
  // widgets below are a hosted-account feature regardless of which data
  // source is driving the rest of this dashboard.
  const { onlineJobs } = useOnlineAppliedJobs();
  const { value: hour24Clock } = useBoolEnvPref(root, "APLYX_24_HOUR_CLOCK", false);
  const run = useRunState();
  const [runStarting, setRunStarting] = useState(false);

  useEffect(() => {
    if (source !== "local" || !root) return;
    void checkForeignRun(root);
  }, [source, root]);

  useEffect(() => {
    if (source !== "local" || !root) return;
    readProfileField(root, "preferred_name")
      .then((name) => {
        if (typeof name === "string" && name.trim()) setPreferredName(name.trim());
      })
      // A bridge failure just leaves the greeting name-less: the
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
        // No preferred name on file: the greeting falls back to the
        // name-less copy below, same as a fresh local install.
      });
    return () => {
      cancelled = true;
    };
  }, [source, hosted, preferredName]);

  useEffect(() => {
    if (source !== "hosted" || !hosted) return;
    let cancelled = false;
    const adapter = new SupabaseAdapter(hosted.client, hosted.userId);
    Promise.all([adapter.readHostedReadiness(), adapter.listVerificationSessions(3)])
      .then(([readiness, sessions]) => {
        if (cancelled) return;
        setHostedReadiness(readiness);
        setVerificationSessions(sessions);
      })
      .catch(() => {
        if (cancelled) return;
        setHostedReadiness(undefined);
        setVerificationSessions(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [source, hosted]);

  // A stable, value-compared key for "which jobs to exclude": depending on
  // this string instead of the `state` object itself means an unrelated
  // state-object identity change (e.g. Supabase's routine hourly
  // TOKEN_REFRESHED firing, which replaces `state` via useAplyxState's own
  // effect even though nothing the user applied to actually changed) no
  // longer re-triggers the fetch/re-evaluate-fit-for-the-whole-registry
  // effect below for no reason. `loaded` is included separately so the
  // effect still fires on the one real transition a same-valued key
  // wouldn't catch: state going from not-yet-loaded to loaded-but-empty
  // (a fresh install with no applied/queue jobs yet).
  const excludeJobIdsKey = state
    ? [...state.applied.map((j) => j.job_id), ...state.queue.map((j) => j.job_id)].sort().join(",")
    : "";

  // Recommended-jobs marquee: local-only, same reasoning as the profile-name
  // lookup above: a hosted-only session has no local job_registry.json or
  // Python fit gate to read from, so it simply doesn't render (see
  // nextAction's own "connect a local install" case for that state).
  useEffect(() => {
    if (source !== "local" || !root || !state) return;
    let cancelled = false;
    const excludeJobIds = excludeJobIdsKey ? excludeJobIdsKey.split(",") : [];
    getRecommendedJobs(root, excludeJobIds)
      .then((jobs) => {
        if (!cancelled) setRecommended(jobs);
      })
      .catch(() => {
        // A bridge failure just leaves the marquee absent: the loaded-but-
        // empty state below already covers "nothing to show".
        if (!cancelled) setRecommended([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately
    // keyed on excludeJobIdsKey (value-stable) rather than `state` (a new
    // object reference on every refresh): see the comment above.
  }, [source, root, loaded, excludeJobIdsKey]);

  // Scheduler status: local-only (the local 30-min schedule and its
  // heartbeat file live on this machine, same reasoning as the two
  // effects above).
  useEffect(() => {
    if (source !== "local" || !root) return;
    let cancelled = false;
    getSchedulerStatus(root)
      .then((s) => {
        if (!cancelled) setSchedulerStatus(s);
      })
      .catch(() => {
        // A bridge failure just leaves the card absent below.
      });
    return () => {
      cancelled = true;
    };
  }, [source, root]);

  const next = loaded ? nextAction(source, state, hostedReadiness) : undefined;
  const pendingQueueEntries = state ? state.queue.filter((e) => !isResolved(state, e)) : [];
  const pendingQueueCount = pendingQueueEntries.length;
  // Real, derived captions for the metrics bar (no fabricated deltas):
  // the most recent send date on hand, the average fit score of what's
  // actually waiting on a decision, and how much of what's been scraped
  // is still a live candidate rather than already ruled out.
  const lastAppliedDate =
    state && state.applied.length > 0
      ? state.applied.reduce((latest, j) => (j.date_applied > latest ? j.date_applied : latest), state.applied[0].date_applied)
      : undefined;
  const pendingQueueScores = pendingQueueEntries
    .map((e) => e.ats_score)
    .filter((n): n is number => typeof n === "number");
  const avgPendingScore =
    pendingQueueScores.length > 0 ? Math.round(pendingQueueScores.reduce((a, b) => a + b, 0) / pendingQueueScores.length) : undefined;
  const candidateJobsSeen = state
    ? state.registry.filter((r) => r.latest_status !== "failed" && r.latest_status !== "skipped_unfit").length
    : 0;
  const todayLabel = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  // Name, not application count, decides "returning user" copy: a
  // preferred name is set once during onboarding, so anyone past their
  // first login has one; "You're set up" is now only for the genuine
  // first-ever visit (no name on file yet AND no applications sent).
  const greeting = preferredName
    ? `Welcome back, ${preferredName}`
    : state?.applied?.length
      ? "Welcome back"
      : "You're set up";

  // Response rate: any tracked application whose outcome moved past the
  // starting "applied" value: a reply of any kind, not just a positive
  // one. Assessments pending: still-open oa_sent invites, the same
  // information Application Statuses' own detail sheet shows in full.
  const respondedCount = onlineJobs.filter((j) => j.outcome_status && j.outcome_status !== "applied").length;
  const responseRate = onlineJobs.length > 0 ? Math.round((respondedCount / onlineJobs.length) * 100) : 0;
  const pendingAssessments = onlineJobs.filter((j) => j.outcome_status === "oa_sent");

  // A synthesized feed, not a real event log: this app doesn't keep one,
  // so "recent activity" is reconstructed from current-state timestamps
  // already on hand: when a local application was sent (date_applied) and
  // when a hosted outcome last changed (outcome_updated_at). Honest about
  // what it actually is rather than fabricating finer-grained history that
  // doesn't exist. Local's date has no time component and hosted's does:
  // an imperfect but reasonable sort given what's available.
  // "Run now" quick action: idle/done start a new run then jump to the
  // full Run screen for progress; any other phase (checking/foreign/
  // running/stopping) just jumps there: a run already exists, this
  // button's job is to get you to it, not start a second one.
  function runQuickActionLabel(): string {
    switch (run.phase) {
      case "checking":
        return "Checking…";
      case "foreign":
        return "Run active elsewhere";
      case "running":
        return "Running…";
      case "stopping":
        return "Stopping…";
      case "done":
        return "Run again";
      default:
        return runStarting ? "Starting…" : "Run now";
    }
  }
  async function handleRunQuickAction() {
    if (run.phase === "idle" || run.phase === "done") {
      if (!root) return;
      setRunStarting(true);
      try {
        await triggerRun(root);
      } finally {
        setRunStarting(false);
      }
    }
    navigate("/app/run");
  }

  const activity = [
    ...(state?.applied ?? []).map((j) => ({
      id: `applied:${j.job_id}`,
      timestamp: j.date_applied,
      title: `Applied to ${j.company} - ${j.title}`,
      sub: j.date_applied,
      kind: "applied" as const,
      badge: undefined as { label: string; className: string } | undefined,
    })),
    ...onlineJobs
      .filter((j) => j.outcome_status && j.outcome_status !== "applied" && j.outcome_updated_at)
      .map((j) => ({
        id: `outcome:${j.job_id}`,
        timestamp: j.outcome_updated_at!,
        title: `${j.company} - ${j.title}`,
        sub: `Updated ${j.outcome_updated_at!.slice(0, 10)}`,
        kind: "outcome" as const,
        badge: {
          label: OUTCOME_LABEL[j.outcome_status!] ?? j.outcome_status!,
          className: outcomeDotClass(j.outcome_status),
        },
      })),
  ]
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
    .slice(0, 8);

  return (
    <div
      className="home-page"
      style={{ maxWidth: "68rem", margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--space-5)" }}
    >
      <header className="aplyx-fade-in home-header">
        <div className="home-header-text">
          <h1>{greeting}</h1>
          <p>
            {todayLabel}{" "}
            <span className="home-quick-links-sep" aria-hidden="true">·</span>{" "}
            {signedIn ? (
              <>
                Signed in as <strong>{session?.user.email}</strong>.
              </>
            ) : (
              "Running locally: your data stays on this machine."
            )}
          </p>
        </div>
        <DigitalClock hour24={hour24Clock} />
      </header>

      <section className="aplyx-fade-in home-toolbar">
        <form
          className="home-quick-search"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = quickQuery.trim();
            if (trimmed) navigate("/app/jobs", { state: { initialQuery: trimmed } });
          }}
        >
          <input
            type="text"
            value={quickQuery}
            onChange={(e) => setQuickQuery(e.currentTarget.value)}
            placeholder="Search for a role, e.g. software engineer intern"
          />
          <button type="submit" className="btn btn-primary">Search</button>
          {source === "local" && root && (
            <button
              type="button"
              className="btn"
              disabled={run.phase === "checking" || run.phase === "stopping" || runStarting}
              onClick={() => void handleRunQuickAction()}
            >
              {runQuickActionLabel()}
            </button>
          )}
        </form>
        <nav className="home-quick-links" aria-label="Shortcuts">
          <button type="button" className="home-link-btn" onClick={() => navigate("/app/review")}>
            Review queue{pendingQueueCount > 0 ? ` (${pendingQueueCount})` : ""}
          </button>
          <span className="home-quick-links-sep" aria-hidden="true">·</span>
          <button type="button" className="home-link-btn" onClick={() => navigate("/app/status")}>
            Application statuses
          </button>
          <span className="home-quick-links-sep" aria-hidden="true">·</span>
          <button type="button" className="home-link-btn" onClick={() => navigate("/app/resumes")}>
            Resumes
          </button>
        </nav>
      </section>

      {!loaded && (
        <>
          <SkeletonStatCards />
          <SkeletonNextCard />
          <SkeletonRows count={3} />
        </>
      )}

      {loaded && state && (
        <div className="metric-bar aplyx-fade-rise">
          <div className="metric">
            <div className="metric-top">
              <span className="metric-icon metric-icon-good" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </span>
              <span className="metric-label">Applications sent</span>
            </div>
            <span className="metric-value" style={{ color: "var(--good)" }}>
              {state.applied.length}
            </span>
            {lastAppliedDate && <span className="metric-caption">Last sent {formatShortDate(lastAppliedDate)}</span>}
          </div>
          <div className="metric">
            <div className="metric-top">
              <span className={`metric-icon ${pendingQueueCount > 0 ? "metric-icon-warn" : "metric-icon-neutral"}`} aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 3" />
                </svg>
              </span>
              <span className="metric-label">Waiting in review queue</span>
            </div>
            <span className="metric-value" style={{ color: pendingQueueCount > 0 ? "var(--warn)" : "var(--text)" }}>
              {pendingQueueCount}
            </span>
            {avgPendingScore !== undefined && <span className="metric-caption">Avg fit score {avgPendingScore}</span>}
          </div>
          <div className="metric">
            <div className="metric-top">
              <span className="metric-icon metric-icon-neutral" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </span>
              <span className="metric-label">Jobs seen</span>
            </div>
            <span className="metric-value">{state.registry.length}</span>
            {state.registry.length > 0 && <span className="metric-caption">{candidateJobsSeen} still in play</span>}
          </div>
        </div>
      )}

      {loaded && source === "hosted" && hostedReadiness && (
        <div className="metric-bar aplyx-fade-rise">
          <div className="metric">
            <span className="metric-value" style={{ color: hostedReadiness.inboxConnected ? "var(--good)" : "var(--warn)" }}>
              {hostedReadiness.inboxConnected ? "Connected" : "Action"}
            </span>
            <span className="metric-label">Inbox: {hostedReadiness.inboxProvider ?? "not connected"}</span>
          </div>
          <div className="metric">
            <span className="metric-value">{verificationSessions?.length ?? 0}</span>
            <span className="metric-label">Recent verification sessions</span>
          </div>
          <div className="metric">
            <span className="metric-value" style={{ color: hostedReadiness.resumeUploaded ? "var(--good)" : "var(--warn)" }}>
              {hostedReadiness.resumeUploaded ? "Ready" : "Missing"}
            </span>
            <span className="metric-label">Hosted resume</span>
          </div>
        </div>
      )}

      {signedIn && onlineJobs.length > 0 && (
        <section className="aplyx-fade-in">
          <h2 className="section-label">Tracking</h2>
          <div className="metric-bar">
            <div className="metric">
              <span className="metric-value">{onlineJobs.length}</span>
              <span className="metric-label">Applications tracked</span>
            </div>
            <div className="metric">
              <span className="metric-value" style={{ color: respondedCount > 0 ? "var(--good)" : "var(--text)" }}>
                {responseRate}%
              </span>
              <span className="metric-label">Response rate</span>
              <div className="metric-progress">
                <div className="metric-progress-fill" style={{ width: `${responseRate}%` }} />
              </div>
            </div>
            <div className="metric">
              <span className="metric-value" style={{ color: pendingAssessments.length > 0 ? "var(--info)" : "var(--text)" }}>
                {pendingAssessments.length}
              </span>
              <span className="metric-label">Assessments pending</span>
            </div>
          </div>
        </section>
      )}

      {signedIn && pendingAssessments.length > 0 && (
        <section className="aplyx-fade-in">
          <h2 className="section-label">Assessments waiting on you</h2>
          <div className="home-alert-cards">
            {pendingAssessments.map((job) => (
              <div key={job.job_id} className="home-alert-card">
                <div className="home-alert-card-icon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 3" />
                  </svg>
                </div>
                <div className="home-alert-card-title">
                  {job.company} - {job.title}
                </div>
                <div className="home-alert-card-detail">
                  {job.outcome_assessment_note ? `Duration: ${job.outcome_assessment_note}` : "No duration listed"}
                </div>
                <div className="home-alert-card-footer">
                  <span>OA sent</span>
                  <button
                    type="button"
                    className="home-alert-card-link"
                    onClick={() => (job.outcome_assessment_url ? void openUrl(job.outcome_assessment_url) : navigate("/app/status"))}
                  >
                    {job.outcome_assessment_url ? "Open assessment" : "View details"} →
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {loaded && source === "hosted" && verificationSessions && verificationSessions.length > 0 && (
        <div className="aplyx-fade-in">
          <h2 className="section-label">Verification sessions</h2>
          <div className="data-list">
            {verificationSessions.map((sessionRow) => (
              <div key={sessionRow.id} className="data-row">
                <div className="data-row-main">
                  <span className="data-row-title">{sessionRow.company || sessionRow.family}</span>
                  <span className="data-row-sub">{sessionRow.candidate_email}</span>
                </div>
                <span className="status-badge status-badge-info">{sessionRow.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {next && (
        <div className="home-guide aplyx-fade-in">
          <div className="home-guide-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </div>
          <div className="home-guide-copy">
            <h2>{next.title}</h2>
            <p>{next.detail}</p>
          </div>
          <button type="button" className="btn btn-primary home-guide-cta" onClick={() => navigate(next.to)}>
            {next.cta}
          </button>
        </div>
      )}

      {loaded && state && source === "local" && (
        <div className="home-widget-grid aplyx-fade-in">
          <WeeklyActivityChart applied={state.applied} />
          <div className="home-widget-stack">
            {schedulerStatus && <SchedulerStatusCard status={schedulerStatus} />}
            <PipelineBreakdown registry={state.registry} />
          </div>
        </div>
      )}

      {loaded && source === "local" && recommended === undefined && (
        <div className="aplyx-fade-in">
          <h2 className="section-label">Recommended next</h2>
          <SkeletonRows count={3} />
        </div>
      )}

      {recommended && recommended.length > 0 && (
        <div className="aplyx-fade-in">
          <h2 className="section-label">Recommended next</h2>
          <RecommendedJobsMarquee jobs={recommended} />
        </div>
      )}

      {recommended && recommended.length === 0 && (
        <p className="field-help aplyx-fade-in">No new matches right now. Check back after your next scheduled run.</p>
      )}

      {loaded && source === "none" && (
        <p className="field-help aplyx-fade-in">No activity yet. Head to Jobs to start searching.</p>
      )}

      {activity.length > 0 && (
        <section className="aplyx-fade-in">
          <h2 className="section-label">Recent activity</h2>
          {/* Synthesized from current-state timestamps (date_applied,
             *  outcome_updated_at): this app has no real event log, so
             *  this is the honest version of "recent activity" rather
             *  than fabricated finer-grained history. */}
          <div className="data-list">
            {activity.map((item) => (
              <div key={item.id} className="data-row">
                <div className={`data-row-logo data-row-logo-fallback home-activity-icon home-activity-icon-${item.kind}`} aria-hidden="true">
                  {item.kind === "applied" ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v5l3 3" />
                    </svg>
                  )}
                </div>
                <div className="data-row-main">
                  <span className="data-row-title">{item.title}</span>
                  <span className="data-row-sub">{item.sub}</span>
                </div>
                {item.badge && <span className={`status-dot ${item.badge.className}`}>{item.badge.label}</span>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
