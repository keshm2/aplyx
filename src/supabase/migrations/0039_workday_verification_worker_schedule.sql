-- Schedule for the workday-verification-worker Edge Function
-- (docs/workday-personal-inbox-plan.md). Mirrors 0009's pattern for
-- email-tracking-worker: pg_cron fires the function via pg_net every
-- 5 minutes (verification windows are short — a 30-minute session
-- needs several poll cycles inside it), with a purpose-scoped
-- invocation secret pulled from Vault, NOT the service-role key.
--
-- NOT deployed by this change — the Edge Function itself is not deployed
-- either (see workday-verification-worker/index.ts header). This migration
-- is applied so the schedule exists once the function is deployed with an
-- explicit go-ahead. The cron job references the function by name; if the
-- function isn't deployed yet, the pg_net POST simply fails closed (the
-- function returns 404/502) and no session is advanced — safe by
-- construction, same as 0009's posture before email-tracking-worker's
-- own first deploy.

-- Supabase Vault secrets are created through vault.create_secret(), not a
-- raw INSERT into vault.secrets — that table's `secret` column is
-- encrypted via a trigger create_secret() drives; inserting into it
-- directly fails (confirmed live, 2026-08-30: "Failed to execute
-- statement" on the INSERT this replaced).
select vault.create_secret(
  gen_random_uuid()::text,
  'workday_verification_worker_secret',
  'purpose-scoped invocation secret for the workday-verification-worker pg_cron job'
)
where not exists (select 1 from vault.secrets where name = 'workday_verification_worker_secret');

select cron.schedule(
  'workday-verification-worker',
  '*/5 * * * *',
  $$
    select net.http_post(
      url := current_setting('app.supabase_url') || '/functions/v1/workday-verification-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'workday_verification_worker_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);
