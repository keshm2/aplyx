-- Hard 45-day age cap on job_cache (2026-09-07).
--
-- Operator rule: a job posting older than 45 days is dropped from the
-- database and never appears in a cached search result. "Age" is the
-- posting's own `posted_at` when the source provides it, else `fetched_at`
-- (when aplyx first cached it — never rewritten on re-fetch, so it's a
-- stable first-sighting timestamp).
--
-- This overrides migration 0006's "append-and-extend only, nothing is
-- ever deleted" stance: `cleanup_job_cache()` below is the deliberate,
-- explicit prune 0006's own comment said to add if reclaiming ever
-- became necessary. It has (48k rows, 56% already expired, ~11k over
-- 45 days old at the time of this migration).
--
-- Run via `supabase db push` or the SQL editor; NOT applied automatically.

-- --- read path: never serve a posting past the age cap ---------------

drop policy if exists "job_cache_select_all" on public.job_cache;
create policy "job_cache_select_all" on public.job_cache
  for select using (
    expires_at > now()
    and coalesce(posted_at, fetched_at) > now() - interval '45 days'
  );

-- job_cache_search is a plain `stable` SQL function (not SECURITY
-- DEFINER), so the RLS policy above already applies inside it — but it
-- also carries its own explicit filters, so keep them in sync.
drop function if exists public.job_cache_search(text, text[], text, int, text[]);
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
      and coalesce(jc.posted_at, jc.fetched_at) > now() - interval '45 days'
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

-- --- prune ----------------------------------------------------------

-- Drops anything past the 45-day age cap, plus anything that has been
-- expired (invisible to readers) for more than 14 days — reclaiming the
-- lingering-lapsed rows 0006 knowingly left on disk. Returns the count.
-- Called by refreshJobCache.ts at the end of each Mon/Wed/Fri run (that
-- job already holds the service_role key); this project has no pg_cron.
create or replace function public.cleanup_job_cache()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  delete from public.job_cache
  where coalesce(posted_at, fetched_at) < now() - interval '45 days'
     or expires_at < now() - interval '14 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.cleanup_job_cache() from public, anon, authenticated;
grant execute on function public.cleanup_job_cache() to service_role, postgres;

create index if not exists job_cache_age_idx
  on public.job_cache ((coalesce(posted_at, fetched_at)));
