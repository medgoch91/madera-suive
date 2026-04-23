// Scheduled jobs — invoked by pg_cron via ?cron=<name>
// Each job fans out to: every chat_id in bot_subscribers + every web push
// subscription. Keeps the wording close to the old Python digest.

import { sb } from '../_shared/sb.ts';
import { sendMessage } from '../_shared/tg.ts';
import { sendWebPush } from '../_shared/push.ts';
import { buildTodayMessage } from './commands.ts';
import { todayCasa } from '../_shared/util.ts';

async function broadcastTelegram(text: string, parseMode: 'Markdown' | 'HTML' = 'Markdown'): Promise<number> {
  const { data: subs } = await sb.from('bot_subscribers').select('chat_id');
  const ids = (subs ?? []).map((s: { chat_id: number }) => s.chat_id);
  await Promise.all(ids.map((id) => sendMessage(id, text, { parseMode }).catch(() => {})));
  return ids.length;
}

// ── cheques_due_morning — 08h Casa ──────────────────────────────
export async function jobChequesDueMorning(): Promise<Response> {
  const today = todayCasa();
  const text = await buildTodayMessage(today);
  const sent = await broadcastTelegram(text);
  await sendWebPush('💳 شيكات اليوم', 'تحقق من الشيكات اللي كيحلو اليوم.', './#cheques', 'cheques-morning');
  return new Response(JSON.stringify({ ok: true, job: 'cheques_due_morning', telegram: sent }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── cheques_today_ping — 16h and 18h ────────────────────────────
export async function jobChequesTodayPing(): Promise<Response> {
  const today = todayCasa();
  const { data: dueToday } = await sb.from('cheques')
    .select('num,fournisseur,montant').eq('echeance', today).neq('status', 'مدفوع');
  if (!dueToday || !dueToday.length) {
    return new Response(JSON.stringify({ ok: true, job: 'cheques_today_ping', skipped: 'none_due' }));
  }
  const total = dueToday.reduce((s, c) => s + Number(c.montant || 0), 0);
  const text = `⏰ *تذكير: ${dueToday.length} شيك كيحل اليوم*\n\nالمجموع: ${total.toLocaleString('fr-MA', { minimumFractionDigits: 2 })} د.م.\n\nافتح /today للتفاصيل.`;
  const sent = await broadcastTelegram(text);
  await sendWebPush('⏰ شيكات اليوم', `${dueToday.length} شيك كيحل — افتح التطبيق.`, './#cheques', 'cheques-ping');
  return new Response(JSON.stringify({ ok: true, job: 'cheques_today_ping', telegram: sent }));
}

// ── workers_eod — 20h summary ───────────────────────────────────
export async function jobWorkersEod(): Promise<Response> {
  const today = todayCasa();
  const { data: pres } = await sb.from('salarie_presences')
    .select('id,salarie_id,statut,date').eq('date', today);
  const { data: pcPres } = await sb.from('ouvrier_pc_presences')
    .select('id,ouvrier_id,qte,prix').eq('date', today);

  const total = (pres?.length ?? 0) + (pcPres?.length ?? 0);
  const text = `🧑‍🔧 *خلاصة الخدامة — ${today}*\n\n• الأجراء: ${(pres ?? []).length} تسجيل\n• العمال بالقطعة: ${(pcPres ?? []).length} تسجيل`;
  if (total === 0) return new Response(JSON.stringify({ ok: true, job: 'workers_eod', skipped: 'empty' }));
  const sent = await broadcastTelegram(text);
  return new Response(JSON.stringify({ ok: true, job: 'workers_eod', telegram: sent }));
}

// ── monthly_report — day 1 @ 09h ────────────────────────────────
export async function jobMonthlyReport(): Promise<Response> {
  const today = new Date();
  const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const first = prev.toISOString().slice(0, 10);
  const last = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().slice(0, 10);
  const { data: bons } = await sb.from('bons').select('total').gte('date', first).lte('date', last);
  const { data: fact } = await sb.from('factures').select('total_ttc').gte('date', first).lte('date', last);
  const dep = (bons ?? []).reduce((s, b) => s + Number(b.total || 0), 0);
  const ca = (fact ?? []).reduce((s, f) => s + Number(f.total_ttc || 0), 0);
  const marg = ca - dep;
  const text = `📊 *تقرير شهر ${first.slice(0, 7)}*\n\n💰 رقم المعاملات: *${ca.toLocaleString('fr-MA', { minimumFractionDigits: 2 })} د.م.*\n💸 المصاريف: *${dep.toLocaleString('fr-MA', { minimumFractionDigits: 2 })} د.م.*\n📈 الهامش: *${marg.toLocaleString('fr-MA', { minimumFractionDigits: 2 })} د.م.*`;
  const sent = await broadcastTelegram(text);
  return new Response(JSON.stringify({ ok: true, job: 'monthly_report', telegram: sent }));
}
