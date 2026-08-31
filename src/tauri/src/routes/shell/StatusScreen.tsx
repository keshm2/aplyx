import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppliedJob } from "@aplyx/core/state.js";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { useAuth } from "../../lib/AuthContext";
import { getSupabaseClient } from "../../lib/supabaseClient";
import { useOnlineAppliedJobs } from "../../lib/useOnlineAppliedJobs";
import { OUTCOME_BADGE, OUTCOME_LABEL, outcomeDotClass } from "../../lib/outcomeStatus";
import { SkeletonRows } from "../../components/Skeleton";
import { ExternalLinkIcon } from "../../components/Icons";
import { BottomSheet } from "../../components/BottomSheet";
import "../../components/formFields.css";
import "../../components/dataList.css";
import "../../components/Skeleton.css";

// Application outcome tracking (docs/application-status-tracking-plan.md)
// is hosted-only: email-tracking-worker only ever reads/writes hosted
// applied_jobs, so a local install's AppliedJob.outcome_status is always
// undefined by construction (see the type's own comment in stateDerive.ts).
// Per the operator's call (2026-08-21): this screen is entirely a
// signed-in feature now. Reachable from local (the nav item always shows,
// so it's discoverable) but renders only a sign-in prompt until then:
// no local application count/list here at all, never blended with hosted
// data the way an earlier version of this screen did.

