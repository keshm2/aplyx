import { useEffect, useState, type ReactNode } from "react";
import { Logo } from "./Logo";
import "./WizardShell.css";

export function WizardShell({
  stepIndex,
  stepCount,
  title,
  subtitle,
  children,
  onBack,
  onNext,
  nextLabel = "Continue",
  nextDisabled = false,
  hideBack = false,
}: {
  stepIndex: number;
  stepCount: number;
  title: string;
  subtitle?: string;
  children: ReactNode;
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  hideBack?: boolean;
}) {
  // Two-phase step transition — fade the outgoing step out, swap content,
  // fade the new one in — the same out/then/in choreography AppShell uses
  // for route changes, not just a fresh fade-in popping in on top of the
  // old step. `frozen` is what's actually rendered at all times; it only
  // updates to the latest props once the out-phase finishes, so the
  // outgoing step's content stays visible (and correct) for its whole
  // fade instead of already showing the next step's title underneath it.
  const [frozen, setFrozen] = useState({ stepIndex, title, subtitle, children });
  const [phase, setPhase] = useState<"idle" | "out" | "in">("idle");

  useEffect(() => {
    if (stepIndex === frozen.stepIndex) return;
    setPhase("out");
    const timer = window.setTimeout(() => {
      setFrozen({ stepIndex, title, subtitle, children });
      setPhase("in");
    }, 120);
    return () => window.clearTimeout(timer);
    // Only a real step change should start a transition — see the effect
    // below for same-step content updates (e.g. typing in a field).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  useEffect(() => {
    // Same-step content refresh: take it immediately, no transition —
    // guarded to idle-only so this can't stomp a frozen "out" snapshot
    // mid-animation with content that's already moved on to the next step.
    if (phase !== "idle" || stepIndex !== frozen.stepIndex) return;
    setFrozen({ stepIndex, title, subtitle, children });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, subtitle, children, phase]);

  useEffect(() => {
    if (phase !== "in") return;
    const timer = window.setTimeout(() => setPhase("idle"), 260);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return (
    <div className="wizard">
      <header className="wizard-header">
        <Logo size={24} />
        <div className="wizard-progress" aria-label={`Step ${frozen.stepIndex + 1} of ${stepCount}`}>
          {Array.from({ length: stepCount }, (_, i) => (
            <span key={i} className={i <= frozen.stepIndex ? "wizard-dot wizard-dot-done" : "wizard-dot"} />
          ))}
        </div>
      </header>

      <div className="wizard-body">
        <div
          key={frozen.stepIndex}
          className={`wizard-step${phase === "out" ? " wizard-step-out" : phase === "in" ? " wizard-step-in" : ""}`}
          onAnimationEnd={(e) => {
            // animationend bubbles from any descendant's own CSS animation
            // (a field's own entrance, a spinner) — only react to this
            // element's own transition finishing.
            if (e.target !== e.currentTarget) return;
            if (phase === "in") setPhase("idle");
          }}
        >
          <h1>{frozen.title}</h1>
          {frozen.subtitle && <p className="wizard-subtitle">{frozen.subtitle}</p>}
          <div className="wizard-step-content">{frozen.children}</div>
        </div>
      </div>

      <footer className="wizard-footer">
        {!hideBack && onBack ? (
          <button className="wizard-back" onClick={onBack}>
            &larr; Back
          </button>
        ) : (
          <span />
        )}
        {onNext && (
          <button className="wizard-next" onClick={onNext} disabled={nextDisabled}>
            {nextLabel} &rarr;
          </button>
        )}
      </footer>
    </div>
  );
}
