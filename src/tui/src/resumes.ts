/**
 * Re-export shim — resume-folder listing moved to @aplyx/core/resumes.js so
 * the desktop app's bridge subprocess can list the same data/resumes/ view,
 * not a second implementation. See src/core/src/resumes.ts.
 */
export * from "@aplyx/core/resumes.js";
