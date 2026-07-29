import React from "react";
import { Box, Text } from "ink";
import type { Heartbeat } from "@aplyx/core/state.js";
import { theme } from "../theme.js";
import { wrapPadded, wrapText } from "./wrapText.js";

function DetailRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box>
      <Text dimColor>{label.padEnd(14)}</Text>
      <Text color={color} bold={Boolean(color)} wrap="truncate-end">
        {value}
      </Text>
    </Box>
  );
}

export interface WelcomeOption {
  label: string;
  description: string;
}

/**
 * Launch surface on every plain `aplyx` run. It is an actual menu,
 * not a splash screen, so the first interaction can be "take me where
 * I want to go" instead of "dismiss this and remember hotkeys".
 */
export function WelcomeScreen({
  contentRows,
  columns,
  options,
  cursor,
  counts,
  unresolvedQueue,
  registryCount,
  heartbeat,
  lastRun,
}: {
  contentRows: number;
  columns: number;
  options: WelcomeOption[];
  cursor: number;
  counts: { applied: number; needsReview: number; failed: number };
  unresolvedQueue: number;
  registryCount: number;
  heartbeat?: Heartbeat;
  lastRun: string;
}) {
  const selected = options[cursor] ?? options[0];
  const wide = columns >= 84 && contentRows >= 16;
  // Fixed-height "Selected" panel: every option's description wraps to a
  // different number of lines, so sizing the panel to only the CURRENT
  // option's description would grow/shrink the whole menu (and shove the
  // footer hint around, or off the bottom of a clipped short terminal) on
  // every arrow-key press. Reserve the tallest any option needs instead.
  const descWidth = wide ? 44 : Math.max(20, columns - 4);
  const descMaxLines = Math.max(1, ...options.map((o) => wrapText(o.description, descWidth).length));
  const descLines = wrapPadded(selected.description, descWidth, descMaxLines);
  const showLastRun = contentRows >= 16;
  // Row tiers: the frame is clipped at the viewport (App pins height with
  // overflow hidden), so on short terminals the menu sheds its supporting
  // bands — intro, description, state, footer hint — before the options
  // themselves get cut off.
  const showIntro = contentRows >= 14;
  const showSelected = contentRows >= 12;
  const showState = wide || contentRows >= 22;
  const showFooterHint = contentRows >= 10;
  const tight = contentRows < 8; // every remaining margin costs an option row
  const health = heartbeat
    ? heartbeat.last_run_exit_code === 0
      ? { label: "healthy", color: theme.good }
      : { label: `exit ${heartbeat.last_run_exit_code}`, color: theme.danger }
    : { label: "not installed", color: undefined };

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Welcome to aplyx
      </Text>
      {showIntro ? (
        <Box marginTop={1}>
          <Text wrap="wrap">
            Choose what you want to do first. Manual browsing, automatic runs,
            review triage, and history all land in the same local record.
          </Text>
        </Box>
      ) : null}

      <Box marginTop={tight ? 0 : 1} flexDirection={wide ? "row" : "column"}>
        <Box flexDirection="column" marginRight={wide ? 4 : 0} width={wide ? 44 : undefined}>
          {tight ? null : <Text dimColor>Start here</Text>}
          <Box marginTop={tight ? 0 : 1} flexDirection="column">
            {options.map((option, index) => {
              const focused = index === cursor;
              // truncate-end: a wrapped option row grows the frame past the
              // viewport on narrow terminals, which corrupts Ink's repaint.
              return (
                <Text
                  key={option.label}
                  color={focused ? theme.accent : undefined}
                  bold={focused}
                  wrap="truncate-end"
                >
                  {focused ? ">" : " "} [{focused ? "x" : " "}] {option.label}
                </Text>
              );
            })}
          </Box>
          {showSelected ? (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Selected</Text>
              {descLines.map((line, i) => (
                <Text key={i} wrap="truncate-end">
                  {line}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>

        {showState ? (
        <Box flexDirection="column" marginTop={wide ? 0 : 1}>
          <Text dimColor>Current state</Text>
          <Box marginTop={1} flexDirection="column">
            <DetailRow label="Applied" value={String(counts.applied)} color={theme.good} />
            <DetailRow label="Needs review" value={String(counts.needsReview)} color={theme.warn} />
            <DetailRow label="Failed" value={String(counts.failed)} color={theme.danger} />
            <DetailRow label="Queue" value={`${unresolvedQueue} pending`} color={unresolvedQueue > 0 ? theme.warn : undefined} />
            <DetailRow label="Registry" value={`${registryCount} jobs seen`} />
            <DetailRow label="Scheduler" value={health.label} color={health.color} />
          </Box>
          {showLastRun ? (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Last run</Text>
              <Text wrap="truncate-end">{lastRun}</Text>
            </Box>
          ) : null}
        </Box>
        ) : null}
      </Box>

      {showFooterHint ? (
        <Box marginTop={1}>
          <Text dimColor>Use ↑/↓, j/k, or tab to move. Enter opens the selected page.</Text>
        </Box>
      ) : null}
    </Box>
  );
}
