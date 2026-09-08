/**
 * Month/year conversions for the `graduation_date` field (fields.ts kind
 * "month"). The stored value stays "Month YYYY" ("May 2027") — the shape
 * resume_graduation.py emits on every resume save, what the Python fit
 * gate's month-name regex reads, and what an ATS "expected graduation"
 * text field expects a human to have typed. These helpers only bridge
 * that string to the UI: a native <input type="month"> (Tauri) speaks
 * ISO "YYYY-MM", and the TUI accepts loose typed input.
 */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "May 2027" -> "2027-05" for a native <input type="month">. A
 *  year-only stored value ("2027", all resume_graduation.py could read)
 *  or anything unparseable returns "" so the input shows empty rather
 *  than a wrong month. */
export function monthYearToInput(stored: string): string {
  const parsed = parseMonthYear(stored);
  return parsed ? `${parsed.year}-${String(parsed.month).padStart(2, "0")}` : "";
}

/** "2027-05" (what <input type="month"> emits) -> "May 2027". Passes ""
 *  through; a malformed value is returned untouched so a caller never
 *  silently drops what the user entered. */
export function inputToMonthYear(iso: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso.trim();
  const month = Number(m[2]);
  if (month < 1 || month > 12) return iso.trim();
  return `${MONTH_NAMES[month - 1]} ${m[1]}`;
}

/** Loose typed entry -> canonical "May 2027". Accepts "May 2027",
 *  "may 2027", "5/2027", "05/2027", "2027-05", "2027/5". Empty -> "".
 *  Unparseable -> null (caller shows a hint, doesn't persist). */
export function normalizeMonthYear(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const parsed = parseMonthYear(trimmed);
  return parsed ? `${MONTH_NAMES[parsed.month - 1]} ${parsed.year}` : null;
}

function parseMonthYear(text: string): { year: number; month: number } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const yearMatch = /\b(20\d{2})\b/.exec(trimmed);
  if (!yearMatch) return null;
  const year = Number(yearMatch[1]);

  const nameIdx = MONTH_NAMES.findIndex((name) =>
    new RegExp(`\\b${name.slice(0, 3)}`, "i").test(trimmed),
  );
  if (nameIdx >= 0) return { year, month: nameIdx + 1 };

  // Numeric month: the 1-2 digit group that isn't the year.
  const numMatch = /\b(\d{1,2})\b/.exec(trimmed.replace(String(year), ""));
  if (numMatch) {
    const month = Number(numMatch[1]);
    if (month >= 1 && month <= 12) return { year, month };
  }
  return null;
}
