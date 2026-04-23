// Telegram command handlers. Simple request→reply flows (no multi-step state).
// Multi-step commands (/newbon, /cheque) live in conversations.ts.

import { sb, SB_REST, SB_HEADERS } from '../_shared/sb.ts';
import { sendMessage, type TgMessage } from '../_shared/tg.ts';
import { sendWebPush } from '../_shared/push.ts';
import { fmtMoney, todayCasa, TZ, safeNum } from '../_shared/util.ts';

// ── /start ──────────────────────────────────────────────────────
export async function cmdStart(msg: TgMessage): Promise<void> {
  const name = msg.from.first_name || 'صاحبي';
  const help = [
    `👋 أهلا *${name}*!`,
    '',
    'سويفي — بوت التيليگرام:',
    '',
    '*الأوامر الأساسية:*',
    '/today — خلاصة اليوم',
    '/balance — رصيد البونات و الشيكات',
    '/stock `<سلعة>` — مخزون سلعة',
    '/listbons — آخر البونات',
    '',
    '*إضافة بيانات:*',
    '/newbon — إضافة بون جديد (مع السلع)',
    '/cheque — إضافة شيك جديد',
    '/cancel — إلغاء العملية الجارية',
    '',
    '*الإشعارات:*',
    '/subscribe — تفعيل إشعارات الصباح',
    '/unsubscribe — إيقاف الإشعارات',
    '/testpush — تجربة إشعار Web Push',
  ].join('\n');
  await sendMessage(msg.chat.id, help, { parseMode: 'Markdown' });
}

// ── /subscribe + /unsubscribe — manages chat_ids table ──────────
export async function cmdSubscribe(msg: TgMessage): Promise<void> {
  const { error } = await sb.from('bot_subscribers').upsert({ chat_id: msg.chat.id }, { onConflict: 'chat_id' });
  if (error) {
    await sendMessage(msg.chat.id, `⚠️ فشل الاشتراك: ${error.message}`);
    return;
  }
  await sendMessage(msg.chat.id, '✅ مشترك! غادي تجيك إشعارات كل صباح.');
}

export async function cmdUnsubscribe(msg: TgMessage): Promise<void> {
  await sb.from('bot_subscribers').delete().eq('chat_id', msg.chat.id);
  await sendMessage(msg.chat.id, '🔕 تم إلغاء الاشتراك.');
}

