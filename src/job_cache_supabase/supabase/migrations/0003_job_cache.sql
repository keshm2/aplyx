-- aplyx shared job-postings cache — proposed, not yet applied.
--
-- A shared, cross-user cache of raw fetched postings, keyed by
-- (source, company_slug, query) — NOT by user. This is distinct from
-- public.jobs (migration 0001): that table is a per-user status ledger
-- (new/seen/applied/...) mirroring data/job_registry.json; this table
-- caches the *posting itself* so a live per-source fetch (Ashby/Lever/
-- Greenhouse/SmartRecruiters/Amazon/Oracle/Workday) can be skipped when a
-- fresh-enough cached row already exists. Postings are generic —
-- fit-gating against a specific user's profile happens locally, after
-- the fetch (scripts/jobs/evaluate_job_fit.py) — so one cached fetch can
-- validly serve every user searching the same source/company/query.
--
-- Populated ONLY by a trusted backend refresh job using the service_role
-- key, which bypasses RLS entirely — never insert/update/delete this
-- table with the anon or an authenticated user's key. That refresh job
-- doesn't exist yet; see the usage instructions for what it needs to do.
--
-- Readable by anyone, signed in or not: unlike every other table in this
-- schema (RLS scoped to auth.uid() = user_id), this one intentionally
-- allows public SELECT, because cached postings aren't personal data.
-- Run this file via `supabase db push` or paste it into the Supabase SQL
-- editor — NOT done automatically as part of writing this migration.

create extension if not exists vector;

create table if not exists public.job_cache (
  id uuid primary key default gen_random_uuid(),

  -- Cache key — mirrors config/targets.json's shape, not a user id.
  source text not null,               -- 'ashbyhq' | 'lever' | 'greenhouse' | 'smartrecruiters' | 'amazon' | 'oracle' | 'workday'
  company_slug text not null,         -- the source-specific board/company identifier
  query text not null default '',     -- normalized search query ('' = unfiltered board listing)

  -- Posting fields — same vocabulary as scripts/state/job_state.py's
  -- canonicalize() and public.jobs, so mapping between the two is direct.
  job_key text not null,
  external_job_id text,
  company text not null,
  title text not null,
  location text,
  location_tier text,
  url text not null,
  apply_url text,
  normalized_url text,
  ats_system text,
  posted_at timestamptz,
  jd_text text,

  -- Embedding over title + company + location (NOT jd_text — keeps
  -- embedding cost/latency low and is enough for query-relevance
  -- ranking/semantic dedup). vector(384) assumes a small model like
  -- all-MiniLM-L6-v2; this is a placeholder — pick the real model before
  -- applying this migration and match the dimension to it exactly
  -- (pgvector requires a fixed dimension per column). Optional: leave
  -- every row's embedding null and this table still works as a plain
  -- TTL cache — nothing else here depends on it.
  embedding vector(384),

  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),

  unique (source, company_slug, query, job_key)
);

alter table public.job_cache enable row level security;

-- The one deliberate departure from this schema's auth.uid() = user_id
-- pattern: any client — signed in or not — can read a non-expired row.
create policy "job_cache_select_all" on public.job_cache
  for select using (expires_at > now());

-- No insert/update/delete policy for anon or authenticated roles. Writes
-- only happen via the service_role key (server-side refresh job only —
-- never ship this key to the TUI, desktop app, or any client bundle).

create index if not exists job_cache_lookup_idx
  on public.job_cache (source, company_slug, query);
create index if not exists job_cache_expires_idx
  on public.job_cache (expires_at);
create index if not exists job_cache_embedding_idx
  on public.job_cache using hnsw (embedding vector_cosine_ops);
