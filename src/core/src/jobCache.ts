import fs from "node:fs/promises";
import path from "node:path";
import { readJobCacheSupabaseConfig } from "./supabaseConfig.js";
import { readJobCacheRedisConfig } from "./redisConfig.js";
import { redisGetJobs } from "./jobCacheRedis.js";
import type { JobSource, SearchJob } from "./jobsSort.js";

// Cache lookups must never make a search feel slower than today. Tuned
// against the live table: a full 4-source, ~35-company concurrent batch
// measured 232-655ms unfiltered (jd_text is the dominant per-row cost —
// see UNFILTERED_PER_COMPANY_LIMIT/FILTERED_PER_COMPANY_LIMIT below),
// with real margin below this budget. If a lookup doesn't come back
// within it, falling through to the existing live fetch (its own,
// longer per-source budget — see SOURCE_DEADLINE_MS in jobs.ts) is
// always the safer failure mode.
const CACHE_LOOKUP_TIMEOUT_MS = 1200;

// Per company, not overall. Capping per company (via the job_cache_search
// RPC's lateral join, not a plain global LIMIT) is load-bearing: a
// global LIMIT across N companies returns Postgres's first-scanned rows
// combined, which in practice let 1-2 companies fill the whole cap and
// left every other configured company with zero results even though
// real cached rows existed for them (see migration 0004's header).
//
// Two different limits, not one — measured live, they have very
// different cost profiles now that the RPC pre-filters by title
// (migration 0005) before applying either cap:
// - UNFILTERED_PER_COMPANY_LIMIT (browsing, no search query typed):
//   10, picked empirically — measured live at 10/15/25/40 across all
//   four sources, and 10 was the last value with consistently fast
//   (sub-second), non-spiky latency; 15 already showed occasional 2s
//   spikes. jd_text (full description text, required so checkJobFit()
//   works on cache-derived jobs without a live refetch) is what makes
//   row count this expensive with nothing narrowing the row set first.
// - FILTERED_PER_COMPANY_LIMIT (a real search query, so titleWords is
//   non-empty): the ILIKE pre-filter already narrows each company down
//   to plausibly-relevant rows before this cap ever applies, so a much
//   higher cap costs almost nothing — measured live, raising a
//   pre-filtered query from 10 to 75 went 77ms -> 103ms. Confirmed live
//   this mattered: a real "software engineer intern" search had 19
//   matching rows sitting past the old shared 10-cap for one source
//   alone, silently excluded even though the RPC had already filtered
//   down to genuine candidates.
// Matches jobs.ts's MAX_PAGE_SIZE — a merged, deduped, final result
// page can never exceed that regardless of source, so there's no
// value in capping any single company past it.
// Exported so refreshJobCache.ts's Redis eager-warm step caps its
// browse-all rows identically instead of re-declaring this number —
// the cached value has to match what this file's own Postgres path
// would return for the same lookup.
export const UNFILTERED_PER_COMPANY_LIMIT = 10;
const FILTERED_PER_COMPANY_LIMIT = 75;

export interface JobCacheLookup {
  source: JobSource;
  companySlugs: string[];
  /** '' for the unfiltered-board sources (Ashby/Lever/Greenhouse/
   *  SmartRecruiters all support a full, unfiltered board fetch — see
   *  refreshJobCache.ts, which is what populates rows under query=''). */
  query: string;
  /** The user's actual search words (lowercased), used as a loose
   *  ILIKE pre-filter inside the job_cache_search RPC (migration 0005)
   *  — applied BEFORE the per-company cap, not after. Without this, a
   *  narrow query like "intern" could come back with zero cache
   *  results for a company that has real intern postings cached,
   *  simply because none of them happened to land in an arbitrary
   *  unfiltered top-N sample (confirmed live). Empty/omitted disables
   *  filtering (the browse-everything case — also switches to the
   *  lower UNFILTERED_PER_COMPANY_LIMIT). Deliberately loose (plain substring, not the
   *  inflection-aware matching titleMatchesQuery does) — that function
   *  still runs afterward on the merged result set and is the
   *  authoritative filter; this only has to be loose enough not to
   *  exclude a real match before that ever sees it. */
  titleWords?: string[];
}

interface JobCacheRow {
  company: string;
  title: string;
  url: string;
  apply_url: string | null;
  external_job_id: string | null;
  location: string | null;
  jd_text: string | null;
  pay_text: string | null;
  posted_at: string | null;
}

