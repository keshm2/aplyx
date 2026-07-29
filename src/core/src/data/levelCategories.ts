/** Checkbox categories for the Levels submenu. Checking a category
 *  writes its keyword bundle into targets.json's level_keywords array.
 *  "Full time" additionally sets targets.json's top-level
 *  `allow_experienced_roles` flag (see LevelCategory.setsAllowExperienced)
 *  — evaluate_job_fit.py's deterministic fit gate has a HARD REJECT for
 *  any posting requiring 3+ years of experience that is independent of
 *  level_keywords content; no set of keywords alone can make senior/
 *  experienced postings pass the gate. The flag is what actually does
 *  that (relaxing exactly that one reject, and the separate "no level
 *  signal at all" reject, while leaving every other gate — role match,
 *  US location, degree, clearance, visa — untouched). Unchecking "Full
 *  time" clears the flag back to false, restoring today's default
 *  intern/new-grad-only behavior exactly. */
export interface LevelCategory {
  id: string;
  label: string;
  /** Shown in parens next to the label, e.g. "(1-2 years exp)". */
  experienceHint?: string;
  keywords: string[];
  setsAllowExperienced?: boolean;
}

export const LEVEL_CATEGORIES: LevelCategory[] = [
  {
    id: "intern",
    label: "Intern",
    keywords: ["intern", "internship"],
  },
  {
    id: "new_grad",
    label: "New grad full time",
    keywords: ["new grad", "new graduate", "university grad", "campus"],
  },
  {
    id: "entry_level",
    label: "Entry-level full time",
    experienceHint: "1-2 years exp suggested",
    keywords: ["entry level", "entry-level", "junior", "early career", "associate"],
  },
  {
    id: "full_time",
    label: "Full time",
    experienceHint: "3+ years exp suggested",
    // Reporting/matching keywords only — the words a posting most
    // reliably uses to actually self-describe as senior/staff+. Kept
    // deliberately narrow (no "experienced", "lead", or bare "ii"/"iii")
    // since those show up in new-grad postings too and would erode the
    // 95%+-confidence bar this option was designed to. The REAL gate
    // relaxation for postings that require 3+ years but don't literally
    // say "senior" (most don't) comes from setsAllowExperienced below,
    // which defers to evaluate_job_fit.py's existing numeric
    // years-of-experience parser (parse_years_required) — a much more
    // reliable signal than any word list.
    keywords: ["senior", "staff", "principal", "sr."],
    setsAllowExperienced: true,
  },
];
