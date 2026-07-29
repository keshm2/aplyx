import fs from "node:fs";
import path from "node:path";

/**
 * Read-only view of data/resumes/ for the Resumes screen. Listing is a
 * plain directory scan done here in TS (matching state.ts's read-only
 * fs reads); actually converting a PDF to markdown needs pypdf, so that
 * stays a Python helper (src/scripts/state/convert_resume.py) invoked from
 * helpers.ts — this module never writes.
 */

export interface ResumeFile {
  /** Filename without extension, e.g. "base_resume_swe". */
  stem: string;
  /** Human label when the stem is one resume-tailor.md expects; undefined for anything else found in the folder. */
  category?: string;
  hasMarkdown: boolean;
  hasPdf: boolean;
  /** PDF present, markdown missing — the case the TUI offers to convert. */
  needsConversion: boolean;
  /** True for the 6 stems resume-tailor.md actually reads by name. */
  expected: boolean;
  /** Short label set at convert time for arbitrarily-named resumes, from .resume_meta.json. */
  description?: string;
}

// Source of truth: src/agents/bodies/resume-tailor.md "Step 1 — Select base
// resume" and docs/SETUP.md's resume section. Keep in sync by hand —
// there's no single shared source for this the TUI can read at runtime.
const EXPECTED_RESUMES: Array<{ stem: string; category: string }> = [
  { stem: "base_resume_swe", category: "SWE" },
  { stem: "base_resume_ai_ml", category: "AI/ML" },
  { stem: "base_resume_cyber", category: "Cyber" },
  { stem: "base_resume_networking_cyber", category: "Networking/Cyber" },
  { stem: "base_resume_balanced", category: "Balanced (default)" },
  { stem: "base_cover_letter", category: "Cover letter" },
];

export function resumesDir(root: string): string {
  return path.join(root, "data", "resumes");
}

function readResumeMeta(root: string): Record<string, { description?: string }> {
  try {
    const raw = fs.readFileSync(path.join(resumesDir(root), ".resume_meta.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function listResumeFiles(root: string): ResumeFile[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(resumesDir(root));
  } catch {
    entries = [];
  }

  const byStem = new Map<string, { md: boolean; pdf: boolean }>();
  for (const name of entries) {
    const ext = path.extname(name).toLowerCase();
    if (ext !== ".md" && ext !== ".pdf") continue;
    const stem = name.slice(0, -ext.length);
    const cur = byStem.get(stem) ?? { md: false, pdf: false };
    if (ext === ".md") cur.md = true;
    if (ext === ".pdf") cur.pdf = true;
    byStem.set(stem, cur);
  }
  // Every expected stem shows up even when neither file exists yet, so
  // the screen always lists all 6 categories with an honest status.
  for (const { stem } of EXPECTED_RESUMES) {
    if (!byStem.has(stem)) byStem.set(stem, { md: false, pdf: false });
  }

  const labelByStem = new Map(EXPECTED_RESUMES.map((e) => [e.stem, e.category]));
  const expectedOrder = new Map(EXPECTED_RESUMES.map((e, i) => [e.stem, i]));
  const meta = readResumeMeta(root);

  return [...byStem.entries()]
    .map(([stem, { md, pdf }]) => ({
      stem,
      category: labelByStem.get(stem),
      hasMarkdown: md,
      hasPdf: pdf,
      needsConversion: pdf && !md,
      expected: labelByStem.has(stem),
      description: meta[stem]?.description || undefined,
    }))
    .sort((a, b) => {
      const ai = expectedOrder.get(a.stem);
      const bi = expectedOrder.get(b.stem);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return a.stem.localeCompare(b.stem);
    });
}

export function pendingConversionCount(root: string): number {
  return listResumeFiles(root).filter((f) => f.needsConversion).length;
}
