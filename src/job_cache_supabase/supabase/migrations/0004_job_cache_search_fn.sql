-- Per-company-capped job_cache reads — fixes a real fairness bug found
-- while load-testing 0003_job_cache.sql live: a plain
-- `company_slug=in.(...)&limit=N` query returns Postgres's first N rows
-- across ALL matching companies combined, in whatever order the planner
-- picks (in practice: index/scan order) — with several companies per
-- source and hundreds of cached postings each, this let 1-2 companies
-- fill the entire row cap and left the rest of a source's companies with
-- ZERO returned postings, even though real cached rows existed for them.
-- A global LIMIT is fundamentally the wrong tool here; this needs a
-- per-company LIMIT, which a lateral join gives cleanly and lets
-- Postgres push the limit down through the (source, company_slug, query)
-- index (job_cache_lookup_idx, migration 0003) per company — measured
-- live: ~150-200ms for a real multi-company batch, vs. 1-1.5s for the
-- equivalent fairness via N separate per-company requests.
--
-- security invoker (the default — no `security definer` here) so this
-- function is subject to job_cache's existing RLS policy
-- (job_cache_select_all, expires_at > now()) exactly like a direct
-- SELECT — no privilege escalation, same anon-readable contract.
--
-- Run this file via `supabase db push` or paste it into the Supabase SQL
-- editor — NOT done automatically as part of writing this migration.

create or replace function public.job_cache_search(
  p_source text,
  p_company_slugs text[],
  p_query text default '',
  p_per_company_limit int default 75
)
returns setof public.job_cache
language sql
stable
as $$
  select jc.*
  from unnest(p_company_slugs) as t(company_slug)
  cross join lateral (
    select *
    from public.job_cache jc
    where jc.source = p_source
      and jc.company_slug = t.company_slug
      and jc.query = p_query
      and jc.expires_at > now()
    limit p_per_company_limit
  ) jc;
$$;

-- Functions aren't executable by anon/authenticated by default — this is
-- the read-only counterpart to job_cache's public SELECT policy.
grant execute on function public.job_cache_search(text, text[], text, int) to anon, authenticated;
