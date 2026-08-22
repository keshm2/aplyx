-- Schedules email-tracking-worker to run every 30 minutes (matches the
-- local scheduler's own cadence, see AGENTS.md). The Authorization value
-- is looked up from Vault by name at execution time -- this migration
-- file itself never contains a real credential, committed or otherwise.
-- The secret it looks up ("cron_worker_secret") is a random value
-- generated specifically for this purpose, seeded via a one-off `supabase
-- db query` call (not part of any migration) -- deliberately NOT the
-- project's service-role key, so this cron job's own credential has no
-- broader reach than "invoke this one function" even if it ever leaked.

select cron.schedule(
  'email-tracking-worker-30min',
  '*/30 * * * *',
  $$
  select net.http_post(
    url := 'https://aedejjesqcbndphkldfs.supabase.co/functions/v1/email-tracking-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_worker_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
