// Scheduled jobs — invoked by pg_cron via ?cron=<name>
// Each job fans out to: every chat_id in bot_subscribers + every web push
// subscription. Keeps the wording close to the old Python digest.

import { sb } from '../_shared/sb.ts';
import { sendMessage, sendDocument, type TgInlineKeyboard } from '../_shared/tg.ts';
import { sendWebPush } from '../_shared/push.ts';
import { buildTodayMessage } from './commands.ts';
import { todayCasa, fmtMoney, safeNum } from '../_shared/util.ts';
import { ftpUpload } from '../_shared/ftp.ts';

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
// Sends ONE message per due cheque with inline action buttons (paid / unpaid /
// defer 7 days). Matches the old Python telegram_bot flow.
export async function jobChequesTodayPing(): Promise<Response> {
  const today = todayCasa();
  const { data: dueToday } = await sb.from('cheques')
    .select('id,num,fournisseur,montant,type').eq('echeance', today).neq('status', 'مدفوع');
  if (!dueToday || !dueToday.length) {
    return new Response(JSON.stringify({ ok: true, job: 'cheques_today_ping', skipped: 'none_due' }));
  }

  const { data: subs } = await sb.from('bot_subscribers').select('chat_id');
  const chatIds = (subs ?? []).map((s: { chat_id: number }) => s.chat_id);

  let sent = 0;
  for (const c of dueToday) {
    const rid = c.id;
    const type = String(c.type ?? 'cheque').toLowerCase();
    const label = type === 'effet' ? '📝 كمبيالة (effet)' : '💳 شيك';
    const num = String(safeNum(c.num)).padStart(4, '0');
    const four = c.fournisseur ?? '?';
    const text = [
      `${label} — *حل اليوم*`,
      `رقم: ${num}`,
      `المورد: ${four}`,
      `المبلغ: *${fmtMoney(c.montant)} د.م.*`,
      `📅 ${today}`,
      '',
      'واش تخلص اليوم؟',
    ].join('\n');

    const replyMarkup: TgInlineKeyboard = {
      inline_keyboard: [
        [
          { text: '✅ تخلص', callback_data: `CHQPAID:${rid}` },
          { text: '❌ باقي',  callback_data: `CHQUNPAID:${rid}` },
        ],
        [{ text: '📅 أجّل 7 أيام', callback_data: `CHQDEFER:${rid}` }],
      ],
    };

    for (const chatId of chatIds) {
      try {
        await sendMessage(chatId, text, { parseMode: 'Markdown', replyMarkup });
        sent++;
      } catch (e) {
        console.error(`cheques_today_ping send to ${chatId} failed`, e);
      }
    }
  }

  const totalSum = dueToday.reduce((s, c) => s + safeNum(c.montant), 0);
  await sendWebPush(
    '⏰ شيكات اليوم',
    `${dueToday.length} شيك كيحل — ${fmtMoney(totalSum)} د.م.`,
    './#cheques',
    'cheques-ping',
  );
  return new Response(JSON.stringify({
    ok: true, job: 'cheques_today_ping', telegram: sent, cheques: dueToday.length,
  }));
}

// ── workers_eod — 20h Casa daily attendance digest ─────────────
// Per-worker breakdown: status icon + name + hours + computed pay.
const _STATUS_LABELS: Record<string, { icon: string; lbl: string }> = {
  present: { icon: '✅', lbl: 'حاضر' },
  absent:  { icon: '🔴', lbl: 'غائب' },
  conge:   { icon: '🟡', lbl: 'عطلة' },
  demi:    { icon: '🟠', lbl: 'نصف نهار' },
};

