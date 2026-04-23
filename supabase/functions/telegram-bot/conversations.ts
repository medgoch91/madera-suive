// Multi-step conversation handlers for /newbon and /cheque.
// State lives in public.bot_conversations keyed by chat_id.
//
// UX: when a step has existing data in the DB (fournisseurs, articles for a
// fournisseur), we surface them as a ReplyKeyboard so the user can tap instead
// of retyping. A dedicated "➕ جديد" button switches to free-text entry.

import { sb } from '../_shared/sb.ts';
import { sendMessage, kbRows, type TgMessage, type TgReplyMarkup } from '../_shared/tg.ts';
import { fmtMoney, todayCasa, safeNum } from '../_shared/util.ts';

type BonLigne = { nom: string; qte: number; prix: number; article_id?: number };
type BonData = {
  fournisseur?: string;
  fournisseur_id?: number;
  lignes: BonLigne[];
  current?: { nom?: string; qte?: number; article_id?: number; last_price?: number };
};

type Conv = {
  chat_id: number;
  command: 'newbon' | 'cheque';
  step: string;
  data: Record<string, unknown>;
  updated_at?: string;
};

const NEW_LABEL = '➕ جديد';
const NEW_ITEM_LABEL = '➕ سلعة جديدة';
const SAVE_LABEL = '✅ حفظ البون';
const CANCEL_LABEL = '❌ إلغاء';
const REMOVE_KB: TgReplyMarkup = { remove_keyboard: true };

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
// /newbon — steps: four → nom → qte → prix → (loop or save)
// ──────────────────────────────────────────────────────────────────
export async function startNewBon(msg: TgMessage): Promise<void> {
  const names = await fetchFournisseurNames();
  const buttons = [...names.slice(0, 20), NEW_LABEL, CANCEL_LABEL];
  await setConv({
    chat_id: msg.chat.id,
    command: 'newbon',
    step: 'four',
    data: { lignes: [] } as BonData,
  });
  await sendMessage(
    msg.chat.id,
    '➕ *بون جديد*\n\nختار الفورنيسور ولا دوس `➕ جديد` باش تزيد واحد ماشي ف اللائحة:',
    { parseMode: 'Markdown', replyMarkup: { keyboard: kbRows(buttons, 2), resize_keyboard: true } },
  );
}

export async function startCheque(msg: TgMessage): Promise<void> {
  const names = await fetchFournisseurNames();
  const buttons = [...names.slice(0, 20), NEW_LABEL, CANCEL_LABEL];
  await setConv({ chat_id: msg.chat.id, command: 'cheque', step: 'four', data: {} });
  await sendMessage(
    msg.chat.id,
    '➕ *شيك جديد*\n\nختار الفورنيسور ولا دوس `➕ جديد`:',
    { parseMode: 'Markdown', replyMarkup: { keyboard: kbRows(buttons, 2), resize_keyboard: true } },
  );
}

export async function handleConvMessage(msg: TgMessage): Promise<boolean> {
  if (!msg.text) return false;
  const conv = await getConv(msg.chat.id);
  if (!conv) return false;

  // Universal cancel from keyboard
  if (msg.text.trim() === CANCEL_LABEL) {
    await endConv(msg.chat.id);
    await sendMessage(msg.chat.id, 'تم الإلغاء.', { replyMarkup: REMOVE_KB });
    return true;
  }

  try {
    if (conv.command === 'newbon') return await stepNewBon(conv, msg);
    if (conv.command === 'cheque') return await stepCheque(conv, msg);
  } catch (e) {
    console.error('conv error', e);
    await sendMessage(msg.chat.id, '⚠️ خطأ تقني. جرب `/cancel` و اعاود.', { replyMarkup: REMOVE_KB });
    await endConv(msg.chat.id);
  }
  return true;
}

// ── DB lookups ─────────────────────────────────────────────────

