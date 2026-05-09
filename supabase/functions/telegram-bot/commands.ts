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
    '/khlas — الباقي للخدامة (اجراء + PCs + تقنيون)',
    '/caisse — حالة الصندوق + آخر الحركات',
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

// ── /khlas — outstanding wages owed to every worker ────────────
// Computes pending pay across the 3 worker types and reports per-worker
// totals plus a grand total. Defaults to "since last taswiya" boundary
// per worker; falls back to "since the beginning of time" if no taswiya
// is on file.
//
// Salaries: uses salary_rates effective-dated lookup so historical
// pointage doesn't get bumped by recent rate changes (matches the
// client-side getRateAtDate logic). Heures-supp totals come from each
// presence row's snapshotted taux_horaire.
//
// PCs: SUM(qte × prix) over presences since last pc_taswiya, minus
// non-reimbursed pc_avances.
//
// Elec techs: SUM(quantity_received × labor_cost_per_piece_ttc) over
// subcontracting_orders since last technician_payment, minus payments.
export async function cmdKhlas(msg: TgMessage): Promise<void> {
  type StatusFactor = Record<string, number>;
  const STATUS_FACTOR: StatusFactor = { present: 1, demi: 0.5, absent: 0, conge: 0 };

  // ── Pull everything in parallel ─────────────────────────────────
  const [salRes, salPresRes, salTaswRes, salRatesRes, salAvsRes,
        ouvRes, pcPresRes, pcTaswRes, pcAvsRes,
        techRes, soRes, techPayRes,
  ] = await Promise.all([
    sb.from('salaries').select('id,nom,prenom,actif,salaire_base,taux_hsup'),
    sb.from('salarie_presences').select('salarie_id,date,statut,heures_supp,taux_horaire'),
    sb.from('salarie_taswiyas').select('salarie_id,date_to'),
    sb.from('salary_rates').select('salarie_id,effective_from,salaire_base,taux_hsup'),
    sb.from('salarie_avances').select('salarie_id,date,montant'),
    sb.from('ouvriers_pc').select('id,nom,actif'),
    sb.from('ouvrier_pc_presences').select('ouvrier_id,date,qte,prix'),
    sb.from('pc_taswiyas').select('ouvrier_id,date_to'),
    sb.from('pc_avances').select('ouvrier_id,date,montant,rembourse'),
    sb.from('technicians').select('id,nom'),
    sb.from('subcontracting_orders').select('technician_name,quantity_received,labor_cost_per_piece_ttc,created_at'),
    sb.from('technician_payments').select('technician_name,amount,pay_date'),
  ]);

  const sals  = salRes.data ?? [];
  const sPres = salPresRes.data ?? [];
  const sTasw = salTaswRes.data ?? [];
  const sRates = salRatesRes.data ?? [];
  const sAvs  = salAvsRes.data ?? [];
  const ouvs  = ouvRes.data ?? [];
  const pPres = pcPresRes.data ?? [];
  const pTasw = pcTaswRes.data ?? [];
  const pAvs  = pcAvsRes.data ?? [];
  const techs = techRes.data ?? [];
  const so    = soRes.data ?? [];
  const tPay  = techPayRes.data ?? [];

  // Helpers
  const lastTasweyaForSal = (id: number): string => {
    const rows = sTasw.filter((t) => Number((t as { salarie_id: number }).salarie_id) === id);
    if (!rows.length) return '0000-01-01';
    return rows.map((r) => String((r as { date_to: string }).date_to)).sort().reverse()[0];
  };
  const lastTasweyaForPc = (id: number): string => {
    const rows = pTasw.filter((t) => Number((t as { ouvrier_id: number }).ouvrier_id) === id);
    if (!rows.length) return '0000-01-01';
    return rows.map((r) => String((r as { date_to: string }).date_to)).sort().reverse()[0];
  };
  const rateAtDate = (salId: number, isoDate: string): { base: number; hsup: number } => {
    const sal = sals.find((s) => Number((s as { id: number }).id) === salId);
    const fallback = {
      base: Number((sal as { salaire_base: number } | undefined)?.salaire_base ?? 0),
      hsup: Number((sal as { taux_hsup: number } | undefined)?.taux_hsup ?? 0),
    };
    const rows = sRates
      .filter((r) => Number((r as { salarie_id: number }).salarie_id) === salId)
      .filter((r) => String((r as { effective_from: string }).effective_from) <= isoDate)
      .sort((a, b) => String((b as { effective_from: string }).effective_from)
                       .localeCompare(String((a as { effective_from: string }).effective_from)));
    if (!rows.length) return fallback;
    const r = rows[0] as { salaire_base: number; taux_hsup: number };
    return {
      base: Number(r.salaire_base ?? fallback.base),
      hsup: Number(r.taux_hsup ?? fallback.hsup),
    };
  };

  // ── Salaries ────────────────────────────────────────────────────
  type SalRow = { id: number; nom: string; net: number };
  const salOut: SalRow[] = [];
  for (const s of sals) {
    const sid = Number((s as { id: number }).id);
    if ((s as { actif: boolean }).actif === false) continue;
    const since = lastTasweyaForSal(sid);
    const myPres = sPres.filter((p) => Number((p as { salarie_id: number }).salarie_id) === sid
                                     && String((p as { date: string }).date) > since);
    let wage = 0;
    for (const p of myPres) {
      const date = String((p as { date: string }).date);
      const status = String((p as { statut: string }).statut || 'present');
      const factor = STATUS_FACTOR[status] ?? 1;
      const hsup  = Number((p as { heures_supp: number }).heures_supp || 0);
      const taux  = Number((p as { taux_horaire: number }).taux_horaire || 0);
      const rate  = rateAtDate(sid, date);
      wage += factor * rate.base + hsup * (taux || rate.hsup);
    }
    const myAvs = sAvs.filter((a) => Number((a as { salarie_id: number }).salarie_id) === sid
                                   && String((a as { date: string }).date) > since)
                       .reduce((t, a) => t + Number((a as { montant: number }).montant || 0), 0);
    const net = wage - myAvs;
    if (Math.abs(net) < 0.01) continue;
    const sName = (s as { nom: string; prenom?: string });
    const fullName = (String(sName.nom || '?') + (sName.prenom ? ' ' + sName.prenom : '')).trim();
    salOut.push({ id: sid, nom: fullName, net });
  }

  // ── PCs ─────────────────────────────────────────────────────────
  type PcRow = { id: number; nom: string; net: number };
  const pcOut: PcRow[] = [];
  for (const o of ouvs) {
    const oid = Number((o as { id: number }).id);
    if ((o as { actif: boolean }).actif === false) continue;
    const since = lastTasweyaForPc(oid);
    const myPres = pPres.filter((r) => Number((r as { ouvrier_id: number }).ouvrier_id) === oid
                                     && String((r as { date: string }).date) > since);
    const wage = myPres.reduce((t, r) => t + Number((r as { qte: number }).qte || 0)
                                            * Number((r as { prix: number }).prix || 0), 0);
    const myAvs = pAvs.filter((a) => Number((a as { ouvrier_id: number }).ouvrier_id) === oid
                                   && (a as { rembourse: boolean }).rembourse !== true)
                       .reduce((t, a) => t + Number((a as { montant: number }).montant || 0), 0);
    const net = wage - myAvs;
    if (Math.abs(net) < 0.01) continue;
    pcOut.push({ id: oid, nom: String((o as { nom: string }).nom || '?'), net });
  }

  // ── Elec techs (subcontracting) ────────────────────────────────
  type TechRow = { nom: string; net: number };
  const techOut: TechRow[] = [];
  for (const t of techs) {
    const name = String((t as { nom: string }).nom || '');
    if (!name) continue;
    const earned = so.filter((r) => String((r as { technician_name: string }).technician_name) === name)
                     .reduce((s, r) => s + Number((r as { quantity_received: number }).quantity_received || 0)
                                       * Number((r as { labor_cost_per_piece_ttc: number }).labor_cost_per_piece_ttc || 0), 0);
    const paid = tPay.filter((p) => String((p as { technician_name: string }).technician_name) === name)
                     .reduce((s, p) => s + Number((p as { amount: number }).amount || 0), 0);
    const net = earned - paid;
    if (Math.abs(net) < 0.01) continue;
    techOut.push({ nom: name, net });
  }

  // ── Format reply ────────────────────────────────────────────────
  const lines: string[] = ['💰 *الباقي للخدامة:*', ''];
  let grand = 0;

  if (salOut.length) {
    salOut.sort((a, b) => b.net - a.net);
    const totWeek = salOut.reduce((t, r) => t + r.net, 0);
    grand += totWeek;
    lines.push(`👥 *الأجراء (الأسبوعي) — ${salOut.length} عامل · ${fmtMoney(totWeek)} د.م.*`);
    for (const r of salOut) {
      const sign = r.net < 0 ? '⚠️ ' : ''; // negative = workers owe back (rare)
      lines.push(`${sign}• ${r.nom} — *${fmtMoney(r.net)} د.م.*`);
    }
    lines.push('');
  }

  if (pcOut.length) {
    pcOut.sort((a, b) => b.net - a.net);
    const totPc = pcOut.reduce((t, r) => t + r.net, 0);
    grand += totPc;
    lines.push(`👷 *عمال PCs — ${pcOut.length} عامل · ${fmtMoney(totPc)} د.م.*`);
    for (const r of pcOut) {
      const sign = r.net < 0 ? '⚠️ ' : '';
      lines.push(`${sign}• ${r.nom} — *${fmtMoney(r.net)} د.م.*`);
    }
    lines.push('');
  }

  if (techOut.length) {
    techOut.sort((a, b) => b.net - a.net);
    const totTech = techOut.reduce((t, r) => t + r.net, 0);
    grand += totTech;
    lines.push(`⚡ *تقنيون (à distance) — ${techOut.length} تقني · ${fmtMoney(totTech)} د.م.*`);
    for (const r of techOut) {
      const sign = r.net < 0 ? '⚠️ ' : '';
      lines.push(`${sign}• ${r.nom} — *${fmtMoney(r.net)} د.م.*`);
    }
    lines.push('');
  }

  if (lines.length === 2) {
    lines.push('_— كلشي مخلص، ما كاين شي معلق —_');
  } else {
    lines.push(`📊 *المجموع المعلق: ${fmtMoney(grand)} د.م.*`);
  }

  await sendMessage(msg.chat.id, lines.join('\n'), { parseMode: 'Markdown' });
}

