/**
 * Pure, fs/network-free search types + sort/match logic — split out of
 * jobs.ts so the desktop app's webview (which can't import node:fs/
 * node:child_process, both used elsewhere in jobs.ts for the Workday/
 * canonicalize/fit/save paths) can import real sort/filter functions
 * directly, not just types, against a SearchJob[] it already fetched via
 * the bridge. Same reasoning as the state.ts/stateDerive.ts split.
 */

export type JobSource =
  | "ashbyhq"
  | "lever"
  | "workday"
  | "greenhouse"
  | "smartrecruiters"
  | "amazon"
  | "oracle";

export interface SearchJob {
  source: JobSource;
  company: string;
  title: string;
  url: string;
  apply_url?: string;
  external_job_id?: string;
  location?: string;
  jd_text?: string;
  /** ISO 8601 when known. Ashby/Lever/Greenhouse give an exact timestamp;
   *  Workday's public API only exposes a bucketed relative-age string
   *  ("Posted 3 Days Ago"), approximated to an ISO date on the Python side. */
  posted_at?: string;
}

/** Most-recently-posted first. Jobs with no parseable posted_at sort
 *  last, never first, so an unknown date never masquerades as "newest". */
function postedTime(job: SearchJob): number {
  const t = job.posted_at ? new Date(job.posted_at).getTime() : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

export function sortByPostedDesc(jobs: SearchJob[]): SearchJob[] {
  return [...jobs].sort((a, b) => postedTime(b) - postedTime(a));
}

export function sortByCompanyAsc(jobs: SearchJob[]): SearchJob[] {
  return [...jobs].sort((a, b) => a.company.localeCompare(b.company) || postedTime(b) - postedTime(a));
}

export function sortByTitleAsc(jobs: SearchJob[]): SearchJob[] {
  return [...jobs].sort((a, b) => a.title.localeCompare(b.title) || postedTime(b) - postedTime(a));
}

/**
 * Does this posting sit in one of the user's preferred_locations?
 *
 * Deliberately forgiving in one direction only: a preference of
 * "Seattle, WA" matches a posting that says just "Seattle" or "Seattle,
 * Washington, United States", because boards write locations a dozen
 * different ways. It never matches on the state alone — "WA" appearing
 * somewhere is not a Seattle job.
 */
export function isPreferredLocation(job: SearchJob, preferred: string[]): boolean {
  const loc = (job.location ?? "").toLowerCase();
  if (!loc || preferred.length === 0) return false;
  return preferred.some((p) => {
    const needle = p.trim().toLowerCase();
    if (!needle) return false;
    if (loc.includes(needle)) return true;
    // Compare on the city part only ("Seattle, WA" -> "seattle"); require a
    // real word so a 1-2 char fragment can't match half the country.
    const city = needle.split(",")[0]?.trim() ?? "";
    return city.length >= 3 && loc.includes(city);
  });
}

/**
 * Preferred-location matches first, then newest-first within each group.
 *
 * preferred_locations is a priority list, not a filter (AGENTS.md
 * "Location handling") — this sorts, it never drops a non-preferred
 * posting. This is the manual search's default (and, unless the user
 * picks a different sort in the UI, only) ordering: jobs where the user
 * actually wants to work land on the first page, everything else still
 * appears, just after them. With no preferred locations set this
 * degrades exactly to sortByPostedDesc.
 */
export function sortByPreferredThenPosted(jobs: SearchJob[], preferred: string[]): SearchJob[] {
  if (preferred.length === 0) return sortByPostedDesc(jobs);
  return [...jobs].sort((a, b) => {
    const pa = isPreferredLocation(a, preferred) ? 1 : 0;
    const pb = isPreferredLocation(b, preferred) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return postedTime(b) - postedTime(a);
  });
}

/** Split a title into comparable word tokens (drops punctuation, so
 *  "Engineer, Backend" and "Engineer (Backend)" tokenize the same). */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9+#]+/i).filter(Boolean);
}

// "intern" needs its own rule in BOTH directions. A subsequence scorer
// treats it as satisfied by scattered letters ("Identity"); plain substring
// makes it a prefix of "Internal"/"International"/"Internet". So it matches
// only as a whole word — intern/interns/internship/internships.
const INTERN_RE = /\bintern(s|ship|ships)?\b/i;

/**
 * Does one query word match a job title?
 *
 * The old rule was `titleLower.includes(term)` for every term, which is
 * why searching "software engineering intern" missed "Software Engineer
 * Intern": "engineering" is not a substring of "engineer". Job titles and
 * the words people search with differ constantly by inflection
 * (engineer/engineering, develop/developer/development,
 * grad/graduate/graduating), and requiring the exact literal form hid real
 * postings.
 *
 * So a term now matches a title word when either is a prefix of the other
 * — which covers every inflection pair above without a stemmer, since the
 * divergence is always in the suffix. The min-length guard is what keeps
 * that honest: short tokens ("ai", "ml", "go", "qa") must match a title
 * word exactly, so "ai" can't match "aid" and "go" can't match "google".
 */
const MIN_PREFIX_LEN = 4;

export function termMatchesTitle(term: string, title: string): boolean {
  if (term === "intern") return INTERN_RE.test(title);
  const titleWords = words(title);
  return titleWords.some((word) => {
    if (word === term) return true;
    if (Math.min(word.length, term.length) < MIN_PREFIX_LEN) return false;
    return word.startsWith(term) || term.startsWith(word);
  });
}

/** Every query word must match somewhere in the title (AND, not OR) — so
 *  a search stays predictable and narrow; only the per-word comparison got
 *  more forgiving, not the overall gate. */
export function titleMatchesQuery(title: string, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  return terms.every((term) => termMatchesTitle(term, title));
}
