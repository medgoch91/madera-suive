-- 20260504040000_cron_daily_report.sql
-- Schedule the comprehensive end-of-day digest 30 min after the per-worker
-- digest so the user can read both consecutively. Casa is UTC+1 → 20:30
-- Casa = 19:30 UTC.

BEGIN;

DO $$
DECLARE
  v_cron_secret TEXT;
  v_supa_url    TEXT;
BEGIN
  -- Reuse the same project URL + secret already used by the existing
  -- workers_eod / cheques cron jobs. Look them up from Vault if available;
  -- otherwise fall back to the literal values used elsewhere.
  v_supa_url := COALESCE(
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url'),
    'https://tpjrzgubttpqtxieioxe.supabase.co'
  );
  v_cron_secret := COALESCE(
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'),
    'Gs_6p8sTlGKP77x0BzO9Gq90j23hLFTGTazRnauBzW0'
  );

  -- Drop any prior schedule with the same name (idempotent migration).
  PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname = 'bot-daily-report';

  PERFORM cron.schedule(
    'bot-daily-report',
    '30 19 * * *',  -- 19:30 UTC = 20:30 Casa
    format(
      $cmd$
      SELECT net.http_post(
        url     := %L,
        headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', %L),
        body    := '{}'::jsonb
      );
      $cmd$,
      v_supa_url || '/functions/v1/telegram-bot?cron=daily_report',
      v_cron_secret
    )
  );
END $$;

COMMIT;
