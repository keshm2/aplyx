import { readSafeField, writeSafeField, readTargetsArrayList, writeTargetsArrayList } from "../settings.js";
import { readProfileUsername, writeProfileUsername } from "../profileLinks.js";
import { readCommittedCompanyDisplays, writeCommittedCompanyDisplays } from "../companyTargets.js";
import type { CompanyEntry } from "../data/companyDirectory.js";

export type FieldValue = string | string[];

/**
 * Local-mode profile field read/write, routed exactly like the TUI
 * onboarding wizard and Settings screen: linkedin/github usernames via
 * profileLinks (which itself sits on safe_fields), role_keywords/
 * preferred_locations via the targets.json array helpers, target_companies
 * via the vetted-directory mapping, everything else via plain safe_fields.
 * Single source of truth for this routing so a new surface (the desktop
 * wizard) never re-derives it. fs-backed (via settings.ts/profileLinks.ts/
 * companyTargets.ts) — LocalAdapter-only; never import this module from
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
    default:
      writeSafeField(root, id, value as string);
  }
}