export async function jobWorkersEod(): Promise<Response> {
  const today = todayCasa();

  // Embedded FK select: salarie_presences.salarie_id → salaries
  const { data: pres } = await sb.from('salarie_presences')
    .select('statut,heures_supp,taux_horaire,salaries(nom,prenom)')
    .eq('date', today);

  // Embedded FK select: ouvrier_pc_presences.ouvrier_id → ouvriers_pc
  const { data: pcPres } = await sb.from('ouvrier_pc_presences')
    .select('qte,prix,pc_nom,ouvriers_pc(nom)')
    .eq('date', today);

  const presN = pres?.length ?? 0;
  const pcN   = pcPres?.length ?? 0;
  if (presN === 0 && pcN === 0) {
    return new Response(JSON.stringify({ ok: true, job: 'workers_eod', skipped: 'empty' }));
  }

  let text = `🧑‍🔧 *خلاصة الخدامة — ${today}*\n`;

  if (presN > 0) {
    text += '\n*👥 الأجراء:*\n';
    let totalHsup = 0, totalHsupCost = 0;
    let presentCount = 0, absentCount = 0, congeCount = 0, demiCount = 0;
    for (const p of pres!) {
      const s   = _STATUS_LABELS[String(p.statut)] || { icon: '·', lbl: String(p.statut || '?') };
      const sal = (p as { salaries?: { nom?: string; prenom?: string } }).salaries;
      const nom = ((sal?.nom || '?') + (sal?.prenom ? ' ' + sal.prenom : '')).trim();
      const hsup = Number(p.heures_supp || 0);
      const taux = Number(p.taux_horaire || 0);
      const cost = hsup * taux;
      totalHsup += hsup;
      totalHsupCost += cost;
      if (p.statut === 'present') presentCount++;
      else if (p.statut === 'absent') absentCount++;
      else if (p.statut === 'conge') congeCount++;
      else if (p.statut === 'demi') demiCount++;
      let line = `${s.icon} ${nom} · ${s.lbl}`;
      if (hsup > 0) {
        line += ` · +${hsup}h`;
        if (taux > 0) line += ` × ${fmtMoney(taux)} = *${fmtMoney(cost)} د.م.*`;
      }
      text += line + '\n';
    }
    const summary: string[] = [];
    if (presentCount) summary.push(`${presentCount} حاضر`);
    if (absentCount)  summary.push(`${absentCount} غائب`);
    if (congeCount)   summary.push(`${congeCount} عطلة`);
    if (demiCount)    summary.push(`${demiCount} نص نهار`);
    if (summary.length) text += `\n📊 ${summary.join(' · ')}`;
    if (totalHsup > 0) text += `\n⏱️ ساعات إضافية: ${totalHsup}h · *${fmtMoney(totalHsupCost)} د.م.*`;
    text += '\n';
  }

  if (pcN > 0) {
    text += '\n*👷 عمال PCs:*\n';
    let totalQte = 0, totalCost = 0;
    for (const r of pcPres!) {
      const ouv = (r as { ouvriers_pc?: { nom?: string } }).ouvriers_pc;
      const nom = ouv?.nom || '?';
      const qte  = Number(r.qte || 0);
      const prix = Number(r.prix || 0);
      const cost = qte * prix;
      totalQte += qte;
      totalCost += cost;
      text += `✅ ${nom} · ${r.pc_nom} · ${qte} × ${fmtMoney(prix)} = *${fmtMoney(cost)} د.م.*\n`;
    }
    text += `\n📦 المجموع: ${totalQte} قطعة · *${fmtMoney(totalCost)} د.م.*\n`;
  }

  const sent = await broadcastTelegram(text);
  return new Response(JSON.stringify({
    ok: true, job: 'workers_eod', telegram: sent,
    salaries: presN, pcs: pcN,
  }));
}

