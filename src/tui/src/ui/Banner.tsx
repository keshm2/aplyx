import React from "react";
import { Box, Text } from "ink";
import { BANNER_ROWS, BANNER_WIDTH } from "../theme.js";

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
 * The persistent aplyx banner. Gradient by row (mode-dependent — see
 * `gradient` below), centered to the current terminal width; collapses
 * to a centered one-line wordmark when the terminal is too narrow or too
 * short for the art (never corrupts layout).
 *
 * `accent`/`gradient` are explicit props (not read from `theme`/
 * `bannerGradient()` directly inside), despite the component already
 * importing from theme.js for other purposes — this component is
 * React.memo'd on props, and both `theme.accent` (mutated in place) and
 * `bannerGradient()`'s result (re-resolved fresh on each call, but never
 * itself a changed prop unless passed down) are invisible to a shallow
 * prop-equality check unless threaded through as plain props. Passing
 * them from App lets memo actually notice a Settings Theme-field switch
 * and re-render both the wordmark title and the art gradient in the new
 * colors, instead of freezing at whatever was live at the banner's last
 * resize (the exact bug `accent` was already fixed for; `gradient` had
 * the identical exposure and was fixed the same way rather than being
 * missed a second time).
 */
export const Banner = React.memo(function Banner({
  columns,
  rows,
  accent,
  gradient,
}: {
  columns: number;
  rows: number;
  accent: string;
  gradient: readonly string[];
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
          <Text color={gradient[i]}>{row}</Text>
        </Box>
      ))}
    </Box>
  );
});
