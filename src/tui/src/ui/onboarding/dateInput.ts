/**
 * Date-of-birth input formatting for the onboarding wizard's `date` field
 * kind. Two jobs, both deliberately done at keystroke time rather than on
 * commit:
 *
 *  1. Insert the `/` separators for the user, so typing `12312005` yields
 *     `12/31/2005` without ever reaching for the slash key.
 *  2. Reject digits that could not begin a valid date, so an invalid
 *     value cannot be typed in the first place ("month 19", "day 45").
 *
 * Validation is per-keystroke and positional, which is why this is a
 * digit-machine rather than a regex over the finished string: at the
 * moment `1` is typed we cannot know whether the month is 1, 10, 11 or
 * 12, so each position only rejects digits that no completion could
 * rescue. Whole-value checks that need every digit (Feb 31, month 00)
 * happen in `dobError` once the field is full.
 *
 * Kept free of React so it can be tested directly.
 */

/** Max sane age; also the floor for a plausible birth year. */
const MIN_YEAR = 1900;

/** Days per month, index 1-12. February is the leap-year maximum (29) —
 *  `dobError` narrows it to 28 for non-leap years once the year is known. */
const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Decide whether `digit` is acceptable at `pos` of the raw digit string
 * (MMDDYYYY, no separators), given the digits already accepted.
 */
function digitAllowed(pos: number, digit: number, prior: string): boolean {
  switch (pos) {
    // Month tens: 0 or 1 only. A leading 2-9 is handled by the caller,
    // which expands it to 0X (typing "5" means May, not an error).
    case 0:
      return digit === 0 || digit === 1;
    // Month ones: 01-09 or 10-12 — never 00, never 13+.
    case 1:
      return prior[0] === "0" ? digit >= 1 : digit <= 2;
    // Day tens: 0-3.
    case 2:
      return digit <= 3;
    // Day ones: bounded by the tens digit AND by the month's real length,
    // so 02/30 is rejected as it's typed rather than at commit.
    case 3: {
      const month = Number.parseInt(prior.slice(0, 2), 10);
      const day = Number.parseInt(prior[2] + String(digit), 10);
      if (day < 1) return false;
      const max = month >= 1 && month <= 12 ? DAYS_IN_MONTH[month]! : 31;
      return day <= max;
    }
    // Year thousands: only 1 or 2 — no one filling this form was born in
    // the year 800 or 3000.
    case 4:
      return digit === 1 || digit === 2;
    // Year hundreds: 19xx or 20xx.
    case 5:
      return prior[4] === "1" ? digit === 9 : digit === 0;
    default:
      return true;
  }
}

/**
 * Fold one typed character into the raw digit string. Returns the digits
 * unchanged when the keystroke is not an acceptable digit, which the
 * caller surfaces as "nothing happened" — the keystroke is swallowed.
 */
export function acceptDobDigit(rawDigits: string, char: string): string {
  const digits = rawDigits;
  const pos = digits.length;

  // A typed separator settles an ambiguous single digit early: "1/" can
  // only mean January, where a bare "1" might still become 10-12. The
  // field inserts separators itself, but people type them from habit, and
  // honoring them is the only way to distinguish "1/15" (Jan 15) from
  // "115" (Nov 5) — identical digit streams otherwise.
  if (char === "/" || char === "-" || char === ".") {
    if (pos === 1 && digits !== "0") return `0${digits}`;
    if (pos === 3 && digits[2] !== "0") return `${digits.slice(0, 2)}0${digits[2]}`;
    return digits;
  }

  if (!/^\d$/.test(char)) return rawDigits;
  if (rawDigits.length >= 8) return rawDigits;
  const digit = Number.parseInt(char, 10);

  // Smart month entry: a leading 2-9 can only be a single-digit month, so
  // "5" becomes May and the day is next.
  if (pos === 0 && digit >= 2) return `0${digit}`;

  // A leading "1" is still ambiguous (Jan, or Oct-Dec). 0/1/2 complete it;
  // anything larger can't finish a month, so the user meant January and
  // this digit begins the day — settle the month and re-handle the digit
  // in the day slot. Without this, typing "15" for Jan 5 swallowed the 5
  // and forced the user to type "0105".
  if (pos === 1 && digits === "1" && digit >= 3) return acceptDobDigit("01", char);

  // Smart day entry: 4-9 can only be a single-digit day.
  if (pos === 2 && digit >= 4) return `${digits}0${digit}`;

  if (!digitAllowed(pos, digit, digits)) return digits;
  return digits + String(digit);
}

/** Render raw MMDDYYYY digits as MM/DD/YYYY, adding each `/` as soon as
 *  the field before it is full (so `12` displays as `12/`, ready for the
 *  day) — that trailing separator is the visible cue the user asked for. */
export function formatDob(rawDigits: string): string {
  const d = rawDigits.slice(0, 8);
  if (d.length <= 2) return d.length === 2 ? `${d}/` : d;
  if (d.length <= 4) {
    const dd = d.slice(2);
    return dd.length === 2 ? `${d.slice(0, 2)}/${dd}/` : `${d.slice(0, 2)}/${dd}`;
  }
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

/** Strip a displayed MM/DD/YYYY back to raw digits (for loading a stored
 *  value into the editor). */
export function dobDigits(display: string): string {
  return display.replace(/\D/g, "").slice(0, 8);
}

/** Backspace one digit. */
export function deleteDobDigit(rawDigits: string): string {
  return rawDigits.slice(0, -1);
}

/**
 * Whole-value validation, for the checks a single keystroke can't make.
 * Returns an error string, or undefined when the value is acceptable.
 * A blank value is acceptable — date of birth is optional.
 */
export function dobError(rawDigits: string): string | undefined {
  if (rawDigits.length === 0) return undefined;
  if (rawDigits.length < 8) return "Date of birth needs all 8 digits — MM/DD/YYYY.";
  const month = Number.parseInt(rawDigits.slice(0, 2), 10);
  const day = Number.parseInt(rawDigits.slice(2, 4), 10);
  const year = Number.parseInt(rawDigits.slice(4, 8), 10);
  if (month < 1 || month > 12) return "Month must be 01-12.";
  const maxDay = month === 2 && !isLeap(year) ? 28 : DAYS_IN_MONTH[month]!;
  if (day < 1 || day > maxDay) {
    return `${year} has only ${maxDay} days in month ${String(month).padStart(2, "0")}.`;
  }
  const now = new Date();
  if (year < MIN_YEAR || year > now.getFullYear()) {
    return `Year must be between ${MIN_YEAR} and ${now.getFullYear()}.`;
  }
  // Reject a date that hasn't happened yet (born later this year).
  const dob = new Date(year, month - 1, day);
  if (dob.getTime() > now.getTime()) return "Date of birth can't be in the future.";
  return undefined;
}