async function fetchFournisseurNames(): Promise<string[]> {
  const { data } = await sb.from('fournisseurs').select('id,nom').order('nom', { ascending: true });
  return (data ?? []).map((f: { nom: string }) => f.nom).filter(Boolean);
}

async function findFournisseur(name: string): Promise<{ id: number; nom: string } | null> {
  const { data } = await sb.from('fournisseurs').select('id,nom').ilike('nom', name).maybeSingle();
  return (data as { id: number; nom: string }) ?? null;
}

async function fetchLinkedArticles(fournisseurId: number): Promise<
  { id: number; nom: string; last_price: number | null }[]
> {
  // supplier_products holds last_purchase_price_ttc and links to articles
  const { data } = await sb.from('supplier_products')
    .select('product_id,last_purchase_price_ttc,articles(nom)')
    .eq('supplier_id', fournisseurId)
    .limit(50);
  const rows = (data ?? []) as Array<{
    product_id: number;
    last_purchase_price_ttc: number | null;
    articles: { nom: string } | null;
  }>;
  return rows
    .filter((r) => r.articles?.nom)
    .map((r) => ({ id: r.product_id, nom: r.articles!.nom, last_price: r.last_purchase_price_ttc }));
}

async function findArticle(nom: string): Promise<{ id: number; nom: string } | null> {
  const { data } = await sb.from('articles').select('id,nom').ilike('nom', nom).maybeSingle();
  return (data as { id: number; nom: string }) ?? null;
}

// "En compte" — total of open bons (no cheque attached) for this fournisseur
async function fetchOutstanding(fournisseurNom: string): Promise<number> {
  const { data } = await sb.from('bons')
    .select('total').eq('fournisseur', fournisseurNom).is('cheque_id', null);
  return (data ?? []).reduce((s, b: { total: number }) => s + safeNum(b.total), 0);
}

