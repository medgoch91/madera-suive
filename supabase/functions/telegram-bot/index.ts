// Telegram bot webhook + scheduled-job entry point.
// Incoming requests:
//   POST /functions/v1/telegram-bot          → Telegram webhook update
//   POST /functions/v1/telegram-bot?cron=X   → pg_cron trigger for job X

import { parseCommand, answerCallbackQuery, type TgUpdate } from '../_shared/tg.ts';
import {
  cmdStart, cmdSubscribe, cmdUnsubscribe, cmdTestPush,
  cmdToday, cmdBalance, cmdStock, cmdListBons, cmdCancel,
} from './commands.ts';
import { startNewBon, startCheque, handleConvMessage } from './conversations.ts';
import {
  jobChequesDueMorning, jobChequesTodayPing,
  jobWorkersEod, jobMonthlyReport,
} from './jobs.ts';
import { handleChequeCallback } from './callbacks.ts';

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const cronJob = url.searchParams.get('cron');

  if (cronJob) {
    const secret = req.headers.get('x-cron-secret');
    const expected = Deno.env.get('CRON_SECRET');
    if (!expected || secret !== expected) {
      return new Response('unauthorized', { status: 401 });
    }
    switch (cronJob) {
      case 'cheques_due_morning': return await jobChequesDueMorning();
      case 'cheques_today_ping':  return await jobChequesTodayPing();
      case 'workers_eod':         return await jobWorkersEod();
      case 'monthly_report':      return await jobMonthlyReport();
      default:
        return new Response(JSON.stringify({ error: 'unknown cron job', cronJob }), { status: 400 });
    }
  }

  if (req.method !== 'POST') {
    return new Response('telegram-bot: POST webhook updates only', { status: 200 });
  }

  let update: TgUpdate;
  try { update = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  try { await route(update); } catch (e) { console.error('route error', e); }
  return new Response('ok', { status: 200 });
});

async function route(update: TgUpdate): Promise<void> {
  if (update.callback_query) {
    const data = update.callback_query.data ?? '';
    if (data.startsWith('CHQPAID:') || data.startsWith('CHQUNPAID:') || data.startsWith('CHQDEFER:')) {
      await handleChequeCallback(update.callback_query);
    } else {
      await answerCallbackQuery(update.callback_query.id);
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.chat) return;

  const parsed = parseCommand(msg.text);
  if (parsed) {
    switch (parsed.cmd) {
      case 'start':       return await cmdStart(msg);
      case 'help':        return await cmdStart(msg);
      case 'subscribe':   return await cmdSubscribe(msg);
      case 'unsubscribe': return await cmdUnsubscribe(msg);
      case 'testpush':    return await cmdTestPush(msg);
      case 'today':       return await cmdToday(msg);
      case 'balance':     return await cmdBalance(msg);
      case 'stock':       return await cmdStock(msg, parsed.args);
      case 'listbons':    return await cmdListBons(msg);
      case 'newbon':      return await startNewBon(msg);
      case 'cheque':      return await startCheque(msg);
      case 'cancel':      return await cmdCancel(msg);
    }
  }

  await handleConvMessage(msg);
}