// ── /caisse — cash-box snapshot on demand ───────────────────────
export async function cmdCaisse(msg: TgMessage): Promise<void> {
  const today = todayCasa();
  const [allRes, todayRes, recent7Res] = await Promise.all([
    sb.from('caisse_movements').select('type,amount').is('deleted_at', null),
    sb.from('caisse_movements').select('type,amount,designation').eq('date', today).is('deleted_at', null),
    sb.from('caisse_movements').select('date,type,amount,designation').is('deleted_at', null)
      .order('id', { ascending: false }).limit(10),
  ]);
  const all      = allRes.data      ?? [];
  const todayRow = todayRes.data    ?? [];
  const recent   = recent7Res.data  ?? [];

  let inAll = 0, outAll = 0;
  for (const m of all) {
    const v = Number((m as { amount: number }).amount || 0);
    if ((m as { type: string }).type === 'in') inAll += v; else outAll += v;
  }
  let inToday = 0, outToday = 0;
  for (const m of todayRow) {
    const v = Number((m as { amount: number }).amount || 0);
    if ((m as { type: string }).type === 'in') inToday += v; else outToday += v;
  }

  const lines = [
    '💵 *حالة الصندوق*',
    '',
    `💼 الرصيد الحالي: *${fmtMoney(inAll - outAll)} د.م.*`,
    '',
    `📅 *اليوم (${today})*`,
    `⬆️ مداخيل: ${fmtMoney(inToday)} د.م.`,
    `⬇️ مخارج: ${fmtMoney(outToday)} د.م.`,
    `📊 صافي: *${fmtMoney(inToday - outToday)} د.م.*`,
  ];
  if (recent.length) {
    lines.push('', '🧾 *آخر 10 حركات:*');
    for (const m of recent) {
      const t = (m as { type: string }).type === 'in' ? '⬆️' : '⬇️';
      const sign = (m as { type: string }).type === 'in' ? '+' : '−';
      const amt = Number((m as { amount: number }).amount || 0);
      const desg = String((m as { designation: string }).designation || '—').slice(0, 40);
      const d = String((m as { date: string }).date || '');
      lines.push(`${t} ${sign}${fmtMoney(amt)} · ${desg} _(${d})_`);
    }
  }
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
