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

// Handler for the /khlas-pay confirmation flow.
// Callback data shapes:
//   KHLAS_SAL:<salId>:<dateFrom>:<dateTo>:<cashPaid>
//   KHLAS_PC:<ouvrierId>:<dateFrom>:<dateTo>:<cashPaid>
//   KHLAS_CANCEL  (no payload — just dismiss)
export async function handleKhlasCallback(cq: TgCallbackQuery): Promise<void> {
  const data = cq.data ?? '';
  const msg = cq.message;
  if (!msg) { await answerCallbackQuery(cq.id); return; }
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const origText = msg.text ?? '';

  if (data === 'KHLAS_CANCEL') {
    await answerCallbackQuery(cq.id, 'ألغيت');
    await editMessageText(chatId, messageId, `${origText}\n\n❌ *ملغية*`, { parseMode: 'Markdown' });
    return;
  }
  const parts = data.split(':');
  if (parts.length !== 5) { await answerCallbackQuery(cq.id, '⚠️ payload'); return; }
  const action = parts[0];
  const wid = Number(parts[1]);
  const dateFrom = parts[2];
  const dateTo = parts[3];
  const cashPaid = Number(parts[4]);
  if (!Number.isFinite(wid) || !Number.isFinite(cashPaid)) { await answerCallbackQuery(cq.id, '⚠️ بيانات'); return; }

  try {
    if (action === 'KHLAS_SAL') {
      const today = todayCasa();
      const { data: sal } = await sb.from('salaries').select('nom,prenom').eq('id', wid).single();
      const nomSal = (String((sal as { nom?: string } | null)?.nom || '?') + ((sal as { prenom?: string } | null)?.prenom ? ' ' + (sal as { prenom?: string } | null)!.prenom : '')).trim();
      const { data: ins, error } = await sb.from('salarie_taswiyas').insert({
        salarie_id: wid, montant: cashPaid, date_from: dateFrom, date_to: dateTo,
        date_paiement: today, nom_salarie: nomSal,
      }).select().single();
      if (error) throw error;
      const taswId = (ins as { id: number }).id;
      // Mirror to caisse + mark absorbed avances
      if (cashPaid > 0) {
        await sb.from('caisse_movements').insert({
          date: today, type: 'out', amount: cashPaid,
          designation: 'تسوية — ' + nomSal,
          linked_kind: 'sal_payment', linked_id: taswId, notes: '',
        });
      }
      await sb.from('salarie_avances').update({ rembourse: true, settled_in_tasweya: taswId })
        .eq('salarie_id', wid).eq('rembourse', false);
      await answerCallbackQuery(cq.id, '✅ تخلص');
      await editMessageText(chatId, messageId, `${origText}\n\n✅ *تم — ${nomSal} تخلص ${cashPaid.toFixed(2)} د.م.*`, { parseMode: 'Markdown' });
      return;
    }

    if (action === 'KHLAS_PC') {
      const today = todayCasa();
      const { data: ouv } = await sb.from('ouvriers_pc').select('nom').eq('id', wid).single();
      const nm = String((ouv as { nom?: string } | null)?.nom || '?');
      const { data: ins, error } = await sb.from('pc_taswiyas').insert({
        ouvrier_id: wid, montant: cashPaid, date_from: dateFrom, date_to: dateTo,
        date_paiement: today,
      }).select().single();
      if (error) throw error;
      const taswId = (ins as { id: number }).id;
      if (cashPaid > 0) {
        await sb.from('caisse_movements').insert({
          date: today, type: 'out', amount: cashPaid,
          designation: 'تسوية PC — ' + nm,
          linked_kind: 'pc_payment', linked_id: taswId, notes: '',
        });
      }
      await sb.from('pc_avances').update({ rembourse: true, settled_in_tasweya: taswId })
        .eq('ouvrier_id', wid).eq('rembourse', false);
      await answerCallbackQuery(cq.id, '✅ تخلص');
      await editMessageText(chatId, messageId, `${origText}\n\n✅ *تم — ${nm} (PC) تخلص ${cashPaid.toFixed(2)} د.م.*`, { parseMode: 'Markdown' });
      return;
    }
    await answerCallbackQuery(cq.id);
  } catch (e) {
    console.error('handleKhlasCallback error', e);
    const errMsg = e instanceof Error ? e.message : String(e);
    await answerCallbackQuery(cq.id, '⚠️ خطأ');
    try { await editMessageText(chatId, messageId, `${origText}\n\n⚠️ *خطأ:* ${errMsg.slice(0, 120)}`, { parseMode: 'Markdown' }); } catch { /* */ }
  }
}
