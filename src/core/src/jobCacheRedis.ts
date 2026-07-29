import zlib from "node:zlib";
import { promisify } from "node:util";
import type { JobSource, SearchJob } from "./jobsSort.js";
import type { JobCacheRedisConfig } from "./redisConfig.js";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * A slow/hung Redis must never delay falling through to the existing
 * Postgres path (its own CACHE_LOOKUP_TIMEOUT_MS budget of 1200ms in
 * jobCache.ts) — this stays well under that, so the two timeouts can
 * never stack into a search-visible delay the way an earlier version
 * of the Postgres-vs-live fallback bug did (see jobs.ts's maybeCached
 * comment on withDeadline).
 *
 * 900, not something tighter: measured live from a cold, one-shot Node
 * process (the same shape every real search spawns, per bridge.ts) —
 * 5 consecutive cold runs against a real ~180-row/300KB compressed
 * payload landed at 232-265ms, but one outlier (likely a cold DNS
 * resolution) hit 435ms. A timeout right at the typical case only
 * buys ~2x margin and risks a spurious "miss" (silently falling
 * through to the slower Postgres path) on ordinary network jitter,
 * not just a genuinely broken Redis — the whole point of this cache
 * is for the fast path to actually fire. 900 keeps real margin over
 * the observed outlier while still leaving Postgres's own fallback
 * budget untouched (500 + 1200 well under any total search deadline
 * elsewhere in the pipeline).
 */
export const REDIS_LOOKUP_TIMEOUT_MS = 900;

/** Bump to v2 to invalidate every cached entry at once (a row-shape or
 *  per-company-cap change) without a manual flush. */
const KEY_VERSION = "v1";

/**
 * Only the unfiltered "browse everything" case is cached — see
 * jobCache.ts's own tuning comments for why a filtered query is
 * already fast enough (~77-103ms, the RPC's ILIKE pre-filter narrows
 * rows before the expensive jd_text materialization happens) that a
 * cache layer buys little there. The browse-all case is the one that
 * measured 232-655ms and is what this key always addresses.
 */
export function jobCacheRedisKey(source: JobSource): string {
  return `jobcache:${KEY_VERSION}:${source}:`;
}

async function upstashCommand(url: string, token: string, command: unknown[], timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { result?: unknown };
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Client-side, read-only lookup. Returns undefined — never throws —
 * on a miss, timeout, network error, malformed payload, or empty
 * result, exactly mirroring readJobCache's own "cache is always
 * optional, live/Postgres fallback is the safety net" contract. An
 * empty array is treated the same as a miss (never "here are zero
 * jobs") for the same reason readJobCache already documents that
 * invariant.
 */
export async function redisGetJobs(
  config: JobCacheRedisConfig,
  source: JobSource,
  timeoutMs: number = REDIS_LOOKUP_TIMEOUT_MS,
): Promise<SearchJob[] | undefined> {
  try {
    const key = jobCacheRedisKey(source);
    const result = await upstashCommand(config.url, config.readOnlyToken, ["GET", key], timeoutMs);
    if (typeof result !== "string" || result.length === 0) return undefined;
    const decompressed = await gunzip(Buffer.from(result, "base64"));
    const jobs = JSON.parse(decompressed.toString("utf8")) as SearchJob[];
    if (!Array.isArray(jobs) || jobs.length === 0) return undefined;
    return jobs;
  } catch {
    return undefined;
  }
}

/**
 * CI-only write path — refreshJobCache.ts is the sole caller, holding
 * a write-capable Upstash token from an env var (never a config file,
 * never shipped to a client — same discipline as SUPABASE_SECRET_KEY).
 * Never throws: a failed warm just means the next read falls through
 * to Postgres, same as any other cache miss.
 */
export async function redisSetJobs(
  url: string,
  writeToken: string,
  source: JobSource,
  jobs: SearchJob[],
  ttlSeconds: number,
): Promise<void> {
  try {
    const key = jobCacheRedisKey(source);
    const compressed = await gzip(Buffer.from(JSON.stringify(jobs), "utf8"));
    const value = compressed.toString("base64");
    await upstashCommand(url, writeToken, ["SET", key, value, "EX", String(ttlSeconds)], REDIS_LOOKUP_TIMEOUT_MS * 4);
  } catch {
    // best-effort warm — a miss just means the next read pays the
    // existing Postgres RPC cost, not a broken search
  }
}
