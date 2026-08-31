import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { loadState, isResolved } from "@aplyx/core/state.js";
import type { AplyxState, QueueEntry } from "@aplyx/core/state.js";
import { openUrl, helperError, reopenApplicationFilled } from "@aplyx/core/helpers.js";
import { markQueueEntryApplied, dismissQueueEntry } from "@aplyx/core/reviewActions.js";
import { theme, statusGlyph, SELECT_MARKER } from "../theme.js";
import { DetailPane, PaneRow, PaneRule, paneLayout } from "./Pane.js";

interface Props {
  root: string;
  /** Only the focused tab receives keys (and never on piped stdin). */
  active: boolean;
  /** Incremented by the shell on global refresh so this screen reloads
   *  its internal state copy: without this, App "R" only updates App's
   *  own state and this screen stays stale. */
  refreshNonce?: number;
  /** Notify the shell that a mutation occurred so top-level badges refresh. */
  onStateChange?: () => void;
  /** Rows the shell hands this screen: the list grows/shrinks with it. */
  contentRows?: number;
  /** Columns of the content band: a detail pane opens when it fits. */
  columns?: number;
}

/**
 * Review-queue triage. The queue file is append-only, so triage records
 * outcomes through the helpers (applied_jobs append + registry event) and
 * derives "resolved" instead of deleting entries.
 */
