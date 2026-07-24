import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { RainbowText, AutoSparkleText } from "./KeyHints.js";
import type { Heartbeat } from "@aplyx/core/state.js";
import { theme, BUILD_MARKER, SIDE_PANEL_WIDTH } from "../theme.js";

type Mode = "manual" | "automatic";

/** Rotating per-launch greetings above the rainbow name. */
const GREETINGS = ["Hello,", "Welcome,", "Nice to see you,", "Hey there,"] as const;

/**
 * Compact greeting + name + clock, meant for the app shell's top header
 * band (always visible, every tab) rather than the right sidebar — freed
 * up so screens that need more horizontal room (the Jobs list) can hide
 * the sidebar without losing this. Owns its own 1 s clock tick so only
 * this small component re-renders, not the whole header.
 */
export function TopStatusBar({ firstName, hour24 = false }: { firstName?: string; hour24?: boolean }) {
  const [greeting] = useState(
    () => GREETINGS[Math.floor(Math.random() * GREETINGS.length)],
  );
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const timeStr = now.toLocaleTimeString("en-US", {
    hour12: !hour24,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const dateStr = now.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <Box>
      <Text dimColor>{greeting} </Text>
      <RainbowText wrap="truncate-end">{firstName ?? "Test User"}</RainbowText>
      <Text dimColor>  {dateStr} · {timeStr}</Text>
    </Box>
  );
}

/**
 * Persistent right-side status panel: current screen/mode plus outcome
 * counts. Shown beside the content region when the terminal is wide and
 * tall enough (see App's showSidebar) and never on the Jobs tab (that
 * screen wants the width for its results table instead); on narrower/
 * shorter terminals it also hides and the content takes the full width.
 * The parent wraps the panel in a bordered Box whose left border is the
 * separator between main content and sidebar; paddingLeft here pads
 * content away from it. The greeting/name/clock that used to live here
 * moved to `TopStatusBar` (above), shown in the app shell's header on
 * every tab instead, so hiding this panel loses nothing.
 */
export function SidePanel({
  applied,
  pending,
  failed,
  seen,
  heartbeat,
  screen,
  mode,
}: {
  applied: number;
  pending: number;
  failed: number;
  seen: number;
  heartbeat?: Heartbeat;
  screen: string;
  mode: Mode;
}) {
  const health = heartbeat
    ? heartbeat.last_run_exit_code === 0
      ? { label: "healthy", color: theme.good }
      : { label: `exit ${heartbeat.last_run_exit_code}`, color: theme.danger }
    : { label: "off", color: undefined };

  const Row = ({
    label,
    value,
    color,
  }: {
    label: string;
    value: React.ReactNode;
    color?: string;
  }) => (
    <Box>
      <Text dimColor>{label.padEnd(8)}</Text>
      <Text bold color={color} wrap="truncate-end">
        {value}
      </Text>
    </Box>
  );

  return (
    <Box flexDirection="column" width={SIDE_PANEL_WIDTH} paddingLeft={1}>
      <Box flexDirection="column">
        <Row label="Screen" value={screen} color={theme.accent} />
        <Row
          label="Mode"
          value={mode === "manual" ? "MANUAL" : <AutoSparkleText>AUTO</AutoSparkleText>}
          color={mode === "manual" ? theme.accent : undefined}
        />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Row label="Applied" value={String(applied)} color={theme.good} />
        <Row label="Queue" value={String(pending)} color={pending > 0 ? theme.warn : undefined} />
        <Row label="Failed" value={String(failed)} color={failed > 0 ? theme.danger : undefined} />
        <Row label="Seen" value={String(seen)} />
        <Row label="Sched" value={health.label} color={health.color} />
      </Box>

      {/* Flex spacer pins the build marker to the bottom of the panel. */}
      <Box flexGrow={1} />
      <Box paddingTop={1}>
        <Text dimColor>build {BUILD_MARKER}</Text>
      </Box>
    </Box>
  );
}
