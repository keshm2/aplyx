import React from "react";
import { Box, Text } from "ink";
import type { AplyxState, Heartbeat } from "@aplyx/core/state.js";
import { theme, statusGlyph, statusColor } from "../theme.js";
import { DetailPane, paneLayout } from "./Pane.js";

interface Props {
  state: AplyxState;
  lastRun: string;
  sessionLog?: string;
  unresolvedQueue: number;
  heartbeat?: Heartbeat;
  /** Inside the persistent app the shell owns the title and hints. */
  embedded?: boolean;
  /** Rows available: tall terminals get a recent-activity panel so the
   *  screen doesn't feel empty. */
  contentRows?: number;
  /** Columns of the content band: recent activity moves to a
   *  full-height right pane when it fits. */
  columns?: number;
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box>
      <Text dimColor>{label.padEnd(13)}</Text>
      <Text bold color={color}>
        {value}
      </Text>
    </Box>
  );
}

export function StatusScreen({
  state,
  lastRun,
  sessionLog,
  unresolvedQueue,
  heartbeat,
  embedded,
  contentRows = 20,
  columns = 0,
}: Props) {
  const counts = { applied: 0, needs_review: 0, failed: 0 };
  for (const job of state.applied) {
    if (job.status in counts) counts[job.status as keyof typeof counts] += 1;
  }
  const healthy = heartbeat ? heartbeat.last_run_exit_code === 0 : null;
  // Pane mode: recent activity fills a full-height right column instead
  // of waiting for a tall terminal. Stacked mode keeps the old behavior
  // (activity only when rows are spare).
  const pane = paneLayout(columns);
  const recentCount = pane.show
    ? Math.max(3, Math.min(14, contentRows - 4))
    : Math.max(0, Math.min(8, contentRows - 21));
  const recent = recentCount > 0 ? [...state.applied].reverse().slice(0, recentCount) : [];

  const activity = (
    <Box flexDirection="column">
      <Text dimColor>Recent activity</Text>
      <Box flexDirection="column" marginTop={1}>
        {recent.length === 0 ? (
          <Text dimColor>nothing recorded yet</Text>
        ) : (
          recent.map((job, i) => (
            <Text key={`${job.job_id}-${i}`} wrap="truncate-end">
              <Text color={statusColor(job.status) ?? "white"}>
                {statusGlyph[job.status] ?? "•"}{" "}
              </Text>
              <Text dimColor>{job.date_applied}  </Text>
              {job.company}: {job.title}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );

  const leftColumn = (
    <Box flexDirection="column" flexGrow={1}>
      {/* Outcomes */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Outcomes</Text>
        <Box flexDirection="column" marginTop={1}>
          <Stat
            label="Applied"
            value={`${statusGlyph.applied} ${counts.applied}`}
            color={theme.good}
          />
          <Stat
            label="Needs review"
            value={`${statusGlyph.needs_review} ${counts.needs_review}`}
            color={theme.warn}
          />
          <Stat
            label="Failed"
            value={`${statusGlyph.failed} ${counts.failed}`}
            color={theme.danger}
          />
        </Box>
      </Box>

      {/* Pipeline */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Pipeline</Text>
        <Box flexDirection="column" marginTop={1}>
          <Stat label="Review queue" value={`${unresolvedQueue} pending`} color={unresolvedQueue > 0 ? theme.warn : undefined} />
          <Stat label="Registry" value={`${state.registry.length} jobs seen`} />
        </Box>
      </Box>

      {/* Scheduler heartbeat: Health reuses Stat (rather than its own
       *  hand-rolled padEnd + Text bold) so its label column and value
       *  weight line up exactly with Outcomes/Pipeline above instead of
       *  being a one-off that happens to look similar. */}
      {heartbeat ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Scheduler</Text>
          <Box flexDirection="column" marginTop={1}>
            <Stat
              label="Health"
              value={
                healthy
                  ? `${statusGlyph.applied} healthy`
                  : `${statusGlyph.failed} exit ${heartbeat.last_run_exit_code} · ${heartbeat.consecutive_nonzero_exits} consecutive`
              }
              color={healthy ? theme.good : theme.danger}
            />
          </Box>
          <Text dimColor>run #{heartbeat.run_counter} at {heartbeat.last_run_completed_at}</Text>
        </Box>
      ) : null}
    </Box>
  );

  return (
    <Box flexDirection="column" paddingX={embedded ? 0 : 1}>
      <Text bold color={theme.accent}>
        {embedded ? "Status" : "aplyx: status"}
      </Text>

      {pane.show ? (
        // Two-column dashboard: stats left, full-height recent activity
        // right (the activity column gets the wider share; its rows are
        // one-line outcome entries that benefit from width).
        <Box flexDirection="row">
          {leftColumn}
          <DetailPane width={Math.max(pane.width, columns - 34)}>{activity}</DetailPane>
        </Box>
      ) : (
        <>
          {leftColumn}
          {recent.length > 0 ? <Box marginTop={1}>{activity}</Box> : null}
        </>
      )}

      {/* Last run footer */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Last run: {lastRun}</Text>
        {sessionLog ? <Text dimColor>Session log: {sessionLog}</Text> : null}
      </Box>

      {embedded ? null : (
        <Box marginTop={1}>
          <Text dimColor>Open the app with: aplyx (screens: status · jobs · review · history · resumes · settings)</Text>
        </Box>
      )}
    </Box>
  );
}
