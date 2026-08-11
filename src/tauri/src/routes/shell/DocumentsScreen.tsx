import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { QueueEntry } from "@aplyx/core/stateDerive.js";
import { isResolved } from "@aplyx/core/stateDerive.js";
import { useAplyxState } from "../../lib/useAplyxState";
import { SkeletonRows } from "../../components/Skeleton";
import "../../components/formFields.css";
import "../../components/dataList.css";
import "../../components/Skeleton.css";

// Read-only companion to ReviewScreen: same queue, same isResolved()
// filtering, same list/detail layout — but scoped to entries that actually
// carry tailored content (tailored_bullets/cover_letter), and with no
// mutation actions at all. review_queue.json/applied_jobs.json are
// append-only by convention (see AGENTS.md's file write discipline), and
// Mark applied/Dismiss already live on the Review queue screen — this
// screen exists purely so a user can read and copy what resume-tailor
// produced, not to introduce a second path that touches the queue.
function hasTailoredContent(entry: QueueEntry): boolean {
  return Boolean(entry.tailored_bullets?.length || entry.cover_letter);
}

export function DocumentsScreen() {
  const { state, loaded } = useAplyxState();
  const [showResolved, setShowResolved] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | undefined>(undefined);

  const entries = useMemo(
    () =>
      state
        ? state.queue.filter((e) => hasTailoredContent(e) && (showResolved || !isResolved(state, e)))
        : [],
    [state, showResolved],
  );
  const selectedEntry = entries.find((e) => e.job_id === selected);

  // Same queue-first landing behavior as ReviewScreen: land on the first
  // item rather than a blank detail pane, and follow along as the
  // showResolved toggle changes which entries are in scope.
  useEffect(() => {
    if (entries.length === 0) return;
    if (!entries.some((e) => e.job_id === selected)) setSelected(entries[0]!.job_id);
  }, [entries, selected]);

  const open = async (entry: QueueEntry) => {
    try {
      await openUrl(entry.apply_url || entry.url);
      setMessage({ text: `Opened ${entry.apply_url || entry.url}` });
    } catch (err) {
      setMessage({ text: `Could not open: ${err instanceof Error ? err.message : String(err)}`, error: true });
    }
  };

  const copyBullets = async (entry: QueueEntry) => {
    try {
      await navigator.clipboard.writeText((entry.tailored_bullets ?? []).join("\n"));
      setMessage({ text: "Copied bullets to clipboard" });
    } catch (err) {
      setMessage({ text: `Could not copy: ${err instanceof Error ? err.message : String(err)}`, error: true });
    }
  };

  const copyCoverLetter = async (entry: QueueEntry) => {
    try {
      await navigator.clipboard.writeText(entry.cover_letter ?? "");
      setMessage({ text: "Copied cover letter to clipboard" });
    } catch (err) {
      setMessage({ text: `Could not copy: ${err instanceof Error ? err.message : String(err)}`, error: true });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <div>
        <h1 style={{ fontSize: "var(--text-3xl)", marginBottom: "var(--space-2)" }}>Documents</h1>
        <div className="data-toolbar">
          <span style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
            {entries.length} {showResolved ? "total" : "pending"}
          </span>
          <div className="data-toolbar-spacer" />
          <button
            type="button"
            className={showResolved ? "source-toggle on" : "source-toggle"}
            onClick={() => setShowResolved((s) => !s)}
          >
            Show resolved
          </button>
        </div>
      </div>

      {message ? (
        <div className={message.error ? "message-banner message-banner-error" : "message-banner"}>{message.text}</div>
      ) : null}

      <div className="data-screen">
        <div className="data-list-col">
          {!loaded ? (
            <SkeletonRows />
          ) : entries.length === 0 ? (
            <div className="data-empty">
              No tailored documents yet — {showResolved ? "none have been produced" : "they appear once the agent tailors a resume for a posting"}.
            </div>
          ) : (
            <div className="data-list">
              {entries.map((entry) => {
                const resolved = state ? isResolved(state, entry) : false;
                return (
                  <button
                    key={entry.job_id}
                    type="button"
                    className={entry.job_id === selected ? "data-row selected" : "data-row"}
                    onClick={() => setSelected(entry.job_id)}
                  >
                    <div className="data-row-main">
                      <span className="data-row-title">
                        {entry.company} — {entry.title}
                      </span>
                      <span className="data-row-sub">
                        {typeof entry.ats_score === "number" ? `ats ${entry.ats_score}` : entry.source ?? ""}
                      </span>
                    </div>
                    <span className={resolved ? "status-badge status-badge-good" : "status-badge status-badge-warn"}>
                      {resolved ? "Resolved" : "Pending"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {selectedEntry ? (
          <div className="detail-col">
            <div className="detail-title">
              {selectedEntry.company} — {selectedEntry.title}
            </div>
            {typeof selectedEntry.ats_score === "number" ? (
              <div className="detail-row">
                <span className="detail-row-label">ATS score</span>
                <span className="detail-row-value">
                  {selectedEntry.ats_score} · {selectedEntry.source ?? "?"}
                </span>
              </div>
            ) : null}
            {selectedEntry.resume_used ? (
              <div className="detail-row">
                <span className="detail-row-label">Resume</span>
                <span className="detail-row-value">{selectedEntry.resume_used}</span>
              </div>
            ) : null}
            <div className="detail-row">
              <span className="detail-row-label">URL</span>
              <span className="detail-row-value">{selectedEntry.url}</span>
            </div>

            {selectedEntry.tailored_bullets?.length ? (
              <>
                <hr className="detail-rule" />
                <div className="detail-row">
                  <span className="detail-row-label">Tailored bullets</span>
                  <ul style={{ margin: 0, paddingLeft: "1.1rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                    {selectedEntry.tailored_bullets.map((bullet, i) => (
                      <li key={i} className="detail-row-value">
                        {bullet}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : null}

            {selectedEntry.cover_letter ? (
              <>
                <hr className="detail-rule" />
                <div className="detail-row">
                  <span className="detail-row-label">Cover letter</span>
                  <span className="detail-row-value" style={{ whiteSpace: "pre-wrap" }}>
                    {selectedEntry.cover_letter}
                  </span>
                </div>
              </>
            ) : null}

            {selectedEntry.missing_keywords?.length ? (
              <>
                <hr className="detail-rule" />
                <div className="detail-row">
                  <span className="detail-row-label">Missing keywords</span>
                  <span className="detail-row-value">{selectedEntry.missing_keywords.join(", ")}</span>
                </div>
              </>
            ) : null}

            <hr className="detail-rule" />
            <div className="detail-actions">
              <button type="button" className="btn btn-sm" onClick={() => void open(selectedEntry)}>
                Open
              </button>
              {selectedEntry.tailored_bullets?.length ? (
                <button type="button" className="btn btn-sm" onClick={() => void copyBullets(selectedEntry)}>
                  Copy bullets
                </button>
              ) : null}
              {selectedEntry.cover_letter ? (
                <button type="button" className="btn btn-sm" onClick={() => void copyCoverLetter(selectedEntry)}>
                  Copy cover letter
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
