// Multi-step conversation handlers for /newbon and /cheque.
// State lives in public.bot_conversations keyed by chat_id.

import { sb } from '../_shared/sb.ts';
import { sendMessage, type TgMessage } from '../_shared/tg.ts';
import { fmtMoney, todayCasa, safeNum } from '../_shared/util.ts';

type Conv = {
  chat_id: number;
  command: 'newbon' | 'cheque';
  step: string;
  data: Record<string, unknown>;
  updated_at?: string;
};

async function getConv(chatId: number): Promise<Conv | null> {
  const { data } = await sb.from('bot_conversations').select('*').eq('chat_id', chatId).maybeSingle();
  return (data as Conv) ?? null;
}

async function setConv(c: Omit<Conv, 'updated_at'>): Promise<void> {
  await sb.from('bot_conversations').upsert(
    { ...c, updated_at: new Date().toISOString() },
    { onConflict: 'chat_id' },
  );
}

async function endConv(chatId: number): Promise<void> {
  await sb.from('bot_conversations').delete().eq('chat_id', chatId);
}

// ──────────────────────────────────────────────────────────────────
// /newbon — steps: fournisseur → article → qte → prix → more/save
// ──────────────────────────────────────────────────────────────────
export async function startNewBon(msg: TgMessage): Promise<void> {
  await setConv({ chat_id: msg.chat.id, command: 'newbon', step: 'four', data: { lignes: [] } });
  await sendMessage(msg.chat.id, '➕ *بون جديد*\n\nاسم الفورنيسور:', { parseMode: 'Markdown' });
}

export async function startCheque(msg: TgMessage): Promise<void> {
  await setConv({ chat_id: msg.chat.id, command: 'cheque', step: 'four', data: {} });
  await sendMessage(msg.chat.id, '➕ *شيك جديد*\n\nاسم الفورنيسور:', { parseMode: 'Markdown' });
}

// Main dispatcher — called from index.ts when a non-command text message arrives
// and a conversation is in progress. Returns true when the message was consumed.
export async function handleConvMessage(msg: TgMessage): Promise<boolean> {
  if (!msg.text) return false;
  const conv = await getConv(msg.chat.id);
  if (!conv) return false;

  try {
    if (conv.command === 'newbon') return await stepNewBon(conv, msg);
    if (conv.command === 'cheque') return await stepCheque(conv, msg);
  } catch (e) {
    console.error('conv error', e);
    await sendMessage(msg.chat.id, '⚠️ خطأ تقني. جرب `/cancel` و اعاود.');
    await endConv(msg.chat.id);
  }
  return true;
}

// ── /newbon flow ────────────────────────────────────────────────
async function stepNewBon(conv: Conv, msg: TgMessage): Promise<boolean> {
  const txt = (msg.text || '').trim();
  const data = conv.data as { fournisseur?: string; lignes: Array<{ nom: string; qte: number; prix: number }>; current?: { nom?: string; qte?: number } };
  data.lignes = data.lignes ?? [];

  if (conv.step === 'four') {
    if (!txt) { await sendMessage(msg.chat.id, 'اسم الفورنيسور خاوي. دخل الاسم.'); return true; }
    data.fournisseur = txt;
    data.current = {};
    await setConv({ chat_id: msg.chat.id, command: 'newbon', step: 'nom', data });
    await sendMessage(msg.chat.id, `✅ *${txt}*\n\nاسم السلعة (ولا /save باش تسجل):`, { parseMode: 'Markdown' });
    return true;
  }

  if (conv.step === 'nom') {
    if (/^\/save$/i.test(txt)) return await saveBon(conv, msg);
    data.current = { nom: txt };
    await setConv({ chat_id: msg.chat.id, command: 'newbon', step: 'qte', data });
    await sendMessage(msg.chat.id, `*${txt}*\n\nالكمية:`, { parseMode: 'Markdown' });
    return true;
  }

  if (conv.step === 'qte') {
    const qte = safeNum(txt);
    if (!qte) { await sendMessage(msg.chat.id, 'الكمية غلط. دخل رقم.'); return true; }
    data.current = { ...(data.current ?? {}), qte };
    await setConv({ chat_id: msg.chat.id, command: 'newbon', step: 'prix', data });
    await sendMessage(msg.chat.id, 'السعر للوحدة:');
    return true;
  }

  if (conv.step === 'prix') {
    const prix = safeNum(txt);
    if (!prix) { await sendMessage(msg.chat.id, 'السعر غلط. دخل رقم.'); return true; }
    const cur = data.current ?? {};
    data.lignes.push({ nom: String(cur.nom ?? '?'), qte: Number(cur.qte ?? 0), prix });
    data.current = {};
    const total = data.lignes.reduce((s, l) => s + l.qte * l.prix, 0);
    await setConv({ chat_id: msg.chat.id, command: 'newbon', step: 'nom', data });
    await sendMessage(msg.chat.id,
      `✅ تزادت.\nالمجموع ديال البون: *${fmtMoney(total)} د.م.*\n\nسلعة جديدة (ولا /save):`,
      { parseMode: 'Markdown' });
    return true;
  }

  return false;
}

