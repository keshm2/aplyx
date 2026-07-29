/**
 * Ordered page registry for the onboarding wizard — 18 fields grouped
 * into 8 pages of 1-5 related fields each, so the user answers several
 * related questions per screen instead of one question at a time (see
 * "Pages" in the onboarding plan). Field `id`s that match a
 * src/config/targets.json safe_fields key exactly are written/read via
 * plain readSafeField/writeSafeField in OnboardingWizard.tsx; the
 * handful that don't (linkedin_username/github_username, role_keywords,
 * preferred_locations, target_companies) get their own persistence path
 * there (profileLinks.ts / top-level targets.json arrays).
 */

export type FieldKind =
  | "text"
  | "yesno"
  | "location"
  | "multi-location"
  | "multi-company"
  | "roles"
  | "date";

export interface FieldDef {
  id: string;
  label: string;
  kind: FieldKind;
  /**
   * Grey hint text shown in an empty field. NEVER put real personal data
   * here — this file is committed to git and compiled into the published
   * npm package, so anything written here is public. A real home address
   * shipped this way once (see the git history for this file); every
   * example below must be obviously synthetic. Reserved-for-fiction values
   * only: 555-01xx phone numbers (NANP), example.com email, and street
   * addresses that are plainly placeholders.
   */
  placeholder?: string;
  /** Optional per-field help shown under the label. */
  help?: string;
}

export interface PageDef {
  title: string;
  fields: FieldDef[];
}

/** The persistent reassurance line QuestionFrame renders on every field
 *  page — see theme.ts's note on theme.warn always pairing a glyph with
 *  a non-error, attention-worthy line. */
export const PRIVACY_LINE = "This info is used for job applications and can be changed later in Settings.";

export const PAGES: PageDef[] = [
  {
    title: "Basics",
    fields: [
      { id: "preferred_name", label: "Preferred name (optional)", kind: "text", placeholder: "how aplyx addresses you" },
      { id: "first_name", label: "Legal first name", kind: "text" },
      { id: "last_name", label: "Legal last name", kind: "text" },
    ],
  },
  {
    title: "Contact",
    fields: [
      {
        id: "email",
        label: "Email applications are sent from",
        kind: "text",
        placeholder: "you@example.com",
        help: "Employers reply here — use an address you actually check.",
      },
      { id: "phone", label: "Phone number", kind: "text", placeholder: "555-0142" },
      { id: "address_line1", label: "Address line 1", kind: "text", placeholder: "123 Example St" },
      { id: "address_line2", label: "Address line 2 (optional)", kind: "text", placeholder: "Apt 4B" },
      { id: "zip_code", label: "Zip code", kind: "text", placeholder: "12345" },
    ],
  },
  {
    title: "Location",
    fields: [
      {
        id: "location",
        label: "Home location (city, state)",
        kind: "location",
        // A well-known metro, deliberately NOT anyone's actual home city —
        // see the FieldDef.placeholder warning above.
        placeholder: "type any city, e.g. Seattle, WA",
        help: "Suggestions are a shortcut, not a list of allowed answers — if your city isn't offered, type it out and press enter.",
      },
    ],
  },
  {
    title: "Profiles",
    fields: [
      { id: "linkedin_username", label: "LinkedIn username", kind: "text", placeholder: "your-username" },
      { id: "github_username", label: "GitHub username", kind: "text", placeholder: "your-username" },
    ],
  },
  {
    title: "Work eligibility",
    fields: [
      { id: "authorized_to_work", label: "Authorized to work in the US? (y/n)", kind: "yesno" },
      { id: "require_sponsorship", label: "Need visa sponsorship? (y/n)", kind: "yesno" },
    ],
  },
  {
    title: "Education",
    fields: [
      {
        id: "graduation_date",
        label: "Graduation date",
        kind: "text",
        placeholder: "June 2027",
        help: "Optional in general, but required to apply to internships — most intern postings ask for it.",
      },
    ],
  },
  {
    title: "Demographics",
    fields: [
      {
        id: "gender",
        label: "Gender (optional)",
        kind: "text",
        placeholder: "e.g. Woman / Man / Non-binary / Decline",
        help: "Asked by many EEO forms. Leave blank to decline — aplyx never invents an answer.",
      },
      { id: "ethnicity", label: "Ethnicity (optional)", kind: "text", placeholder: "e.g. Asian / Decline" },
      { id: "hispanic_or_latino", label: "Hispanic or Latino? (y/n)", kind: "yesno" },
      { id: "date_of_birth", label: "Date of birth (optional)", kind: "date", placeholder: "MM/DD/YYYY" },
    ],
  },
  {
    title: "Roles",
    fields: [
      {
        id: "role_keywords",
        label: "Roles you're targeting (comma-separated)",
        kind: "roles",
        placeholder: "software engineer, swe, ...",
      },
    ],
  },
  {
    title: "Job targets",
    fields: [
      {
        id: "preferred_locations",
        label: "Preferred job locations (optional)",
        kind: "multi-location",
        placeholder: "type any city — enter adds it, blank enter moves on",
        help: "A priority list, not a filter: aplyx searches the whole US either way, these just sort matching jobs to the top. Any city works, listed or not.",
      },
      { id: "target_companies", label: "Target companies", kind: "multi-company", placeholder: "type to search" },
    ],
  },
];

/** All 18 field ids in page order — the fixed denominator for the
 *  committed_fields.length / 18 percentage. */
export const FIELD_IDS: string[] = PAGES.flatMap((page) => page.fields.map((f) => f.id));
export const TOTAL_FIELDS = FIELD_IDS.length;

/** Page indices after the 8 field pages: Resumes (not counted toward the
 *  18-field percentage), then Completion. */
export const RESUME_PAGE_INDEX = PAGES.length;
export const COMPLETION_PAGE_INDEX = PAGES.length + 1;
export const LAST_PAGE_INDEX = COMPLETION_PAGE_INDEX;
