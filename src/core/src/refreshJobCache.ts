/**
 * Populates the shared Supabase job_cache table (see
 * src/job_cache_supabase/supabase/migrations/0003_job_cache.sql) so searchJobs()'s cache checks
 * (jobCache.ts) actually have something to hit. NOT part of this
 * package's public export surface (see package.json's "exports" map:
 * this file is deliberately absent from it) and never imported by any
 * TUI/desktop entry point, so it never ships inside src/tui/'s bundled CLI
 * or the desktop app's Node subprocess bridge.
 *
 * Run standalone, holding the Supabase secret key (Project Settings →
 * API Keys → "Secret keys": sb_secret_..., the current replacement for
 * the legacy service_role JWT; authorizes via the same service_role
 * Postgres role and still sets BYPASSRLS, so it bypasses RLS identically.
 * This is the only thing in the whole codebase that should ever hold
 * that key; it must never reach src/config/job_cache_supabase.json, a
 * client bundle, or any file that gets committed):
 *
 *   SUPABASE_SECRET_KEY=sb_secret_... node src/core/dist/refreshJobCache.js
 *
 * Locally, the project URL comes from src/config/job_cache_supabase.json,
 * its own project, deliberately separate from src/config/supabase.json
 * (hosted auth/profile sync). Split apart 2026-07-23: the two workloads
 * were sharing one project's disk I/O budget, and job_cache's own write
 * volume (~14k rows across 47 companies, refreshed hourly at the time)
 * pushed it toward the free-tier limit, producing Cloudflare 522s on
 * unrelated requests. See supabaseConfig.ts's readJobCacheSupabaseConfig
 * for the full reasoning: the move to a daily cadence (2026-07-30) cut
 * that write volume by ~24x on its own, and it moved again (2026-08-26)
 * to 3 runs/week, Mon/Wed/Fri, not daily, once real egress usage
 * showed even daily wasn't enough margin against the free tier. (A
 * same-day first attempt at this, a day-of-month cron step value,
 * silently didn't work; see the workflow file's own comment for the
 * live-verified reason and why weekday-list cron replaced it.) In CI
 * (.github/workflows/refresh-job-cache.yml, Mon/Wed/Fri, well under
 * job_cache's 7-day retention window) that file doesn't exist on a fresh
 * checkout, so SUPABASE_URL is read as a direct override first, not
 * secret, just the project's own URL, stored as a plain repo secret
 * alongside SUPABASE_SECRET_KEY for convenience.
 *
 * This refresh is strictly ADDITIVE and must stay that way. Every run
 * inserts postings it has not seen before and pushes the retention
 * window out on ones it sees again; it never deletes, never truncates,
 * and never rewrites an existing row's original discovery timestamp (see
 * jobCacheRow's note on the deliberately-omitted fetched_at). A run that
 * fetches fewer postings than the last one therefore SHRINKS nothing:
 * previously-cached jobs stay readable until their own window lapses.
 *
 * Refreshes the four sources that support a full, unfiltered board fetch,
 * Ashby, Lever, Greenhouse, SmartRecruiters, using
 * src/config/job_cache_targets.json's company slugs. That file is
 * deliberately separate from src/config/targets.json (gitignored, holds this
 * operator's personal profile/PII): it's committed, so a CI checkout
 * can see it, and it must only ever hold company slugs. Every row is
 * written under query='' (see jobCache.ts's header for why: query-string
 * matching happens downstream against the merged result set, identically
 * whether a job came from cache or a live fetch).
 *
 * Amazon/Oracle/Workday are Python-backed and query-parameterized (their
 * APIs don't offer a "list everything" mode the way the four above do;
 * see jobs.ts's fetchAmazon/fetchOracle/fetchWorkday), deliberately
 * left out of this first pass rather than guessing at a query set to
 * seed them with. searchJobs() already skips the cache check for those
 * three entirely (see maybeCached's call sites in jobs.ts), so this gap
 * is inert, not silently broken.
 *
 * Also eagerly warms a Redis browse-all entry per source right after
 * its Postgres upsert succeeds (see jobCacheRedis.ts, jobCache.ts's
 * readJobCache): the single most common no-query "just show me
 * openings" case is then warm immediately after every refresh instead
 * of waiting for the first post-refresh search to populate it lazily
 * (which a client can't do anyway: Redis writes need a write-capable
 * token, and this script is the only thing that should ever hold one).
 * Needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_WRITE_TOKEN as env
 * vars (same discipline as SUPABASE_SECRET_KEY: never a config file,
 * never a client bundle); if either is absent, the warm step logs and
 * skips rather than failing the run, since the Postgres upsert already
 * succeeded and stays the source of truth either way.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { findProjectRoot } from "./project.js";
import { readJobCacheSupabaseConfig } from "./supabaseConfig.js";
import { configured, fetchAshby, fetchLever, fetchGreenhouse, fetchSmartRecruiters } from "./jobs.js";
import { UNFILTERED_PER_COMPANY_LIMIT } from "./jobCache.js";
import { redisSetJobs } from "./jobCacheRedis.js";
import type { SearchJob, JobSource } from "./jobsSort.js";

// 7 days: a *retention window measured from each posting's last
// sighting*, not a "how stale may this be" freshness bound. Was 2h,
// matching migration 0003's column default, back when this ran hourly.
//
// Two things forced it up together (2026-07-30):
//
// 1. The refresh moved to daily, then to Mon/Wed/Fri (see
//    .github/workflows/refresh-job-cache.yml: job boards don't post
//    often enough to justify hourly, and hourly scheduled runs were
//    being throttled to 2-3h apart by GitHub anyway, which meant a 2h
//    TTL was already letting the cache go fully cold between real runs).
//    A TTL at or near the cadence means the table reads as empty for
//    most of the interval; 7 days is still comfortable margin before a
//    single row drops out, even across the longer Friday->Monday gap.
//
// 2. The refresh is deliberately ADDITIVE: every run only ever adds
//    newly-discovered postings and extends the window on ones it sees
//    again. Nothing is ever deleted (there is no delete path against
//    job_cache anywhere in this codebase, by design). expires_at is
//    therefore the ONLY mechanism that retires a posting, and it now
//    means "last seen on a board 7 days ago": a posting that comes
//    down still lingers a week, which is the intended tradeoff: a
//    stale-but-visible listing is a far better failure mode than
//    silently dropping thousands of live jobs the moment one board
//    fetch hiccups.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 73 hours: just past the LONGEST refresh gap the Mon/Wed/Fri schedule
// actually produces: Friday to Monday is 3 days (72h), not 2, unlike a
// true every-other-day cadence, with 1h grace so one slow/late CI run
// doesn't let the warm entry go cold before the next one lands. Sized
// against the real worst-case gap, not the average one, since a TTL
// that expires mid-gap means the fallback-to-Postgres path (not a cache
// miss with nothing to fall back to) starts absorbing reads for the
// back half of every cycle: working directly against the reason this
// cadence changed at all. Still far under job_cache's own 7-day
// Postgres expires_at, so a served-at-expiry Redis entry can never be
// staler than Postgres would already allow.
//
// Note this entry holds only what the CURRENT run fetched live, while
// Postgres additionally retains everything seen in the last 7 days. The
// divergence is deliberate and safe in that direction: Redis serves the
// capped (UNFILTERED_PER_COMPANY_LIMIT) browse-all case, so it returns a
// *fresher subset*, and any real query falls through to the fuller
// Postgres set anyway (see jobCache.ts's readFromRedisOrPostgres).
const REDIS_WARM_TTL_SECONDS = 73 * 60 * 60;

interface JobCacheTargets {
  ashby_company_slugs?: string[];
  lever_company_slugs?: string[];
  greenhouse_company_slugs?: string[];
  smartrecruiters_company_slugs?: string[];
}

async function readJobCacheTargets(root: string): Promise<JobCacheTargets> {
  const raw = await fs.readFile(path.join(root, "src", "config", "job_cache_targets.json"), "utf8");
  return JSON.parse(raw) as JobCacheTargets;
}

interface RefreshSource {
  source: JobSource;
  slugs: string[];
  fetch: () => Promise<{ jobs: SearchJob[] }>;
}

function jobCacheRow(source: JobSource, slug: string, query: string, job: SearchJob, now: Date) {
  return {
    source,
    company_slug: slug,
    query,
    job_key: job.external_job_id || job.url,
    external_job_id: job.external_job_id ?? null,
    company: job.company,
    title: job.title,
    location: job.location ?? null,
    url: job.url,
    apply_url: job.apply_url ?? null,
    normalized_url: job.url,
    ats_system: source,
    posted_at: job.posted_at ?? null,
    jd_text: job.jd_text ?? null,
    pay_text: job.pay_text ?? null,
    // fetched_at is deliberately ABSENT from this payload. PostgREST's
    // resolution=merge-duplicates generates DO UPDATE SET only for the
    // columns actually present in the body, so omitting it means: a
    // brand-new row gets the column's own `default now()` (migration
    // 0003), and a row we've seen before keeps the timestamp it was
    // FIRST discovered at, forever. Including it would silently rewrite
    // every existing row's discovery time on every run: exactly the
    // "overwrite what's already there" behavior this refresh is not
    // supposed to have. Last-seen isn't lost by this: it's recoverable
    // as (expires_at - CACHE_TTL_MS), since expires_at IS sent below.
    // Nothing in the app reads fetched_at today (the RPC in migrations
    // 0004/0005 selects neither), so this is a strict information gain.
    expires_at: new Date(now.getTime() + CACHE_TTL_MS).toISOString(),
  };
}

// Postgres's ON CONFLICT DO UPDATE (this upsert's on_conflict=source,
// company_slug,query,job_key) hard-errors ("cannot affect row a second
// time") if a single statement's input rows collide on that key, so a
// duplicate here isn't just wasted work, it fails the whole chunk (and
// after 3 retries of the same unchanged rows, the whole run). Confirmed
// live 2026-07-30: SmartRecruiters' offset-paginated /postings endpoint
// (fetchSmartRecruitersCompany in jobs.ts) re-served an already-seen
// Dominos posting across the offset=0/offset=100 page boundary: Dominos
// carries 24k+ constantly opening/closing store-level postings, so the
// board's default sort can shift between two sequential page requests,
// letting a posting cross from one page into the next. That's a live-data
// race, not a fixed bug in one company's data: any high-volume board on
// any source is equally exposed. Deduping here, on the same key Postgres
// uses for conflict resolution, closes the failure class regardless of
// which upstream API or company produces the collision.
//
// Keyed on all four arbiter columns, not just the two that vary within a
// single source's batch. source and query are in fact constant per call
// today (one source per loop iteration, query always ''), so this is
// currently equivalent, but it is equivalent by coincidence of the
// caller, not by construction. Keying on exactly what Postgres keys on
// means this stays correct if a later change ever batches two sources,
// or seeds a query-parameterized source (Amazon/Oracle/Workday, see
// this file's header) into the same upsert.
function dedupeRows<T extends { source: string; company_slug: string; query: string; job_key: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of rows) {
    const key = JSON.stringify([row.source, row.company_slug, row.query, row.job_key]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

// A single source's rows can be huge: measured live, 20 greenhouse
// companies (spacex/databricks/etc.) produced 8,201 rows and a 75MB JSON
// body in one shot, which is almost certainly what actually hung a real
// CI run rather than erroring: a request that size either exceeds
// Supabase's gateway payload limit outright, or is just slow enough
// upserting 8,000+ rows with conflict resolution in one transaction to
// look indistinguishable from hung. Chunking keeps each request small
// and bounded, and gives per-chunk progress instead of one long silence.
//
// Dropped 200 -> 50 after the previous Supabase project reported disk
// I/O nearing its usage limit (free tier: 0.5 CPU/1GB; cumulative
// migrations, the original manual refresh, and repeated retried CI
// attempts all added up there); dropped again, 50 -> 25, as an extra
// safety margin on the fresh replacement project, even though a brand
// new project shouldn't carry that same accumulated I/O history. A 522
// "connection timed out" at the Cloudflare layer, on requests as cheap
// as a single-row SELECT, fit I/O-starved Postgres becoming unresponsive
// to new connections better than a payload-size problem: smaller
// chunks alone don't fix that (same total bytes written either way);
// UPSERT_INTER_CHUNK_DELAY_MS below is what actually matters, spreading
// writes out over time instead of shrinking them.
const UPSERT_CHUNK_SIZE = 25;
// Applied between every chunk, not just on retry: the point is
// spreading write pressure out over time so Postgres gets room to
// flush/checkpoint between transactions, not just making individual
// requests smaller.
const UPSERT_INTER_CHUNK_DELAY_MS = 1_500;
// The first real CI run aborted on the very first 200-row chunk (~1.8MB)
// at the old 30s timeout, before any progress had even been logged:
// most likely a slow/transient path from a fresh GitHub-hosted runner
// to Supabase rather than anything about the request itself. Bumped to
// 60s and given one retry (same "one retry clears most transient
// blips" reasoning jobs.ts's fetchJson already uses for the live
// per-source fetches) rather than assumed to be a payload problem again.
const UPSERT_TIMEOUT_MS = 60_000;

async function upsertChunkOnce(url: string, secretKey: string, rows: ReturnType<typeof jobCacheRow>[]): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSERT_TIMEOUT_MS);
  try {
    // apikey + an *identical* Authorization: Bearer value: the new key
    // format (secret or publishable) is rejected in Authorization unless
    // it exactly matches apikey (see Supabase's API keys docs); this is
    // the one header shape that's valid for both the new secret key and
    // the legacy service_role JWT, so it works either way.
    const response = await fetch(`${url}/rest/v1/job_cache?on_conflict=source,company_slug,query,job_key`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!response.ok) {
      // Truncated: a non-2xx from the Supabase edge is sometimes a full
      // Cloudflare HTML error page (confirmed live: a 522 "connection
      // timed out" response body ran 100+ lines), not worth dumping
      // whole into CI logs on every retry.
      const body = (await response.text()).slice(0, 300);
      throw new Error(`job_cache upsert failed: HTTP ${response.status}: ${body}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// 4 attempts, exponential backoff (2s/5s/10s between). Bumped up from a
// single 1s-backoff retry after a live run hit HTTP 522 "connection
// timed out between Cloudflare and the origin" on both the first
// attempt AND that one retry, ~20s apart: whatever this is (transient
// Supabase-side blip, cold-start, or something else on their end; the
// request itself was small and well-formed, so this isn't a payload or
// timeout-value problem), it didn't clear in under 20s, so it gets a
// real chance to before this gives up and fails the whole run.
const UPSERT_RETRY_BACKOFF_MS = [2_000, 5_000, 10_000];

async function upsertChunk(url: string, secretKey: string, rows: ReturnType<typeof jobCacheRow>[], attempt = 0): Promise<void> {
  try {
    await upsertChunkOnce(url, secretKey, rows);
  } catch (err) {
    if (attempt >= UPSERT_RETRY_BACKOFF_MS.length) throw err;
    const backoff = UPSERT_RETRY_BACKOFF_MS[attempt]!;
    console.log(`    retry ${attempt + 1}/${UPSERT_RETRY_BACKOFF_MS.length} in ${backoff}ms after: ${err instanceof Error ? err.message : String(err)}`);
    await new Promise((resolve) => setTimeout(resolve, backoff));
    return upsertChunk(url, secretKey, rows, attempt + 1);
  }
}

async function upsert(url: string, secretKey: string, rows: ReturnType<typeof jobCacheRow>[]): Promise<void> {
  const totalChunks = Math.ceil(rows.length / UPSERT_CHUNK_SIZE);
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunkNum = i / UPSERT_CHUNK_SIZE + 1;
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    console.log(`  upserting chunk ${chunkNum}/${totalChunks} (${chunk.length} rows)...`);
    await upsertChunk(url, secretKey, chunk);
    console.log(`  ...upserted ${Math.min(i + UPSERT_CHUNK_SIZE, rows.length)}/${rows.length}`);
    if (i + UPSERT_CHUNK_SIZE < rows.length) {
      await new Promise((resolve) => setTimeout(resolve, UPSERT_INTER_CHUNK_DELAY_MS));
    }
  }
}

/**
 * Same shape the Postgres job_cache_search RPC returns for a browse-all
 * (query='', no title words) lookup, grouped by company, capped at
 * UNFILTERED_PER_COMPANY_LIMIT per company, so the Redis-cached value
 * and the Postgres fallback stay consistent regardless of which path a
 * given search happens to hit.
 */
