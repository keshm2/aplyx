/**
 * Runnable self-check for monthYear.ts (no test framework in this repo):
 *   npm run test --workspace=@aplyx/core
 * Fails loudly on any regression in the graduation_date conversions.
 */
import assert from "node:assert/strict";
import { inputToMonthYear, monthYearToInput, normalizeMonthYear } from "./monthYear.js";

assert.equal(monthYearToInput("May 2027"), "2027-05");
assert.equal(monthYearToInput("December 2027"), "2027-12");
assert.equal(monthYearToInput("2027"), "", "year-only stored value can't fill a month input");
assert.equal(monthYearToInput(""), "");

assert.equal(inputToMonthYear("2027-05"), "May 2027");
assert.equal(inputToMonthYear(""), "");
assert.equal(inputToMonthYear("2027-13"), "2027-13", "out-of-range month passes through untouched");

assert.equal(normalizeMonthYear("May 2027"), "May 2027");
assert.equal(normalizeMonthYear("may 2027"), "May 2027");
assert.equal(normalizeMonthYear("5/2027"), "May 2027");
assert.equal(normalizeMonthYear("05/2027"), "May 2027");
assert.equal(normalizeMonthYear("2027-05"), "May 2027");
assert.equal(normalizeMonthYear(""), "");
assert.equal(normalizeMonthYear("sometime next year"), null);
assert.equal(normalizeMonthYear("13/2027"), null, "month 13 is not a month");

// Round-trip: whatever the native input hands back must re-render identically.
assert.equal(monthYearToInput(inputToMonthYear("2027-09")), "2027-09");

console.log("monthYear.selfcheck: ok");