/**
 * Reads cached postings from the shared Supabase job_cache table via the
 * job_cache_search RPC (src/job_cache_supabase/supabase/migrations/0003_job_cache.sql,
 * 0004_job_cache_search_fn.sql) in place of a live per-source fetch.
 * Read-only, anon-key access — the RPC is `security invoker`, subject to
 * job_cache's own RLS policy, which allows public SELECT on unexpired
 * rows regardless of sign-in state, since postings aren't personal data.
 *
 * Returns undefined — never throws — whenever the cache isn't usable for
 * any reason: no src/config/job_cache_supabase.json on this install,
 * unreachable, slow, or genuinely empty. Every caller treats undefined as
 * "fall back to the existing live fetch," exactly as if this function
 * didn't exist. A cache MISS is not evidence of zero jobs — an empty
 * resultset must never be returned as "here are the results," only as
 * "try live." Deliberately its own config, separate from
 * src/config/supabase.json (hosted auth) — see supabaseConfig.ts's
 * readJobCacheSupabaseConfig for why.
 */
// jobsSort.ts's termMatchesTitle (the real, authoritative matcher) does
// BIDIRECTIONAL prefix matching for words >=4 chars: word.startsWith(term)
// OR term.startsWith(word). A plain `title ILIKE '%term%'` only catches
// the first direction — if a query word is a longer *extension* of a
// title word (query "engineering" against a title that says "Engineer"),
// the literal term never appears as a substring in the title at all, so
// ILIKE incorrectly excludes a match the real filter would accept.
// Confirmed live: "software engineering intern" returned 0 from Ashby's
// cache while "software engineer intern" correctly returned 4 — the only
// difference was that one extra "-ing".
//
// Truncating each word to its own first MIN_PREFIX_LEN characters before
// building the ILIKE pattern closes this: any title word sharing that
// same prefix will contain it as a literal substring regardless of which
// word is longer, so both directions of the real matcher's prefix check
// are covered. Words shorter than MIN_PREFIX_LEN are left whole — the
// real matcher only exact-matches those (no prefix leniency below the
// threshold), and ILIKE on the full short word is already a safe (loose,
// never under-inclusive) superset of an exact-match requirement.
const MIN_PREFIX_LEN = 4;

function looseTitleFilterWords(titleWords: string[]): string[] {
  return titleWords.map((word) => (word.length >= MIN_PREFIX_LEN ? word.slice(0, MIN_PREFIX_LEN) : word));
}

// In-memory browse-all snapshots, one per cacheable source — only ever
// populated by startInMemoryCacheRefresh() below, which only the
// persistent search daemon (bridge.ts's --serve mode) calls. A one-shot
// bridge invocation (the TUI, or the Rust side's one-shot fallback path)
// never populates this, so it just stays empty and the check in
// readJobCache() below is a no-op — completely safe either way, same
// "an absent/unpopulated cache tier degrades to the next one" contract
// every other tier here already has.
const inMemorySnapshots = new Map<JobSource, SearchJob[]>();
let inMemoryRefreshTimer: ReturnType<typeof setInterval> | undefined;

// 60 minutes (was 3, changed 2026-08-26 as a direct egress-reduction
// measure — this loop's own POST-per-source-per-tick traffic, pulling up
// to IN_MEMORY_PER_COMPANY_LIMIT rows with full jd_text each, run for the
// entire lifetime of every open desktop-app/TUI daemon session, was a
// real contributor to job_cache pushing past its free-tier egress cap).
// A live search never waits on this loop either way — readJobCache()
// answers from the in-memory Map (sub-10ms) regardless of how often it's
// refreshed, so this interval has zero effect on perceived search speed;
// it only bounds how stale a long-lived daemon's snapshot can get before
// a refresh lands. Now that CI itself only refreshes job_cache every
// other day (~48h), even 60 minutes of in-memory lag is trivial by
// comparison — 20x fewer of this loop's own reads for no meaningful
// freshness cost. (IN_MEMORY_PER_COMPANY_LIMIT below is the other lever
// if more headroom is ever needed — a smaller per-refresh payload rather
// than a less frequent one — left untouched here since this interval
// change alone already gets a 20x reduction on its own.)
const IN_MEMORY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Starts a background loop that keeps an in-memory browse-all snapshot
 * warm per cacheable source, for every source in `sources` that has a
 * non-empty shared company list. This is the tier that actually reaches
 * sub-10ms: no network call at all on a hit, just a Map lookup — but it
 * only means anything inside a long-lived process, since the snapshot
 * lives in module state that a one-shot process would just throw away
 * on exit. Idempotent (a second call while a timer is already running
 * is a no-op) so bridge.ts's --serve startup can call this without
 * worrying about being invoked more than once.
 */
