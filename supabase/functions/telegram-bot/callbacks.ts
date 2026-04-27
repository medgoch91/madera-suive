// Inline-keyboard callback handlers for cheque actions
// Ported from telegram_bot.py: cb_chq_paid / cb_chq_unpaid / cb_chq_defer

import { sb } from '../_shared/sb.ts';
import { editMessageText, answerCallbackQuery, type TgCallbackQuery } from '../_shared/tg.ts';
import { todayCasa } from '../_shared/util.ts';

function addDaysIso(iso: string, days: number): string {
  // Parse as noon UTC to avoid DST edge cases when adding days to a Casa date
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function handleChequeCallback(cq: TgCallbackQuery): Promise<void> {
  const data = cq.data ?? '';
  const msg = cq.message;
  if (!msg) { await answerCallbackQuery(cq.id); return; }

  const colon = data.indexOf(':');
  if (colon < 0) { await answerCallbackQuery(cq.id); return; }
  const action = data.slice(0, colon);
  const cid = Number(data.slice(colon + 1));
  if (!Number.isFinite(cid)) { await answerCallbackQuery(cq.id); return; }

  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const origText = msg.text ?? '';

  try {
    if (action === 'CHQPAID') {
      const today = todayCasa();
      const { error } = await sb.from('cheques')
        .update({ status: 'مدفوع', paid_at: today }).eq('id', cid);
      if (error) throw error;
      await answerCallbackQuery(cq.id, '✅ تخلص');
      await editMessageText(
        chatId, messageId,
        `${origText}\n\n✅ *تم — تخلص (${today})*`,
        { parseMode: 'Markdown' },
      );
      return;
    }

    if (action === 'CHQUNPAID') {
      await answerCallbackQuery(cq.id, 'ok — غادي نعاود نذكّر.');
      await editMessageText(
        chatId, messageId,
        `${origText}\n\n❌ *باقي — غادي نعاود نذكّر*`,
        { parseMode: 'Markdown' },
      );
      return;
    }

    if (action === 'CHQDEFER') {
      const newDate = addDaysIso(todayCasa(), 7);
      const { error } = await sb.from('cheques')
        .update({ echeance: newDate }).eq('id', cid);
      if (error) throw error;
      await answerCallbackQuery(cq.id, `📅 تأجل إلى ${newDate}`);
      await editMessageText(
        chatId, messageId,
        `${origText}\n\n📅 *تأجل إلى ${newDate}*`,
        { parseMode: 'Markdown' },
      );
      return;
    }

    await answerCallbackQuery(cq.id);
  } catch (e) {
    console.error('handleChequeCallback error', e);
    const errMsg = e instanceof Error ? e.message : String(e);
    await answerCallbackQuery(cq.id, '⚠️ خطأ');
    try {
      await editMessageText(
        chatId, messageId,
        `${origText}\n\n⚠️ *خطأ تقني:* ${errMsg.slice(0, 120)}`,
        { parseMode: 'Markdown' },
      );
    } catch { /* ignore */ }
  }
}
