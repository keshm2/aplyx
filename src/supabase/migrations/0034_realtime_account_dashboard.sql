-- Enables Postgres Changes (Realtime) for the five tables the web account
-- dashboard (src/site/account.html/account.js) mirrors live from the
-- desktop app: profiles, jobs, job_events, applied_jobs, review_queue.
--
-- Without this, a client's supabase.channel(...).on('postgres_changes', ...)
-- subscription silently never fires for these tables — the publication is
-- the thing that actually streams row changes out; RLS (already enabled on
-- every table below since migration 0001) is what then scopes which of
-- those streamed changes a given subscriber's session is allowed to see,
-- unchanged from how it already scopes REST reads. No RLS policy changes
-- needed here — this migration only turns Realtime on for tables that
-- already enforce auth.uid() = user_id.
--
-- Run this file via `supabase db push` or paste it into the Supabase SQL
-- editor — not applied automatically as part of writing this migration.

alter publication supabase_realtime add table public.profiles;
alter publication supabase_realtime add table public.jobs;
alter publication supabase_realtime add table public.job_events;
alter publication supabase_realtime add table public.applied_jobs;
alter publication supabase_realtime add table public.review_queue;
