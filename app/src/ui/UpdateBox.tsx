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
 * `borderStyle`) so each border cell can carry its own color: a white
 * bump travels clockwise around an otherwise theme-accent outline — a
 * wave that goes accent → white → accent, never rainbow.
 *
 * Controls support both keyboard (`y` / `n`) and mouse clicks. Ink 5 has
 * no stable high-level mouse API, so clicks are handled via raw xterm SGR
 * mouse-reporting escape sequences on stdin while the prompt is active.
 */
const BOX_W = 38;
const BOX_H = 6;
const BUTTON_ROW = 4; // zero-based within the box
const YES_RANGE: [number, number] = [3, 9];
const NO_RANGE: [number, number] = [13, 18];

function hex2(n: number): string {
  return Math.round(n).toString(16).padStart(2, "0");
}
/** Blend between theme.accent (t=0) and white (t=1). Reads theme.accent
 *  fresh on every call rather than a module-load snapshot — Settings'
 *  Theme field mutates it in place (see theme.ts's applyThemeMode), and a
 *  frozen 0x8B5CF6 baked in here would keep animating dark-mode violet
 *  even after switching to Light. */
function blend(t: number): string {
  const hex = theme.accent.replace("#", "");
  const n = Number.parseInt(hex, 16);
  const r0 = (n >> 16) & 0xff;
  const g0 = (n >> 8) & 0xff;
  const b0 = n & 0xff;
  const r = r0 + (0xff - r0) * t;
  const g = g0 + (0xff - g0) * t;
  const b = b0 + (0xff - b0) * t;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
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
        if (y !== y0 + BUTTON_ROW) continue;
        const localX = x - x0;
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
    (input) => {
      const k = input.toLowerCase();
      if (k === "y") onYes();
      else if (k === "n") onNo();
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

  const cellColor = (row: number, col: number) => {
    if (!animate) return theme.accent;
    const idx = perimeterIndex(row, col, BOX_W, h);
    const intensity = Math.max(0, Math.cos((2 * Math.PI * (idx - phase)) / P));
    return blend(intensity ** 3);
  };

  const borderChar = (row: number, col: number) => {
    if (row === 0) return col === 0 ? "╭" : col === BOX_W - 1 ? "╮" : "─";
    if (row === h - 1) return col === 0 ? "╰" : col === BOX_W - 1 ? "╯" : "─";
    return col === 0 || col === BOX_W - 1 ? "│" : " ";
  };

  const renderBorderRow = (row: number) => (
    <Text>
      {Array.from({ length: BOX_W }, (_, col) => (
        <Text key={col} color={cellColor(row, col)}>
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