export function StatusScreen() {
  const { status: authStatus, session } = useAuth();
  const navigate = useNavigate();
  const [message, setMessage] = useState<{ text: string; error?: boolean } | undefined>(undefined);

  const [showLogForm, setShowLogForm] = useState(false);
  const [logCompany, setLogCompany] = useState("");
  const [logTitle, setLogTitle] = useState("");
  const [logUrl, setLogUrl] = useState("");
  const [logDate, setLogDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [logSaving, setLogSaving] = useState(false);
  const [logError, setLogError] = useState<string | undefined>(undefined);
  const [onlineSelected, setOnlineSelected] = useState<string | undefined>(undefined);

  const { onlineJobs, onlineLoaded, refreshOnlineJobs } = useOnlineAppliedJobs();

  async function submitManualLog() {
    if (!session) return;
    setLogSaving(true);
    setLogError(undefined);
    try {
      const client = await getSupabaseClient();
      await new SupabaseAdapter(client, session.user.id).addManualAppliedJob({
        company: logCompany,
        title: logTitle,
        url: logUrl,
        dateApplied: logDate,
      });
      setMessage({ text: `Logged ${logCompany}, ${logTitle}. It'll show up below and in email tracking on the next scheduled scan.` });
      setLogCompany("");
      setLogTitle("");
      setLogUrl("");
      setLogDate(new Date().toISOString().slice(0, 10));
      setShowLogForm(false);
      await refreshOnlineJobs();
    } catch (err) {
      setLogError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogSaving(false);
    }
  }

  const sortedOnlineJobs = useMemo(
    () => [...onlineJobs].sort((a, b) => (a.date_applied < b.date_applied ? 1 : a.date_applied > b.date_applied ? -1 : 0)),
    [onlineJobs],
  );
  const selectedOnlineJob = sortedOnlineJobs.find((j) => j.job_id === onlineSelected);

  // Orientation numbers for the stat-card row, shown at full layout
  // density (0 values included) rather than only once jobs exist, so the
  // screen never collapses down to a bare list/empty-state with nothing
  // else on it.
  const stats = useMemo(() => {
    const tracked = sortedOnlineJobs.length;
    const interviews = sortedOnlineJobs.filter(
      (j) => j.outcome_status === "interview_requested" || j.outcome_status === "offer",
    ).length;
    const responded = sortedOnlineJobs.filter((j) => j.outcome_status && j.outcome_status !== "applied").length;
    const responseRate = tracked > 0 ? Math.round((responded / tracked) * 100) : 0;
    const atsScores = sortedOnlineJobs
      .map((j) => j.ats_score)
      .filter((s): s is number => typeof s === "number");
    const avgAts = atsScores.length > 0 ? Math.round(atsScores.reduce((a, b) => a + b, 0) / atsScores.length) : undefined;
    return { tracked, interviews, responseRate, avgAts };
  }, [sortedOnlineJobs]);

  // Confirms an outcome actually changed since the last read: pops only
  // the row(s) whose outcome_status flipped between two `onlineJobs`
  // snapshots, never on first paint (prevOutcomeRef starts empty, so the
  // very first pass only records baselines, it never diffs against
  // nothing) and never on an unrelated re-render.
  const prevOutcomeRef = useRef<Record<string, string | undefined>>({});
  const [poppingIds, setPoppingIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevOutcomeRef.current;
    const changed: string[] = [];
    for (const job of onlineJobs) {
      if (job.job_id in prev && prev[job.job_id] !== job.outcome_status) changed.push(job.job_id);
      prev[job.job_id] = job.outcome_status;
    }
    if (changed.length === 0) return;
    setPoppingIds(new Set(changed));
    const t = setTimeout(() => setPoppingIds(new Set()), 200);
    return () => clearTimeout(t);
  }, [onlineJobs]);

  const open = async (job: AppliedJob) => {
    try {
      await openUrl(job.apply_url || job.url);
    } catch (err) {
      setMessage({ text: `Could not open: ${err instanceof Error ? err.message : String(err)}`, error: true });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <h1 style={{ fontSize: "var(--text-3xl)" }}>Application statuses</h1>

      {message ? (
        <div className={message.error ? "message-banner message-banner-error" : "message-banner"}>{message.text}</div>
      ) : null}

      {authStatus !== "signed-in" ? (
        <div className="settings-section" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", alignItems: "center", textAlign: "center" }}>
          <p style={{ color: "var(--text-muted)" }}>
            Application status tracking reads your inbox for replies (offers, rejections, assessment invites) and
            needs a signed-in account to work. Sign in to start tracking where each application actually stands.
          </p>
          <button type="button" className="settings-action-btn" onClick={() => navigate("/auth")}>
            Sign in
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" className="settings-action-btn" onClick={() => setShowLogForm((s) => !s)}>
              {showLogForm ? "Cancel" : "Log a past application"}
            </button>
          </div>

          {showLogForm && (
            <div className="settings-section">
              <p className="field-help" style={{ marginBottom: "var(--space-3)" }}>
                For an application you sent outside aplyx: company/title/date so email tracking can pick up
                replies for it too. Aplyx never applied here on your behalf, so it can't verify anything about this
                row beyond what you enter.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                <div style={{ display: "flex", gap: "var(--space-3)" }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label" htmlFor="log-company">Company</label>
                    <input id="log-company" type="text" value={logCompany} onChange={(e) => setLogCompany(e.currentTarget.value)} placeholder="SpaceX" />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label" htmlFor="log-title">Title</label>
                    <input id="log-title" type="text" value={logTitle} onChange={(e) => setLogTitle(e.currentTarget.value)} placeholder="New Grad Software Security Engineer" />
                  </div>
                </div>
                <div style={{ display: "flex", gap: "var(--space-3)" }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label" htmlFor="log-url">Job posting URL (optional)</label>
                    <input id="log-url" type="text" value={logUrl} onChange={(e) => setLogUrl(e.currentTarget.value)} placeholder="https://…" />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="log-date">Date applied</label>
                    <input id="log-date" type="date" value={logDate} onChange={(e) => setLogDate(e.currentTarget.value)} />
                  </div>
                </div>
                {logError && <p className="field-help" style={{ color: "var(--danger)" }}>{logError}</p>}
                <button
                  type="button"
                  className="settings-action-btn"
                  disabled={logSaving || !logCompany.trim() || !logTitle.trim()}
                  onClick={() => void submitManualLog()}
                  style={{ alignSelf: "flex-start" }}
                >
                  {logSaving ? "Logging…" : "Log application"}
                </button>
              </div>
            </div>
          )}

          <div className="stat-cards">
            <div className="stat-card aplyx-fade-rise">
              <span className="stat-value">{stats.tracked}</span>
              <span className="stat-label">Tracked</span>
            </div>
            <div className="stat-card aplyx-fade-rise">
              <span className="stat-value" style={{ color: stats.interviews > 0 ? "var(--special)" : "var(--text)" }}>
                {stats.interviews}
              </span>
              <span className="stat-label">Interviews / offers</span>
            </div>
            <div className="stat-card aplyx-fade-rise">
              <span className="stat-value" style={{ color: stats.responseRate > 0 ? "var(--good)" : "var(--text)" }}>
                {stats.responseRate}%
              </span>
              <span className="stat-label">Response rate</span>
              <div className="stat-progress">
                <div className="stat-progress-fill" style={{ width: `${stats.responseRate}%` }} />
              </div>
            </div>
            <div className="stat-card aplyx-fade-rise">
              <span className="stat-value">{stats.avgAts ?? "N/A"}</span>
              <span className="stat-label">Avg ATS score</span>
            </div>
          </div>

          {!onlineLoaded ? (
            <SkeletonRows />
          ) : sortedOnlineJobs.length === 0 ? (
            <div className="data-empty">No applications tracked yet: log one above, or connect your inbox in Settings.</div>
          ) : (
            <div className="data-list">
              {sortedOnlineJobs.map((job) => (
                <div
                  key={job.job_id}
                  role="button"
                  tabIndex={0}
                  className="data-row"
                  onClick={() => setOnlineSelected(job.job_id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOnlineSelected(job.job_id);
                    }
                  }}
                >
                  <div className="data-row-main">
                    <span className="data-row-title">
                      {job.company}, {job.title}
                    </span>
                    <span className="data-row-sub">Applied on: {job.date_applied}</span>
                  </div>
                  <span
                    className={`status-dot ${outcomeDotClass(job.outcome_status)}${poppingIds.has(job.job_id) ? " aplyx-status-pop" : ""}`}
                  >
                    {OUTCOME_LABEL[job.outcome_status ?? "applied"] ?? job.outcome_status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <BottomSheet
        open={!!selectedOnlineJob}
        onClose={() => setOnlineSelected(undefined)}
        title={selectedOnlineJob ? `${selectedOnlineJob.company}, ${selectedOnlineJob.title}` : ""}
      >
        {selectedOnlineJob && (
          <>
            <span
              className={`status-badge ${OUTCOME_BADGE[selectedOnlineJob.outcome_status ?? "applied"] ?? "status-badge-muted"}`}
              style={{ alignSelf: "flex-start" }}
            >
              {OUTCOME_LABEL[selectedOnlineJob.outcome_status ?? "applied"] ?? selectedOnlineJob.outcome_status}
            </span>

            <div className="detail-row">
              <span className="detail-row-label">Applied on</span>
              <span className="detail-row-value">{selectedOnlineJob.date_applied}</span>
            </div>

            {selectedOnlineJob.outcome_status && selectedOnlineJob.outcome_status !== "applied" && selectedOnlineJob.outcome_updated_at ? (
              <div className="detail-row">
                <span className="detail-row-label">Outcome detected</span>
                <span className="detail-row-value">
                  <span style={{ color: "var(--text-faint)", fontSize: "var(--text-xs)" }}>
                    {selectedOnlineJob.outcome_updated_at}
                    {selectedOnlineJob.outcome_source ? `, ${selectedOnlineJob.outcome_source}` : ""}
                    {selectedOnlineJob.outcome_source?.startsWith("email:") ? "; best-effort keyword match, not verified" : ""}
                  </span>
                </span>
              </div>
            ) : null}

            {/* Assessment-specific detail: only ever set alongside
               *  outcome_status === "oa_sent" (email-tracking-worker only
               *  extracts these when it classifies a message that way).
               *  A verbatim-matched phrase, not a computed deadline;
               *  company phrasing is too inconsistent to parse a real one
               *  from ("active for 7 days" vs. "complete by August 30"). */}
            {selectedOnlineJob.outcome_status === "oa_sent" && selectedOnlineJob.outcome_assessment_note ? (
              <div className="detail-row">
                <span className="detail-row-label">Duration to complete</span>
                <span className="detail-row-value">{selectedOnlineJob.outcome_assessment_note}</span>
              </div>
            ) : null}

            {selectedOnlineJob.outcome_status === "oa_sent" && selectedOnlineJob.outcome_assessment_url ? (
              <button
                type="button"
                className="btn btn-primary detail-open-btn"
                onClick={() => void openUrl(selectedOnlineJob.outcome_assessment_url!)}
              >
                <ExternalLinkIcon />
                Open assessment link
              </button>
            ) : null}

            {typeof selectedOnlineJob.ats_score === "number" ? (
              <div className="detail-row">
                <span className="detail-row-label">ATS score</span>
                <span className="detail-row-value">{selectedOnlineJob.ats_score}</span>
              </div>
            ) : null}

            {selectedOnlineJob.url ? (
              <div className="detail-row">
                <span className="detail-row-label">URL</span>
                <span className="detail-row-value">{selectedOnlineJob.url}</span>
              </div>
            ) : null}

            {selectedOnlineJob.reasoning ? (
              <div className="detail-row">
                <span className="detail-row-label">Why</span>
                <span className="detail-row-value">{selectedOnlineJob.reasoning}</span>
              </div>
            ) : null}

            {(selectedOnlineJob.url || selectedOnlineJob.apply_url) && (
              <button type="button" className="btn btn-primary detail-open-btn" onClick={() => void open(selectedOnlineJob)}>
                <ExternalLinkIcon />
                Open posting
              </button>
            )}
          </>
        )}
      </BottomSheet>
    </div>
  );
}