async function saveBon(conv: Conv, msg: TgMessage): Promise<boolean> {
  const data = conv.data as { fournisseur?: string; lignes: Array<{ nom: string; qte: number; prix: number }> };
  if (!data.lignes || !data.lignes.length) {
    await sendMessage(msg.chat.id, 'البون خاوي. زيد 1 سلعة على الأقل.');
    return true;
  }
  // Next BON number
  const { data: rows } = await sb.from('bons').select('num').order('num', { ascending: false }).limit(50);
  let maxN = 0;
  (rows || []).forEach((r) => { const s = String(r.num ?? ''); const m = s.match(/^BON-(\d+)$/); if (m) maxN = Math.max(maxN, Number(m[1])); else if (/^\d+$/.test(s)) maxN = Math.max(maxN, Number(s)); });
  const num = `BON-${String(maxN + 1).padStart(4, '0')}`;

  const total = data.lignes.reduce((s, l) => s + l.qte * l.prix, 0);
  const lignes = data.lignes.map((l) => ({ nom: l.nom, qte: l.qte, prix: l.prix, unite: '' }));

  const { data: saved, error } = await sb.from('bons').insert({
    num, fournisseur: data.fournisseur, date: todayCasa(),
    statut: 'Brouillon', remise_type: '%', remise_val: 0,
    total, total_net: total, lignes, note: '',
  }).select().single();

  await endConv(msg.chat.id);

  if (error || !saved) {
    await sendMessage(msg.chat.id, `❌ خطأ ف حفظ البون: ${error?.message ?? '?'}`);
    return true;
  }

  const lbl = data.lignes.map((l) => `• ${l.nom} × ${l.qte} @ ${fmtMoney(l.prix)}`).join('\n');
  await sendMessage(msg.chat.id,
    `✅ *${num} محفوظ!*\n\n🏢 ${data.fournisseur}\n📅 ${todayCasa()}\n\n${lbl}\n\n💰 *المجموع: ${fmtMoney(total)} د.م.*`,
    { parseMode: 'Markdown' });
  return true;
}

// ── /cheque flow ────────────────────────────────────────────────
async function stepCheque(conv: Conv, msg: TgMessage): Promise<boolean> {
  const txt = (msg.text || '').trim();
  const data = conv.data as { fournisseur?: string; montant?: number };

  if (conv.step === 'four') {
    if (!txt) { await sendMessage(msg.chat.id, 'اسم الفورنيسور خاوي.'); return true; }
    data.fournisseur = txt;
    await setConv({ chat_id: msg.chat.id, command: 'cheque', step: 'montant', data });
    await sendMessage(msg.chat.id, `*${txt}*\n\nالمبلغ (د.م.):`, { parseMode: 'Markdown' });
    return true;
  }

  if (conv.step === 'montant') {
    const montant = safeNum(txt);
    if (!montant) { await sendMessage(msg.chat.id, 'المبلغ غلط. دخل رقم.'); return true; }
    data.montant = montant;
    await setConv({ chat_id: msg.chat.id, command: 'cheque', step: 'echeance', data });
    await sendMessage(msg.chat.id, 'تاريخ الاستحقاق (YYYY-MM-DD):');
    return true;
  }

  if (conv.step === 'echeance') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(txt)) {
      await sendMessage(msg.chat.id, 'التاريخ خاصو يكون YYYY-MM-DD. مثال: 2026-05-15');
      return true;
    }
    // Next CHK number — simple max+1 across all rows
    const { data: rows } = await sb.from('cheques').select('num').order('num', { ascending: false }).limit(100);
    let maxN = 0;
    (rows || []).forEach((r) => { const s = String(r.num ?? ''); const m = s.match(/^CHK-(\d+)$/); if (m) maxN = Math.max(maxN, Number(m[1])); else if (/^\d+$/.test(s)) maxN = Math.max(maxN, Number(s)); });
    const num = `CHK-${String(maxN + 1).padStart(4, '0')}`;

    const { data: saved, error } = await sb.from('cheques').insert({
      num, fournisseur: data.fournisseur, montant: Math.round((data.montant ?? 0) * 100) / 100,
      echeance: txt, date: todayCasa(), status: 'معلق', type: 'cheque',
    }).select().single();

    await endConv(msg.chat.id);

    if (error || !saved) {
      await sendMessage(msg.chat.id, `❌ خطأ ف حفظ الشيك: ${error?.message ?? '?'}`);
      return true;
    }
    await sendMessage(msg.chat.id,
      `✅ *${num} محفوظ!*\n\n🏢 ${data.fournisseur}\n💰 ${fmtMoney(data.montant!)} د.م.\n📅 استحقاق: ${txt}`,
      { parseMode: 'Markdown' });
    return true;
  }

  return false;
}
