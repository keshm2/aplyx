import "./Switch.css";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** True while a real backend operation triggered by this switch is in
   *  flight. Distinct from `disabled` (which just blocks the click);
   *  `pending` also drives a breathing-pulse animation so a genuinely
   *  in-progress toggle reads as "working," not "broken." Defaults to
   *  `disabled` when omitted, since today's one caller always sets both
   *  together; kept as a separate prop so a future disabled-but-idle
   *  case (e.g. "unavailable, nothing to do") doesn't inherit the pulse. */
  pending?: boolean;
  label: string; // accessible name, this control has no visible text of its own
}

/** An iOS-style toggle: a pill track + sliding thumb, not a plain button.
 *  Tap-triggered (not draggable), so this doesn't need the full gesture
 *  machinery (velocity handoff, rubber-banding), just the things that
 *  still matter for a tap: instant press feedback (respond on pointer-down,
 *  not click), a critically-damped settle (no bounce: this isn't a
 *  momentum-driven gesture, so overshoot would read as noise, not physicality),
 *  and a reduced-motion fallback that still communicates the state change. */
export function Switch({ checked, onChange, disabled, pending, label }: SwitchProps) {
  const isPending = pending ?? disabled;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={isPending || undefined}
      aria-label={label}
      disabled={disabled}
      className={`apple-switch${checked ? " apple-switch-on" : ""}${isPending ? " apple-switch-pending" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="apple-switch-thumb" />
    </button>
  );
}
