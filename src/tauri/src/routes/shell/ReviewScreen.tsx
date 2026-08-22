import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { QueueEntry, FillRecord } from "@aplyx/core/stateDerive.js";
import { isResolved } from "@aplyx/core/stateDerive.js";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { markQueueEntryApplied, dismissQueueEntry, reopenApplicationFilled, approveSubmit, readScreenshot, readFillRecord, readWorkdayCheckpoint, type ApproveSubmitResult, type WorkdayCheckpoint } from "../../lib/bridge";
import { useAplyxState } from "../../lib/useAplyxState";
import { useAuth } from "../../lib/AuthContext";
import { getSupabaseClient } from "../../lib/supabaseClient";
import { SkeletonRows } from "../../components/Skeleton";
import "../../components/formFields.css";
import "../../components/dataList.css";
import "../../components/Skeleton.css";

/** A queue entry is a confirm-before-submit "ready to submit" item when its
 *  status is "ready_to_submit" — the agent ran the full pipeline through
 *  pre-submit verification then paused with a filled-but-not-submitted form
 *  (docs/hosted-auto-apply-plan.md Stage 1). These surface a screenshot,
 *  structured field summary (fill_record), and resume preview
 *  (tailored_bullets/cover_letter) for the user to approve before the
 *  actual submit click. Ordinary needs_review entries stay on the existing
 *  Open/Mark applied/Dismiss flow unchanged. */
function isReadyToSubmit(entry: QueueEntry): boolean {
  return entry.status === "ready_to_submit";
}

function isWorkdayEntry(entry: QueueEntry): boolean {
  return (entry.source ?? "") === "workday";
}

/** Classifies a Workday checkpoint status (the `status` field the local
 *  runtime writes to data/workday_apply_runs/<job_id>.json — see
 *  approve_submit_workday.py) into the categories the detail pane and
 *  action buttons branch on. `ready_to_submit` is the final review/submit
 *  stage: the form is filled and verified, and the only remaining step is
 *  the actual submit click — the queue row's status is still
 *  `needs_review` at that point (the runtime paused instead of
 *  submitting), so the UI has to surface the checkpoint state itself
 *  rather than trust the queue badge. `submitted` is terminal success;
 *  the `*_unrecognized` / `submit_*` statuses are errors or ambiguous
 *  outcomes that need operator attention. Everything else is an
 *  in-progress waiting state (account created, verified, logged in, a
 *  page filled or advanced) where "Continue Workday" is the right next
 *  action. */
type WorkdayCheckpointCategory = "ready" | "waiting" | "submitted" | "error" | "unknown";

function classifyWorkdayStatus(status: string | undefined): WorkdayCheckpointCategory {
  switch (status) {
    case "ready_to_submit":
      return "ready";
    case "submitted":
      return "submitted";
    case "awaiting_verification":
    case "verified":
    case "logged_in":
    case "page_filled":
    case "page_advanced":
      return "waiting";
    case "submit_validation_error":
    case "submit_click_failed":
    case "submit_outcome_unclear":
    case "account_form_unrecognized":
    case "login_form_unrecognized":
    case "form_unrecognized":
      return "error";
    default:
      return "unknown";
  }
}

/** Human-readable label for a Workday checkpoint status, used in the
 *  detail pane's status badge. Falls back to the raw status string so
 *  a future runtime status the classifier hasn't catalogued still
 *  surfaces verbatim instead of as "unknown". */
function workdayStatusLabel(status: string | undefined): string {
  switch (status) {
    case "ready_to_submit": return "Ready to submit";
    case "submitted": return "Submitted";
    case "awaiting_verification": return "Awaiting verification";
    case "verified": return "Verified";
    case "logged_in": return "Logged in";
    case "page_filled": return "Page filled";
    case "page_advanced": return "Page advanced";
    case "submit_validation_error": return "Submit validation error";
    case "submit_click_failed": return "Submit click failed";
    case "submit_outcome_unclear": return "Submit outcome unclear";
    case "account_form_unrecognized": return "Account form unrecognized";
    case "login_form_unrecognized": return "Login form unrecognized";
    case "form_unrecognized": return "Form unrecognized";
    default: return status ?? "unknown";
  }
}