function browseAllRows(jobs: SearchJob[]): SearchJob[] {
  const byCompany = new Map<string, SearchJob[]>();
  for (const job of jobs) {
    const list = byCompany.get(job.company) ?? [];
    if (list.length < UNFILTERED_PER_COMPANY_LIMIT) list.push(job);
    byCompany.set(job.company, list);
  }
  return [...byCompany.values()].flat();
}

/**
 * Eager warm, not lazy populate: the only Redis write path in the
 * system (see jobCacheRedis.ts's header). Best-effort: a missing write
 * token (e.g. a local manual refresh) just skips the warm with a log
 * line rather than failing the whole refresh run, since the Postgres
 * upsert above already succeeded and remains the source of truth
 * either way.
 */
async function warmRedisBrowseAll(source: JobSource, jobs: SearchJob[]): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const writeToken = process.env.UPSTASH_REDIS_WRITE_TOKEN;
  if (!url || !writeToken) {
    console.log(`${source}: UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_WRITE_TOKEN not set, skipping Redis warm`);
    return;
  }
  // Never overwrite a good warm entry with an empty one. A board
  // returning zero postings is far more likely an upstream outage or a
  // silently-changed API than a company genuinely closing every req, and
  // SET with an empty array would throw away the last known-good entry
  // for the whole REDIS_WARM_TTL_SECONDS window. Leaving the previous
  // value in place lets it age out naturally instead. (redisGetJobs
  // already treats an empty array as a miss, so this was never able to
  // serve "zero jobs" as an answer, but at the old 75min TTL the cost
  // of the mistake was an hour of lost hit rate; at 25h it would be a
  // full day of every browse-all paying the Postgres path.)
  if (jobs.length === 0) {
    console.log(`${source}: fetch returned 0 postings, leaving the existing Redis entry alone rather than blanking it`);
    return;
  }
  const rows = browseAllRows(jobs);
  await redisSetJobs(url, writeToken, source, rows, REDIS_WARM_TTL_SECONDS);
  console.log(`${source}: warmed Redis browse-all cache with ${rows.length} postings`);
}

