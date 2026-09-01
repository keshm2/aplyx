-- Fixes a real bug found while deploying workday-verification-worker for
-- the first time (2026-08-30): 0039 minted a brand-new Vault secret
-- ("workday_verification_worker_secret") and had the cron job send THAT
-- as x-cron-secret, but the function itself checks
-- Deno.env.get("CRON_SECRET"), the same shared Edge Function secret
-- email-tracking-worker already uses (confirmed by reading
-- workday-verification-worker/index.ts:26). Those are two different
-- values, so every cron invocation would have gotten 401 unauthorized,
-- forever, silently (a failed net.http_post still shows "succeeded" in
-- cron.job_run_details: the SQL command running is not the same as the
-- HTTP call it made succeeding).
--
-- Fix: point the cron job at the same Vault secret 0009's own
-- email-tracking-worker-30min job already uses and has been running
-- successfully against for weeks ("cron_worker_secret"): its value is
-- already provisioned as the CRON_SECRET Edge Function secret, unlike
-- the now-orphaned workday_verification_worker_secret. Re-registering
-- under the same job name replaces the existing schedule rather than
-- creating a duplicate.
--
-- Second bug in the same migration, same root cause (untested SQL):
-- current_setting('app.supabase_url') is not actually configured in
-- this project (confirmed live: NULL); 0009's job hardcodes the literal
-- URL instead, which is what actually works. Matching that here rather
-- than repeating the unset-GUC mistake.

select cron.unschedule('workday-verification-worker');

select cron.schedule(
  'workday-verification-worker',
  '*/5 * * * *',
  $$
    select net.http_post(
      url := 'https://aedejjesqcbndphkldfs.supabase.co/functions/v1/workday-verification-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_worker_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);

-- The mismatched secret this replaces is now unused. Left in place
-- rather than dropped here: deleting a Vault secret is a one-way
-- operation and this migration's job is fixing the cron wiring, not
-- vault housekeeping.
