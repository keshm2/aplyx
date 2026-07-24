import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { gradientColor, hueColor, theme, sparkleGradient, SPINNER_FRAMES, isReducedMotion } from "../theme.js";

/**
 * Renders a hint string ("/ query · ↑↓ move · s save") with the key cap
 * of every chunk in the bold accent color and the description dimmed —
 * so the available commands read at a glance instead of being one dim
 * line. Chunks are "key description"; the first token is the key.
 */
export function KeyHints({ hints }: { hints: string }) {
  const chunks = hints.split(" · ").filter(Boolean);
  return (
    <Text>
      {chunks.map((chunk, i) => {
        const space = chunk.indexOf(" ");
        const key = space === -1 ? chunk : chunk.slice(0, space);
        const label = space === -1 ? "" : chunk.slice(space + 1);
        return (
          <Text key={i}>
            {i > 0 ? <Text color={theme.rule}> · </Text> : null}
            <Text bold color={theme.accent}>
              {key}
            </Text>
            {label ? <Text dimColor> {label}</Text> : null}
          </Text>
        );
      })}
    </Text>
  );
}

/**
 * Animated rainbow text for the MAX-cap warning: each character cycles
 * through the hue wheel. Animates only on a real TTY (a piped one-frame
 * render gets a static warning color so CI output stays deterministic).
 */
export function RainbowText({
  children,
  wrap,
}: {
  children: string;
  wrap?: React.ComponentProps<typeof Text>["wrap"];
}) {
  const animate = Boolean(process.stdout.isTTY) && !isReducedMotion();
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => setOffset((o) => (o + 14) % 360), 90);
    return () => clearInterval(timer);
  }, [animate]);
  if (!animate) {
    return (
      <Text bold color={theme.danger} wrap={wrap}>
        {children}
      </Text>
    );
  }
  return (
    <Text bold wrap={wrap}>
      {Array.from(children).map((ch, i) => (
        <Text key={i} color={hueColor(offset + i * 16)}>
          {ch}
        </Text>
      ))}
    </Text>
  );
}

/**
 * Animated sparkle text for AUTO mode: each character cycles through an
 * accent → white blend (sparkleGradient(), the same two colors UpdateBox's
 * traveling border ring uses — see theme.ts) rather than the full hue
 * wheel, so "AUTO" reads as calm/purposeful instead of alarming. Pass
 * `gradient` to reuse this for a different wave — e.g. RunScreen's live
 * "running" indicator colors itself by the configured coding-agent
 * harness (see theme.ts's harnessGradient) instead of the default accent.
 * `tickMs`/`offsetStep` default to the original AUTO-badge tuning (90ms,
 * 0.35/tick); callers that want a slower, smoother wave — the harness
 * gradient — pass a longer tick and a smaller step. Same
 * animate-only-on-a-real-TTY fallback as RainbowText — a piped one-frame
 * render gets a static warn color.
 */
export function AutoSparkleText({
  children,
  gradient = sparkleGradient(),
  tickMs = 90,
  offsetStep = 0.35,
}: {
  children: string;
  gradient?: readonly string[];
  tickMs?: number;
  offsetStep?: number;
}) {
  const animate = Boolean(process.stdout.isTTY) && !isReducedMotion();
  const [offset, setOffset] = useState(0);
  const period = 2 * (gradient.length - 1);
  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => setOffset((o) => (o + offsetStep) % period), tickMs);
    return () => clearInterval(timer);
  }, [animate, period, tickMs, offsetStep]);
  if (!animate) {
    return (
      <Text bold color={theme.warn}>
        {children}
      </Text>
    );
  }
  return (
    <Text bold>
      {Array.from(children).map((ch, i) => (
        <Text key={i} color={gradientColor(offset + i * 0.6, gradient)}>
          {ch}
        </Text>
      ))}
    </Text>
  );
}

/**
 * Cycling "working" glyph (SPINNER_FRAMES: the braille rotation), the
 * Claude-Code-style activity indicator — a symbol that visibly changes
 * on its own, not just a color animation, so "something is happening"
 * reads even for someone not looking closely at hue shifts. 80ms is the
 * conventional braille-spinner cadence (matches most CLI "thinking"
 * indicators of this family). Non-TTY fallback renders the first frame
 * statically, matching the other animated components' pattern.
 */
export function SpinnerGlyph({ color }: { color?: string } = {}) {
  // Deliberately not gated on isReducedMotion() like the other three —
  // per this component's own docstring, it exists specifically so
  // "something is happening" reads without watching color shifts.
  // Freezing it under reduced motion would remove that fallback and make
  // a genuinely live run look stuck instead of calmer.
  const animate = Boolean(process.stdout.isTTY);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [animate]);
  return (
    <Text bold color={color ?? theme.accent}>
      {SPINNER_FRAMES[animate ? frame : 0]}
    </Text>
  );
}

// Always show a few lit cells even at ratio 0 — an all-empty bar reads as
// "nothing is happening" or "missing", not "just started".
const MIN_FILLED_CELLS = 3;

/**
 * Animated gradient progress bar. Filled cells shimmer left-to-right
 * through `gradient` (default sparkleGradient()) so the animation reads as
 * one system with AutoSparkleText — pass a different gradient (e.g.
 * theme.ts's harnessGradient) to recolor it for a specific context, as
 * RunScreen's live run-progress bar does by configured harness.
 * `minFilled`/`tickMs`/`offsetStep` default to the original run-progress-
 * view tuning (3 cells always lit — "something is happening" — ticking
 * every 90ms by 0.35); callers that need an honest 0%-means-empty bar
 * (e.g. onboarding, before anything has been answered) or a slower/
 * smoother shimmer pass their own values rather than changing the shared
 * defaults. Non-TTY fallback renders a flat accent-colored bar, matching
 * AutoSparkleText/RainbowText's static-on-a-pipe behavior. Originally the
 * run-progress view's own private helper (RunScreen.tsx); moved here and
 * exported so the onboarding wizard's sidebar can reuse it.
 */
export function GradientProgressBar({
  ratio,
  width,
  minFilled = MIN_FILLED_CELLS,
  tickMs = 90,
  offsetStep = 0.35,
  gradient = sparkleGradient(),
}: {
  ratio: number;
  width: number;
  minFilled?: number;
  tickMs?: number;
  offsetStep?: number;
  gradient?: readonly string[];
}) {
  const animate = Boolean(process.stdout.isTTY) && !isReducedMotion();
  const [offset, setOffset] = useState(0);
  const period = 2 * (gradient.length - 1);
  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => setOffset((o) => (o + offsetStep) % period), tickMs);
    return () => clearInterval(timer);
  }, [animate, tickMs, offsetStep, period]);
  const filled = Math.max(minFilled, Math.min(width, Math.round(ratio * width)));
  const empty = width - filled;
  if (!animate) {
    return (
      <Text>
        <Text bold color={theme.accent}>
          {"█".repeat(filled)}
        </Text>
        <Text dimColor>{"░".repeat(empty)}</Text>
      </Text>
    );
  }
  return (
    <Text bold>
      {Array.from({ length: filled }, (_, i) => (
        <Text key={i} color={gradientColor(offset + i * 0.6, gradient)}>
          █
        </Text>
      ))}
      <Text dimColor>{"░".repeat(empty)}</Text>
    </Text>
  );
}