// ── /newbon flow ────────────────────────────────────────────────
async function stepNewBon(conv: Conv, msg: TgMessage): Promise<boolean> {
  const txt = (msg.text || '').trim();
  const data = conv.data as BonData;
  data.lignes = data.lignes ?? [];

  // Step: fournisseur pick
  if (conv.step === 'four') {
    if (!txt) { await sendMessage(msg.chat.id, 'اسم الفورنيسور خاوي.'); return true; }
    if (txt === NEW_LABEL) {
      await setConv({ chat_id: msg.chat.id, command: 'newbon', step: 'four_new', data });
      await sendMessage(msg.chat.id, 'كتب اسم الفورنيسور الجديد:', { replyMarkup: REMOVE_KB });
      return true;
    }
    const match = await findFournisseur(txt);
    data.fournisseur = match?.nom ?? txt;
    data.fournisseur_id = match?.id;
    data.current = {};
    return await promptArticleStep(msg.chat.id, data, match?.id);
  }

  // Step: fournisseur free-text (user picked ➕ جديد)
  if (conv.step === 'four_new') {
    if (!txt) { await sendMessage(msg.chat.id, 'اسم الفورنيسور خاوي. دخل الاسم.'); return true; }
    data.fournisseur = txt;
    data.fournisseur_id = undefined;
    data.current = {};
    return await promptArticleStep(msg.chat.id, data, undefined);
  }

  // Step: article pick / free text
  if (conv.step === 'nom') {
    if (txt === SAVE_LABEL || /^\/save$/i.test(txt)) return await saveBon(conv, msg);
    if (txt === NEW_ITEM_LABEL) {
      await setConv({ chat_id: msg.chat.id, command: 'newbon', step: 'nom_new', data });
      await sendMessage(msg.chat.id, 'كتب اسم السلعة الجديدة:', { replyMarkup: REMOVE_KB });
      return true;
    }
    // Match against linked articles (prefill last_price) or any article by name
    let articleId: number | undefined;
    let lastPrice: number | undefined;
    if (data.fournisseur_id) {
      const linked = await fetchLinkedArticles(data.fournisseur_id);
      const hit = linked.find((a) => a.nom.toLowerCase() === txt.toLowerCase());
      if (hit) { articleId = hit.id; lastPrice = hit.last_price ?? undefined; }
    }
    if (!articleId) {
      const art = await findArticle(txt);
      if (art) articleId = art.id;
    }
    data.current = { nom: txt, article_id: articleId, last_price: lastPrice };
    await setConv({ chat_id: msg.chat.id, command: 'newbon', step: 'qte', data });
    await sendMessage(msg.chat.id, `*${txt}*\n\nالكمية:`, {
      parseMode: 'Markdown',
      replyMarkup: REMOVE_KB,
    });
    return true;
  }

  if (conv.step === 'nom_new') {
    if (!txt) { await sendMessage(msg.chat.id, 'اسم السلعة خاوي.'); return true; }
    data.current = { nom: txt, article_id: undefined, last_price: undefined };
    await setConv({ chat_id: msg.chat.id, command: 'newbon', step: 'qte', data });
    await sendMessage(msg.chat.id, `*${txt}*\n\nالكمية:`, { parseMode: 'Markdown' });
    return true;
  }

  if (conv.step === 'qte') {
    const qte = safeNum(txt);
    if (!qte) { await sendMessage(msg.chat.id, 'الكمية غلط. دخل رقم.'); return true; }
    const cur = data.current ?? {};
    cur.qte = qte;
    data.current = cur;
    await setConv({ chat_id: msg.chat.id, command: 'newbon', step: 'prix', data });
    if (typeof cur.last_price === 'number' && cur.last_price > 0) {
      const priceStr = cur.last_price.toFixed(2);
      await sendMessage(
        msg.chat.id,
        `السعر للوحدة:\n_آخر ثمن مسجل: *${fmtMoney(cur.last_price)}* د.م._\n\nدوس ✅ باش تأكد نفس الثمن، ولا كتب ثمن جديد.`,
        {
          parseMode: 'Markdown',
          replyMarkup: {
            keyboard: [[{ text: `✅ ${priceStr}` }], [{ text: CANCEL_LABEL }]],
            resize_keyboard: true,
          },
        },
      );
    } else {
      await sendMessage(msg.chat.id, 'السعر للوحدة:', { replyMarkup: REMOVE_KB });
    }
    return true;
  }

  if (conv.step === 'prix') {
    const cleaned = txt.replace(/^✅\s*/, '').replace(',', '.').trim();
    const prix = safeNum(cleaned);
    if (!prix) { await sendMessage(msg.chat.id, 'السعر غلط. دخل رقم.'); return true; }
    const cur = data.current ?? {};
    const last = typeof cur.last_price === 'number' && cur.last_price > 0 ? cur.last_price : undefined;
    data.lignes.push({
      nom: String(cur.nom ?? '?'),
      qte: Number(cur.qte ?? 0),
      prix,
      article_id: cur.article_id,
    });
    data.current = {};
    const total = data.lignes.reduce((s, l) => s + l.qte * l.prix, 0);
    await setConv({ chat_id: msg.chat.id, command: 'newbon', step: 'nom', data });
    let priceAlert = '';
    if (typeof last === 'number' && Math.abs(last - prix) > 0.01) {
      const arrow = prix > last ? '🔺' : '🔻';
      priceAlert = `\n${arrow} *تنبيه:* الثمن تبدل من ${fmtMoney(last)} إلى *${fmtMoney(prix)}* د.م.`;
    }
    await sendMessage(
      msg.chat.id,
      `✅ تزادت.${priceAlert}\nالمجموع ديال البون: *${fmtMoney(total)} د.م.*\n\nختار سلعة أخرى ولا دوس *${SAVE_LABEL}*:`,
      {
        parseMode: 'Markdown',
        replyMarkup: await articleKeyboardFor(data.fournisseur_id, /*withSave*/ true),
      },
    );
    return true;
  }

  return false;
}

