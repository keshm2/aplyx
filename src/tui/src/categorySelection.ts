/** Shared read/write logic for the Season/Level/Role checkbox submenus
 *  (Settings' Company targets section). Each submenu is backed by a
 *  fixed list of {id, label, keywords} categories (see
 *  src/tui/src/data/{season,level,role}Categories.ts); this module maps
 *  between "which category ids are checked" and the flat keyword array
 *  actually stored in targets.json (role_keywords/level_keywords/
 *  season_keywords), which is what evaluate_job_fit.py reads. */

export interface KeywordCategory {
  id: string;
  keywords: string[];
}

/** A category counts as "checked" if ANY of its keywords is present in
 *  the current array — not ALL of them. This is deliberately lenient:
 *  a hand-edited config (or one seeded before a category's bundle grew)
 *  that only has a subset of a category's synonyms should still show
 *  that category as checked, rather than surprising the user with an
 *  apparently-unchecked box for something they clearly already opted
 *  into. */
export function selectedCategoryIds<C extends KeywordCategory>(categories: C[], currentKeywords: string[]): Set<string> {
  const current = new Set(currentKeywords.map((k) => k.toLowerCase()));
  const selected = new Set<string>();
  for (const cat of categories) {
    if (cat.keywords.some((kw) => current.has(kw.toLowerCase()))) selected.add(cat.id);
  }
  return selected;
}

/** The flat keyword array to write for a given set of checked category
 *  ids — the union of every checked category's keyword bundle, in
 *  category-definition order, deduplicated. */
export function keywordsForSelectedCategories<C extends KeywordCategory>(
  categories: C[],
  selectedIds: Set<string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cat of categories) {
    if (!selectedIds.has(cat.id)) continue;
    for (const kw of cat.keywords) {
      const key = kw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(kw);
    }
  }
  return out;
}
