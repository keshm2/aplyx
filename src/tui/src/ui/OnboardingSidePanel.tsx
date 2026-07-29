import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { SpinnerGlyph, GradientProgressBar } from "./KeyHints.js";
import { theme, SIDE_PANEL_WIDTH } from "../theme.js";

const BAR_WIDTH = 12;

/**
 * Reduced sidebar shown only while the onboarding wizard is active:
 * clock + <symbol> <progress bar> <percentage> — no greeting/name (would
 * show an awkward placeholder before any name is entered), no
 * Applied/Queue/Failed/Seen/Sched rows (no run history yet), no build
 * marker. The normal SidePanel only takes over once <App> mounts
 * post-wizard. Every dynamic Text uses wrap="truncate-end" throughout —
 * the Phase 3b narrow-terminal fix's discipline, so it isn't
 * reintroduced here.
 */
export function OnboardingSidePanel({ percent }: { percent: number }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    hour12: true,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });

  return (
    <Box flexDirection="column" width={SIDE_PANEL_WIDTH} paddingLeft={1}>
      <Text color={theme.warn} wrap="truncate-end">
        ⚠ saved locally
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold wrap="truncate-end">
          {dateStr}
        </Text>
        <Text bold color={theme.accent} wrap="truncate-end">
          {timeStr}
        </Text>
      </Box>
      <Box marginTop={1}>
        <SpinnerGlyph />
        <Text> </Text>
        <GradientProgressBar
          ratio={percent / 100}
          width={BAR_WIDTH}
          minFilled={0}
          tickMs={70}
          offsetStep={0.12}
        />
        <Text wrap="truncate-end"> {percent}%</Text>
      </Box>
    </Box>
  );
}