// ── /testpush ───────────────────────────────────────────────────
export async function cmdTestPush(msg: TgMessage): Promise<void> {
  const hour = new Date().toLocaleString('fr-MA', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  const res = await sendWebPush('🧪 تجربة push', `الإشعارات خدّامة! (${hour})`, './#dashboard', 'testpush');
  if (res.sent === 0 && res.dead === 0) {
    await sendMessage(msg.chat.id, '🔕 ما كاين حتى مشترك ف Web Push. زيد التطبيق مـ Admin.');
    return;
  }
  await sendMessage(msg.chat.id, `✅ تصيفطو الإشعار لـ ${res.sent} مشترك.` + (res.dead ? ` (${res.dead} دابا محذوفين)` : ''));
}

// ── /today — daily summary ──────────────────────────────────────
export async function cmdToday(msg: TgMessage): Promise<void> {
  const today = todayCasa();
  const text = await buildTodayMessage(today);
  await sendMessage(msg.chat.id, text, { parseMode: 'Markdown' });
}

export async function buildTodayMessage(today: string): Promise<string> {
  const { data: dueToday } = await sb.from('cheques')
    .select('num,fournisseur,montant,echeance,type,status').eq('echeance', today)
    .neq('status', 'مدفوع').order('montant', { ascending: false });
  const { data: overdue } = await sb.from('cheques')
    .select('num,fournisseur,montant,echeance,type,status').lt('echeance', today)
    .neq('status', 'مدفوع').order('echeance', { ascending: true }).limit(15);

  if ((!dueToday || !dueToday.length) && (!overdue || !overdue.length)) {
    return `✅ *الشيكات — ${today}*\n\nما كاين حتى شيك اليوم أو متأخر.`;
  }

  const lines = [`💳 *الشيكات — ${today}*`, ''];
  if (dueToday && dueToday.length) {
    const total = dueToday.reduce((s, c) => s + safeNum(c.montant), 0);
    lines.push(`🔔 *اليوم كيحل (${dueToday.length}):*`);
    dueToday.forEach((c) => {
      const n = String(safeNum(c.num)).padStart(4, '0');
      lines.push(`• CHK-${n} — ${c.fournisseur ?? '?'} — *${fmtMoney(c.montant)} د.م.*`);
    });
    lines.push(`   _المجموع: ${fmtMoney(total)} د.م._`, '');
  }
  if (overdue && overdue.length) {
    const totalO = overdue.reduce((s, c) => s + safeNum(c.montant), 0);
    lines.push(`⚠️ *متأخر (${overdue.length}):*`);
    overdue.slice(0, 10).forEach((c) => {
      const n = String(safeNum(c.num)).padStart(4, '0');
      lines.push(`• CHK-${n} — ${c.fournisseur ?? '?'} — ${fmtMoney(c.montant)} د.م. (${c.echeance})`);
    });
    if (overdue.length > 10) lines.push(`   _... و ${overdue.length - 10} شيكات أخرى_`);
    lines.push(`   _المجموع المتأخر: ${fmtMoney(totalO)} د.م._`);
  }
  return lines.join('\n');
}

// ── /balance — open bons + cheques due soon ─────────────────────
export async function cmdBalance(msg: TgMessage): Promise<void> {
  const { data: openBons } = await sb.from('bons')
    .select('num,fournisseur,total,date').is('cheque_id', null).order('date', { ascending: false });
  const today = todayCasa();
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const { data: dueSoon } = await sb.from('cheques')
    .select('num,fournisseur,montant,echeance').neq('status', 'مدفوع')
    .gte('echeance', today).lte('echeance', in7).order('echeance', { ascending: true });

  const lines = ['⚖️ *الرصيد:*', ''];
  if (openBons && openBons.length) {
    const total = openBons.reduce((s, b) => s + safeNum(b.total), 0);
    lines.push(`📋 *بونات بلا شيك (${openBons.length}):* ${fmtMoney(total)} د.م.`);
    openBons.slice(0, 8).forEach((b) => {
      const n = String(safeNum(b.num)).padStart(4, '0');
      lines.push(`• BON-${n} — ${b.fournisseur ?? '?'} — ${fmtMoney(b.total)}`);
    });
    if (openBons.length > 8) lines.push(`   _... و ${openBons.length - 8} آخرين_`);
    lines.push('');
  }
  if (dueSoon && dueSoon.length) {
    const total = dueSoon.reduce((s, c) => s + safeNum(c.montant), 0);
    lines.push(`📅 *شيكات ف 7 أيام (${dueSoon.length}):* ${fmtMoney(total)} د.م.`);
    dueSoon.slice(0, 8).forEach((c) => {
      const n = String(safeNum(c.num)).padStart(4, '0');
      lines.push(`• CHK-${n} — ${c.fournisseur ?? '?'} — ${fmtMoney(c.montant)} (${c.echeance})`);
    });
  }
  if (lines.length === 2) lines.push('_— كلشي مفرّغ —_');
  await sendMessage(msg.chat.id, lines.join('\n'), { parseMode: 'Markdown' });
}

// ── /stock <query> ──────────────────────────────────────────────
export async function cmdStock(msg: TgMessage, args: string[]): Promise<void> {
  if (!args.length) {
    await sendMessage(msg.chat.id, 'استعمال: `/stock <اسم سلعة>`\nمثال: `/stock LED`', { parseMode: 'Markdown' });
    return;
  }
  const q = args.join(' ').trim();
  const { data: arts } = await sb.from('articles')
    .select('id,nom,ref,stock,unite,cat').ilike('nom', `%${q}%`).limit(10);
  if (!arts || !arts.length) {
    await sendMessage(msg.chat.id, `❌ ما لقينا حتى سلعة فيها "${q}".`);
    return;
  }
  const lines = [`📦 *السلع — "${q}":*`, ''];
  arts.forEach((a) => {
    const st = Number(a.stock ?? 0);
    const stockStr = st > 0 ? `${st} ${a.unite ?? ''}` : '❌ 0';
    lines.push(`• *${a.nom}* ${a.ref ? `(${a.ref})` : ''} — ${stockStr}`);
  });
  await sendMessage(msg.chat.id, lines.join('\n'), { parseMode: 'Markdown' });
}

// ── /listbons — last N bons ─────────────────────────────────────
export async function cmdListBons(msg: TgMessage): Promise<void> {
  const { data: bons } = await sb.from('bons')
    .select('num,fournisseur,total,date').order('date', { ascending: false }).limit(10);
  if (!bons || !bons.length) {
    await sendMessage(msg.chat.id, '— ما كاين حتى بون —');
    return;
  }
  const lines = ['📋 *آخر 10 بونات:*', ''];
  bons.forEach((b) => {
    const n = String(safeNum(b.num)).padStart(4, '0');
    lines.push(`• BON-${n} — ${b.fournisseur ?? '?'} — *${fmtMoney(b.total)}* — ${b.date}`);
  });
  await sendMessage(msg.chat.id, lines.join('\n'), { parseMode: 'Markdown' });
}

// ── /cancel — clears any conversation state (handled by the router) ─
export async function cmdCancel(msg: TgMessage): Promise<void> {
  await sb.from('bot_conversations').delete().eq('chat_id', msg.chat.id);
  await sendMessage(msg.chat.id, 'تم الإلغاء.', { replyMarkup: { remove_keyboard: true } });
}