// ── daily_report — 20:30 Casa, full business-day digest ───────
// Comprehensive end-of-day digest covering every meaningful transaction
// for today: spending (bons d'entrée), inflow (cheques + factures),
// stock movement (bons_sortie + legacy material_dispatches), caisse
// ledger, low-stock alerts, and a brief workers headline (the detailed
// per-worker digest stays in jobWorkersEod, fired at 20:00 Casa).
export async function jobDailyReport(): Promise<Response> {
  const today = todayCasa();

  // Run all reads in parallel so the function stays well under the 60s
  // edge-function budget even on a very busy day.
  const [
    bonsRes, cheRes, factRes, bsRes, bsLinesRes,
    caisseRes, mdRes, soRes, alertsRes,
    presRes, pcPresRes,
  ] = await Promise.all([
    sb.from('bons').select('id,total,total_net,fournisseur').eq('date', today),
    sb.from('cheques').select('id,montant,type,fournisseur,status').eq('date', today),
    sb.from('factures').select('id,total_ttc,total_ht,client').eq('date', today),
    sb.from('bons_sortie').select('id,bon_number,department_id,destination').eq('date', today),
    sb.from('bons_sortie_lines').select('bon_id,qty'),
    sb.from('caisse_movements').select('type,montant').eq('date', today),
    sb.from('material_dispatches').select('id,quantity').gte('created_at', today + 'T00:00:00').lte('created_at', today + 'T23:59:59'),
    sb.from('subcontracting_orders').select('id,quantity_received,labor_cost_per_piece_ttc,technician_name').gte('created_at', today + 'T00:00:00').lte('created_at', today + 'T23:59:59'),
    sb.from('articles').select('id,nom,stock,stock_min').not('stock_min', 'is', null),
    sb.from('salarie_presences').select('statut,heures_supp,taux_horaire').eq('date', today),
    sb.from('ouvrier_pc_presences').select('qte,prix').eq('date', today),
  ]);

  const bons   = bonsRes.data  ?? [];
  const cheq   = cheRes.data   ?? [];
  const fact   = factRes.data  ?? [];
  const bs     = bsRes.data    ?? [];
  const bsLn   = bsLinesRes.data ?? [];
  const caisse = caisseRes.data ?? [];
  const md     = mdRes.data    ?? [];
  const so     = soRes.data    ?? [];
  const arts   = alertsRes.data ?? [];
  const pres   = presRes.data  ?? [];
  const pcPres = pcPresRes.data ?? [];

  // Build per-department BS roll-ups (resolve dept name once).
  const bsByDept: Record<number, { count: number; qty: number; lines: number }> = {};
  const linesByBon: Record<number, number> = {};
  for (const l of bsLn) {
    const bid = Number((l as { bon_id: number }).bon_id);
    linesByBon[bid] = (linesByBon[bid] ?? 0) + Number((l as { qty: number }).qty || 0);
  }
  for (const b of bs) {
    const did = Number((b as { department_id: number }).department_id);
    const bid = Number((b as { id: number }).id);
    if (!bsByDept[did]) bsByDept[did] = { count: 0, qty: 0, lines: 0 };
    bsByDept[did].count++;
    bsByDept[did].qty += linesByBon[bid] ?? 0;
    // line-count per bon: count rows in bsLn that match this bon
    bsByDept[did].lines += bsLn.filter((l) => Number((l as { bon_id: number }).bon_id) === bid).length;
  }
  const deptIds = Object.keys(bsByDept).map((k) => Number(k));
  let depts: Array<{ id: number; name: string; icon: string }> = [];
  if (deptIds.length) {
    const { data: depRows } = await sb.from('departments').select('id,name,icon').in('id', deptIds);
    depts = (depRows ?? []) as Array<{ id: number; name: string; icon: string }>;
  }

  // Spending
  const totBonsHT  = bons.reduce((s, b) => s + Number((b as { total: number }).total || 0), 0);
  const totBonsNet = bons.reduce((s, b) => s + Number((b as { total_net: number }).total_net || 0), 0);
  // Inflow
  const totFactTTC = fact.reduce((s, f) => s + Number((f as { total_ttc: number }).total_ttc || 0), 0);
  const totFactHT  = fact.reduce((s, f) => s + Number((f as { total_ht: number }).total_ht || 0), 0);
  // Cheques (net of paid)
  const totCheqAll  = cheq.reduce((s, c) => s + Number((c as { montant: number }).montant || 0), 0);
  const totCheqPaid = cheq.filter((c) => (c as { status: string }).status === 'مدفوع')
                          .reduce((s, c) => s + Number((c as { montant: number }).montant || 0), 0);
  // Caisse net
  let caisseIn = 0, caisseOut = 0;
  for (const m of caisse) {
    const v = Number((m as { montant: number }).montant || 0);
    if (String((m as { type: string }).type) === 'in') caisseIn += v;
    else caisseOut += v;
  }
  // Workers brief
  let presentCount = 0, absentCount = 0, demiCount = 0, congeCount = 0;
  let totalHsup = 0, totalHsupCost = 0;
  for (const p of pres) {
    const st = String((p as { statut: string }).statut);
    if (st === 'present') presentCount++;
    else if (st === 'absent') absentCount++;
    else if (st === 'conge') congeCount++;
    else if (st === 'demi') demiCount++;
    const hs = Number((p as { heures_supp: number }).heures_supp || 0);
    const tx = Number((p as { taux_horaire: number }).taux_horaire || 0);
    totalHsup += hs;
    totalHsupCost += hs * tx;
  }
  let pcQte = 0, pcCost = 0;
  for (const r of pcPres) {
    const q = Number((r as { qte: number }).qte || 0);
    const p = Number((r as { prix: number }).prix || 0);
    pcQte += q;
    pcCost += q * p;
  }
  // Subcontracting
  let soDelivered = 0, soLaborCost = 0;
  for (const r of so) {
    const q = Number((r as { quantity_received: number }).quantity_received || 0);
    const lc = Number((r as { labor_cost_per_piece_ttc: number }).labor_cost_per_piece_ttc || 0);
    soDelivered += q;
    soLaborCost += q * lc;
  }
  // Low-stock alerts
  const lowStock = arts.filter((a) => {
    const stk = Number((a as { stock: number }).stock || 0);
    const min = Number((a as { stock_min: number }).stock_min || 0);
    return min > 0 && stk < min;
  });

  // ── Build the Markdown digest ─────────────────────────────────
  const lines: string[] = [];
  lines.push(`📊 *خلاصة النهار — ${today}*`);
  lines.push('');

  // Spending block
  if (bons.length) {
    lines.push(`💸 *المصاريف (بونات)*`);
    lines.push(`📋 ${bons.length} بون · المجموع: *${fmtMoney(totBonsNet || totBonsHT)} د.م.*`);
    lines.push('');
  }

  // Inflow block
  if (fact.length) {
    lines.push(`💰 *المداخيل (فواتير)*`);
    lines.push(`🧾 ${fact.length} فاتورة · TTC: *${fmtMoney(totFactTTC)} د.م.* (HT: ${fmtMoney(totFactHT)})`);
    lines.push('');
  }
  if (cheq.length) {
    lines.push(`💳 *الشيكات (مسجلة اليوم)*`);
    lines.push(`📝 ${cheq.length} شيك · المجموع: *${fmtMoney(totCheqAll)} د.م.*` +
      (totCheqPaid ? ` · مدفوع: ${fmtMoney(totCheqPaid)}` : ''));
    lines.push('');
  }

  // Stock outflow (BS hub + legacy elec dispatches)
  if (bs.length || md.length) {
    lines.push(`📤 *خروج المخزون*`);
    if (bs.length) {
      lines.push(`بونات الخروج: *${bs.length}* بون · ${Object.values(bsByDept).reduce((s, d) => s + d.lines, 0)} سطر`);
      for (const did of deptIds) {
        const r = bsByDept[did];
        const d = depts.find((x) => Number(x.id) === did);
        const label = d ? `${d.icon || ''} ${d.name}` : `#${did}`;
        lines.push(`  • ${label}: ${r.count} بون · ${r.lines} سطر · ${r.qty} قطعة`);
      }
    }
    if (md.length) {
      const mdQty = md.reduce((s, m) => s + Number((m as { quantity: number }).quantity || 0), 0);
      lines.push(`⚡ Élec dispatches (legacy): ${md.length} · ${mdQty} قطعة`);
    }
    lines.push('');
  }

  // Caisse net
  if (caisseIn || caisseOut) {
    const net = caisseIn - caisseOut;
    lines.push(`💵 *الصندوق*`);
    lines.push(`⬆️ ${fmtMoney(caisseIn)} · ⬇️ ${fmtMoney(caisseOut)} · صافي: *${fmtMoney(net)} د.م.*`);
    lines.push('');
  }

  // Workers brief (detailed view stays in workers_eod)
  if (pres.length || pcPres.length) {
    lines.push(`🧑‍🔧 *الخدامة (نظرة سريعة)*`);
    if (pres.length) {
      const parts: string[] = [];
      if (presentCount) parts.push(`${presentCount} حاضر`);
      if (absentCount)  parts.push(`${absentCount} غائب`);
      if (congeCount)   parts.push(`${congeCount} عطلة`);
      if (demiCount)    parts.push(`${demiCount} نص نهار`);
      lines.push(`👥 ${pres.length} تسجيل (${parts.join(' · ') || '—'})` +
        (totalHsup ? ` · ⏱ ${totalHsup}h × ${fmtMoney(totalHsupCost)} د.م.` : ''));
    }
    if (pcPres.length) {
      lines.push(`👷 PCs: ${pcQte} قطعة · *${fmtMoney(pcCost)} د.م.*`);
    }
    lines.push('');
  }

  // Subcontracting (techs)
  if (so.length) {
    lines.push(`🤝 *المقاولة (تقنيون)*`);
    lines.push(`${so.length} تسليم · ${soDelivered} قطعة · يد عاملة: *${fmtMoney(soLaborCost)} د.م.*`);
    lines.push('');
  }

  // Low-stock alerts
  if (lowStock.length) {
    lines.push(`⚠️ *تنبيهات المخزون (${lowStock.length})*`);
    for (const a of lowStock.slice(0, 10)) {
      const stk = Number((a as { stock: number }).stock || 0);
      const min = Number((a as { stock_min: number }).stock_min || 0);
      const nom = String((a as { nom: string }).nom || '?');
      lines.push(`  • ${nom} · باقي ${stk} (الحد ${min})`);
    }
    if (lowStock.length > 10) lines.push(`  …(+${lowStock.length - 10} okhrin)`);
    lines.push('');
  }

  // Empty-state (don't broadcast a content-less ping)
  if (lines.length <= 2) {
    return new Response(JSON.stringify({ ok: true, job: 'daily_report', skipped: 'empty' }));
  }

  const sent = await broadcastTelegram(lines.join('\n'));
  return new Response(JSON.stringify({
    ok: true, job: 'daily_report', telegram: sent,
    bons: bons.length, cheq: cheq.length, fact: fact.length,
    bs: bs.length, md: md.length, so: so.length,
    caisse_in: caisseIn, caisse_out: caisseOut,
    low_stock: lowStock.length,
    pres: pres.length, pc_pres: pcPres.length,
  }));
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

// ── backup_telegram + backup_gdrive — daily 02:00 Casa ────────
// Dump every business table to JSON, then fan out to:
//   - Telegram (sendDocument to every bot_subscribers chat)
//   - Google Drive (multipart upload to a service-account-shared folder)
// Retention is manual on both ends.
const BACKUP_TABLES = [
  'fournisseurs', 'articles', 'prix', 'bons', 'cheques', 'supplier_products',
  'salaries', 'salarie_presences', 'salarie_avances', 'salarie_taswiyas', 'sal_catalogue',
  'ouvriers_pc', 'ouvrier_pc_assign', 'ouvrier_pc_presences',
  'fact_clients', 'fact_produits', 'factures', 'fact_societe',
  'chantiers', 'technicians', 'products', 'product_recipe',
  'material_dispatches', 'subcontracting_orders', 'material_returns', 'technician_payments',
  'bot_subscribers', 'push_subscriptions', 'audit_log',
];

// Build the JSON dump once — both destinations share the bytes.
async function buildBackupDump(): Promise<{
  today: string;
  json: string;
  totalRows: number;
  errors: string[];
}> {
  const today = todayCasa();
  const dump: Record<string, unknown> = {
    _meta: {
      exportedAt: new Date().toISOString(),
      casablancaDate: today,
      version: 'auto-cron',
      tables: BACKUP_TABLES.length,
    },
  };
  let totalRows = 0;
  const errors: string[] = [];
  for (const t of BACKUP_TABLES) {
    const { data, error } = await sb.from(t).select('*');
    if (error) {
      console.error('backup table', t, error);
      dump[t] = { _error: error.message };
      errors.push(t);
    } else {
      dump[t] = data;
      totalRows += data?.length ?? 0;
    }
  }
  return { today, json: JSON.stringify(dump, null, 2), totalRows, errors };
}

// ── Google service-account JWT → access token → Drive upload ──
// Pure Deno: no SDK. Signs the JWT with crypto.subtle (RS256) using the
// SA's PEM private key from env GDRIVE_SA_KEY (the whole JSON blob).
function _b64urlNoPad(buf: Uint8Array | string): string {
  const s = typeof buf === 'string' ? btoa(buf) : btoa(String.fromCharCode(...buf));
  return s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function _importPkcs8Pem(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/g, '')
                  .replace(/-----END PRIVATE KEY-----/g, '')
                  .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );
}

