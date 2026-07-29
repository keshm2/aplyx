import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

/**
 * Shared split-view primitives (rules + columns style — no boxed
 * borders). Screens that show a selection render a full-height detail
 * pane on the right, separated by the same dim-violet left border the
 * app shell uses for the sidebar, so every page reads as one system.
 */

export interface PaneLayout {
  show: boolean;
  width: number;
}

/** Whether a right-hand detail pane fits, and how wide it should be.
 *  ~42% of the content band, clamped so the list keeps ≥ ~44 cols. */
export function paneLayout(columns: number): PaneLayout {
  const show = columns >= 76;
  const width = Math.max(28, Math.min(48, Math.floor(columns * 0.42)));
  return { show, width };
}

/** The right-hand detail column. Width includes the 1-col separator. */
export function DetailPane({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <Box
      flexDirection="column"
      marginLeft={1}
      width={width}
      flexShrink={0}
      paddingLeft={1}
      borderStyle="single"
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      borderColor={theme.rule}
    >
      {children}
    </Box>
  );
}

/** Label/value row used inside detail panes — label dimmed, value wraps. */
export function PaneRow({
  label,
  value,
  color,
  wrap = "truncate-end",
}: {
  label: string;
  value: string;
  color?: string;
  wrap?: "truncate-end" | "wrap";
}) {
  return (
    <Box>
      {/* 9, not 8: "location" (SearchScreen's detail pane) is exactly 8
          chars, and a label filling its box edge-to-edge left no gap
          before the value — "locationSingapore" ran together. */}
      <Box width={9} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color={color} wrap={wrap}>
          {value}
        </Text>
      </Box>
    </Box>
  );
}

/** Dimmed "── title ──" separator inside a pane. */
export function PaneRule({ title }: { title: string }) {
  return (
    <Box marginTop={1}>
      <Text color={theme.rule}>── </Text>
      <Text dimColor>{title}</Text>
      <Text color={theme.rule}> ──</Text>
    </Box>
  );
}
