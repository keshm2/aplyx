import { useEffect, useRef, useState } from "react";
import { LogoMark } from "../../../components/Logo";
import "./IntroSplash.css";

/**
 * A brief, full-bleed narrative beat between real wizard steps — "Welcome
 * to Aplyx.", "Let's set up your preferences...", "Now, let's get to know
 * more about you." Auto-advances after `delayMs` (no button, nothing to
 * interact with), fading out before calling onAdvance so the swap to the
 * next page never feels like a hard cut. Deliberately outside WizardShell
 * (no header/footer/progress-dots chrome) — these aren't steps to track
 * progress against, just pacing.
 *
 * Callers must pass a distinct `key` per step (LocalWizard.tsx does, via
 * `key={step}`) — three separate IntroSplash usages sit at the same
 * position in LocalWizard's render tree, so without a key React treats
 * them as one instance being updated with new props rather than fresh
 * mounts. `leaving`/the "already advanced" ref would then carry over from
 * the previous splash: the next one would mount already faded out, and
 * its own advance would be silently swallowed as a duplicate call —
 * exactly what happened before this had a key, caught by tracing through
 * an actual run rather than guessed at.
 */
export function IntroSplash({
  heading,
  caption,
  delayMs = 2000,
  onAdvance,
}: {
  heading: string;
  caption?: string;
  delayMs?: number;
  onAdvance: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const advanced = useRef(false);

  useEffect(() => {
    const leaveTimer = window.setTimeout(() => setLeaving(true), delayMs);
    return () => window.clearTimeout(leaveTimer);
  }, [delayMs]);

  function advanceOnce() {
    if (advanced.current) return;
    advanced.current = true;
    onAdvance();
  }

  useEffect(() => {
    if (!leaving) return;
    // Safety net: onAnimationEnd (below) is the precise, no-drift way this
    // normally advances — driven straight off the CSS animation actually
    // finishing rather than a second independent timer racing it (an
    // earlier version used two separate 260ms setTimeouts here, which
    // could drift apart under real scheduling jitter and leave the splash
    // sitting at opacity 0 for a beat before actually advancing). But
    // prefers-reduced-motion turns the animation off entirely (animation:
    // none), so animationend never fires at all for those users — without
    // this backstop the splash would stall forever for them.
    const backstop = window.setTimeout(advanceOnce, 320);
    return () => window.clearTimeout(backstop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  return (
    <div
      className={`intro-splash${leaving ? " intro-splash-out" : ""}`}
      onAnimationEnd={(e) => {
        if (e.target !== e.currentTarget || !leaving) return;
        advanceOnce();
      }}
    >
      <LogoMark size={88} />
      <h1 className="intro-splash-heading">{heading}</h1>
      {caption && <p className="intro-splash-caption">{caption}</p>}
    </div>
  );
}