async function getGcpAccessToken(saKey: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = _b64urlNoPad(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = _b64urlNoPad(JSON.stringify({
    iss: saKey.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = header + '.' + claim;
  const key = await _importPkcs8Pem(saKey.private_key);
  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned),
  );
  const sig = _b64urlNoPad(new Uint8Array(sigBuf));
  const jwt = unsigned + '.' + sig;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });
  const json = await res.json();
  if (!json.access_token) {
    throw new Error('GCP token exchange failed: ' + JSON.stringify(json));
  }
  return json.access_token as string;
}

async function uploadToDrive(token: string, folderId: string, filename: string, content: string): Promise<{ id: string; name: string; webViewLink?: string }> {
  const boundary = '----madera-' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name: filename, parents: [folderId] });
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    meta + '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    content + '\r\n' +
    `--${boundary}--`;
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const e = await res.text();
    throw new Error('Drive upload failed: ' + res.status + ' ' + e);
  }
  return await res.json();
}

export async function jobBackupTelegram(): Promise<Response> {
  const { today, json, totalRows, errors } = await buildBackupDump();
  const filename = `backup-maderadeco-${today}.json`;
  const sizeKb = (json.length / 1024).toFixed(1);
  const errLine = errors.length ? `\n⚠️ خطأ ف ${errors.length} tables: ${errors.join(', ')}` : '';
  const caption = `🗄️ *Backup auto* — ${today}\n📊 ${totalRows} sajalat · ${BACKUP_TABLES.length} tables · ${sizeKb} KB${errLine}`;

  const blob = new Blob([json], { type: 'application/json' });

  const { data: subs } = await sb.from('bot_subscribers').select('chat_id');
  const chatIds = (subs ?? []).map((s: { chat_id: number }) => s.chat_id);

  let sent = 0;
  for (const chatId of chatIds) {
    try {
      const ok = await sendDocument(chatId, blob, filename, { caption, parseMode: 'Markdown' });
      if (ok) sent++;
    } catch (e) {
      console.error('backup send to', chatId, 'failed', e);
    }
  }

  return new Response(JSON.stringify({
    ok: true, job: 'backup', telegram: sent, rows: totalRows, size_kb: Number(sizeKb), errors,
  }));
}

