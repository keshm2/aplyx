/**
 * Fuzzy subsequence matching with fzf/VS-Code-quick-open-style scoring:
 * the query's characters must appear in order somewhere in the
 * candidate text (not necessarily contiguous), so a typo or a partial
 * word ("elvnlbs") can still find "ElevenLabs" — a plain prefix/
 * substring check would reject both. Contiguous runs and matches at a
 * word boundary (start of text, or right after a space/hyphen/
 * underscore) score higher, and the match's starting position is
 * penalized, so a clean prefix match still naturally floats to the top
 * without needing a separate special case for it — it's just the
 * highest-scoring shape a match can take.
 *
 * `weightOf` is an optional flat bonus added on top of the text-match
 * score (default 0 for every item) — the hook `companyDirectory` uses to
 * rank hand-vetted companies above ones auto-discovered from a larger
 * external source, so a handful of well-known names don't get buried
 * once the pool grows into the thousands.
 *
 * A genuine prefix match gets an explicit bonus (PREFIX_BONUS) rather
 * than relying purely on boundary/consecutive bonuses to float it to the
 * top on their own — they don't reliably do that. A scattered match that
 * happens to land on two word-boundary characters (e.g. "sea" against
 * "Scottsdale, AZ": 's' starts the city, 'a' starts the state code after
 * the comma) can out-score a true single-run prefix match against a
 * different, better candidate ("sea" against "Seattle, WA" — one long
 * consecutive run, but only one boundary hit) by a point or two, which
 * ranked Scottsdale above Seattle for a "sea" search until this was
 * added — confirmed by tracing the exact scores, not assumed.
 */
export function filterSuggestions<T = string>(
  query: string,
  pool: T[],
  limit = 8,
  textOf: (item: T) => string = (item) => String(item),
  weightOf: (item: T) => number = () => 0,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return pool.slice(0, limit);

  const scored: { item: T; score: number }[] = [];
  for (const item of pool) {
    const text = textOf(item).toLowerCase();
    const matchScore = fuzzyScore(q, text);
    if (matchScore === null) continue;
    scored.push({ item, score: matchScore + weightOf(item) });
  }
  // Stable sort (Array.prototype.sort is stable in Node/V8) so ties keep
  // pool order, matching the old prefix/substring bucketing's tie
  // behavior.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}

/** Per-character bonus for matching right at a word boundary (text
 *  start, or just after a space/hyphen/underscore) — rewards "sea"
 *  matching the start of "Seattle" much more than an incidental "sea"
 *  buried mid-word. */
const BOUNDARY_BONUS = 10;
/** Per-character bonus for extending an unbroken run of matched
 *  characters, growing with run length — a query matched as one
 *  contiguous block (the old "prefix"/"substring" cases) heavily
 *  outscores the same characters scattered across the candidate. */
const CONSECUTIVE_BONUS = 3;
/** Flat bonus for every matched character, so two matches of very
 *  different quality but the same query never tie at 0. */
const MATCH_BONUS = 1;
/** Penalty per character the match starts into the text — an earlier
 *  match (closer to a true prefix) beats a later one, all else equal. */
const START_PENALTY = 0.5;
/** Flat bonus when the query is a true prefix of the text (case-
 *  insensitive) — large enough to dominate any combination of the bonuses
 *  above, so a real prefix match always outranks a scattered match that
 *  happens to hit multiple word boundaries elsewhere in a longer/busier
 *  candidate string. */
const PREFIX_BONUS = 50;

function isWordBoundaryChar(ch: string | undefined): boolean {
  return ch === undefined || !/[a-z0-9]/i.test(ch);
}

/** Returns a score if `query`'s characters all appear in `text`, in
 *  order (a subsequence match); null if they don't (no match at all —
 *  the fuzzy equivalent of the old "neither startsWith nor includes"
 *  rejection). Both inputs are assumed already lowercased/trimmed. */
function fuzzyScore(query: string, text: string): number | null {
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let firstMatchIndex = -1;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] !== query[qi]) {
      consecutive = 0;
      continue;
    }
    if (firstMatchIndex === -1) firstMatchIndex = ti;
    score += MATCH_BONUS + consecutive * CONSECUTIVE_BONUS;
    if (isWordBoundaryChar(text[ti - 1])) score += BOUNDARY_BONUS;
    consecutive++;
    qi++;
  }
  if (qi < query.length) return null;
  score -= firstMatchIndex * START_PENALTY;
  if (text.startsWith(query)) score += PREFIX_BONUS;
  return score;
}
