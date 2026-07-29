/**
 * Populates the shared Supabase job_cache table (see
 * supabase/migrations/0003_job_cache.sql) so searchJobs()'s cache checks
 * (jobCache.ts) actually have something to hit. NOT part of this
 * package's public export surface (see package.json's "exports" map —
 * this file is deliberately absent from it) and never imported by any
 * TUI/desktop entry point, so it never ships inside src/tui/'s bundled CLI
 * or the desktop app's Node subprocess bridge.
 *
 * Run standalone, holding the Supabase secret key (Project Settings →
 * API Keys → "Secret keys" — sb_secret_..., the current replacement for
 * the legacy service_role JWT; authorizes via the same service_role
 * Postgres role and still sets BYPASSRLS, so it bypasses RLS identically.
 * This is the only thing in the whole codebase that should ever hold
 * that key; it must never reach src/config/job_cache_supabase.json, a
 * client bundle, or any file that gets committed):
 *
 *   SUPABASE_SECRET_KEY=sb_secret_... node src/core/dist/refreshJobCache.js
 *
 * Locally, the project URL comes from src/config/job_cache_supabase.json —
 * its own project, deliberately separate from src/config/supabase.json
 * (hosted auth/profile sync). Split apart 2026-07-23: the two workloads
 * were sharing one project's disk I/O budget, and job_cache's own write
 * volume (~14k rows across 47 companies, refreshed hourly) pushed it
 * toward the free-tier limit, producing Cloudflare 522s on unrelated
 * requests. See supabaseConfig.ts's readJobCacheSupabaseConfig for the
 * full reasoning. In CI (.github/workflows/refresh-job-cache.yml, hourly
 * — under job_cache's 2h TTL) that file doesn't exist on a fresh
 * checkout, so SUPABASE_URL is read as a direct override first — not
 * secret, just the project's own URL, stored as a plain repo secret
 * alongside SUPABASE_SECRET_KEY for convenience.
 *
 * Refreshes the four sources that support a full, unfiltered board fetch
 * — Ashby, Lever, Greenhouse, SmartRecruiters — using
 * src/config/job_cache_targets.json's company slugs. That file is
 * deliberately separate from src/config/targets.json (gitignored, holds this
 * operator's personal profile/PII) — it's committed, so a CI checkout
 * can see it, and it must only ever hold company slugs. Every row is
 * written under query='' (see jobCache.ts's header for why: query-string
 * matching happens downstream against the merged result set, identically
 * whether a job came from cache or a live fetch).
 *
 * Amazon/Oracle/Workday are Python-backed and query-parameterized (their
 * APIs don't offer a "list everything" mode the way the four above do —
 * see jobs.ts's fetchAmazon/fetchOracle/fetchWorkday) — deliberately
 * left out of this first pass rather than guessing at a query set to
 * seed them with. searchJobs() already skips the cache check for those
 * three entirely (see maybeCached's call sites in jobs.ts), so this gap
 * is inert, not silently broken.
 *
 * Also eagerly warms a Redis browse-all entry per source right after
 * its Postgres upsert succeeds (see jobCacheRedis.ts, jobCache.ts's
 * readJobCache) — the single most common no-query "just show me
 * openings" case is then warm immediately after every refresh instead
 * of waiting for the first post-refresh search to populate it lazily
 * (which a client can't do anyway: Redis writes need a write-capable
 * token, and this script is the only thing that should ever hold one).
 * Needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_WRITE_TOKEN as env
 * vars (same discipline as SUPABASE_SECRET_KEY — never a config file,
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

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // matches job_cache's own column default (2h) — kept explicit here so upserts refresh it, not just inserts.

// 75 minutes: just past the hourly refresh cadence (15min grace so one
// slow/failed CI run doesn't let the warm entry go fully cold before
// the next one lands), while staying well under job_cache's own 2h
// Postgres expires_at — a served-at-expiry Redis entry can never be
// staler than Postgres would already allow. Shorter buys no real
// freshness (the underlying data only changes once an hour anyway) and
// only throws away hit rate.
const REDIS_WARM_TTL_SECONDS = 75 * 60;

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
    fetched_at: now.toISOString(),
    expires_at: new Date(now.getTime() + CACHE_TTL_MS).toISOString(),
  };
}

// A single source's rows can be huge — measured live, 20 greenhouse
// companies (spacex/databricks/etc.) produced 8,201 rows and a 75MB JSON
// body in one shot, which is almost certainly what actually hung a real
// CI run rather than erroring: a request that size either exceeds
// Supabase's gateway payload limit outright, or is just slow enough
// upserting 8,000+ rows with conflict resolution in one transaction to
// look indistinguishable from hung. Chunking keeps each request small
// and bounded, and gives per-chunk progress instead of one long silence.
//
// Dropped 200 -> 50 after the previous Supabase project reported disk
// I/O nearing its usage limit (free tier: 0.5 CPU/1GB — cumulative
// migrations, the original manual refresh, and repeated retried CI
// attempts all added up there); dropped again, 50 -> 25, as an extra
// safety margin on the fresh replacement project, even though a brand
// new project shouldn't carry that same accumulated I/O history. A 522
// "connection timed out" at the Cloudflare layer, on requests as cheap
// as a single-row SELECT, fit I/O-starved Postgres becoming unresponsive
// to new connections better than a payload-size problem — smaller
// chunks alone don't fix that (same total bytes written either way);
// UPSERT_INTER_CHUNK_DELAY_MS below is what actually matters, spreading
// writes out over time instead of shrinking them.
const UPSERT_CHUNK_SIZE = 25;
// Applied between every chunk, not just on retry — the point is
// spreading write pressure out over time so Postgres gets room to
// flush/checkpoint between transactions, not just making individual
// requests smaller.
const UPSERT_INTER_CHUNK_DELAY_MS = 1_500;
// The first real CI run aborted on the very first 200-row chunk (~1.8MB)
// at the old 30s timeout, before any progress had even been logged —
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
    // apikey + an *identical* Authorization: Bearer value — the new key
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
      // Truncated — a non-2xx from the Supabase edge is sometimes a full
      // Cloudflare HTML error page (confirmed live: a 522 "connection
      // timed out" response body ran 100+ lines), not worth dumping
      // whole into CI logs on every retry.
      const body = (await response.text()).slice(0, 300);
      throw new Error(`job_cache upsert failed: HTTP ${response.status} — ${body}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// 4 attempts, exponential backoff (2s/5s/10s between). Bumped up from a
// single 1s-backoff retry after a live run hit HTTP 522 "connection
// timed out between Cloudflare and the origin" on both the first
// attempt AND that one retry, ~20s apart — whatever this is (transient
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
 * (query='', no title words) lookup — grouped by company, capped at
 * UNFILTERED_PER_COMPANY_LIMIT per company — so the Redis-cached value
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
 * Eager warm, not lazy populate — the only Redis write path in the
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
    console.log(`${source}: UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_WRITE_TOKEN not set — skipping Redis warm`);
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
    console.error("SUPABASE_SECRET_KEY is not set — refusing to run. This must never live in a file.");
    process.exit(1);
  }
  const root = findProjectRoot();
  // SUPABASE_URL overrides src/config/supabase.json when set (CI has no such
  // file on a fresh checkout — see this file's header). Locally, neither
  // set, falls back to the same config file the desktop app reads.
  const url = process.env.SUPABASE_URL || readJobCacheSupabaseConfig(root)?.url;
  if (!url) {
    console.error("Neither SUPABASE_URL nor a configured src/config/supabase.json was found — nothing to refresh against.");
    process.exit(1);
  }
  // Diagnostic preflight — added after 3 consecutive live CI runs all
  // failed the same way (every upsert attempt, including retries with
  // real exponential backoff, hit HTTP 522 "connection timed out
  // between Cloudflare and the origin"). This isolates whether it's
  // GitHub Actions' network path to this Supabase project failing
  // entirely (reads too) or something specific to the write/POST path —
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
  for (const { source, slugs, fetch } of sources) {
    if (slugs.length === 0) {
      console.log(`${source}: no company slugs configured, skipping`);
      continue;
    }
    const { jobs } = await fetch();
    // job.company is the slug itself for these four sources (see jobs.ts's
    // fetchAshby/fetchLever/fetchGreenhouse/fetchSmartRecruiters), so this
    // groups fetched postings back by the slug they actually came from.
    const rows = jobs.map((job) => jobCacheRow(source, job.company, "", job, now));
    await upsert(url, secretKey, rows);
    console.log(`${source}: cached ${rows.length} postings across ${slugs.length} companies`);
    await warmRedisBrowseAll(source, jobs);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
