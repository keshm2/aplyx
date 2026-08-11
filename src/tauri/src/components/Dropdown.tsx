import { useEffect, useRef, useState } from "react";
import "./Dropdown.css";

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

interface DropdownProps<T extends string> {
  value: T;
  options: readonly DropdownOption<T>[];
  onChange: (value: T) => void;
  label: string;
}

function ChevronIcon() {
  return (
    <svg className="dropdown-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="dropdown-check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** A single-select listbox: button trigger + animated popover panel.
 *  Swaps in for a wrapping grid of toggle buttons once a picker has too
 *  many options to compare at a glance (6, in Settings' Theme family and
 *  Font pickers) — same mount-once/outside-click/Escape mechanics as
 *  NotificationBell.tsx's dropdown, so "a button opens a floating panel"
 *  reads as one visual language across the app rather than two. */
export function Dropdown<T extends string>({ value, options, onChange, label }: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  // Never rendered until the first open, same reasoning as
  // NotificationBell's `everOpened` — a session that never opens this
  // picker pays nothing, and once opened, closing gets a real exit
  // transition instead of an instant unmount.
  const [everOpened, setEverOpened] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  function toggleOpen() {
    setOpen((o) => {
      const next = !o;
      if (next) setEverOpened(true);
      return next;
    });
  }

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="dropdown-root" ref={rootRef}>
      <button type="button" className="dropdown-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={toggleOpen}>
        <span>{selected?.label ?? value}</span>
        <ChevronIcon />
      </button>

      {everOpened && (
        <div className={`dropdown-panel${open ? " dropdown-panel-open" : ""}`} role="listbox" aria-label={label} aria-hidden={!open}>
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className={opt.value === value ? "dropdown-option selected" : "dropdown-option"}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              <span>{opt.label}</span>
              {opt.value === value && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
