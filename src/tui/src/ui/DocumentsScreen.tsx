import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { loadState, isResolved } from "@aplyx/core/state.js";
import type { AplyxState, QueueEntry } from "@aplyx/core/state.js";
import { openUrl, helperError } from "@aplyx/core/helpers.js";
import { theme, statusGlyph, SELECT_MARKER } from "../theme.js";
import { DetailPane, paneLayout } from "./Pane.js";

interface Props {
  root: string;
  /** Only the focused tab receives keys (and never on piped stdin). */
  active: boolean;
  /** Incremented by the shell on global refresh so this screen reloads
   *  its internal state copy — without this, App "R" only updates App's
   *  own state and this screen stays stale. */
  refreshNonce?: number;
  /** Rows the shell hands this screen — the list grows/shrinks with it. */
  contentRows?: number;
  /** Columns of the content band — a detail pane opens when it fits. */
  columns?: number;
}

/** True once resume-tailor has actually produced something to review here —
 *  a queue entry that only went through the fit gate (e.g. needs_review
 *  before tailoring ever ran) has neither field, and is out of scope for
 *  this tab by design (see the module comment above Props). */
function hasTailoredDocs(entry: QueueEntry): boolean {
  return Boolean(entry.tailored_bullets?.length || entry.cover_letter);
}

/** Greedy word-wrap with forced paragraph breaks preserved — used to
 *  precompute exactly how many terminal rows a block of text will occupy
 *  so the detail pane's total content can be kept within the rows actually
 *  available *before* handing anything to Ink.
 *
 *  This screen is the first place in the app that hands Ink a block of
 *  content routinely taller than the pane showing it (a tailored cover
 *  letter alone commonly runs 15-30 rows once bullets/keywords are added).
 *  Letting Ink's own `wrap="wrap"` + a fixed-height `overflow="hidden"`
 *  ancestor do that clipping produced real, reproducible corruption —
 *  stale characters from the previous frame bleeding into unrelated rows
 *  (state/ats, url) — rather than a clean truncation. Wrapping by hand and
 *  slicing the resulting plain-string rows to the known row budget avoids
 *  ever asking Ink to clip overflowing content in the first place. */