/** Badge class for a Workday checkpoint category — mirrors the queue
 *  row's badge palette so the checkpoint section reads consistently
 *  with the rest of the screen. */
function workdayBadgeClass(category: WorkdayCheckpointCategory): string {
  switch (category) {
    case "ready": return "status-badge status-badge-info";
    case "submitted": return "status-badge status-badge-good";
    case "error": return "status-badge status-badge-danger";
    case "waiting": return "status-badge status-badge-warn";
    default: return "status-badge status-badge-muted";
  }
}

/** Formats the richer Workday continuation result (checkpoint status,
 *  filled-field count, resume attachment, confirmation URL) into a single
 *  message-banner string so the user can see where the resumable flow
 *  paused without opening the checkpoint file. The script's own message
 *  is always the lead; this appends the structured context it carries. */
function formatWorkdayDetail(result: ApproveSubmitResult): string {
  const parts: string[] = [result.message];
  if (result.checkpointStatus) parts.push(`checkpoint: ${result.checkpointStatus}`);
  if (typeof result.filledFields === "number") parts.push(`${result.filledFields} field(s) filled`);
  if (result.resumeAttached) parts.push("resume attached");
  if (result.confirmationUrl) parts.push(result.confirmationUrl);
  return parts.join(" · ");
}

/** Defensively reads the screenshot reference a ready-to-submit entry may
 *  carry — `screenshot_path` (local, a file the bridge reads as a data URL)
 *  or `screenshot_url` (hosted, a URL the webview loads directly). The
 *  core/adapter slice adds whichever field applies to the entry's mode;
 *  both are optional and absent on entries that never reached the fill
 *  step (e.g. Workday). */
function screenshotRef(entry: QueueEntry): { kind: "path"; value: string } | { kind: "url"; value: string } | undefined {
  const path = (entry as QueueEntry & { screenshot_path?: string }).screenshot_path;
  if (path) return { kind: "path", value: path };
  const url = (entry as QueueEntry & { screenshot_url?: string }).screenshot_url;
  if (url) return { kind: "url", value: url };
  return undefined;
}