async function promptArticleStep(chatId: number, data: BonData, fournisseurId: number | undefined): Promise<boolean> {
  await setConv({ chat_id: chatId, command: 'newbon', step: 'nom', data });
  const label = data.fournisseur ? `✅ *${data.fournisseur}*` : '';
  const prompt = fournisseurId
    ? `${label}\n\nختار سلعة من هاد اللائحة (ولا ${NEW_ITEM_LABEL}):`
    : `${label}\n\nفورنيسور جديد — ما كاينة حتى سلعة مربطة بيه. كتب اسم السلعة:`;
  await sendMessage(chatId, prompt, {
    parseMode: 'Markdown',
    replyMarkup: await articleKeyboardFor(fournisseurId, /*withSave*/ false),
  });
  return true;
}

async function articleKeyboardFor(
  fournisseurId: number | undefined,
  withSave: boolean,
): Promise<TgReplyMarkup> {
  const names: string[] = [];
  if (fournisseurId) {
    const linked = await fetchLinkedArticles(fournisseurId);
    for (const a of linked.slice(0, 20)) names.push(a.nom);
  }
  const extra: string[] = [];
  if (withSave) extra.push(SAVE_LABEL);
  extra.push(NEW_ITEM_LABEL, CANCEL_LABEL);
  return { keyboard: kbRows([...names, ...extra], 2), resize_keyboard: true };
}

async function saveBon(conv: Conv, msg: TgMessage): Promise<boolean> {
  const data = conv.data as BonData;
  if (!data.lignes || !data.lignes.length) {
    await sendMessage(msg.chat.id, 'البون خاوي. زيد 1 سلعة على الأقل.');
    return true;
  }
  // Next BON number
  const { data: rows } = await sb.from('bons').select('num').order('num', { ascending: false }).limit(50);
  let maxN = 0;
  (rows || []).forEach((r) => {
    const s = String(r.num ?? '');
    const m = s.match(/^BON-(\d+)$/);
    if (m) maxN = Math.max(maxN, Number(m[1]));
    else if (/^\d+$/.test(s)) maxN = Math.max(maxN, Number(s));
  });
  const num = `BON-${String(maxN + 1).padStart(4, '0')}`;

  const total = data.lignes.reduce((s, l) => s + l.qte * l.prix, 0);
  const lignes = data.lignes.map((l) => ({
    nom: l.nom,
    qte: l.qte,
    prix: l.prix,
    unite: '',
    articleId: l.article_id ?? null,
  }));

  const { data: saved, error } = await sb.from('bons').insert({
    num, fournisseur: data.fournisseur, date: todayCasa(),
    statut: 'Brouillon', remise_type: '%', remise_val: 0,
    total, total_net: total, lignes, note: '',
  }).select().single();

  await endConv(msg.chat.id);

  if (error || !saved) {
    await sendMessage(msg.chat.id, `❌ خطأ ف حفظ البون: ${error?.message ?? '?'}`, { replyMarkup: REMOVE_KB });
    return true;
  }

  const lbl = data.lignes.map((l) => `• ${l.nom} × ${l.qte} @ ${fmtMoney(l.prix)}`).join('\n');
  await sendMessage(
    msg.chat.id,
    `✅ *${num} محفوظ!*\n\n🏢 ${data.fournisseur}\n📅 ${todayCasa()}\n\n${lbl}\n\n💰 *المجموع: ${fmtMoney(total)} د.م.*`,
    { parseMode: 'Markdown', replyMarkup: REMOVE_KB },
  );
  return true;
}