function wrapLines(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (para.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of para.split(" ")) {
      if (current.length === 0) current = word;
      else if (current.length + 1 + word.length <= w) current += " " + word;
      else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** One already-wrapped detail-pane row, tagged with its own React key so
 *  the budget walk below can slice a flat list without re-keying. */
interface DetailRow {
  key: string;
  node: React.ReactNode;
}

function textRow(key: string, content: string, props: Record<string, unknown> = {}): DetailRow {
  return { key, node: <Text key={key} wrap="truncate-end" {...props}>{content || " "}</Text> };
}

/** Matches PaneRule's exact look (── title ──) as two explicit rows — a
 *  blank spacer + the rule line — so its cost is precisely 2 in the row
 *  budget below, rather than relying on PaneRule's own `marginTop` (a
 *  layout-level gap Ink computes itself, not something this hand-rolled
 *  budget can see). */
function ruleRows(key: string, title: string): DetailRow[] {
  return [
    { key: `${key}-gap`, node: <Text key={`${key}-gap`}> </Text> },
    {
      key: `${key}-title`,
      node: (
        <Text key={`${key}-title`} wrap="truncate-end">
          <Text color={theme.rule}>── </Text>
          <Text dimColor>{title}</Text>
          <Text color={theme.rule}> ──</Text>
        </Text>
      ),
    },
  ];
}

/** label/value pair wrapped to `width` with a 9-col label column, matching
 *  PaneRow's look — hand-rolled here (rather than reusing PaneRow) so every
 *  wrapped continuation line is its own precomputed DetailRow the budget
 *  walk can count and slice. */
function labeledRows(key: string, label: string, value: string, width: number): DetailRow[] {
  const labelCol = label.padEnd(9);
  const valueWidth = Math.max(4, width - 9);
  const lines = wrapLines(value, valueWidth);
  return lines.map((line, i) => ({
    key: `${key}-${i}`,
    node: (
      <Text key={`${key}-${i}`} wrap="truncate-end">
        {i === 0 ? labelCol : " ".repeat(9)}
        {line}
      </Text>
    ),
  }));
}

/** Builds the whole detail-pane row list for `selected`, already wrapped
 *  and already sliced to `budget` rows (see wrapLines' comment for why) —
 *  content order follows the spec exactly: header, ats/resume, bullets,
 *  a rule, cover letter, a rule, missing keywords, url, then the actions
 *  hint. Whatever doesn't fit is dropped from the END (url/actions first),
 *  with a one-line note in its place — the tailored content itself is why
 *  this tab exists, so it takes priority over the (redundant — the footer
 *  hint bar already says the same thing) in-pane action hint. */
function buildDetailRows(
  selected: QueueEntry,
  resolved: boolean,
  width: number,
): DetailRow[] {
  const rows: DetailRow[] = [];
  rows.push(textRow("header", `${selected.company} — ${selected.title}`, { bold: true, color: theme.accent }));
  rows.push(textRow("state", `state    ${resolved ? "resolved" : "pending"}`, {
    color: resolved ? theme.good : theme.warn,
  }));
  if (typeof selected.ats_score === "number") {
    rows.push(textRow("ats", `ats      ${selected.ats_score} · ${selected.source ?? "?"}`));
  }
  if (selected.resume_used) rows.push(textRow("resume", `resume   ${selected.resume_used}`));

  if (selected.tailored_bullets && selected.tailored_bullets.length > 0) {
    rows.push(...ruleRows("bullets-rule", "bullets"));
    selected.tailored_bullets.forEach((bullet, bi) => {
      wrapLines(`• ${bullet}`, width).forEach((line, li) => rows.push(textRow(`bullet-${bi}-${li}`, line)));
    });
  }
  if (selected.cover_letter) {
    rows.push(...ruleRows("cover-rule", "cover letter"));
    wrapLines(selected.cover_letter, width).forEach((line, li) => rows.push(textRow(`cover-${li}`, line)));
  }
  if (selected.missing_keywords && selected.missing_keywords.length > 0) {
    rows.push(...ruleRows("keywords-rule", "missing keywords"));
    wrapLines(selected.missing_keywords.join(", "), width).forEach((line, li) =>
      rows.push(textRow(`keywords-${li}`, line)),
    );
  }
  rows.push(...labeledRows("url", "url", selected.url, width));
  rows.push(...ruleRows("actions-rule", "actions"));
  rows.push(textRow("actions-hint", "enter/o open · x resolved", { dimColor: true }));
  return rows;
}

/** Slices `rows` to `budget`, appending a one-line "n more lines" note in
 *  the last slot when something had to be cut — so truncation is always
 *  visible rather than silently clipped. */
function fitRows(rows: DetailRow[], budget: number): DetailRow[] {
  if (rows.length <= budget) return rows;
  const cut = rows.length - (budget - 1);
  const kept = rows.slice(0, Math.max(0, budget - 1));
  kept.push({
    key: "truncated-note",
    node: (
      <Text key="truncated-note" dimColor wrap="truncate-end">
        … {cut} more line{cut === 1 ? "" : "s"} — heighten the terminal to see the rest
      </Text>
    ),
  });
  return kept;
}

/**
 * Read-only viewer over the review queue's tailored content. review_queue.json
 * is append-only by project convention (AGENTS.md's "File write discipline"),
 * and this screen introduces no new mutation path — it exists purely so a
 * user can read/copy the tailored bullets, cover letter, and missing
 * keywords resume-tailor already produced for a queued posting. Mutation
 * (mark applied / dismiss) stays on the separate Review tab.
 */
export function DocumentsScreen({ root, active, refreshNonce, contentRows = 20, columns = 0 }: Props) {
  const [state, setState] = useState<AplyxState>(() => loadState(root));
  const [cursor, setCursor] = useState(0);
  const [showResolved, setShowResolved] = useState(false);
  const [message, setMessage] = useState("");
  // With the detail pane the selection details move off the list column,
  // so the list keeps most of the rows; stacked (narrow) reserves rows
  // for the inline details below.
  const pane = paneLayout(columns);
  const visible = Math.max(3, Math.min(30, contentRows - (pane.show ? 5 : 8)));
  // The detail pane's own row budget: same overhead accounting as `visible`
  // above (used for the list's own pagination), but not capped at 30 —
  // unlike the list, which gains nothing from showing more than ~30 rows
  // at once, the detail pane's tailored content (a full cover letter
  // routinely runs 20-40+ rows once bullets/keywords are added) should use
  // all the vertical room a tall terminal actually has. Two rows more
  // margin than `visible` uses, so the message/rows-indicator lines below
  // the list|detail row never have to compete with this pane for the same
  // budget App.tsx's own frame-height clip enforces — see fitRows' own
  // truncation note for what happens on a terminal too short to fit it all.
  const detailBudget = Math.max(6, contentRows - (pane.show ? 7 : 10));

  const entries = useMemo(
    () => state.queue.filter((e) => hasTailoredDocs(e) && (showResolved || !isResolved(state, e))),
    [state, showResolved],
  );
  const selected: QueueEntry | undefined = entries[cursor];

  // Shell-level refresh (App "R" / tab switch) reloads this screen's
  // internal state copy — without this, App refresh only updates its own
  // state and this screen stays stale.
  useEffect(() => {
    setState(loadState(root));
  }, [root, refreshNonce]);

  // Post-render safety clamp: a concurrent queue shrink can leave the
  // cursor out of bounds and `selected` undefined until the next keypress
  // (same reasoning as ReviewScreen.tsx's matching effect).
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  // Keep the selected row visible when the list is longer than the visible
  // window — same synchronous-during-render derivation as ReviewScreen.tsx
  // (an effect reacting to `cursor` would leave one stale-window frame
  // actually painted before catching up).
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

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === "j")
        return setCursor((c) => Math.min(entries.length - 1, c + 1));
      if (input === "x") return setShowResolved((s) => !s);
      if (!selected) {
        if (input === "o" || key.return) {
          setMessage("Nothing selected — no tailored documents to open.");
        }
        return;
      }
      if (input === "o" || key.return) {
        try {
          const target = selected.apply_url || selected.url;
          openUrl(target);
          setMessage(`Opened ${target}`);
        } catch (err) {
          setMessage(helperError(err));
        }
      }
    },
    { isActive: active && Boolean(process.stdin.isTTY) },
  );

  const empty = entries.length === 0;
  const page = entries.slice(offset, offset + visible);

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Documents{" "}
        <Text dimColor>
          ({entries.length} {showResolved ? "total" : "pending"})
        </Text>
      </Text>

      <Box marginTop={1} flexDirection="row" minHeight={pane.show ? visible : undefined}>
        <Box flexDirection="column" flexGrow={1}>
          {empty ? (
            <Box flexDirection="column">
              <Text dimColor>{statusGlyph.needs_review} No tailored documents yet.</Text>
              <Text dimColor>
                Bullets and cover letters appear here once resume-tailor runs on a queued posting.
              </Text>
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
              const label = `${glyph} ${entry.company} — ${entry.title}${ats}${tail}`;
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
              fitRows(
                buildDetailRows(selected, isResolved(state, selected), Math.max(10, pane.width - 3)),
                detailBudget,
              ).map((row) => row.node)
            ) : (
              <>
                <Text dimColor>No selection</Text>
                <Text dimColor wrap="wrap">
                  Tailored bullets and cover letters land here once resume-tailor runs on a queued posting.
                </Text>
              </>
            )}
          </DetailPane>
        ) : null}
      </Box>

      {!pane.show && selected ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>url  {selected.url}</Text>
          <Text dimColor>
            {selected.tailored_bullets?.length ? `${selected.tailored_bullets.length} bullets` : ""}
            {selected.tailored_bullets?.length && selected.cover_letter ? " · " : ""}
            {selected.cover_letter ? "cover letter" : ""}
            {" — widen the terminal to view the full text"}
          </Text>
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

export const DOCUMENTS_HINTS = "↑↓ select · enter/o open · x resolved";
