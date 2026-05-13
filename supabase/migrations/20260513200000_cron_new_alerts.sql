-- 20260513200000_cron_new_alerts.sql
-- 4 new bot notifications requested 2026-05-13:
--   • overdue_cheques  — every day 09h Casa = 08:00 UTC
--   • upcoming_cheques — every day 09h Casa = 08:00 UTC
--   • stock_critical   — every day 08h Casa = 07:00 UTC (with cheques_due_morning)
--   • weekly_digest    — every Sunday 19h Casa = 18:00 UTC
--
-- All four hit the existing public.call_bot_cron(p_job) helper which forwards
-- to the telegram-bot Edge Function with the x-cron-secret header. Safe to
-- re-run — unschedule first then schedule.

BEGIN;

-- Idempotent removal so re-runs don't double-fire
SELECT cron.unschedule('bot-overdue-cheques')   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='bot-overdue-cheques');
SELECT cron.unschedule('bot-upcoming-cheques')  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='bot-upcoming-cheques');
SELECT cron.unschedule('bot-stock-critical')    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='bot-stock-critical');
SELECT cron.unschedule('bot-weekly-digest')     WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='bot-weekly-digest');

-- Schedules
SELECT cron.schedule('bot-overdue-cheques',  '0 8 * * *',  $$select call_bot_cron('overdue_cheques');$$);
SELECT cron.schedule('bot-upcoming-cheques', '0 8 * * *',  $$select call_bot_cron('upcoming_cheques');$$);
SELECT cron.schedule('bot-stock-critical',   '0 7 * * *',  $$select call_bot_cron('stock_critical');$$);
SELECT cron.schedule('bot-weekly-digest',    '0 18 * * 0', $$select call_bot_cron('weekly_digest');$$);

COMMIT;
