// Telegram bot webhook + scheduled-job entry point.
// Incoming requests:
//   POST /functions/v1/telegram-bot          → Telegram webhook update
//   POST /functions/v1/telegram-bot?cron=X   → pg_cron trigger for job X

import { parseCommand, answerCallbackQuery, type TgUpdate } from '../_shared/tg.ts';
import {
  cmdStart, cmdSubscribe, cmdUnsubscribe, cmdTestPush,
  cmdToday, cmdBalance, cmdStock, cmdListBons, cmdCancel, cmdKhlas, cmdCaisse, cmdKhlasPay,
} from './commands.ts';
import { startNewBon, startCheque, handleConvMessage } from './conversations.ts';
import {
  jobChequesDueMorning, jobChequesTodayPing,
  jobWorkersEod, jobMonthlyReport, jobDailyReport, jobCaisseEod,
  jobBackupTelegram, jobBackupGdrive, jobBackupFtp, jobBackupAll,
  debugWorkerBreakdown, debugWorkersEodText,
} from './jobs.ts';
import { handleChequeCallback, handleKhlasCallback } from './callbacks.ts';

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const cronJob = url.searchParams.get('cron');
  const debugWorker = url.searchParams.get('debug_worker');

  // Authenticated debug — returns a JSON breakdown of one worker's cumulative
  // payable so we can reconcile the bot's number against what the app shows.
  if (debugWorker) {
    const secret = req.headers.get('x-cron-secret');
    const expected = Deno.env.get('CRON_SECRET');
    if (!expected || secret !== expected) {
      return new Response('unauthorized', { status: 401 });
    }
    const payload = await debugWorkerBreakdown(debugWorker);
    return new Response(JSON.stringify(payload, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.searchParams.get('debug_text') === '1') {
    const secret = req.headers.get('x-cron-secret');
    const expected = Deno.env.get('CRON_SECRET');
    if (!expected || secret !== expected) return new Response('unauthorized', { status: 401 });
    const t = await debugWorkersEodText();
    return new Response(t, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

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
      case 'daily_report':        return await jobDailyReport();
      case 'caisse_eod':          return await jobCaisseEod();
      case 'monthly_report':      return await jobMonthlyReport();
      case 'backup':              return await jobBackupAll();          // Telegram + Drive + FTP
      case 'backup_telegram':     return await jobBackupTelegram();     // for ad-hoc testing
      case 'backup_gdrive':       return await jobBackupGdrive();       // for ad-hoc testing
      case 'backup_ftp':          return await jobBackupFtp();          // for ad-hoc testing
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
    } else if (data.startsWith('KHLAS_')) {
      await handleKhlasCallback(update.callback_query);
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
      case 'khlas':       return await cmdKhlas(msg, parsed.args);
      case 'baqi':        return await cmdKhlas(msg, parsed.args);
      case 'wages':       return await cmdKhlas(msg, parsed.args);
      case 'caisse':      return await cmdCaisse(msg);
      case 'khlaspay':    return await cmdKhlasPay(msg, parsed.args);
      case 'khlas-pay':   return await cmdKhlasPay(msg, parsed.args);
      case 'pay':         return await cmdKhlasPay(msg, parsed.args);
      case 'stock':       return await cmdStock(msg, parsed.args);
      case 'listbons':    return await cmdListBons(msg);
      case 'newbon':      return await startNewBon(msg);
      case 'cheque':      return await startCheque(msg);
      case 'cancel':      return await cmdCancel(msg);
    }
  }

  await handleConvMessage(msg);
}