export function ReviewScreen({ root, active, refreshNonce, onStateChange, contentRows = 20, columns = 0 }: Props) {
  const [state, setState] = useState<AplyxState>(() => loadState(root));
  const [cursor, setCursor] = useState(0);
  const [showResolved, setShowResolved] = useState(false);
  const [message, setMessage] = useState("");
  // With the detail pane the selection details move off the list column,
  // so the list keeps most of the rows; stacked (narrow) reserves rows
  // for the inline details below.
  const pane = paneLayout(columns);
  const visible = Math.max(3, Math.min(30, contentRows - (pane.show ? 5 : 8)));

  const entries = useMemo(
    () => state.queue.filter((e) => showResolved || !isResolved(state, e)),
    [state, showResolved],
  );
  const selected: QueueEntry | undefined = entries[cursor];

  // Shell-level refresh (App "R" / tab switch) reloads this screen's
  // internal state copy: without this, App refresh only updates its own
  // state and this screen stays stale.
  useEffect(() => {
    setState(loadState(root));
  }, [root, refreshNonce]);

  // Post-render safety clamp: refresh()'s cursor clamp runs against the
  // stale pre-render `entries` closure, so a concurrent queue shrink of
  // more than one item can leave the cursor out of bounds and `selected`
  // undefined until the next keypress. Re-clamp here against the actual
  // current entries.length every render so the cursor is always valid.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  // Keep the selected row visible when the queue is longer than the visible
  // window. The cursor may legitimately move outside the first page; this
  // window follows it so there is always a visible selection marker.
  //
  // Computed during render (via a ref, not useState+useEffect): an effect
  // reacting to `cursor` only adjusts the offset AFTER the commit that
  // already moved the cursor, so there's a real intermediate frame (
  // actually painted to the terminal, not just theoretical) where the
  // selected row has scrolled out of the still-stale window and nothing
  // visible carries the selection marker. Deriving offset synchronously
  // here means the window rendered this pass is already correct.
  const offsetRef = useRef(0);
  const maxOffset = Math.max(0, entries.length - visible);
  let offset = Math.min(offsetRef.current, maxOffset);
  if (entries.length > visible) {
    if (cursor < offset) offset = cursor;
    else if (cursor >= offset + visible) offset = cursor - visible + 1;
  } else {
    offset = 0;
  }
  offsetRef.current = offset;

  const refresh = () => {
    const fresh = loadState(root);
    const freshEntries = fresh.queue.filter((e) => showResolved || !isResolved(fresh, e));
    setState(fresh);
    setCursor((c) => Math.max(0, Math.min(c, Math.max(0, freshEntries.length - 1))));
    onStateChange?.();
  };

  const markApplied = (entry: QueueEntry) => {
    setMessage(markQueueEntryApplied(root, entry).message);
  };

  const dismiss = (entry: QueueEntry) => {
    setMessage(dismissQueueEntry(root, entry).message);
  };

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === "j")
        return setCursor((c) => Math.min(entries.length - 1, c + 1));
      if (input === "x") return setShowResolved((s) => !s);
      if (!selected) {
        if (input === "o" || input === "a" || input === "d" || key.return) {
          setMessage("Queue is empty. Nothing selected.");
        }
        return;
      }
      try {
        if (input === "o" || key.return) {
          // A fill record means this application was actually filled out
          // (in full or in part) before landing in review: reopen it
          // pre-filled (fields, resume, cover letter already in place)
          // instead of a blank form. Entries with nothing to replay (e.g.
          // Workday, which never reaches the fill step) fall back to the
          // plain URL open below.
          if (selected.fill_record_path) {
            setMessage("Opening pre-filled application…");
            reopenApplicationFilled(root, selected.job_id).then((result) => {
              setMessage(result.message);
            });
          } else {
            const target = selected.apply_url || selected.url;
            openUrl(target);
            setMessage(`Opened ${target}`);
          }
        } else if (input === "a") {
          markApplied(selected);
          refresh();
        } else if (input === "d") {
          dismiss(selected);
          refresh();
        }
      } catch (err) {
        setMessage(helperError(err));
      }
    },
    { isActive: active && Boolean(process.stdin.isTTY) },
  );

  const empty = entries.length === 0;
  const page = entries.slice(offset, offset + visible);

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Review queue{" "}
        <Text dimColor>
          ({entries.length} {showResolved ? "total" : "pending"})
        </Text>
      </Text>

      <Box marginTop={1} flexDirection="row" minHeight={pane.show ? visible : undefined}>
        <Box flexDirection="column" flexGrow={1}>
          {empty ? (
            <Box flexDirection="column">
              <Text dimColor>{statusGlyph.applied} Nothing to review.</Text>
              <Text dimColor>Queue is empty{showResolved ? "" : ": new items appear as the agent runs"}.</Text>
            </Box>
          ) : (
            page.map((entry, i) => {
              const idx = offset + i;
              const resolved = isResolved(state, entry);
              const marker = idx === cursor ? SELECT_MARKER : " ";
              const glyph = resolved ? statusGlyph.applied : "•";
              const ats =
                typeof entry.ats_score === "number" ? `  ats ${entry.ats_score}` : "";
              const tail = resolved ? "  [resolved]" : "";
              const label = `${glyph} ${entry.company} · ${entry.title}${ats}${tail}`;
              return idx === cursor ? (
                <Text key={`${entry.job_id}-${idx}`} color={theme.accent} inverse wrap="truncate-end">
                  {`${marker} ${label}`}
                </Text>
              ) : (
                <Text key={`${entry.job_id}-${idx}`} wrap="truncate-end">
                  {`${marker} ${label}`}
                </Text>
              );
            })
          )}
        </Box>
        {pane.show ? (
          <DetailPane width={pane.width}>
            {selected ? (
              <>
                <Text bold color={theme.accent} wrap="truncate-end">
                  {selected.company} · {selected.title}
                </Text>
                <PaneRow
                  label="state"
                  value={isResolved(state, selected) ? "resolved" : "pending"}
                  color={isResolved(state, selected) ? theme.good : theme.warn}
                />
                {typeof selected.ats_score === "number" ? (
                  <PaneRow label="ats" value={`${selected.ats_score} · ${selected.source ?? "?"}`} />
                ) : null}
                {selected.resume_used ? <PaneRow label="resume" value={selected.resume_used} /> : null}
                <PaneRow label="url" value={selected.url} wrap="wrap" />
                {selected.reasoning ? (
                  <>
                    <PaneRule title="why" />
                    <Text wrap="wrap">{selected.reasoning}</Text>
                  </>
                ) : null}
                {selected.doubt_signals && selected.doubt_signals.length > 0 ? (
                  <PaneRow label="doubt" value={selected.doubt_signals.join(", ")} wrap="wrap" />
                ) : null}
                <PaneRule title="actions" />
                <Text dimColor wrap="wrap">enter/o open · a mark applied · d dismiss</Text>
              </>
            ) : (
              <>
                <Text dimColor>No selection</Text>
                <Text dimColor wrap="wrap">Items land here when the agent (or a manual save) flags a posting for review.</Text>
              </>
            )}
          </DetailPane>
        ) : null}
      </Box>

      {!pane.show && selected ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>url  {selected.url}</Text>
          {selected.reasoning ? <Text dimColor>why  {selected.reasoning}</Text> : null}
          {selected.doubt_signals && selected.doubt_signals.length > 0 ? (
            <Text dimColor>doubt  {selected.doubt_signals.join(", ")}</Text>
          ) : null}
        </Box>
      ) : null}

      {message ? (
        <Box marginTop={1}>
          <Text color={theme.warn}>{statusGlyph.needs_review} {message}</Text>
        </Box>
      ) : null}

      {!empty && entries.length > visible ? (
        <Box marginTop={1}>
          <Text dimColor>
            rows {offset + 1}–{Math.min(offset + visible, entries.length)} of {entries.length} · ↑/↓ to navigate
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export const REVIEW_HINTS = "↑↓ select · enter/o open · a applied · d dismiss · x resolved";
