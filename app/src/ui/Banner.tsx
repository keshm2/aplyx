import React from "react";
import { Box, Text } from "ink";
import { BANNER_ROWS, BANNER_GRADIENT, BANNER_WIDTH } from "../theme.js";

/** Terminals shorter than this get the one-line wordmark even when wide —
 *  six rows of art plus the shell chrome (7) leaves too little room for
 *  any screen's minimum content below ~24 rows. */
const FULL_ART_MIN_ROWS = 24;

export type BannerVariant = "art" | "wordmark";

export function bannerVariant(columns: number, rows: number): BannerVariant {
  return columns >= BANNER_WIDTH + 2 && rows >= FULL_ART_MIN_ROWS ? "art" : "wordmark";
}

/** Rows the banner occupies — the app shell uses this to size the
 *  content region responsively. */
export function bannerHeight(columns: number, rows: number): number {
  return bannerVariant(columns, rows) === "art" ? BANNER_ROWS.length : 1;
}

/**
 * The persistent aplyx banner. Violet→maroon gradient by row, centered
 * to the current terminal width; collapses to a centered one-line
 * wordmark when the terminal is too narrow or too short for the art
 * (never corrupts layout).
 *
 * `accent` is an explicit prop (not read from `theme` directly inside),
 * despite the component already importing `theme` for other purposes —
 * this component is React.memo'd on props, and `theme.accent` is a
 * mutated-in-place value (see theme.ts's applyThemeMode), not a new
 * object reference the memo comparison would ever see change. Passing it
 * as a plain string prop from App lets the default shallow-prop-equality
 * check actually notice a Settings Theme-field switch and re-render the
 * wordmark variant's title in the new color, instead of memo silently
 * freezing it at whatever accent was live at the banner's last resize.
 */
export const Banner = React.memo(function Banner({
  columns,
  rows,
  accent,
}: {
  columns: number;
  rows: number;
  accent: string;
}) {
  if (bannerVariant(columns, rows) === "wordmark") {
    return (
      <Box paddingX={1} justifyContent="center">
        <Text bold color={accent}>
          APLYX
        </Text>
        <Text dimColor> — job application agent</Text>
      </Box>
    );
  }
  // Each art row sits in its own full-width row Box with justifyContent
  // center — Ink's alignItems="center" on a column doesn't reliably
  // center <Text> children cross-axis, but a row Box stretches to the
  // full width and centers its <Text> child deterministically.
  return (
    <Box flexDirection="column" paddingX={1}>
      {BANNER_ROWS.map((row, i) => (
        <Box key={i} justifyContent="center">
          <Text color={BANNER_GRADIENT[i]}>{row}</Text>
        </Box>
      ))}
    </Box>
  );
});
