-- Fixes narrow queries (e.g. "intern") returning far too few cached
-- results, found live: ashbyhq/lever/greenhouse all correctly reported
-- "ready" with zero matches for an "intern" search, while Amazon (never
-- cached — always live, server-side query-filtered) dominated the page.
--
-- Root cause: job_cache_search's per-company LIMIT (migration 0004) was
-- applied to an ARBITRARY, unordered sample of each company's cached
-- rows — title-relevance filtering only happened afterward, client-side
-- (jobs.ts's titleMatchesQuery), on that already-capped sample. Most
-- companies post far more full-time roles than intern roles, so an
-- unordered top-10 sample of, say, OpenAI's 700+ cached postings could
-- easily contain zero intern-titled ones even though real intern
-- postings exist elsewhere in OpenAI's full cached set for that company.
--
-- Adds a loose ILIKE pre-filter (all of p_title_words must appear as a
-- substring, case-insensitive) applied INSIDE the lateral join, before
-- the per-company LIMIT — so the rows a company contributes are already
-- relevant candidates, not a random pre-filter sample most of which
-- gets discarded. This is intentionally loose, not a replacement for
-- jobs.ts's titleMatchesQuery (which is inflection-aware and does exact
-- per-word matching on the final merged/deduped result set) — it just
-- has to be good enough that a real match isn't excluded before that
-- precise filter ever sees it. p_title_words = '{}' (the default —
-- browsing with no query typed) skips filtering entirely, unchanged
-- from before.
--
-- Run this file via `supabase db push` or paste it into the Supabase
-- SQL editor — NOT done automatically as part of writing this migration.

drop function if exists public.job_cache_search(text, text[], text, int);

create or replace function public.job_cache_search(
  p_source text,
  p_company_slugs text[],
  p_query text default '',
  p_per_company_limit int default 75,
  p_title_words text[] default '{}'
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
      and (
        p_title_words = '{}'::text[]
        or not exists (
          select 1 from unnest(p_title_words) as w
          where jc.title not ilike '%' || w || '%'
        )
      )
    limit p_per_company_limit
  ) jc;
$$;

grant execute on function public.job_cache_search(text, text[], text, int, text[]) to anon, authenticated;
