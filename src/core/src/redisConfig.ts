import fs from "node:fs";
import path from "node:path";

export interface JobCacheRedisConfig {
  url: string;
  readOnlyToken: string;
}

/**
 * Reads src/config/job_cache_redis.json, a read-only Upstash Redis warm
 * layer sitting in front of the shared job_cache Postgres RPC
 * (jobCache.ts's readJobCache, jobCacheRedis.ts's redisGetJobs). No
 * baked-in default here, unlike readSupabaseConfig's hosted-auth
 * project: this repo doesn't ship a working Upstash database out of
 * the box (unlike the maintainer-provisioned Supabase projects), so a
 * missing/placeholder file means the Redis check is skipped entirely
 * and every lookup falls straight through to the existing Postgres
 * path, exactly as if this file didn't exist. Once a real project is
 * provisioned, its URL + a *read-only* REST token go here (or get
 * baked into a future DEFAULT_JOB_CACHE_REDIS_CONFIG the same way
 * DEFAULT_SUPABASE_CONFIG works, if this project wants every install
 * to share one warm cache the way job_cache's Postgres side already
 * does).
 *
 * Deliberately read-only: Upstash tokens are scoped read-only or
 * full-access, not per-command, so there's no way to hand a client a
 * token that can GET but not FLUSHDB/DEL. Every write (the daily
 * eager-warm in refreshJobCache.ts) uses a separate, CI-only,
 * write-capable token read from an env var, never written to a
 * config file, never shipped in a client bundle, exactly the same
 * discipline this codebase already applies to job_cache's Postgres
 * SUPABASE_SECRET_KEY.
 */
export function readJobCacheRedisConfig(root: string): JobCacheRedisConfig | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(root, "src", "config", "job_cache_redis.json"), "utf8"),
    ) as Partial<JobCacheRedisConfig>;
    const url = (parsed.url ?? "").trim();
    const readOnlyToken = (parsed.readOnlyToken ?? "").trim();
    if (!url || !readOnlyToken) return undefined;
    if (url.includes("YOUR-UPSTASH-ENDPOINT") || readOnlyToken === "YOUR_UPSTASH_READ_ONLY_REST_TOKEN") return undefined;
    return { url, readOnlyToken };
  } catch {
    return undefined;
  }
}
