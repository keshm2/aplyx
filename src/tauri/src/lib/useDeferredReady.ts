import { useEffect, useState } from "react";

// Long enough to clear --duration-normal (tokens.css: 220ms, shell-route-in's
// own length) with room to spare, and long enough to read as a deliberate
// loading state rather than an accidental flicker -- confirmed via a
// headless DOM probe (2026-09-08) that 240ms's whole skeleton-then-swap
// cycle can complete before it's consciously noticed; 400ms is the same
// ballpark other apps hold a skeleton for on purpose (Slack, Linear).
const DEFAULT_DELAY_MS = 400;

function prefersReducedMotion(): boolean {
  if (document.documentElement.dataset.reducedMotion === "1") return true;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * False for one short window on every mount, true after. Home and Run are
 * the only two screens rendering WeeklyActivityChart's SVG-heavy subtree,
 * and both re-render their FULL content on every navigation back to them:
 * useAplyxState/useRunState are module-level stores that stay "loaded"
 * across navigations, so there's no natural loading gate after the first
 * visit -- the heavy chart layout was landing in the very same frame as
 * AppShell.css's shell-route-in transform/opacity animation, which is
 * what actually caused the reported "lag between screen switches"
 * (confirmed live, 2026-09-08: the earlier will-change fix helped but
 * didn't fully resolve it on either screen, and this is why -- will-change
 * promotes the layer, it doesn't make a simultaneous heavy layout free).
 *
 * Screens use this to keep their first frame on mount to a cheap
 * skeleton, so the transition animates over cheap content and the
 * expensive layout lands one paint after it's done instead of racing it
 * -- the same "skeleton page" technique already used for real data
 * loading (Skeleton.tsx), just covering the transition window too.
 *
 * Skipped when reduced motion is on: there's no transform animation to
 * protect against, so the delay would only cost real perceived load time
 * for no benefit.
 */
export function useDeferredReady(delayMs = DEFAULT_DELAY_MS): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    if (prefersReducedMotion()) {
      setReady(true);
      return;
    }
    const id = window.setTimeout(() => setReady(true), delayMs);
    return () => window.clearTimeout(id);
  }, [delayMs]);
  return ready;
}
