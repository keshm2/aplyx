import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin, useStdout } from "ink";
import { theme } from "../theme.js";

/**
 * Update prompt box — shown at the bottom-right of the frame whenever
 * `cli.tsx`'s launch-time version probe (detectUpdate) finds a newer
 * upstream VERSION. Asks "a new update (v <ver>) is available —
 * install it?" with yes/no controls.
 *
 * The outline is a hand-drawn perimeter (not Ink's single-color
 * `borderStyle`) so each border cell can carry its own color: a
 * `theme.glow` bump travels clockwise around an otherwise theme-accent
 * outline — a wave that goes accent → glow → accent, never rainbow.
 * `glow` is a per-theme color (theme.ts's Palette interface), not
 * always literal white: a dark-background theme (Aplyx Default, Ember
 * Dusk) wants a bright white pop, but a light-background theme (Cloud
 * Surf, Mint Frost) blending toward white would fade the wave into an
 * already-white terminal until it's unreadable — those themes set glow
 * to a deep, near-black shade of their own hue instead, so the wave
 * still reads as a clear highlight regardless of which background the
 * active theme actually targets.
 *
 * Controls support both keyboard (`y` / `n` / `esc`) and mouse clicks.
 * Ink 5 has no stable high-level mouse API, so clicks are handled via raw
 * xterm SGR mouse-reporting escape sequences on stdin while the prompt
 * is active. A `[×]` close control sits in the top border (clickable,
 * and `esc` is its keyboard equivalent) — declining and closing are the
 * same outcome (`onNo`), just two different ways in to it: pressing `n`,
 * clicking `[N] no`, clicking `[×]`, or pressing `esc`.
 */
const BOX_W = 38;
const BOX_H = 6;
const BUTTON_ROW = 4; // zero-based within the box
const YES_RANGE: [number, number] = [3, 9];
const NO_RANGE: [number, number] = [13, 18];
const CLOSE_ROW = 0; // top border row
const CLOSE_RANGE: [number, number] = [BOX_W - 6, BOX_W - 4]; // the "[×]" cells, left of the top-right corner

function hex2(n: number): string {
  return Math.round(n).toString(16).padStart(2, "0");
}
/** Blend between theme.accent (t=0) and theme.glow (t=1). Reads both
 *  fresh on every call rather than a module-load snapshot — Settings'
 *  Theme field mutates them in place (see theme.ts's applyThemeMode),
 *  and frozen hexes baked in here would keep animating whichever
 *  theme was active at first render forever, never matching a later
 *  switch. */
function blend(t: number): string {
  const from = hexToRgbLocal(theme.accent);
  const to = hexToRgbLocal(theme.glow);
  const r = from[0] + (to[0] - from[0]) * t;
  const g = from[1] + (to[1] - from[1]) * t;
  const b = from[2] + (to[2] - from[2]) * t;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}
