-- Enable pg_cron + pg_net so we can schedule HTTP calls to the Edge Function
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Helper: fire the telegram-bot function with a given cron job name.
-- pg_net.http_post is async — returns a request id immediately.
create or replace function public.call_bot_cron(p_job text)
returns bigint
language plpgsql
security definer
as $$
declare req_id bigint;
begin
  select net.http_post(
    url := 'https://tpjrzgubttpqtxieioxe.supabase.co/functions/v1/telegram-bot?cron=' || p_job,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', 'Gs_6p8sTlGKP77x0BzO9Gq90j23hLFTGTazRnauBzW0'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) into req_id;
  return req_id;
end;
$$;

-- Schedule the five jobs. All times are UTC in pg_cron; Casablanca is
-- UTC+1 most of the year, so 08h Casa = 07h UTC.
-- Unschedule first so re-running the migration doesn't duplicate jobs.
do $$
declare j text;
begin
  for j in select jobname from cron.job where jobname like 'bot-%' loop
    perform cron.unschedule(j);
  end loop;
end $$;

select cron.schedule('bot-cheques-morning', '0 7 * * *',  $$select call_bot_cron('cheques_due_morning');$$);
select cron.schedule('bot-cheques-ping-16', '0 15 * * *', $$select call_bot_cron('cheques_today_ping');$$);
select cron.schedule('bot-cheques-ping-18', '0 17 * * *', $$select call_bot_cron('cheques_today_ping');$$);
select cron.schedule('bot-workers-eod',     '0 19 * * *', $$select call_bot_cron('workers_eod');$$);
select cron.schedule('bot-monthly',         '0 8 1 * *',  $$select call_bot_cron('monthly_report');$$);
