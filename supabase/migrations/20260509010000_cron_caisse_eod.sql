-- 20260509010000_cron_caisse_eod.sql
-- Cash-flow recap at 21:00 Casa = 20:00 UTC, 30 min after the daily_report
-- and 60 min after workers_eod. Focused on caisse + settlements only.

BEGIN;

DO $$ BEGIN
  PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname = 'bot-caisse-eod';
  PERFORM cron.schedule('bot-caisse-eod', '0 20 * * *', $cmd$ select call_bot_cron('caisse_eod'); $cmd$);
END $$;

COMMIT;
