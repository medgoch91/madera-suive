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

// Broadcast helper — inline import-free fan-out to bot_subscribers so
// `/khlaspay` settlements show up to every subscribed chat (matches the
// in-app salKhallas notif behavior).
async function _broadcastSettleNotif(text: string): Promise<void> {
  try {
    const { data: subs } = await sb.from('bot_subscribers').select('chat_id');
    const ids = (subs ?? []).map((s: { chat_id: number }) => s.chat_id);
    await Promise.all(ids.map((id) => {
      // Lazy import avoids a top-level circular dep with tg.ts in case
      // callbacks.ts is reused without index.ts wiring.
      return import('../_shared/tg.ts').then(({ sendMessage }) =>
        sendMessage(id, text, { parseMode: 'Markdown' }).catch(() => {})
      );
    }));
  } catch (e) { console.warn('settle broadcast failed:', e); }
}

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
  const action = parts[0];
  if ((action === 'KHLAS_SAL' || action === 'KHLAS_PC') && parts.length !== 5) {
    await answerCallbackQuery(cq.id, '⚠️ payload'); return;
  }
  const wid = Number(parts[1]);
  const dateFrom = parts[2];
  const dateTo = parts[3];
  const cashPaidEncoded = Number(parts[4]);
  if (!Number.isFinite(wid) || !Number.isFinite(cashPaidEncoded)) { await answerCallbackQuery(cq.id, '⚠️ بيانات'); return; }

  // Helper: format date for human notif (DD/MM/YYYY).
  const fmtDateAr = (iso: string): string => {
    if (!iso || iso.length < 10) return iso || '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  };

  try {
    if (action === 'KHLAS_SAL') {
      const today = todayCasa();

      // 🔴 Must-fix #3: idempotency guard against double-tap. Two ✅ taps
      // (or two devices) would otherwise create two taswiyas + two caisse
      // rows for the same period.
      const { data: existing } = await sb.from('salarie_taswiyas').select('id,montant')
        .eq('salarie_id', wid).eq('date_from', dateFrom).eq('date_to', dateTo).limit(1);
      if (existing && existing.length) {
        await answerCallbackQuery(cq.id, '⚠️ تخلصت قبل');
        await editMessageText(chatId, messageId, `${origText}\n\n⚠️ *تخلصت قبل* — ${(existing[0] as { montant: number }).montant.toFixed(2)} د.م.`, { parseMode: 'Markdown' });
        return;
      }

      // Re-compute gross + avs at confirm time so a worker who got an
      // avance between message render and ✅ tap still settles correctly.
      const { data: sal } = await sb.from('salaries').select('nom,prenom,salaire_base,taux_hsup').eq('id', wid).single();
      const salRow = sal as { nom: string; prenom?: string; salaire_base: number; taux_hsup: number } | null;
      if (!salRow) throw new Error('worker not found');
      const nomSal = (String(salRow.nom || '?') + (salRow.prenom ? ' ' + salRow.prenom : '')).trim();

      const { data: pres } = await sb.from('salarie_presences').select('statut,heures_supp,taux_horaire,notes').eq('salarie_id', wid).gte('date', dateFrom).lte('date', dateTo);
      const STATUS_FACTOR: Record<string, number> = { present: 1, demi: 0.5, absent: 0, conge: 0 };
      let base = 0, hsupCost = 0, prod = 0;
      (pres ?? []).forEach((p) => {
        const pp = p as { statut: string; heures_supp: number; taux_horaire: number; notes?: string };
        base += (STATUS_FACTOR[pp.statut] ?? 0) * Number(salRow.salaire_base || 0);
        hsupCost += Number(pp.heures_supp || 0) * Number(pp.taux_horaire || 0);
        if (pp.notes) try { prod += JSON.parse(pp.notes).reduce((t: number, l: { qte: number; prix: number }) => t + Number(l.qte) * Number(l.prix), 0); } catch (_) { /* */ }
      });
      const gross = base + hsupCost + prod;

      const { data: avs } = await sb.from('salarie_avances').select('id,montant').eq('salarie_id', wid).eq('rembourse', false);
      const avsRows = (avs ?? []) as Array<{ id: number; montant: number }>;
      const totalAvs = avsRows.reduce((t, a) => t + Number(a.montant || 0), 0);
      const isOverflow = totalAvs > gross + 0.01;
      const cashPaid = Math.max(0, gross - totalAvs);
      const rollover = isOverflow ? Math.round((totalAvs - gross) * 100) / 100 : 0;

      // Insert the taswiya row
      const { data: ins, error } = await sb.from('salarie_taswiyas').insert({
        salarie_id: wid, montant: cashPaid, date_from: dateFrom, date_to: dateTo,
        date_paiement: today, nom_salarie: nomSal,
      }).select().single();
      if (error) throw error;
      const taswId = (ins as { id: number }).id;

      // Mirror to caisse only when there's actual cash flow
      if (cashPaid > 0) {
        await sb.from('caisse_movements').insert({
          date: today, type: 'out', amount: cashPaid,
          designation: 'تسوية — ' + nomSal,
          linked_kind: 'sal_payment', linked_id: taswId, notes: '',
        });
      }

      // Mark exactly the avances we counted (id=in.(…)) — narrower than
      // "rembourse=false" so an avance inserted between the SELECT and
      // this UPDATE doesn't get silently absorbed.
      if (avsRows.length) {
        await sb.from('salarie_avances').update({ rembourse: true, settled_in_tasweya: taswId })
          .in('id', avsRows.map((a) => a.id));
      }

      // 🔴 Must-fix #1: rollover. When avs > gross the leftover becomes a
      // fresh avance for next week — exactly mirrors the in-app salKhallas.
      if (rollover > 0) {
        await sb.from('salarie_avances').insert({
          salarie_id: wid,
          date: today,
          montant: rollover,
          notes: `🔄 ترصيد من تسوية ${fmtDateAr(dateFrom)} → ${fmtDateAr(dateTo)}`,
          rembourse: false,
        });
      }

      // Inline edit (caller-only) + broadcast to all subscribers
      await answerCallbackQuery(cq.id, '✅ تخلص');
      await editMessageText(chatId, messageId, `${origText}\n\n✅ *تم — ${nomSal} تخلص ${cashPaid.toFixed(2)} د.م.*${isOverflow ? `\n🔄 ترصيد للأسبوع الجاي: ${rollover.toFixed(2)} د.م.` : ''}`, { parseMode: 'Markdown' });
      const broadcastLines = [
        `💰 *تخلص — ${nomSal}*`,
        `📅 الفترة: ${fmtDateAr(dateFrom)} → ${fmtDateAr(dateTo)}`,
      ];
      if (isOverflow) {
        broadcastLines.push(`⚠️ السلف (${totalAvs.toFixed(2)}) > الأجر (${gross.toFixed(2)})`);
        broadcastLines.push('💵 الكاش: 0 DH');
        broadcastLines.push(`🔄 ترصيد للأسبوع الجاي: ${rollover.toFixed(2)} DH`);
      } else {
        broadcastLines.push(`💵 المبلغ: ${cashPaid.toFixed(2)} DH`);
        if (totalAvs > 0) broadcastLines.push(`🛈 (الأجر ${gross.toFixed(2)} − سلف ${totalAvs.toFixed(2)})`);
      }
      broadcastLines.push('', '_(via /khlaspay)_');
      await _broadcastSettleNotif(broadcastLines.join('\n'));
      return;
    }

    if (action === 'KHLAS_PC') {
      const today = todayCasa();

      // Idempotency guard
      const { data: existing } = await sb.from('pc_taswiyas').select('id,montant')
        .eq('ouvrier_id', wid).eq('date_from', dateFrom).eq('date_to', dateTo).limit(1);
      if (existing && existing.length) {
        await answerCallbackQuery(cq.id, '⚠️ تخلصت قبل');
        await editMessageText(chatId, messageId, `${origText}\n\n⚠️ *تخلصت قبل* — ${(existing[0] as { montant: number }).montant.toFixed(2)} د.م.`, { parseMode: 'Markdown' });
        return;
      }

      const { data: ouv } = await sb.from('ouvriers_pc').select('nom').eq('id', wid).single();
      const nm = String((ouv as { nom?: string } | null)?.nom || '?');

      const { data: pres } = await sb.from('ouvrier_pc_presences').select('qte,prix').eq('ouvrier_id', wid).gte('date', dateFrom).lte('date', dateTo);
      const gross = (pres ?? []).reduce((t, r) => t + Number((r as { qte: number }).qte || 0) * Number((r as { prix: number }).prix || 0), 0);

      const { data: avs } = await sb.from('pc_avances').select('id,montant').eq('ouvrier_id', wid).eq('rembourse', false);
      const avsRows = (avs ?? []) as Array<{ id: number; montant: number }>;
      const totalAvs = avsRows.reduce((t, a) => t + Number(a.montant || 0), 0);
      const isOverflow = totalAvs > gross + 0.01;
      const cashPaid = Math.max(0, gross - totalAvs);
      const rollover = isOverflow ? Math.round((totalAvs - gross) * 100) / 100 : 0;

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
      if (avsRows.length) {
        await sb.from('pc_avances').update({ rembourse: true, settled_in_tasweya: taswId })
          .in('id', avsRows.map((a) => a.id));
      }
      if (rollover > 0) {
        await sb.from('pc_avances').insert({
          ouvrier_id: wid,
          date: today,
          montant: rollover,
          notes: `🔄 ترصيد من تسوية ${fmtDateAr(dateFrom)} → ${fmtDateAr(dateTo)}`,
          rembourse: false,
        });
      }

      await answerCallbackQuery(cq.id, '✅ تخلص');
      await editMessageText(chatId, messageId, `${origText}\n\n✅ *تم — ${nm} (PC) تخلص ${cashPaid.toFixed(2)} د.م.*${isOverflow ? `\n🔄 ترصيد للأسبوع الجاي: ${rollover.toFixed(2)} د.م.` : ''}`, { parseMode: 'Markdown' });
      const broadcastLines = [
        `💰 *تخلص PC — ${nm}*`,
        `📅 الفترة: ${fmtDateAr(dateFrom)} → ${fmtDateAr(dateTo)}`,
      ];
      if (isOverflow) {
        broadcastLines.push(`⚠️ السلف (${totalAvs.toFixed(2)}) > الأجر (${gross.toFixed(2)})`);
        broadcastLines.push('💵 الكاش: 0 DH');
        broadcastLines.push(`🔄 ترصيد للأسبوع الجاي: ${rollover.toFixed(2)} DH`);
      } else {
        broadcastLines.push(`💵 المبلغ: ${cashPaid.toFixed(2)} DH`);
        if (totalAvs > 0) broadcastLines.push(`🛈 (الأجر ${gross.toFixed(2)} − سلف ${totalAvs.toFixed(2)})`);
      }
      broadcastLines.push('', '_(via /khlaspay)_');
      await _broadcastSettleNotif(broadcastLines.join('\n'));
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