export function startInMemoryCacheRefresh(root: string, sources: readonly JobSource[]): void {
  if (inMemoryRefreshTimer) return;
  const refreshOnce = async () => {
    for (const source of sources) {
      const shared = await sharedCacheSlugs(root, source);
      if (shared.size === 0) continue;
      // Pulled directly from Postgres at IN_MEMORY_PER_COMPANY_LIMIT
      // (500/company), not the small 10/company Redis browse-all entry
      // — that cap is fine for a live search falling through to a
      // precise query on a miss, but not for the ONLY thing a warm
      // in-memory hit trusts (see readJobCache below).
      const jobs = await fetchFullSourceSnapshot(root, source, [...shared]);
      if (jobs) inMemorySnapshots.set(source, jobs);
    }
  };
  void refreshOnce();
  inMemoryRefreshTimer = setInterval(() => void refreshOnce(), IN_MEMORY_REFRESH_INTERVAL_MS);
  inMemoryRefreshTimer.unref?.();
}

export async function readJobCache(root: string, lookup: JobCacheLookup): Promise<SearchJob[] | undefined> {
  if (lookup.companySlugs.length === 0) return undefined;

  // Unconditional — not just the browse-all case. The in-memory
  // snapshot holds IN_MEMORY_PER_COMPANY_LIMIT rows/company (not the
  // small browse-all cap), so it's a large-enough candidate pool to
  // answer a filtered query correctly too: searchJobs() (jobs.ts)
  // always re-filters whatever readJobCache returns through the real,
  // authoritative titleMatchesQuery on the final merged set regardless
  // of where a row came from — this tier just needs to not silently
  // exclude a real match before that filter ever sees it, exactly the
  // same bar the Postgres RPC's own pre-filter already has to clear.
  const snapshot = inMemorySnapshots.get(lookup.source);
  if (snapshot) return snapshot;

  return readFromRedisOrPostgres(root, lookup);
}

/**
 * Redis (browse-all only) -> Postgres RPC. Split out from readJobCache()
 * so the in-memory refresh loop above can call straight into this,
 * bypassing the in-memory tier itself (refreshing FROM the snapshot
 * would just keep re-returning the same stale copy forever). Checking
 * Redis no longer depends on the Supabase job_cache config being
 * present — an earlier version of this function gated the Redis check
 * behind that config's existence, which meant an install with only
 * src/config/job_cache_redis.json set (no Postgres project configured)
 * would silently skip Redis too.
 */
async function readFromRedisOrPostgres(root: string, lookup: JobCacheLookup): Promise<SearchJob[] | undefined> {
  const titleWords = lookup.titleWords ?? [];

  // Redis only covers the browse-all (no-query) case — the expensive
  // one (232-655ms, see this file's header) and the one
  // refreshJobCache.ts's eager warm keeps populated. A filtered query
  // is already ~77-103ms via the RPC's own ILIKE pre-filter (migration
  // 0005), so it stays on the Postgres path below unchanged — caching
  // it would buy little for real added complexity (a per-query-shape
  // key space instead of one key per source).
  if (titleWords.length === 0) {
    const redisConfig = readJobCacheRedisConfig(root);
    if (redisConfig) {
      const cached = await redisGetJobs(redisConfig, lookup.source);
      if (cached) return cached;
    }
  }

  const config = readJobCacheSupabaseConfig(root);
  if (!config) return undefined;

  const perCompanyLimit = titleWords.length > 0 ? FILTERED_PER_COMPANY_LIMIT : UNFILTERED_PER_COMPANY_LIMIT;
  return postgresJobCacheSearch(
    config,
    lookup.source,
    lookup.companySlugs,
    lookup.query,
    perCompanyLimit,
    looseTitleFilterWords(titleWords),
    CACHE_LOOKUP_TIMEOUT_MS,
  );
}

/** Raw job_cache_search RPC call — factored out so both a live search's
 *  cache check (small, tightly-timed caps above) and the in-memory
 *  daemon's background full-dataset refresh (see fetchFullSourceSnapshot
 *  below, a much bigger cap with no live search waiting on it) share one
 *  implementation instead of two copies of the same fetch/parse logic. */