export function ReviewScreen() {
  const { state, loaded, source, root, hosted, refresh } = useAplyxState();
  const { status: authStatus, session } = useAuth();
  const [showResolved, setShowResolved] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | undefined>(undefined);
  const [screenshot, setScreenshot] = useState<string | undefined>(undefined);
  const [fillRecord, setFillRecord] = useState<FillRecord | null | undefined>(undefined);
  const [workdayCheckpoint, setWorkdayCheckpoint] = useState<WorkdayCheckpoint | null | undefined>(undefined);

  const entries = useMemo(
    () => (state ? state.queue.filter((e) => showResolved || !isResolved(state, e)) : []),
    [state, showResolved],
  );
  const selectedEntry = entries.find((e) => e.job_id === selected);

  // Queue-first workflow: land on the first pending item rather than a
  // blank detail pane, and when acting on one resolves/removes it from
  // `entries`, land on the next one automatically — deciding on an item
  // flows straight into the next decision instead of bouncing back to an
  // empty pane that has to be re-clicked into.
  useEffect(() => {
    if (entries.length === 0) return;
    if (!entries.some((e) => e.job_id === selected)) setSelected(entries[0]!.job_id);
  }, [entries, selected]);

  // Loads the confirm-before-submit artifact (screenshot + field summary)
  // for the selected ready-to-submit entry. Local mode reads the screenshot
  // file via the bridge and the fill record via readFillRecord; hosted mode
  // uses screenshot_url directly and the inline fill_record the adapter
  // already populated. Resets when the selection changes or leaves
  // ready-to-submit so stale artifacts never bleed across entries.
  useEffect(() => {
    setScreenshot(undefined);
    setFillRecord(undefined);
    setWorkdayCheckpoint(undefined);
    if (!selectedEntry) return;
    let cancelled = false;
    const loadLocal = source === "local" && root;
    if (isReadyToSubmit(selectedEntry)) {
      const ref = screenshotRef(selectedEntry);
      if (ref?.kind === "url") {
        setScreenshot(ref.value);
      } else if (ref?.kind === "path" && loadLocal) {
        readScreenshot(root, ref.value)
          .then((url) => { if (!cancelled) setScreenshot(url ?? undefined); })
          .catch(() => { if (!cancelled) setScreenshot(undefined); });
      }
      if (selectedEntry.fill_record) {
        setFillRecord(selectedEntry.fill_record);
      } else if (loadLocal && selectedEntry.fill_record_path) {
        readFillRecord(root, selectedEntry.fill_record_path)
          .then((rec) => { if (!cancelled) setFillRecord(rec); })
          .catch(() => { if (!cancelled) setFillRecord(null); });
      } else {
        setFillRecord(null);
      }
    } else if (isWorkdayEntry(selectedEntry) && loadLocal) {
      readWorkdayCheckpoint(root, selectedEntry.job_id)
        .then(async (checkpoint) => {
          if (cancelled) return;
          setWorkdayCheckpoint(checkpoint);
          const path = checkpoint?.screenshot_path;
          if (!path) return;
          try {
            const url = await readScreenshot(root, path);
            if (!cancelled) setScreenshot(url ?? undefined);
          } catch {
            if (!cancelled) setScreenshot(undefined);
          }
        })
        .catch(() => {
          if (!cancelled) setWorkdayCheckpoint(null);
        });
    }
    return () => { cancelled = true; };
  }, [selectedEntry, source, root]);

  const open = async (entry: QueueEntry) => {
    // A fill record means this application was actually filled out (in
    // full or in part) before landing in review — reopen it pre-filled
    // (fields, resume, cover letter already in place) instead of a blank
    // form. Local-only: replaying a fill drives the user's real, already-
    // installed Chrome via Playwright, which a hosted-only session (no
    // local install on this machine) has no way to do — a hosted entry's
    // fill_record (content, not a path — see stateDerive.ts) falls back to
    // the plain URL open below, same as an entry with nothing to replay
    // (e.g. Workday, which never reaches the fill step).
    if (source === "local" && root && entry.fill_record_path) {
      setMessage({ text: "Opening pre-filled application…" });
      try {
        const result = await reopenApplicationFilled(root, entry.job_id);
        setMessage({ text: result.message, error: !result.ok });
      } catch (err) {
        setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
      }
      return;
    }
    try {
      await openUrl(entry.apply_url || entry.url);
      setMessage({ text: `Opened ${entry.apply_url || entry.url}` });
    } catch (err) {
      setMessage({ text: `Could not open: ${err instanceof Error ? err.message : String(err)}`, error: true });
    }
  };

  const markApplied = async (entry: QueueEntry) => {
    setBusy(true);
    try {
      const result =
        source === "local" && root
          ? await markQueueEntryApplied(root, entry)
          : source === "hosted" && hosted
            ? await new SupabaseAdapter(hosted.client, hosted.userId).markQueueEntryApplied(entry)
            : undefined;
      if (!result) return;
      setMessage({ text: result.message });
      await refresh();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (entry: QueueEntry) => {
    setBusy(true);
    try {
      const result =
        source === "local" && root
          ? await dismissQueueEntry(root, entry)
          : source === "hosted" && hosted
            ? await new SupabaseAdapter(hosted.client, hosted.userId).dismissQueueEntry(entry)
            : undefined;
      if (!result) return;
      setMessage({ text: result.message });
      await refresh();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  // Confirm-before-submit "Approve" — the agent paused with a filled,
  // verified form; this tells it to click submit. Local mode goes through
  // the bridge (approveSubmit → triggerSingleJobApply as the v1 mechanism);
  // hosted mode calls SupabaseAdapter.approveSubmit, which the core/adapter
  // slice provides. Resolves once the run has launched, not once it
  // finishes — the actual outcome shows up the normal way (review queue or
  // applied_jobs, picked up by useAplyxState's poll).
  const approve = async (entry: QueueEntry) => {
    setBusy(true);
    try {
      const result =
        source === "local" && root
          ? isWorkdayEntry(entry)
            ? authStatus === "signed-in" && session
              ? await (async () => {
                  const client = await getSupabaseClient();
                  const adapter = new SupabaseAdapter(client, session.user.id);
                  const forwardingEmail = String(await adapter.readProfileField("email") ?? "").trim();
                  if (!forwardingEmail) {
                    return { ok: false, message: "Workday continuation needs a hosted sign-in with a profile email saved first." };
                  }
                  const alias = await adapter.claimManagedAlias("workday", forwardingEmail);
                  const inbox = await adapter.listInboundEmails(alias.id);
                  // Capture the row IDs of the unconsumed verification
                  // link/OTP we're handing to the script, so after the
                  // run we can mark them consumed — a one-time
                  // verification link must never be re-handed to the next
                  // continuation. The script reports whether it actually
                  // used each (usedVerificationLink/usedVerificationOtp);
                  // we only consume the ones it consumed.
                  const linkRow = inbox.find((row) => !row.consumed_at && row.parsed_link);
                  const otpRow = inbox.find((row) => !row.consumed_at && row.parsed_otp);
                  const result = await approveSubmit(root, entry, {
                    aliasEmail: `${alias.alias}@mail.aplyx.app`,
                    aliasId: alias.id,
                    verificationLink: linkRow?.parsed_link,
                    verificationOtp: otpRow?.parsed_otp,
                  });
                  // Consume the verification mails the script actually
                  // used. Best-effort: a consume failure (RLS, missing
                  // row) is surfaced as a follow-up warning, not a hard
                  // error — the verification already happened in the
                  // browser; not marking it consumed only means the next
                  // run might re-offer it, which the script's own
                  // checkpoint state guards against independently.
                  const consumeWarnings: string[] = [];
                  if (result.usedVerificationLink && linkRow) {
                    try { await adapter.consumeInboundEmail(linkRow.id); }
                    catch (e) { consumeWarnings.push(`could not mark verification link consumed: ${e instanceof Error ? e.message : String(e)}`); }
                  }
                  if (result.usedVerificationOtp && otpRow) {
                    try { await adapter.consumeInboundEmail(otpRow.id); }
                    catch (e) { consumeWarnings.push(`could not mark verification OTP consumed: ${e instanceof Error ? e.message : String(e)}`); }
                  }
                  const detail = formatWorkdayDetail(result);
                  const message = consumeWarnings.length > 0
                    ? `${detail} (${consumeWarnings.join("; ")})`
                    : detail;
                  return { ...result, message };
                })()
              : { ok: false, message: "Workday continuation needs you to be signed in so aplyx can claim a managed alias." }
            : await approveSubmit(root, entry)
          : source === "hosted" && hosted
            ? await (new SupabaseAdapter(hosted.client, hosted.userId) as SupabaseAdapter & {
                approveSubmit?(entry: QueueEntry): Promise<{ ok: boolean; message: string }>;
              }).approveSubmit?.(entry)
            : undefined;
      if (!result) {
        setMessage({ text: "Approve is not available for this entry.", error: true });
        return;
      }
      setMessage({ text: result.message, error: !result.ok });
      await refresh();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <div>
        <h1 style={{ fontSize: "var(--text-3xl)", marginBottom: "var(--space-2)" }}>Review queue</h1>
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
              Nothing to review — {showResolved ? "the queue is empty" : "new items appear as the agent runs"}.
            </div>
          ) : (
            <div className="data-list">
              {entries.map((entry) => {
                const resolved = state ? isResolved(state, entry) : false;
                const ready = isReadyToSubmit(entry);
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
                    <span
                      className={
                        resolved
                          ? "status-badge status-badge-good"
                          : ready
                            ? "status-badge status-badge-info"
                            : "status-badge status-badge-warn"
                      }
                    >
                      {resolved ? "Resolved" : ready ? "Ready to submit" : "Pending"}
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
            {selectedEntry.reasoning ? (
              <>
                <hr className="detail-rule" />
                <div className="detail-row">
                  <span className="detail-row-label">Why</span>
                  <span className="detail-row-value">{selectedEntry.reasoning}</span>
                </div>
              </>
            ) : null}
            {selectedEntry.doubt_signals && selectedEntry.doubt_signals.length > 0 ? (
              <div className="detail-row">
                <span className="detail-row-label">Doubt</span>
                <span className="detail-row-value">{selectedEntry.doubt_signals.join(", ")}</span>
              </div>
            ) : null}
            {isWorkdayEntry(selectedEntry) && workdayCheckpoint ? (
              <>
                <hr className="detail-rule" />
                <div className="detail-row">
                  <span className="detail-row-label">Checkpoint</span>
                  <span className="detail-row-value">
                    <span className={workdayBadgeClass(classifyWorkdayStatus(workdayCheckpoint.status))}>
                      {workdayStatusLabel(workdayCheckpoint.status)}
                    </span>
                    {workdayCheckpoint.updated_at ? ` · updated ${workdayCheckpoint.updated_at}` : ""}
                  </span>
                </div>
                {workdayCheckpoint.alias_email ? (
                  <div className="detail-row">
                    <span className="detail-row-label">Alias</span>
                    <span className="detail-row-value">{workdayCheckpoint.alias_email}</span>
                  </div>
                ) : null}
                {workdayCheckpoint.last_fill ? (
                  <>
                    {workdayCheckpoint.last_fill.step_title ? (
                      <div className="detail-row">
                        <span className="detail-row-label">Last step</span>
                        <span className="detail-row-value">{workdayCheckpoint.last_fill.step_title}</span>
                      </div>
                    ) : null}
                    {workdayCheckpoint.last_fill.next_step_title ? (
                      <div className="detail-row">
                        <span className="detail-row-label">Next step</span>
                        <span className="detail-row-value">{workdayCheckpoint.last_fill.next_step_title}</span>
                      </div>
                    ) : null}
                    {workdayCheckpoint.last_fill.url ? (
                      <div className="detail-row">
                        <span className="detail-row-label">Step URL</span>
                        <span className="detail-row-value">{workdayCheckpoint.last_fill.url}</span>
                      </div>
                    ) : null}
                    {typeof workdayCheckpoint.last_fill.filled_labels?.length === "number" ? (
                      <div className="detail-row">
                        <span className="detail-row-label">Filled fields</span>
                        <span className="detail-row-value">
                          {workdayCheckpoint.last_fill.filled_labels.length}
                          {workdayCheckpoint.last_fill.resume_attached ? " · resume attached" : ""}
                        </span>
                      </div>
                    ) : null}
                    {workdayCheckpoint.last_fill.unmatched_keys && workdayCheckpoint.last_fill.unmatched_keys.length > 0 ? (
                      <div className="detail-row">
                        <span className="detail-row-label">Unmatched</span>
                        <span className="detail-row-value">{workdayCheckpoint.last_fill.unmatched_keys.join(", ")}</span>
                      </div>
                    ) : null}
                    {workdayCheckpoint.last_fill.advance_error ? (
                      <div className="detail-row">
                        <span className="detail-row-label">Advance</span>
                        <span className="detail-row-value">{workdayCheckpoint.last_fill.advance_error}</span>
                      </div>
                    ) : null}
                  </>
                ) : null}
                {screenshot ? (
                  <div className="detail-row">
                    <span className="detail-row-label">Screenshot</span>
                    <img
                      className="detail-screenshot"
                      src={screenshot}
                      alt={`Workday checkpoint for ${selectedEntry.company}`}
                    />
                  </div>
                ) : null}
              </>
            ) : null}

            {isReadyToSubmit(selectedEntry) ? (
              <>
                <hr className="detail-rule" />
                {screenshot ? (
                  <div className="detail-row">
                    <span className="detail-row-label">Form screenshot</span>
                    <img
                      className="detail-screenshot"
                      src={screenshot}
                      alt={`Filled application form for ${selectedEntry.company}`}
                    />
                  </div>
                ) : null}
                {fillRecord && fillRecord.fields.length > 0 ? (
                  <div className="detail-row">
                    <span className="detail-row-label">Filled fields</span>
                    <ul className="detail-field-summary">
                      {fillRecord.fields.map((f, i) => (
                        <li key={i}>
                          <span className="detail-field-name">{f.field_name}</span>
                          <span className="detail-field-value">{f.filled_value}</span>
                          <span className={`detail-field-src${f.verified ? "" : " detail-field-src-unverified"}`}>
                            {f.source}
                            {f.verified ? "" : " · unverified"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {selectedEntry.tailored_bullets && selectedEntry.tailored_bullets.length > 0 ? (
                  <div className="detail-row">
                    <span className="detail-row-label">Resume preview</span>
                    <ul className="detail-bullets">
                      {selectedEntry.tailored_bullets.map((bullet, i) => (
                        <li key={i}>{bullet}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {selectedEntry.cover_letter ? (
                  <div className="detail-row">
                    <span className="detail-row-label">Cover letter</span>
                    <span className="detail-row-value" style={{ whiteSpace: "pre-wrap" }}>
                      {selectedEntry.cover_letter}
                    </span>
                  </div>
                ) : null}
              </>
            ) : null}

            <hr className="detail-rule" />
            {isWorkdayEntry(selectedEntry) && workdayCheckpoint ? (
              <div className="detail-row">
                <span className="detail-row-label">Next action</span>
                <span className="detail-row-value" style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
                  {(() => {
                    const category = classifyWorkdayStatus(workdayCheckpoint.status);
                    if (category === "ready") {
                      return "Checkpoint reached the final review/submit stage. The queue row still shows needs_review because the runtime paused before clicking submit — approve below to submit.";
                    }
                    if (category === "submitted") {
                      return "Checkpoint recorded a submitted application. The queue row should resolve to applied shortly; if it doesn't, mark applied manually.";
                    }
                    if (category === "error") {
                      return "Checkpoint ended in an error or ambiguous state. Continue Workday to retry from the checkpoint, or apply manually via the posting URL.";
                    }
                    if (category === "waiting") {
                      return "Checkpoint paused mid-flow. Continue Workday to resume from the checkpoint.";
                    }
                    return "Continue Workday to resume from the checkpoint, or apply manually via the posting URL.";
                  })()}
                </span>
              </div>
            ) : null}
            <div className="detail-actions">
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void open(selectedEntry)}>
                Open
              </button>
              {isReadyToSubmit(selectedEntry) || isWorkdayEntry(selectedEntry) ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => void approve(selectedEntry)}
                >
                  {isWorkdayEntry(selectedEntry) && !isReadyToSubmit(selectedEntry)
                    ? classifyWorkdayStatus(workdayCheckpoint?.status) === "ready"
                      ? "Approve submit"
                      : "Continue Workday"
                    : "Approve submit"}
                </button>
              ) : null}
              <button
                type="button"
                className={isReadyToSubmit(selectedEntry) ? "btn btn-sm" : "btn btn-primary btn-sm"}
                disabled={busy}
                onClick={() => void markApplied(selectedEntry)}
              >
                Mark applied
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={busy}
                onClick={() => void dismiss(selectedEntry)}
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
