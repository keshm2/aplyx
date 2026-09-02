import { useEffect, useMemo, useRef, useState } from "react";
import "./formFields.css";

/**
 * A themed MM/DD/YYYY date field: a text input you can still type into,
 * plus a calendar popover that fits aplyx's own tokens rather than the
 * OS's native picker. The year selector spans 1920 through eight years
 * out, so the same control works for a birthdate and for a future
 * graduation date.
 *
 * Stored value is always the "MM/DD/YYYY" string the rest of aplyx
 * expects (dateInput.ts in the TUI produces the same shape); an empty or
 * partial string is passed through untouched.
 */

const MIN_YEAR = 1920;
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Parse "MM/DD/YYYY" to a Date, or null if it isn't a complete valid one. */
function parseMDY(value: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const month = Number(mm) - 1;
  const day = Number(dd);
  const year = Number(yyyy);
  if (month < 0 || month > 11 || day < 1 || day > 31 || year < MIN_YEAR) return null;
  const d = new Date(year, month, day);
  // Reject rollovers (e.g. 02/30 -> March 2).
  if (d.getMonth() !== month || d.getDate() !== day) return null;
  return d;
}

export function DatePickerField({
  id,
  value,
  onChange,
  placeholder = "MM/DD/YYYY",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const maxYear = new Date().getFullYear() + 8;
  const years = useMemo(
    () => Array.from({ length: maxYear - MIN_YEAR + 1 }, (_, i) => maxYear - i),
    [maxYear],
  );

  const parsed = parseMDY(value);
  // Which month the grid is showing: the selected date's month, else today.
  const [view, setView] = useState(() => parsed ?? new Date());
  useEffect(() => {
    if (parsed) setView(parsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const viewYear = view.getFullYear();
  const viewMonth = view.getMonth();
  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  function pick(day: number) {
    onChange(`${pad(viewMonth + 1)}/${pad(day)}/${viewYear}`);
    setOpen(false);
  }

  function shiftMonth(delta: number) {
    setView(new Date(viewYear, viewMonth + delta, 1));
  }

  return (
    <div className="datepicker" ref={wrapRef}>
      <div className="datepicker-input">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          onFocus={() => setOpen(true)}
        />
        <button
          type="button"
          className="datepicker-toggle"
          aria-label="Open calendar"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="datepicker-pop" role="dialog" aria-label="Choose a date">
          <div className="datepicker-head">
            <button type="button" className="datepicker-nav" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            <div className="datepicker-selects">
              <select
                aria-label="Month"
                value={viewMonth}
                onChange={(e) => setView(new Date(viewYear, Number(e.currentTarget.value), 1))}
              >
                {MONTHS.map((name, i) => (
                  <option key={name} value={i}>{name}</option>
                ))}
              </select>
              <select
                aria-label="Year"
                value={viewYear}
                onChange={(e) => setView(new Date(Number(e.currentTarget.value), viewMonth, 1))}
              >
                {years.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <button type="button" className="datepicker-nav" aria-label="Next month" onClick={() => shiftMonth(1)}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
            </button>
          </div>

          <div className="datepicker-grid datepicker-weekdays">
            {WEEKDAYS.map((d, i) => (
              <span key={i} className="datepicker-weekday">{d}</span>
            ))}
          </div>
          <div className="datepicker-grid">
            {cells.map((day, i) =>
              day === null ? (
                <span key={`e${i}`} />
              ) : (
                <button
                  key={day}
                  type="button"
                  className={
                    "datepicker-day" +
                    (parsed && parsed.getFullYear() === viewYear && parsed.getMonth() === viewMonth && parsed.getDate() === day
                      ? " is-selected"
                      : "")
                  }
                  onClick={() => pick(day)}
                >
                  {day}
                </button>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