async function postgresJobCacheSearch(
  config: { url: string; anonKey: string },
  source: JobSource,
  companySlugs: string[],
  query: string,
  perCompanyLimit: number,
  titleWords: string[],
  timeoutMs: number,
): Promise<SearchJob[] | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.url}/rest/v1/rpc/job_cache_search`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_source: source,
        p_company_slugs: companySlugs,
        p_query: query,
        p_per_company_limit: perCompanyLimit,
        p_title_words: titleWords,
      }),
    });
    if (!response.ok) return undefined;
    const rows = (await response.json()) as JobCacheRow[];
    if (rows.length === 0) return undefined;
    return rows.map((row): SearchJob => ({
      source,
      company: row.company,
      title: row.title,
      url: row.url,
      apply_url: row.apply_url ?? undefined,
      external_job_id: row.external_job_id ?? undefined,
      location: row.location ?? undefined,
      jd_text: row.jd_text ?? undefined,
      pay_text: row.pay_text ?? undefined,
      posted_at: row.posted_at ?? undefined,
    }));
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// How many rows per company the in-memory daemon snapshot holds — much
// higher than FILTERED_PER_COMPANY_LIMIT (75), which was already tuned
// as "enough that a real filtered match isn't missed" for the direct
// Postgres RPC path; 500 matches jobs.ts's own MAX_PAGE_SIZE, the
// existing "this is already the most the app ever shows or uses"
// ceiling elsewhere in this codebase. Deliberately NOT the small
// UNFILTERED_PER_COMPANY_LIMIT (10) the browse-all Redis entry uses —
// that cap is fine for Redis/the one-shot paths (a real search still
// falls through to a precise Postgres/live query on a miss), but the
// in-memory daemon tier is the ONLY thing standing between a query and
// its answer once a source is warm — see readJobCache's in-memory
// check, which unconditionally trusts whatever is in inMemorySnapshots
// as a complete-enough candidate pool.
const IN_MEMORY_PER_COMPANY_LIMIT = 500;

// A background refresh has no live search waiting on it, so it can
// afford a much longer budget than CACHE_LOOKUP_TIMEOUT_MS (1.2s) — a
// bigger per-company cap means a bigger response to wait for.
const IN_MEMORY_REFRESH_TIMEOUT_MS = 20_000;

/** Pulls a much fuller per-company dataset directly from Postgres (not
 *  the small capped Redis browse-all entry — see IN_MEMORY_PER_COMPANY_LIMIT
 *  above for why) for the in-memory daemon's own background refresh
 *  loop. Never throws; a failed refresh just leaves the previous
 *  snapshot (if any) in place until the next attempt. */
async function fetchFullSourceSnapshot(root: string, source: JobSource, companySlugs: string[]): Promise<SearchJob[] | undefined> {
  const config = readJobCacheSupabaseConfig(root);
  if (!config) return undefined;
  return postgresJobCacheSearch(config, source, companySlugs, "", IN_MEMORY_PER_COMPANY_LIMIT, [], IN_MEMORY_REFRESH_TIMEOUT_MS);
}

const CACHE_SOURCE_KEY: Partial<Record<JobSource, string>> = {
  ashbyhq: "ashby_company_slugs",
  lever: "lever_company_slugs",
  greenhouse: "greenhouse_company_slugs",
  smartrecruiters: "smartrecruiters_company_slugs",
};

/**
 * The full shared-cache company list for a source (src/config/
 * job_cache_targets.json, committed, the same ~47 companies for every
 * install) — independent of a user's own src/config/targets.json, which is
 * a completely separate, per-install list.
 *
 * This is the SEARCH SCOPE fix, distinct from (and found after) the
 * earlier coverage-safety fix: it's not enough to just make sure a
 * user's own configured companies never get silently dropped when
 * they're absent from the shared cache — the shared cache's OTHER
 * companies (the ones a user never personally configured, like SpaceX
 * for most installs) were never being searched AT ALL, cache or no
 * cache, because searchJobs() only ever iterated a source's *personal*
 * slug list. The whole reason job_cache_targets.json is a curated,
 * broader company list in the first place — "so users have a lot of
 * options to apply to" — never actually took effect; the cache was
 * only ever speeding up and correctly covering a user's own existing
 * (often narrow) list, never expanding what got searched. Confirmed
 * live: SpaceX (only in the shared list, not any tested personal one)
 * never appeared in results for any query, no matter how broad.
 *
 * Callers (jobs.ts's maybeCached) union this with a source's personal
 * slug list — the shared list is always searched via cache; whichever
 * of the user's own companies aren't already part of it get live-fetched
 * on top, so nothing from either list is ever dropped.
 *
 * Never throws — a missing/unreadable file just means the shared list is
 * empty, which safely falls back to exactly the old personal-list-only
 * behavior rather than breaking search.
 */
export async function sharedCacheSlugs(root: string, source: JobSource): Promise<Set<string>> {
  const key = CACHE_SOURCE_KEY[source];
  if (!key) return new Set();
  try {
    const raw = await fs.readFile(path.join(root, "src", "config", "job_cache_targets.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return new Set((parsed[key] as string[] | undefined) ?? []);
  } catch {
    return new Set();
  }
}
