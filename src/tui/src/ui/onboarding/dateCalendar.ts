/**
 * Pure calendar-grid math for the date-of-birth field's calendar overlay
 * (DateCalendarField.tsx / OnboardingWizard.tsx). Kept free of Ink so it's
 * testable directly, same split as dateInput.ts's digit-machine.
 *
 * The overlay is a second way to answer the same field digit-entry
 * already answers (see dateInput.ts): arrow keys move a cursor day by
 * day/week, PageUp/PageDown move by month, `[`/`]` move by year, Enter
 * commits. Every move is clamped to [MIN_YEAR-01-01, today] so a birth
 * date can never land in the future or before 1920, the same bound
 * dobError already enforces on typed digits - the calendar just can't
 * reach an invalid value in the first place, rather than rejecting one
 * after the fact.
 */

export const CALENDAR_MIN_YEAR = 1920;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days in `month` (0-11) of `year`, leap-year aware. */
export function daysInMonth(year: number, month: number): number {
  if (month === 1 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month]!;
}

/** Strip a Date to midnight local, for clean day-granularity comparisons. */
function atMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function minDate(): Date {
  return new Date(CALENDAR_MIN_YEAR, 0, 1);
}

/** Clamp `d` into [Jan 1 CALENDAR_MIN_YEAR, today]. */
export function clampToRange(d: Date, today: Date = new Date()): Date {
  const floor = minDate();
  const ceiling = atMidnight(today);
  const day = atMidnight(d);
  if (day.getTime() < floor.getTime()) return floor;
  if (day.getTime() > ceiling.getTime()) return ceiling;
  return day;
}

/** Add `days` to `d`, clamped to range. */
export function addDaysClamped(d: Date, days: number, today?: Date): Date {
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  return clampToRange(next, today);
}

/** Move by `months`, clamped to range; the day-of-month is preserved when
 *  the target month is short enough, else pinned to that month's last day
 *  (Jan 31 -> Feb 28/29, not Mar 2/3). */
export function addMonthsClamped(d: Date, months: number, today?: Date): Date {
  const targetMonthIndex = d.getMonth() + months;
  const year = d.getFullYear() + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const day = Math.min(d.getDate(), daysInMonth(year, month));
  return clampToRange(new Date(year, month, day), today);
}

/** Move by `years`, same day-pinning as addMonthsClamped (leap-day births
 *  landing on Feb 29 in a non-leap target year pin to Feb 28). */
export function addYearsClamped(d: Date, years: number, today?: Date): Date {
  const year = d.getFullYear() + years;
  const day = Math.min(d.getDate(), daysInMonth(year, d.getMonth()));
  return clampToRange(new Date(year, d.getMonth(), day), today);
}

export interface CalendarCell {
  day: number | null;
  /** True for the cursor's current day. */
  isSelected: boolean;
  /** True for today's date, so it stays visually findable even unselected. */
  isToday: boolean;
}

/** A 6-row x 7-col grid (with leading/trailing nulls for days outside the
 *  month) for the month `selected` falls in. Always 6 rows so the grid
 *  never resizes between months and the surrounding layout stays put. */
export function buildMonthGrid(selected: Date, today: Date = new Date()): CalendarCell[][] {
  const year = selected.getFullYear();
  const month = selected.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const total = daysInMonth(year, month);
  const todayMid = atMidnight(today);

  const cells: CalendarCell[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push({ day: null, isSelected: false, isToday: false });
  for (let day = 1; day <= total; day++) {
    cells.push({
      day,
      isSelected: day === selected.getDate(),
      isToday: year === todayMid.getFullYear() && month === todayMid.getMonth() && day === todayMid.getDate(),
    });
  }
  while (cells.length < 42) cells.push({ day: null, isSelected: false, isToday: false });

  const rows: CalendarCell[][] = [];
  for (let r = 0; r < 6; r++) rows.push(cells.slice(r * 7, r * 7 + 7));
  return rows;
}

export function formatMDY(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

const MDY_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** Parse a committed "MM/DD/YYYY" display value (dateInput.ts's own
 *  format) back to a Date, or null if it isn't one - the calendar's
 *  starting point when opened on an already-filled field. */
export function parseMDY(display: string): Date | null {
  const m = MDY_RE.exec(display.trim());
  if (!m) return null;
  const month = Number(m[1]) - 1;
  const day = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(year, month, day);
  if (d.getMonth() !== month || d.getDate() !== day) return null;
  return d;
}