// ── /cheque flow ────────────────────────────────────────────────
async function stepCheque(conv: Conv, msg: TgMessage): Promise<boolean> {
  const txt = (msg.text || '').trim();
  const data = conv.data as { fournisseur?: string; fournisseur_id?: number; montant?: number };

  if (conv.step === 'four') {
    if (!txt) { await sendMessage(msg.chat.id, 'اسم الفورنيسور خاوي.'); return true; }
    if (txt === NEW_LABEL) {
      await setConv({ chat_id: msg.chat.id, command: 'cheque', step: 'four_new', data });
      await sendMessage(msg.chat.id, 'كتب اسم الفورنيسور الجديد:', { replyMarkup: REMOVE_KB });
      return true;
    }
    const match = await findFournisseur(txt);
    data.fournisseur = match?.nom ?? txt;
    data.fournisseur_id = match?.id;
    const outstanding = match ? await fetchOutstanding(match.nom) : 0;
    await setConv({ chat_id: msg.chat.id, command: 'cheque', step: 'montant', data });
    let prompt = `*${data.fournisseur}*\n\nالمبلغ (د.م.):`;
    let kb: TgReplyMarkup = REMOVE_KB;
    if (outstanding > 0) {
      const amt = outstanding.toFixed(2);
      prompt = `*${data.fournisseur}*\n\n💼 ف الحساب: *${fmtMoney(outstanding)} د.م.* (بونات بلا شيك)\n\nدوس ✅ باش تخلص كل شي، ولا كتب مبلغ آخر:`;
      kb = { keyboard: [[{ text: `✅ ${amt}` }], [{ text: CANCEL_LABEL }]], resize_keyboard: true };
    }
    await sendMessage(msg.chat.id, prompt, { parseMode: 'Markdown', replyMarkup: kb });
    return true;
  }

  if (conv.step === 'four_new') {
    if (!txt) { await sendMessage(msg.chat.id, 'اسم الفورنيسور خاوي.'); return true; }
    data.fournisseur = txt;
    data.fournisseur_id = undefined;
    await setConv({ chat_id: msg.chat.id, command: 'cheque', step: 'montant', data });
    await sendMessage(msg.chat.id, `*${txt}*\n\nالمبلغ (د.م.):`, { parseMode: 'Markdown', replyMarkup: REMOVE_KB });
    return true;
  }

  if (conv.step === 'montant') {
    const cleaned = txt.replace(/^✅\s*/, '').replace(',', '.').trim();
    const montant = safeNum(cleaned);
    if (!montant) { await sendMessage(msg.chat.id, 'المبلغ غلط. دخل رقم.'); return true; }
    data.montant = montant;
    await setConv({ chat_id: msg.chat.id, command: 'cheque', step: 'echeance', data });
    await sendMessage(msg.chat.id, 'تاريخ الاستحقاق (YYYY-MM-DD):', { replyMarkup: REMOVE_KB });
    return true;
  }

  if (conv.step === 'echeance') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(txt)) {
      await sendMessage(msg.chat.id, 'التاريخ خاصو يكون YYYY-MM-DD. مثال: 2026-05-15');
      return true;
    }
    const { data: rows } = await sb.from('cheques').select('num').order('num', { ascending: false }).limit(100);
    let maxN = 0;
    (rows || []).forEach((r) => {
      const s = String(r.num ?? '');
      const m = s.match(/^CHK-(\d+)$/);
      if (m) maxN = Math.max(maxN, Number(m[1]));
      else if (/^\d+$/.test(s)) maxN = Math.max(maxN, Number(s));
    });
    const num = `CHK-${String(maxN + 1).padStart(4, '0')}`;

    const { data: saved, error } = await sb.from('cheques').insert({
      num, fournisseur: data.fournisseur, montant: Math.round((data.montant ?? 0) * 100) / 100,
      echeance: txt, date: todayCasa(), status: 'معلق', type: 'cheque',
    }).select().single();

    await endConv(msg.chat.id);

    if (error || !saved) {
      await sendMessage(msg.chat.id, `❌ خطأ ف حفظ الشيك: ${error?.message ?? '?'}`, { replyMarkup: REMOVE_KB });
      return true;
    }
    await sendMessage(
      msg.chat.id,
      `✅ *${num} محفوظ!*\n\n🏢 ${data.fournisseur}\n💰 ${fmtMoney(data.montant!)} د.م.\n📅 استحقاق: ${txt}`,
      { parseMode: 'Markdown', replyMarkup: REMOVE_KB },
    );
    return true;
  }

  return false;
}