export async function jobBackupGdrive(): Promise<Response> {
  const saKeyRaw = Deno.env.get('GDRIVE_SA_KEY');
  const folderId = Deno.env.get('GDRIVE_FOLDER_ID');
  if (!saKeyRaw || !folderId) {
    return new Response(JSON.stringify({
      ok: false, job: 'gdrive_backup',
      error: 'GDRIVE_SA_KEY or GDRIVE_FOLDER_ID env not set',
    }), { status: 200 });
  }
  let saKey: { client_email: string; private_key: string };
  try {
    saKey = JSON.parse(saKeyRaw);
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false, job: 'gdrive_backup',
      error: 'GDRIVE_SA_KEY is not valid JSON: ' + (e as Error).message,
    }), { status: 200 });
  }
  const { today, json, totalRows, errors } = await buildBackupDump();
  const filename = `backup-maderadeco-${today}.json`;
  try {
    const token = await getGcpAccessToken(saKey);
    const file = await uploadToDrive(token, folderId, filename, json);
    return new Response(JSON.stringify({
      ok: true, job: 'gdrive_backup', file: file.id, name: file.name,
      rows: totalRows, errors,
    }));
  } catch (e) {
    console.error('gdrive backup failed', e);
    return new Response(JSON.stringify({
      ok: false, job: 'gdrive_backup',
      error: (e as Error).message || String(e),
    }), { status: 200 });
  }
}

