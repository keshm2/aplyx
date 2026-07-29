/** Checkbox categories for the Seasons submenu. Checking a category
 *  writes its synonym bundle into targets.json's season_keywords array —
 *  keeping both spellings/forms a posting might actually use (e.g.
 *  "fall" and "autumn", "co-op" and "coop") so checking one season
 *  option doesn't silently lose recall on a posting that phrased it
 *  differently. */
export interface SeasonCategory {
  id: string;
  label: string;
  keywords: string[];
}

export const SEASON_CATEGORIES: SeasonCategory[] = [
  { id: "summer", label: "Summer", keywords: ["summer"] },
  { id: "fall", label: "Fall", keywords: ["fall", "autumn"] },
  { id: "winter", label: "Winter", keywords: ["winter"] },
  { id: "spring", label: "Spring", keywords: ["spring"] },
  { id: "co_op", label: "Co-op", keywords: ["co-op", "coop"] },
  { id: "year_round", label: "Year-round", keywords: ["year-round", "year round"] },
  { id: "off_cycle", label: "Off-cycle", keywords: ["off-cycle", "off cycle"] },
];
