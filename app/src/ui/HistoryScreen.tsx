import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AplyxState } from "@aplyx/core/state.js";
import { openUrl, helperError } from "@aplyx/core/helpers.js";
import { statusColor, statusGlyph, theme, SELECT_MARKER } from "../theme.js";
import { DetailPane, PaneRow, PaneRule, paneLayout } from "./Pane.js";

export function HistoryScreen({
  state,
  active,
  contentRows = 20,
  columns = 0,
}: {
  state: AplyxState;
  active: boolean;
  /** Rows the shell hands this screen — the list grows/shrinks with it. */
  contentRows?: number;
  /** Columns of the content band — a detail pane opens when it fits. */
  columns?: number;
}) {
  const jobs = [...state.applied].reverse(); // newest first
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  const [message, setMessage] = useState("");
  // Pane mode moves selection details off the list column.
  const pane = paneLayout(columns);
  const PAGE = Math.max(3, Math.min(30, contentRows - (pane.show ? 5 : 8)));

  const clampCursor = (c: number) => Math.max(0, Math.min(jobs.length - 1, c));
  const maxOffset = Math.max(0, jobs.length - PAGE);

  useEffect(() => {
    setCursor((current) => clampCursor(current));
    setOffset((current) => Math.min(current, maxOffset));
  }, [jobs.length, maxOffset]);

  useInput(
    (input, key) => {
      if (key.downArrow || input === "j") {
        setCursor((c) => {
          const next = clampCursor(c + 1);
          setOffset((o) => (next >= o + PAGE ? Math.min(maxOffset, next - PAGE + 1) : o));
          return next;
        });
      }
      if (key.upArrow || input === "k") {
        setCursor((c) => {
          const next = clampCursor(c - 1);
          setOffset((o) => (next < o ? Math.max(0, o - 1) : o));
          return next;
        });
      }
      if (key.return || input === "o") {
        const entry = jobs[cursor];
        if (!entry) {
          setMessage("No outcomes recorded yet — nothing to open.");
          return;
        }
        try {
          const target = entry.apply_url || entry.url;
          openUrl(target);
          setMessage(`Opened ${target}`);
        } catch (err) {
          setMessage(`Could not open browser: ${helperError(err)}`);
        }
      }
    },
    { isActive: active && Boolean(process.stdin.isTTY) },
  );

  const selected = jobs[cursor];
  const page = jobs.slice(offset, offset + PAGE);
  const totals = { applied: 0, needs_review: 0, failed: 0 };
  for (const job of jobs) {
    if (job.status in totals) totals[job.status as keyof typeof totals] += 1;
  }

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        History{" "}
        <Text dimColor>
          ({jobs.length} outcomes, newest first)
        </Text>
      </Text>

      <Box marginTop={1} flexDirection="row" minHeight={pane.show ? PAGE : undefined}>
        <Box flexDirection="column" flexGrow={1}>
        {jobs.length === 0 ? (
          <Box flexDirection="column">
            <Text dimColor>{statusGlyph.needs_review} No applications recorded yet.</Text>
            <Text dimColor>Outcomes from agent runs appear here.</Text>
          </Box>
        ) : (
          page.map((job, i) => {
            const idx = offset + i;
            const marker = idx === cursor ? SELECT_MARKER : " ";
            const glyph = statusGlyph[job.status] ?? "•";
            const atsTail =
              typeof job.ats_score === "number" ? `  ats ${job.ats_score}` : "";
            // Selected row: one inverse string (monochrome accent — selection
            // is the dominant signal, glyph still carries status meaning).
            // Non-selected row: same character grid, status prefix colored,
            // date dimmed. Both share the exact same spacing so columns align.
            if (idx === cursor) {
              return (
                <Text key={`${job.job_id}-${idx}`} color={theme.accent} inverse wrap="truncate-end">
                  {`${marker} ${glyph} ${job.status.padEnd(13)} ${job.date_applied}  ${job.company} — ${job.title}${atsTail}`}
                </Text>
              );
            }
            return (
              <Text key={`${job.job_id}-${idx}`} wrap="truncate-end">
                {`${marker} `}
                <Text color={statusColor(job.status) ?? "white"}>{`${glyph} ${job.status.padEnd(13)}`}</Text>
                <Text dimColor>{` ${job.date_applied}  `}</Text>
                {`${job.company} — ${job.title}`}
                {atsTail ? <Text dimColor>{atsTail}</Text> : null}
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
                  {selected.company} — {selected.title}
                </Text>
                <PaneRow
                  label="status"
                  value={`${statusGlyph[selected.status] ?? "•"} ${selected.status}`}
                  color={statusColor(selected.status)}
                />
                <PaneRow label="date" value={selected.date_applied} />
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
                <PaneRule title="totals" />
                <PaneRow label="applied" value={String(totals.applied)} color={theme.good} />
                <PaneRow label="review" value={String(totals.needs_review)} color={theme.warn} />
                <PaneRow label="failed" value={String(totals.failed)} color={theme.danger} />
              </>
            ) : (
              <>
                <Text dimColor>No outcomes yet</Text>
                <Text dimColor wrap="wrap">Every applied / needs-review / failed outcome is recorded here as the agent runs.</Text>
              </>
            )}
          </DetailPane>
        ) : null}
      </Box>

      {!pane.show && selected ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>url  {selected.url}</Text>
          {selected.reasoning ? (
            <Text dimColor>why  {selected.reasoning}</Text>
          ) : null}
          {typeof selected.ats_score === "number" ? (
            <Text dimColor>ats  {selected.ats_score} · {selected.source ?? "?"} · {selected.resume_used ?? "?"}</Text>
          ) : null}
        </Box>
      ) : null}

      {message ? (
        <Box marginTop={1}>
          <Text dimColor>{message}</Text>
        </Box>
      ) : null}

      {jobs.length > PAGE ? (
        <Box marginTop={1}>
          <Text dimColor>
            rows {offset + 1}–{Math.min(offset + PAGE, jobs.length)} of {jobs.length} · ↑/↓ to navigate
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export const HISTORY_HINTS = "↑↓ select · enter/o open";
