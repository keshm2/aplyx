/**
 * Re-export shim — the manual job-search logic (board fetchers, title
 * matching, canonicalize/fit/save) moved to @aplyx/core/jobs.js so the
 * desktop app's bridge subprocess can run the exact same code, not a
 * second implementation. See src/core/src/jobs.ts.
 */
export * from "@aplyx/core/jobs.js";