async function main(): Promise<void> {
  // SUPABASE_SECRET_KEY is the current name; SUPABASE_SERVICE_ROLE_KEY
  // still honored for anyone running this against a project still on
  // legacy JWT keys.
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secretKey) {
    console.error("SUPABASE_SECRET_KEY is not set: refusing to run. This must never live in a file.");
    process.exit(1);
  }
  const root = findProjectRoot();
  // SUPABASE_URL overrides src/config/supabase.json when set (CI has no such
  // file on a fresh checkout; see this file's header). Locally, neither
  // set, falls back to the same config file the desktop app reads.
  const url = process.env.SUPABASE_URL || readJobCacheSupabaseConfig(root)?.url;
  if (!url) {
    console.error("Neither SUPABASE_URL nor a configured src/config/supabase.json was found: nothing to refresh against.");
    process.exit(1);
  }
  // Diagnostic preflight: added after 3 consecutive live CI runs all
  // failed the same way (every upsert attempt, including retries with
  // real exponential backoff, hit HTTP 522 "connection timed out
  // between Cloudflare and the origin"). This isolates whether it's
  // GitHub Actions' network path to this Supabase project failing
  // entirely (reads too) or something specific to the write/POST path:
  // a plain GET was never actually tested from GitHub Actions before
  // now, only from a different environment where it worked fine.
  const preflightStart = Date.now();
  try {
    const preflight = await fetch(`${url}/rest/v1/job_cache?select=id&limit=1`, {
      headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    console.log(`preflight GET: HTTP ${preflight.status} in ${Date.now() - preflightStart}ms`);
  } catch (err) {
    console.log(`preflight GET failed in ${Date.now() - preflightStart}ms: ${err instanceof Error ? err.message : String(err)}`);
  }

  const targets = await readJobCacheTargets(root);

  const sources: RefreshSource[] = [
    { source: "ashbyhq", slugs: configured(targets.ashby_company_slugs), fetch: () => fetchAshby(configured(targets.ashby_company_slugs)) },
    { source: "lever", slugs: configured(targets.lever_company_slugs), fetch: () => fetchLever(configured(targets.lever_company_slugs)) },
    { source: "greenhouse", slugs: configured(targets.greenhouse_company_slugs), fetch: () => fetchGreenhouse(configured(targets.greenhouse_company_slugs)) },
    { source: "smartrecruiters", slugs: configured(targets.smartrecruiters_company_slugs), fetch: () => fetchSmartRecruiters(configured(targets.smartrecruiters_company_slugs), "") },
  ];

  const now = new Date();
  // Per-source isolation: one source's failure must not cost the other
  // three their refresh. This mattered much less hourly (the next
  // attempt was 60 minutes away); on a Mon/Wed/Fri cadence, letting an
  // Ashby outage abort the run before Greenhouse is even attempted means
  // Greenhouse goes up to ~72h (a missed Friday run) without a refresh
  // for no reason of its own. Failures are collected and re-raised at
  // the end instead of swallowed, so the run still goes red in CI and
  // nothing fails silently: it just fails AFTER everything that could
  // succeed has.
  const failures: string[] = [];
  for (const { source, slugs, fetch } of sources) {
    if (slugs.length === 0) {
      console.log(`${source}: no company slugs configured, skipping`);
      continue;
    }
    try {
      const { jobs } = await fetch();
      // job.company is the slug itself for these four sources (see jobs.ts's
      // fetchAshby/fetchLever/fetchGreenhouse/fetchSmartRecruiters), so this
      // groups fetched postings back by the slug they actually came from.
      const rows = dedupeRows(jobs.map((job) => jobCacheRow(source, job.company, "", job, now)));
      const droppedDupes = jobs.length - rows.length;
      if (droppedDupes > 0) {
        console.log(`${source}: dropped ${droppedDupes} duplicate posting(s) before upsert (same company + job key)`);
      }
      await upsert(url, secretKey, rows);
      console.log(`${source}: cached ${rows.length} postings across ${slugs.length} companies`);
      await warmRedisBrowseAll(source, jobs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${source}: FAILED: ${message}`);
      failures.push(`${source}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length}/${sources.length} source(s) failed:\n  - ${failures.join("\n  - ")}`);
  }
  console.log(`all ${sources.length} sources refreshed successfully`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
