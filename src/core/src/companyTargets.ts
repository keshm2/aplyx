import { readTargetsArrayList, writeTargetsArrayList } from "./settings.js";
import type { CompanyEntry } from "./data/companyDirectory.js";

/** vendor -> its targets.json slug-array key. The single place that maps
 *  a CompanyEntry's vendor to where its slug lives, so adding a vendor
 *  (as Greenhouse just was) only touches this list, not the read/write
 *  logic below. */
const VENDOR_KEYS: Record<CompanyEntry["vendor"], string> = {
  ashby: "ashby_company_slugs",
  lever: "lever_company_slugs",
  greenhouse: "greenhouse_company_slugs",
};

/** Target companies aren't stored under one key — they're derived as the
 *  intersection of each vendor's *_company_slugs array with the vetted
 *  directory, so both the onboarding wizard and Settings can show what's
 *  already added without keeping a separate copy of this logic. */
export function readCommittedCompanyDisplays(root: string, directory: CompanyEntry[]): string[] {
  const committed: Partial<Record<CompanyEntry["vendor"], Set<string>>> = {};
  for (const [vendor, key] of Object.entries(VENDOR_KEYS) as [CompanyEntry["vendor"], string][]) {
    committed[vendor] = new Set(readTargetsArrayList(root, key));
  }
  return directory.filter((e) => committed[e.vendor]!.has(e.slug)).map((e) => e.display);
}

/** Maps the chosen display names back to their slugs via the directory,
 *  splits by vendor, and merges into each vendor's existing array —
 *  dropping any leftover REPLACE_ME placeholder from a fresh install. */
export function writeCommittedCompanyDisplays(root: string, displays: string[], directory: CompanyEntry[]): void {
  const displaySet = new Set(displays);
  const chosen = directory.filter((e) => displaySet.has(e.display));
  for (const [vendor, key] of Object.entries(VENDOR_KEYS) as [CompanyEntry["vendor"], string][]) {
    const existing = new Set(readTargetsArrayList(root, key));
    existing.delete("REPLACE_ME");
    for (const e of chosen) {
      if (e.vendor === vendor) existing.add(e.slug);
    }
    writeTargetsArrayList(root, key, [...existing]);
  }
}