export async function jobBackupFtp(): Promise<Response> {
  const host = Deno.env.get('HOSTINGER_FTP_HOST');
  const user = Deno.env.get('HOSTINGER_FTP_USER');
  const pass = Deno.env.get('HOSTINGER_FTP_PASS');
  if (!host || !user || !pass) {
    return new Response(JSON.stringify({
      ok: false, job: 'ftp_backup',
      error: 'HOSTINGER_FTP_HOST/USER/PASS env not set',
    }), { status: 200 });
  }
  const { today, json, totalRows, errors } = await buildBackupDump();
  const filename = `backup-maderadeco-${today}.json`;
  const remotePath = `backups/${filename}`;
  try {
    await ftpUpload({ host, user, pass, remotePath, content: json });
    return new Response(JSON.stringify({
      ok: true, job: 'ftp_backup', remote: remotePath,
      rows: totalRows, errors,
    }));
  } catch (e) {
    console.error('ftp backup failed', e);
    return new Response(JSON.stringify({
      ok: false, job: 'ftp_backup',
      error: (e as Error).message || String(e),
    }), { status: 200 });
  }
}

// Combined: fire all configured destinations in one cron call. Each side runs
// independently — one failing must not block the others.
export async function jobBackupAll(): Promise<Response> {
  const tgRes = await jobBackupTelegram().catch((e) => new Response(JSON.stringify({ ok: false, error: String(e) })));
  const gdRes = await jobBackupGdrive().catch((e) => new Response(JSON.stringify({ ok: false, error: String(e) })));
  const ftpRes = await jobBackupFtp().catch((e) => new Response(JSON.stringify({ ok: false, error: String(e) })));
  const tg  = await tgRes.json().catch(() => ({}));
  const gd  = await gdRes.json().catch(() => ({}));
  const ftp = await ftpRes.json().catch(() => ({}));
  return new Response(JSON.stringify({ ok: true, telegram: tg, gdrive: gd, ftp }));
}