function hexToRgbLocal(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Perimeter index for a border cell, clockwise from the top-left
 *  corner. The perimeter is one continuous loop so a single traveling
 *  phase animates the whole outline as one wave. */
function perimeterIndex(row: number, col: number, w: number, h: number): number {
  if (row === 0) return col; // top, left→right
  if (row === h - 1) return 2 * w + h - 3 - col; // bottom, right→left
  if (col === w - 1) return w + (row - 1); // right, top→bottom
  return 2 * w + 2 * h - 4 - row; // left, bottom→top
}

export function UpdateBox({
  version,
  active,
  columns,
  rows,
  pad,
  onYes,
  onNo,
}: {
  version: string;
  active: boolean;
  columns: number;
  rows: number;
  pad: number;
  onYes: () => void;
  onNo: () => void;
}) {
  const animate = Boolean(process.stdout.isTTY);
  const [phase, setPhase] = useState(0);
  const { stdin, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => setPhase((p) => p + 2), 80);
    return () => clearInterval(timer);
  }, [animate]);

  useEffect(() => {
    if (!active || !stdout.isTTY || !isRawModeSupported) return;
    stdout.write("\x1b[?1000h\x1b[?1006h");

    const x0 = columns - pad - BOX_W + 1;
    const y0 = rows - BOX_H - 1;

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const matches = text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([mM])/g);
      for (const match of matches) {
        const button = Number.parseInt(match[1] ?? "", 10);
        const x = Number.parseInt(match[2] ?? "", 10);
        const y = Number.parseInt(match[3] ?? "", 10);
        const suffix = match[4];
        if (button !== 0 || suffix !== "M") continue;
        const localX = x - x0;
        if (y === y0 + CLOSE_ROW && localX >= CLOSE_RANGE[0] && localX <= CLOSE_RANGE[1]) {
          onNo();
          return;
        }
        if (y !== y0 + BUTTON_ROW) continue;
        if (localX >= YES_RANGE[0] && localX <= YES_RANGE[1]) {
          onYes();
          return;
        }
        if (localX >= NO_RANGE[0] && localX <= NO_RANGE[1]) {
          onNo();
          return;
        }
      }
    };

    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      stdout.write("\x1b[?1000l\x1b[?1006l");
    };
  }, [active, columns, isRawModeSupported, onNo, onYes, pad, rows, stdin, stdout]);

  useInput(
    (input, key) => {
      const k = input.toLowerCase();
      if (k === "y") onYes();
      else if (k === "n" || key.escape) onNo();
    },
    { isActive: active },
  );

  const ver = version.length > 24 ? version.slice(0, 23) + "…" : version;
  const lines = [
    `A new update (v ${ver}) is`,
    `available — install it?`,
    "",
    `  [Y] yes      [N] no`,
  ];
  const h = BOX_H;
  const inner = BOX_W - 2;
  const P = 2 * BOX_W + 2 * h - 4;

  const isCloseCell = (row: number, col: number) =>
    row === CLOSE_ROW && col >= CLOSE_RANGE[0] && col <= CLOSE_RANGE[1];

  const cellColor = (row: number, col: number) => {
    // Plain, non-animated color for the [×] close control — a clickable
    // control reading as decoration (traveling with the border wave)
    // would be easy to miss as interactive at all.
    if (isCloseCell(row, col)) return theme.warn;
    if (!animate) return theme.accent;
    const idx = perimeterIndex(row, col, BOX_W, h);
    const intensity = Math.max(0, Math.cos((2 * Math.PI * (idx - phase)) / P));
    return blend(intensity ** 3);
  };

  const borderChar = (row: number, col: number) => {
    if (row === 0) {
      if (col === 0) return "╭";
      if (col === BOX_W - 1) return "╮";
      if (col === CLOSE_RANGE[0]) return "[";
      if (col === CLOSE_RANGE[0] + 1) return "×";
      if (col === CLOSE_RANGE[1]) return "]";
      return "─";
    }
    if (row === h - 1) return col === 0 ? "╰" : col === BOX_W - 1 ? "╯" : "─";
    return col === 0 || col === BOX_W - 1 ? "│" : " ";
  };

  const renderBorderRow = (row: number) => (
    <Text>
      {Array.from({ length: BOX_W }, (_, col) => (
        <Text key={col} bold={isCloseCell(row, col)} color={cellColor(row, col)}>
          {borderChar(row, col)}
        </Text>
      ))}
    </Text>
  );

  const renderMiddleRow = (row: number, content: string) => {
    const padded = content.length > inner ? content.slice(0, inner) : content.padEnd(inner);
    return (
      <Text>
        <Text color={cellColor(row, 0)}>│</Text>
        <Text>{padded}</Text>
        <Text color={cellColor(row, BOX_W - 1)}>│</Text>
      </Text>
    );
  };

  return (
    <Box flexDirection="column" flexShrink={0}>
      {renderBorderRow(0)}
      {lines.map((line, i) => {
        const row = i + 1;
        if (line === "") return <React.Fragment key={i}>{renderMiddleRow(row, "")}</React.Fragment>;
        if (line.includes("[Y]")) {
          const buttons = "  [Y] yes   [N] no";
          const pad = " ".repeat(Math.max(0, inner - buttons.length));
          return (
            <Text key={i}>
              <Text color={cellColor(row, 0)}>│</Text>
              <Text>
                {"  "}
                <Text bold color={theme.good}>[Y]</Text>
                <Text> yes   </Text>
                <Text bold color={theme.warn}>[N]</Text>
                <Text> no</Text>
                {pad}
              </Text>
              <Text color={cellColor(row, BOX_W - 1)}>│</Text>
            </Text>
          );
        }
        return <React.Fragment key={i}>{renderMiddleRow(row, line)}</React.Fragment>;
      })}
      {renderBorderRow(h - 1)}
    </Box>
  );
}
