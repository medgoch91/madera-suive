-- Daily backup to Telegram at 02:00 Casablanca (= 01:00 UTC, Morocco no DST).
-- Edge Function jobBackupTelegram dumps every business table to JSON
-- and sends as a document to all bot_subscribers.

-- Drop any previous schedule first so re-runs don't duplicate.
do $$
declare j text;
begin
  for j in select jobname from cron.job where jobname = 'bot-backup-daily' loop
    perform cron.unschedule(j);
  end loop;
end $$;

select cron.schedule('bot-backup-daily', '0 1 * * *', $$select call_bot_cron('backup');$$);
