import {
  readSafeField,
  writeSafeField,
  readTargetsArrayList,
  writeTargetsArrayList,
  writeTargetsBool,
} from "../settings.js";
import { readProfileUsername, writeProfileUsername } from "../profileLinks.js";
import { readCommittedCompanyDisplays, writeCommittedCompanyDisplays } from "../companyTargets.js";
import { LEVEL_CATEGORIES } from "../data/levelCategories.js";
import { selectedCategoryIds, keywordsForSelectedCategories } from "../categorySelection.js";
import type { CompanyEntry } from "../data/companyDirectory.js";

const EXPERIENCED_LEVEL_ID = "full_time";

/** Which level checkboxes to pre-select when the user has never set them,
 *  from the graduation date they entered earlier in onboarding. Mirrors
 *  resume_graduation.derive_recruiting_stage's mapping (kept in sync by
 *  hand; both are a three-row table): a student graduating within ~10
 *  months is in new-grad season, otherwise they have a summer left and
 *  want internships. No parseable date -> offer both. */
export function defaultLevelIds(root: string): string[] {
  const raw = readSafeField(root, "graduation_date");
  const yearMatch = raw.match(/\b(20\d{2})\b/);
  if (!yearMatch) return ["intern", "new_grad"];
  const year = Number(yearMatch[1]);
  const months = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  ];
  const lower = raw.toLowerCase();
  let month = 6;
  for (let i = 0; i < months.length; i++) {
    if (lower.includes(months[i]!)) {
      month = i + 1;
      break;
    }
  }
  const now = new Date();
  const monthsOut = (year - now.getFullYear()) * 12 + (month - (now.getMonth() + 1));
  return monthsOut <= 10 ? ["new_grad", "entry_level"] : ["intern"];
}

/** The level category ids currently selected, or the graduation-derived
 *  default when nothing is stored yet. */
export function readSelectedLevelIds(root: string): string[] {
  const stored = [...selectedCategoryIds(LEVEL_CATEGORIES, readTargetsArrayList(root, "level_keywords"))];
  return stored.length > 0 ? stored : defaultLevelIds(root);
}

/** Write the level selection: the union of the checked categories' keyword
 *  bundles into level_keywords, plus allow_experienced_roles when "Full
 *  time" is checked (the flag evaluate_job_fit.py reads to relax its
 *  experience-based rejects). Same expansion the Settings Levels menu
 *  does. */
export function writeSelectedLevelIds(root: string, ids: string[]): void {
  const set = new Set(Array.isArray(ids) ? ids : []);
  writeTargetsArrayList(root, "level_keywords", keywordsForSelectedCategories(LEVEL_CATEGORIES, set));
  writeTargetsBool(root, "allow_experienced_roles", set.has(EXPERIENCED_LEVEL_ID));
}

export type FieldValue = string | string[];

/**
 * Local-mode profile field read/write, routed exactly like the TUI
 * onboarding wizard and Settings screen: linkedin/github usernames via
 * profileLinks (which itself sits on safe_fields), role_keywords/
 * preferred_locations via the targets.json array helpers, target_companies
 * via the vetted-directory mapping, everything else via plain safe_fields.
 * Single source of truth for this routing so a new surface (the desktop
 * wizard) never re-derives it. fs-backed (via settings.ts/profileLinks.ts/
 * companyTargets.ts): LocalAdapter-only; never import this module from
 * hosted-mode/frontend code (see onboarding/hostedFields.ts for the
 * pure field-id lists SupabaseAdapter needs instead).
 */
export function readLocalProfileField(root: string, id: string, directory: CompanyEntry[]): FieldValue {
  switch (id) {
    case "linkedin_username":
      return readProfileUsername(root, "linkedin");
    case "github_username":
      return readProfileUsername(root, "github");
    case "role_keywords":
      return readTargetsArrayList(root, "role_keywords");
    case "preferred_locations":
      return readTargetsArrayList(root, "preferred_locations");
    case "target_companies":
      return readCommittedCompanyDisplays(root, directory);
    case "levels":
      return readSelectedLevelIds(root);
    default:
      return readSafeField(root, id);
  }
}

export function writeLocalProfileField(root: string, id: string, value: FieldValue, directory: CompanyEntry[]): void {
  switch (id) {
    case "linkedin_username":
      writeProfileUsername(root, "linkedin", value as string);
      return;
    case "github_username":
      writeProfileUsername(root, "github", value as string);
      return;
    case "role_keywords":
      writeTargetsArrayList(root, "role_keywords", value as string[]);
      return;
    case "preferred_locations":
      writeTargetsArrayList(root, "preferred_locations", value as string[]);
      return;
    case "target_companies":
      writeCommittedCompanyDisplays(root, value as string[], directory);
      return;
    case "levels":
      writeSelectedLevelIds(root, value as string[]);
      return;
    default:
      writeSafeField(root, id, value as string);
  }
}
