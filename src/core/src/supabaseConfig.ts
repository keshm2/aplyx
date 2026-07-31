import fs from "node:fs";
import path from "node:path";

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

/**
 * aplyx's own hosted-auth Supabase project — the backend "Sign in / Sync
 * across devices" on the desktop app's entry screen actually talks to.
 * An anon key is meant to be public (every Supabase web/mobile app ships
 * one in its client bundle; access control is Row Level Security on the
 * backend, not secrecy of this key), so baking it in here is the normal,
 * correct way to do this — the alternative, requiring every end user to
 * stand up their own Supabase project just to click "Sign in," is what
 * was actually shipping: src/config/supabase.json is gitignored and reaches
 * no distribution channel (git tarball, npm package, or the desktop
 * app's bundled resources all exclude it), so literally every install
 * outside this maintainer's own dev machine hit the "isn't set up yet"
 * dead end. `readSupabaseConfig` below still checks for a local
 * src/config/supabase.json first — self-hosters who want their own backend
 * still get to override this, same as before.
 */
export const DEFAULT_SUPABASE_CONFIG: SupabaseConfig = {
  url: "https://aedejjesqcbndphkldfs.supabase.co",
  anonKey: "sb_publishable_d3pJdWv70x7tYbDEWoGkFw_HCUpS1_i",
};

/**
 * Reads src/config/supabase.json — a live, gitignored, *local override* of
 * DEFAULT_SUPABASE_CONFIG above (src/config/supabase.example.json is the
 * committed placeholder template, same convention as every other
 * src/config/*.example.json file) — and falls back to the baked-in default
 * when it's missing or still holds the example placeholders. Every real
 * install gets working hosted sign-in against aplyx's own backend without
 * any setup; a self-hoster who wants a different backend still can by
 * dropping their own src/config/supabase.json in.
 */
export function readSupabaseConfig(root: string): SupabaseConfig {
  return readSupabaseConfigFile(root, "supabase.json") ?? DEFAULT_SUPABASE_CONFIG;
}

/**
 * Reads src/config/job_cache_supabase.json — a deliberately separate project
 * from src/config/supabase.json's (hosted auth/profile sync). Split apart
 * 2026-07-23 after the auth project's disk I/O usage climbed toward its
 * free-tier limit (partly from job_cache's own write volume — ~14k rows
 * across 47 companies, refreshed hourly at the time — daily since
 * 2026-07-30) and started producing Cloudflare
 * 522s on unrelated requests; the two workloads no longer share one
 * project's resource ceiling. job_cache holds no personal data (see
 * src/job_cache_supabase/supabase/migrations/0003_job_cache.sql's RLS comment), so this project
 * doesn't need to be the same one hosted auth uses — jobCache.ts and
 * refreshJobCache.ts are the only callers, both entirely independent of
 * the desktop app's SupabaseAdapter/auth flow, which still reads
 * readSupabaseConfig() above unchanged.
 */
export function readJobCacheSupabaseConfig(root: string): SupabaseConfig | undefined {
  return readSupabaseConfigFile(root, "job_cache_supabase.json");
}

function readSupabaseConfigFile(root: string, filename: string): SupabaseConfig | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(root, "src", "config", filename), "utf8"),
    ) as Partial<SupabaseConfig>;
    const url = (parsed.url ?? "").trim();
    const anonKey = (parsed.anonKey ?? "").trim();
    if (!url || !anonKey) return undefined;
    if (url.includes("YOUR_PROJECT_REF") || anonKey === "YOUR_SUPABASE_ANON_KEY") return undefined;
    return { url, anonKey };
  } catch {
    return undefined;
  }
}
