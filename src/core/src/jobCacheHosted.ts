/**
 * Browser-safe hosted job search over the shared job_cache project.
 *
 * This is the "Tier 0" cached search from docs/hosted-no-agent-tiers-plan.md:
 * a plain `fetch()` against the public job_cache_search RPC, no Node APIs,
 * no local checkout, no LLM. It's what a hosted-only user (signed in, no
 * repo cloned) gets in place of jobs.ts's full local search, which needs
 * Python + a checkout.
 *
 * Deliberately NOT in jobCache.ts: that module imports node:fs / node:path
 * for the local-install config files and can't be pulled into the Tauri
 * webview bundle. This module is the shared implementation the desktop app
 * imports directly; src/site/account.js is a hand-kept parallel copy for
 * the marketing site (which has no bundler to import this).
 */
import type { JobSource, SearchJob } from "./jobsSort.js";

/**
 * The public job_cache project — a separate Supabase project from the auth
 * one (DEFAULT_SUPABASE_CONFIG), holding only non-PII cached postings. The
 * key is a publishable/anon key, safe to bake in exactly like the auth
 * anon key already is. Mirrors src/site/account.js's JOB_CACHE_CONFIG and
 * src/config/job_cache_supabase.example.json.
 */
export const DEFAULT_JOB_CACHE_CONFIG = {
  url: "https://sxxjwzuvplwxivbqtnsx.supabase.co",
  anonKey: "sb_publishable_9mUMbIq28KZ0oHoayOJ1FQ_m7eX2U7f",
} as const;

/**
 * The curated, public company-slug pool the shared cache is refreshed for
 * (.github/workflows/refresh-job-cache.yml). Hand-kept in sync with
 * src/config/job_cache_targets.json (the canonical copy the Python/Node
 * refresh reads from disk) and src/site/assets/job_cache_targets.json (the
 * marketing site's fetched copy). Company slugs only, nothing personal.
 */
export const JOB_CACHE_TARGET_SLUGS: Record<HostedJobSource, string[]> = {
  ashbyhq: [
    "openai", "airwallex", "harvey", "snowflake", "whoop", "clickhouse", "sierra",
    "cohere", "notion", "ramp", "plaid", "replit", "perplexity", "vanta", "thumbtack",
    "clickup", "supabase", "drata", "cognition", "elevenlabs", "linear", "posthog",
  ],
  lever: [
    "spotify", "palantir", "ro", "gopuff", "anchorage", "highspot", "activecampaign",
    "octoenergy", "outreach", "shieldai", "veeva", "zoox",
  ],
  greenhouse: [
    "spacex", "databricks", "stripe", "doordashusa", "datadog", "anthropic", "mongodb",
    "okta", "samsara", "toast", "brex", "cloudflare", "wolt", "oscar", "elastic",
    "pinterest", "scaleai", "reddit", "twilio", "gitlab", "affirm", "airbnb", "asana",
    "discord", "figma", "robinhood",
  ],
  smartrecruiters: [
    "sixt", "wise", "canva", "Docusign", "Dominos", "Equinox", "Visa", "Wayfair",
  ],
};

/** The four cacheable boards (the only sources job_cache holds). */
export type HostedJobSource = "ashbyhq" | "lever" | "greenhouse" | "smartrecruiters";
export const HOSTED_JOB_SOURCES: HostedJobSource[] = ["ashbyhq", "lever", "greenhouse", "smartrecruiters"];

export const HOSTED_JOB_SOURCE_LABELS: Record<HostedJobSource, string> = {
  ashbyhq: "Ashby",
  lever: "Lever",
  greenhouse: "Greenhouse",
  smartrecruiters: "SmartRecruiters",
};

// Same tuned values as src/site/account.js: a typed query pulls more rows
// per company, an empty "browse everything" pull stays small.
const PER_COMPANY_LIMIT_SEARCH = 20;
const PER_COMPANY_LIMIT_BROWSE = 6;

interface JobCacheConfig {
  url: string;
  anonKey: string;
}

interface RawRow {
  company?: string;
  title?: string;
  url?: string;
  apply_url?: string | null;
  external_job_id?: string | null;
  location?: string | null;
  jd_text?: string | null;
  pay_text?: string | null;
  posted_at?: string | null;
}

/**
 * Runs one job_cache_search RPC per source in parallel, merges, and sorts
 * (company then title, same as the website). Never throws: a failed or
 * slow source contributes zero rows rather than failing the whole search
 * ("degrade, don't break", same contract as jobCache.ts).
 *
 * `p_query` is always "" — it is NOT the search filter. job_cache_search
 * matches `jc.query = p_query` exactly against the fetch-mode key a row
 * was cached under, and the refresh writes everything under query=''. The
 * real title filtering happens through `p_title_words` (a loose ILIKE
 * pre-filter in the RPC) plus, in the desktop app, jobs.ts's own
 * authoritative title match on the merged result.
 */
export async function searchHostedJobCache(
  query: string,
  opts: { config?: JobCacheConfig; signal?: AbortSignal; sources?: HostedJobSource[] } = {},
): Promise<SearchJob[]> {
  const config = opts.config ?? DEFAULT_JOB_CACHE_CONFIG;
  const sources = opts.sources ?? HOSTED_JOB_SOURCES;
  const titleWords = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const perCompanyLimit = titleWords.length > 0 ? PER_COMPANY_LIMIT_SEARCH : PER_COMPANY_LIMIT_BROWSE;

  const perSource = await Promise.all(
    sources.map((source) =>
      searchOneSource(config, source, JOB_CACHE_TARGET_SLUGS[source] ?? [], titleWords, perCompanyLimit, opts.signal),
    ),
  );

  const rows = perSource.flat();
  rows.sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title));
  return rows;
}

async function searchOneSource(
  config: JobCacheConfig,
  source: HostedJobSource,
  companySlugs: string[],
  titleWords: string[],
  perCompanyLimit: number,
  signal: AbortSignal | undefined,
): Promise<SearchJob[]> {
  if (companySlugs.length === 0) return [];
  try {
    const response = await fetch(`${config.url}/rest/v1/rpc/job_cache_search`, {
      method: "POST",
      signal,
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_source: source,
        p_company_slugs: companySlugs,
        p_query: "",
        p_per_company_limit: perCompanyLimit,
        p_title_words: titleWords,
      }),
    });
    if (!response.ok) return [];
    const rows = (await response.json()) as RawRow[];
    if (!Array.isArray(rows)) return [];
    return rows.map((row): SearchJob => ({
      source: source as JobSource,
      company: row.company ?? "",
      title: row.title ?? "",
      url: row.url ?? "",
      apply_url: row.apply_url ?? undefined,
      external_job_id: row.external_job_id ?? undefined,
      location: row.location ?? undefined,
      jd_text: row.jd_text ?? undefined,
      pay_text: row.pay_text ?? undefined,
      posted_at: row.posted_at ?? undefined,
    }));
  } catch {
    return [];
  }
}
