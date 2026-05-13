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

export async function debugWorkersEodText(): Promise<string> {
  return await buildWorkersEodText();
}

async function buildWorkersEodText(): Promise<string> {
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

  let text = `🧑‍🔧 *خلاصة الخدامة — ${today}*\n`;
  if (presN === 0 && pcN === 0) {
    text += '\n_ما كاينش حركة اليوم_\n';
  }

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

  // ── Cumulative unpaid balance per worker (since last tasweya) ─────
  // What the user owes RIGHT NOW. Resets to 0 when a tasweya is recorded.
  // Same logic as the in-app salaries page so the boss sees one consistent
  // running total: gross since last tasweya − unpaid avances.
  type Salarie = { id: number; nom?: string; prenom?: string; salaire_base?: number; taux_hsup?: number };
  type SalPres = { salarie_id: number; date: string; statut?: string; heures_supp?: number; taux_horaire?: number };
  type SalTas  = { salarie_id: number; date_to?: string; date_paiement?: string };
  type SalAv   = { salarie_id: number; montant: number; rembourse?: boolean };
  type PcOuv   = { id: number; nom?: string };
  type PcPres  = { ouvrier_id: number; date: string; qte: number; prix: number };
  type PcTas   = { ouvrier_id: number; date_to?: string };
  type PcAv    = { ouvrier_id: number; montant: number; rembourse?: boolean };

  type SubOrder = { technician_name?: string; quantity_received?: number; labor_cost_per_piece_ttc?: number };
  type TechPay  = { technician_name?: string; amount?: number };

  const [salList, allSalPres, salTas, salAv, pcList, allPcPres, pcTas, pcAv, subOrders, techPays] = await Promise.all([
    sb.from('salaries').select('id,nom,prenom,salaire_base,taux_hsup').then(r => (r.data || []) as Salarie[]),
    sb.from('salarie_presences').select('salarie_id,date,statut,heures_supp,taux_horaire').lte('date', today).then(r => (r.data || []) as SalPres[]),
    sb.from('salarie_taswiyas').select('salarie_id,date_to,date_paiement').then(r => (r.data || []) as SalTas[]),
    sb.from('salarie_avances').select('salarie_id,montant,rembourse').then(r => (r.data || []) as SalAv[]),
    sb.from('ouvriers_pc').select('id,nom').then(r => (r.data || []) as PcOuv[]),
    sb.from('ouvrier_pc_presences').select('ouvrier_id,date,qte,prix').lte('date', today).then(r => (r.data || []) as PcPres[]),
    sb.from('pc_taswiyas').select('ouvrier_id,date_to').then(r => (r.data || []) as PcTas[]),
    sb.from('pc_avances').select('ouvrier_id,montant,rembourse').then(r => (r.data || []) as PcAv[]),
    sb.from('subcontracting_orders').select('technician_name,quantity_received,labor_cost_per_piece_ttc').then(r => (r.data || []) as SubOrder[]),
    sb.from('technician_payments').select('technician_name,amount').then(r => (r.data || []) as TechPay[]),
  ]);

  const lastSalTaswiyaCutoff = (salId: number): string => {
    const rows = salTas.filter(t => Number(t.salarie_id) === salId);
    if (!rows.length) return '0000-01-01';
    return rows.map(t => String(t.date_to || '')).sort().pop() || '0000-01-01';
  };
  const lastPcTaswiyaCutoff = (pcId: number): string => {
    const rows = pcTas.filter(t => Number(t.ouvrier_id) === pcId);
    if (!rows.length) return '0000-01-01';
    return rows.map(t => String(t.date_to || '')).sort().pop() || '0000-01-01';
  };

  // Each worker has gross (what they earned since last tasweya), avances
  // (unpaid advances), payable = max(0, gross − avances), and rollover =
  // max(0, avances − gross). The bot reports "what's left to pay" (payable)
  // and surfaces rollover separately so the boss doesn't get a confusing
  // negative number when an advance exceeded the earnings.
  type WorkerLine = { name: string; gross: number; avances: number; payable: number; rollover: number };

  const salLines: WorkerLine[] = [];
  for (const s of salList) {
    const cutoff = lastSalTaswiyaCutoff(s.id);
    const myPres = allSalPres.filter(p => Number(p.salarie_id) === s.id && String(p.date) > cutoff);
    const base = Number(s.salaire_base || 0);
    let gross = 0;
    for (const p of myPres) {
      const mult = p.statut === 'present' ? 1 : p.statut === 'demi' ? 0.5 : 0;
      gross += mult * base;
      const hs = Number(p.heures_supp || 0);
      const tx = Number(p.taux_horaire || s.taux_hsup || 0);
      gross += hs * tx;
    }
    const av = salAv.filter(a => Number(a.salarie_id) === s.id && !a.rembourse).reduce((t, a) => t + Number(a.montant || 0), 0);
    const payable  = Math.max(0, gross - av);
    const rollover = Math.max(0, av - gross);
    if (payable <= 0.005 && rollover <= 0.005) continue;
    const fullName = ((s.nom || '?') + (s.prenom ? ' ' + s.prenom : '')).trim();
    salLines.push({ name: fullName, gross, avances: av, payable, rollover });
  }

  const pcLines: WorkerLine[] = [];
  for (const o of pcList) {
    const cutoff = lastPcTaswiyaCutoff(o.id);
    const myPres = allPcPres.filter(p => Number(p.ouvrier_id) === o.id && String(p.date) > cutoff);
    const gross = myPres.reduce((t, p) => t + Number(p.qte || 0) * Number(p.prix || 0), 0);
    const av = pcAv.filter(a => Number(a.ouvrier_id) === o.id && !a.rembourse).reduce((t, a) => t + Number(a.montant || 0), 0);
    const payable  = Math.max(0, gross - av);
    const rollover = Math.max(0, av - gross);
    if (payable <= 0.005 && rollover <= 0.005) continue;
    pcLines.push({ name: o.nom || ('PC #' + o.id), gross, avances: av, payable, rollover });
  }

  // Subcontracted technicians (électricité à distance) — running due:
  //   earned = Σ subcontracting_orders.quantity_received × labor_cost_per_piece_ttc
  //   paid   = Σ technician_payments.amount
  //   due    = max(0, earned − paid)
  // We list techs with a strictly positive due so the digest only shows what
  // remains to pay (negative balances are credits and not actionable here).
  const techMap: Record<string, { earned: number; paid: number }> = {};
  for (const o of subOrders) {
    const name = String(o.technician_name || '').trim();
    if (!name) continue;
    const earned = Number(o.quantity_received || 0) * Number(o.labor_cost_per_piece_ttc || 0);
    if (!techMap[name]) techMap[name] = { earned: 0, paid: 0 };
    techMap[name].earned += earned;
  }
  for (const p of techPays) {
    const name = String(p.technician_name || '').trim();
    if (!name) continue;
    if (!techMap[name]) techMap[name] = { earned: 0, paid: 0 };
    techMap[name].paid += Number(p.amount || 0);
  }
  const techLines: { name: string; earned: number; paid: number; due: number }[] = [];
  for (const name of Object.keys(techMap)) {
    const r = techMap[name];
    const due = r.earned - r.paid;
    if (due > 0.005) techLines.push({ name, earned: r.earned, paid: r.paid, due });
  }

  if (salLines.length || pcLines.length || techLines.length) {
    text += '\n━━━━━━━━━━━━━━━━━━\n*💰 المعلق التراكمي — كيخلصو غادي:*\n';
    let bigTotal = 0;
    let bigRollover = 0;
    const renderWorkerLine = (l: WorkerLine): string => {
      let line = `• ${l.name} → `;
      if (l.payable > 0.005) {
        line += `*${fmtMoney(l.payable)} د.م.*`;
        if (l.avances > 0.005) line += `  _(${fmtMoney(l.gross)} − سلف ${fmtMoney(l.avances)})_`;
      } else {
        // Avances exceed gross → nothing to pay this period; show rollover.
        line += `*0 د.م.*  🔄 _سلف فايضة: ${fmtMoney(l.rollover)} (كتمشي للأسبوع الجاي)_`;
      }
      return line + '\n';
    };
    if (salLines.length) {
      text += '\n👥 أجراء:\n';
      salLines.sort((a, b) => b.payable - a.payable);
      for (const l of salLines) {
        bigTotal += l.payable;
        bigRollover += l.rollover;
        text += renderWorkerLine(l);
      }
    }
    if (pcLines.length) {
      text += '\n👷 PCs:\n';
      pcLines.sort((a, b) => b.payable - a.payable);
      for (const l of pcLines) {
        bigTotal += l.payable;
        bigRollover += l.rollover;
        text += renderWorkerLine(l);
      }
    }
    if (techLines.length) {
      text += '\n🛠️ تقنيون (électricité à distance):\n';
      techLines.sort((a, b) => b.due - a.due);
      for (const l of techLines) {
        bigTotal += l.due;
        text += `• ${l.name} → *${fmtMoney(l.due)} د.م.*  _(${fmtMoney(l.earned)} − دفعات ${fmtMoney(l.paid)})_\n`;
      }
    }
    text += `\n🎯 *المجموع المعلق: ${fmtMoney(bigTotal)} د.م.*`;
    if (bigRollover > 0.005) text += `  _(+ سلف فايضة ${fmtMoney(bigRollover)} كترصد)_`;
    text += `\n_ℹ️ كيتراكم كل يوم. كيرجع 0 ملي تسجل تسوية._`;
  }

  return text;
}

export async function jobWorkersEod(): Promise<Response> {
  const text = await buildWorkersEodText();
  const sent = await broadcastTelegram(text);
  return new Response(JSON.stringify({
    ok: true, job: 'workers_eod', telegram: sent,
  }));
}

// ── Debug — return the per-worker cumulative breakdown as JSON. Gated by
// the cron-secret in index.ts; useful for reconciling against the in-app
// KPI when a discrepancy is reported.
export async function debugWorkerBreakdown(name: string): Promise<unknown> {
  const today = todayCasa();
  const needle = String(name || '').trim().toLowerCase();

  const [salList, salPres, salTas, salAv, pcList, pcPres, pcTas, pcAv, subOrders, techPays] = await Promise.all([
    sb.from('salaries').select('id,nom,prenom,salaire_base,taux_hsup').then(r => (r.data || []) as Array<{id:number;nom?:string;prenom?:string;salaire_base?:number;taux_hsup?:number}>),
    sb.from('salarie_presences').select('salarie_id,date,statut,heures_supp,taux_horaire').lte('date', today).then(r => (r.data || []) as Array<{salarie_id:number;date:string;statut?:string;heures_supp?:number;taux_horaire?:number}>),
    sb.from('salarie_taswiyas').select('salarie_id,date_from,date_to,date_paiement,montant').then(r => (r.data || []) as Array<{salarie_id:number;date_from?:string;date_to?:string;date_paiement?:string;montant?:number}>),
    sb.from('salarie_avances').select('salarie_id,date,montant,rembourse').then(r => (r.data || []) as Array<{salarie_id:number;date?:string;montant:number;rembourse?:boolean}>),
    sb.from('ouvriers_pc').select('id,nom').then(r => (r.data || []) as Array<{id:number;nom?:string}>),
    sb.from('ouvrier_pc_presences').select('ouvrier_id,date,qte,prix,pc_nom').lte('date', today).then(r => (r.data || []) as Array<{ouvrier_id:number;date:string;qte:number;prix:number;pc_nom?:string}>),
    sb.from('pc_taswiyas').select('ouvrier_id,date_from,date_to,montant').then(r => (r.data || []) as Array<{ouvrier_id:number;date_from?:string;date_to?:string;montant?:number}>),
    sb.from('pc_avances').select('ouvrier_id,date,montant,rembourse').then(r => (r.data || []) as Array<{ouvrier_id:number;date?:string;montant:number;rembourse?:boolean}>),
    sb.from('subcontracting_orders').select('technician_name,quantity_received,labor_cost_per_piece_ttc').then(r => (r.data || []) as Array<{technician_name?:string;quantity_received?:number;labor_cost_per_piece_ttc?:number}>),
    sb.from('technician_payments').select('technician_name,amount').then(r => (r.data || []) as Array<{technician_name?:string;amount?:number}>),
  ]);

  // ── Salarie match ─────────────────────────────────────────────
  const matchSal = salList.find(s => {
    const full = ((s.nom || '') + (s.prenom ? ' ' + s.prenom : '')).trim().toLowerCase();
    return full.includes(needle) || (s.nom || '').toLowerCase().includes(needle);
  });
  let salReport: unknown = null;
  if (matchSal) {
    const tasRows = salTas.filter(t => Number(t.salarie_id) === matchSal.id);
    const cutoff = tasRows.length
      ? tasRows.map(t => String(t.date_to || '')).sort().pop() || '0000-01-01'
      : '0000-01-01';
    const myPres = salPres.filter(p => Number(p.salarie_id) === matchSal.id && String(p.date) > cutoff);
    const base = Number(matchSal.salaire_base || 0);
    let gross = 0;
    const presBreakdown = myPres.map(p => {
      const mult = p.statut === 'present' ? 1 : p.statut === 'demi' ? 0.5 : 0;
      const wage = mult * base;
      const hs = Number(p.heures_supp || 0);
      const tx = Number(p.taux_horaire || matchSal.taux_hsup || 0);
      const hsupCost = hs * tx;
      gross += wage + hsupCost;
      return { date: p.date, statut: p.statut, mult, wage, hsup: hs, tx, hsupCost, line: wage + hsupCost };
    });
    const unpaidAv = salAv.filter(a => Number(a.salarie_id) === matchSal.id && !a.rembourse);
    const av = unpaidAv.reduce((t, a) => t + Number(a.montant || 0), 0);
    salReport = {
      kind: 'salarie',
      id: matchSal.id,
      name: ((matchSal.nom || '') + (matchSal.prenom ? ' ' + matchSal.prenom : '')).trim(),
      salaire_base: base,
      lastTaswiya: tasRows.sort((a, b) => String(a.date_to||'').localeCompare(String(b.date_to||''))).slice(-1)[0] || null,
      cutoff,
      presences_since_cutoff: presBreakdown,
      unpaid_avances: unpaidAv,
      gross,
      avances: av,
      payable: Math.max(0, gross - av),
      rollover: Math.max(0, av - gross),
    };
  }

  // ── PC match ──────────────────────────────────────────────────
  const matchPc = pcList.find(o => (o.nom || '').toLowerCase().includes(needle));
  let pcReport: unknown = null;
  if (matchPc) {
    const tasRows = pcTas.filter(t => Number(t.ouvrier_id) === matchPc.id);
    const cutoff = tasRows.length
      ? tasRows.map(t => String(t.date_to || '')).sort().pop() || '0000-01-01'
      : '0000-01-01';
    const myPres = pcPres.filter(p => Number(p.ouvrier_id) === matchPc.id && String(p.date) > cutoff);
    let gross = 0;
    const presBreakdown = myPres.map(p => {
      const line = Number(p.qte || 0) * Number(p.prix || 0);
      gross += line;
      return { date: p.date, pc_nom: p.pc_nom, qte: p.qte, prix: p.prix, line };
    });
    const unpaidAv = pcAv.filter(a => Number(a.ouvrier_id) === matchPc.id && !a.rembourse);
    const av = unpaidAv.reduce((t, a) => t + Number(a.montant || 0), 0);
    pcReport = {
      kind: 'pc',
      id: matchPc.id,
      name: matchPc.nom,
      lastTaswiya: tasRows.sort((a, b) => String(a.date_to||'').localeCompare(String(b.date_to||''))).slice(-1)[0] || null,
      cutoff,
      presences_since_cutoff: presBreakdown,
      unpaid_avances: unpaidAv,
      gross,
      avances: av,
      payable: Math.max(0, gross - av),
      rollover: Math.max(0, av - gross),
    };
  }

  // ── Technician match (subcontracting) ─────────────────────────
  const techNames = Array.from(new Set([
    ...subOrders.map(o => String(o.technician_name || '').trim()),
    ...techPays.map(p => String(p.technician_name || '').trim()),
  ].filter(Boolean)));
  const matchTech = techNames.find(n => n.toLowerCase().includes(needle));
  let techReport: unknown = null;
  if (matchTech) {
    const orders = subOrders.filter(o => String(o.technician_name).trim() === matchTech);
    const payments = techPays.filter(p => String(p.technician_name).trim() === matchTech);
    const earned = orders.reduce((t, o) => t + Number(o.quantity_received || 0) * Number(o.labor_cost_per_piece_ttc || 0), 0);
    const paid = payments.reduce((t, p) => t + Number(p.amount || 0), 0);
    techReport = {
      kind: 'technician',
      name: matchTech,
      earned,
      paid,
      due: Math.max(0, earned - paid),
      orders,
      payments,
    };
  }

  return {
    today,
    query: name,
    matches: { salarie: salReport, pc: pcReport, technician: techReport },
  };
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
    sb.from('factures').select('id,total_ttc,total_ht,client_nom').eq('date', today),
    sb.from('bons_sortie').select('id,bon_number,department_id,destination').eq('date', today),
    sb.from('bons_sortie_lines').select('bon_id,qty'),
    sb.from('caisse_movements').select('type,amount').eq('date', today).is('deleted_at', null),
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
    const v = Number((m as { amount: number }).amount || 0);
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

// ── caisse_eod — 21:00 Casa, focused cash-flow recap ─────────
// Companion to daily_report (20:30 Casa). Shorter, cash-focused: today's
// caisse in/out/net + running balance + breakdown of settlements paid.
export async function jobCaisseEod(): Promise<Response> {
  const today = todayCasa();

  const [caisseTodayRes, caisseAllRes, salTaswRes, pcTaswRes, techPayRes] = await Promise.all([
    sb.from('caisse_movements')
      .select('type,amount,designation,linked_kind').eq('date', today).is('deleted_at', null),
    sb.from('caisse_movements')
      .select('type,amount').is('deleted_at', null),
    sb.from('salarie_taswiyas').select('montant,nom_salarie').eq('date_paiement', today),
    sb.from('pc_taswiyas').select('montant,ouvrier_id').eq('date_paiement', today),
    sb.from('technician_payments').select('amount,technician_name').eq('pay_date', today),
  ]);

  const today_movements = caisseTodayRes.data ?? [];
  const all_movements   = caisseAllRes.data   ?? [];
  const salT  = salTaswRes.data  ?? [];
  const pcT   = pcTaswRes.data   ?? [];
  const techP = techPayRes.data  ?? [];

  let inToday = 0, outToday = 0;
  for (const m of today_movements) {
    const v = Number((m as { amount: number }).amount || 0);
    if ((m as { type: string }).type === 'in') inToday += v; else outToday += v;
  }
  let inAll = 0, outAll = 0;
  for (const m of all_movements) {
    const v = Number((m as { amount: number }).amount || 0);
    if ((m as { type: string }).type === 'in') inAll += v; else outAll += v;
  }
  const solde = inAll - outAll;

  const salTotal  = salT.reduce ((s, t) => s + Number((t as { montant: number }).montant || 0), 0);
  const pcTotal   = pcT.reduce  ((s, t) => s + Number((t as { montant: number }).montant || 0), 0);
  const techTotal = techP.reduce((s, p) => s + Number((p as { amount: number }).amount || 0), 0);
  const settleTotal = salTotal + pcTotal + techTotal;
  const settleCount = salT.length + pcT.length + techP.length;

  // Empty-state: no cash movement and no settlement → don't ping the user
  if (today_movements.length === 0 && settleCount === 0) {
    return new Response(JSON.stringify({ ok: true, job: 'caisse_eod', skipped: 'empty' }));
  }

  const lines: string[] = [`💵 *خلاصة الصندوق — ${today}*`, ''];
  if (inToday || outToday) {
    lines.push(`⬆️ مداخيل: *${fmtMoney(inToday)} د.م.*`);
    lines.push(`⬇️ مخارج: *${fmtMoney(outToday)} د.م.*`);
    lines.push(`📊 صافي اليوم: *${fmtMoney(inToday - outToday)} د.م.*`);
    lines.push('');
  }
  if (settleCount > 0) {
    lines.push(`💰 *تسويات اليوم — ${settleCount} خدام:*`);
    if (salT.length)  lines.push(`👥 الأجراء: ${salT.length} · ${fmtMoney(salTotal)} د.م.`);
    if (pcT.length)   lines.push(`👷 PCs:    ${pcT.length} · ${fmtMoney(pcTotal)} د.م.`);
    if (techP.length) lines.push(`🛠 تقنيون: ${techP.length} · ${fmtMoney(techTotal)} د.م.`);
    lines.push(`المجموع: *${fmtMoney(settleTotal)} د.م.*`);
    lines.push('');
  }
  lines.push(`💼 *الصندوق الحالي: ${fmtMoney(solde)} د.م.*`);

  const sent = await broadcastTelegram(lines.join('\n'));
  return new Response(JSON.stringify({
    ok: true, job: 'caisse_eod', telegram: sent,
    in_today: inToday, out_today: outToday, solde,
    settlements: settleCount, settle_total: settleTotal,
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

// ── overdue_cheques — 09h Casa daily ───────────────────────────
// Lists cheques whose echeance is in the past AND status != مدفوع.
// Each row gets an inline keyboard (تخلص / أجّل) for one-tap action.
type ChqRow = { id: number; num?: string; fournisseur?: string; montant?: number; type?: string; echeance?: string; status?: string };
export async function jobOverdueCheques(): Promise<Response> {
  const today = todayCasa();
  const { data } = await sb.from('cheques')
    .select('id,num,fournisseur,montant,type,echeance,status')
    .lt('echeance', today).neq('status', 'مدفوع').order('echeance', { ascending: true });
  const list = (data || []) as ChqRow[];
  if (!list.length) {
    return new Response(JSON.stringify({ ok: true, job: 'overdue_cheques', skipped: 'none' }));
  }
  const { data: subs } = await sb.from('bot_subscribers').select('chat_id');
  const chatIds = (subs ?? []).map((s: { chat_id: number }) => s.chat_id);
  // One umbrella message + per-cheque rows is noisy. Send ONE message that
  // summarizes count + total, with action buttons per top 8.
  const total = list.reduce((s, c) => s + safeNum(c.montant), 0);
  const dayDiff = (iso: string): number => {
    const a = new Date(iso + 'T12:00:00Z').getTime();
    const b = new Date(today + 'T12:00:00Z').getTime();
    return Math.round((b - a) / 86400000);
  };
  let text = `⚠️ *${list.length} تسوية ف التأخير* — *${fmtMoney(total)} د.م.*\n\n`;
  const top = list.slice(0, 10);
  for (const c of top) {
    const lbl = (c.type === 'effet' ? '📜' : '💳');
    const d = dayDiff(String(c.echeance || ''));
    text += `${lbl} #${c.num} · ${c.fournisseur} · *${fmtMoney(c.montant)} د.م.* · ⏳ ${d} يوم\n`;
  }
  if (list.length > 10) text += `\n_… و ${list.length - 10} أخرى_\n`;
  const replyMarkup: TgInlineKeyboard = {
    inline_keyboard: top.slice(0, 5).map((c) => [
      { text: `✅ ${c.num}`, callback_data: `CHQPAID:${c.id}` },
      { text: `📅 +7ج ${c.num}`, callback_data: `CHQDEFER:${c.id}` },
    ]),
  };
  let sent = 0;
  for (const chatId of chatIds) {
    try { await sendMessage(chatId, text, { parseMode: 'Markdown', replyMarkup }); sent++; }
    catch (e) { console.error('overdue_cheques send fail', e); }
  }
  await sendWebPush('⚠️ شيكات متأخرة', `${list.length} شيك · ${fmtMoney(total)} د.م.`, './#cheques', 'overdue');
  return new Response(JSON.stringify({ ok: true, job: 'overdue_cheques', telegram: sent, count: list.length, total }));
}

// ── upcoming_cheques — 09h Casa daily ──────────────────────────
// Pre-warning J-7 + J-3 + tomorrow. Two pre-alert windows: 3-day inner
// (urgent), 7-day outer (heads-up). Today's cheques are already handled
// by jobChequesDueMorning + jobChequesTodayPing.
export async function jobUpcomingCheques(): Promise<Response> {
  const today = todayCasa();
  const addDays = (n: number): string => {
    const d = new Date(today + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const in7 = addDays(7);
  const { data } = await sb.from('cheques')
    .select('id,num,fournisseur,montant,type,echeance,status')
    .gt('echeance', today).lte('echeance', in7).neq('status', 'مدفوع').order('echeance', { ascending: true });
  const list = (data || []) as ChqRow[];
  if (!list.length) {
    return new Response(JSON.stringify({ ok: true, job: 'upcoming_cheques', skipped: 'none' }));
  }
  const total = list.reduce((s, c) => s + safeNum(c.montant), 0);
  // Split into <=3-day inner (urgent ⚠️) and 4-7 day outer (heads-up 📅)
  const inner: ChqRow[] = [];
  const outer: ChqRow[] = [];
  for (const c of list) {
    const eTime = new Date(String(c.echeance) + 'T12:00:00Z').getTime();
    const tTime = new Date(today + 'T12:00:00Z').getTime();
    const days = Math.round((eTime - tTime) / 86400000);
    if (days <= 3) inner.push(c); else outer.push(c);
  }
  let text = `🔔 *${list.length} تسوية جايا* — *${fmtMoney(total)} د.م.* خلال 7 أيام\n`;
  const fmtRow = (c: ChqRow, days: number) => {
    const lbl = c.type === 'effet' ? '📜' : '💳';
    return `${lbl} #${c.num} · ${c.fournisseur} · *${fmtMoney(c.montant)}* · 📅 بعد ${days}ج (${c.echeance})\n`;
  };
  if (inner.length) {
    text += '\n⚠️ *مستعجل (≤3 أيام):*\n';
    for (const c of inner) {
      const days = Math.max(0, Math.round((new Date(String(c.echeance) + 'T12:00:00Z').getTime() - new Date(today + 'T12:00:00Z').getTime()) / 86400000));
      text += fmtRow(c, days);
    }
  }
  if (outer.length) {
    text += '\n📅 *قريب (4-7 أيام):*\n';
    for (const c of outer) {
      const days = Math.round((new Date(String(c.echeance) + 'T12:00:00Z').getTime() - new Date(today + 'T12:00:00Z').getTime()) / 86400000);
      text += fmtRow(c, days);
    }
  }
  text += '\n_💡 حضّر الكاش / السلف قبل ما يحلو._';
  const sent = await broadcastTelegram(text);
  await sendWebPush('🔔 شيكات قادمة', `${list.length} خلال 7 أيام · ${fmtMoney(total)} د.م.`, './#cheques', 'upcoming-cheques');
  return new Response(JSON.stringify({ ok: true, job: 'upcoming_cheques', telegram: sent, count: list.length, total }));
}

// ── stock_critical — 08h Casa daily ────────────────────────────
// Lists articles whose stock fell below stock_min. Capped at top 10 by
// criticity (ratio stock / stock_min ascending — most-broken first).
type ArtRow = { id: number; nom?: string; ref?: string; unite?: string; stock?: number | null; stock_min?: number | null; cat?: string };
export async function jobStockCritical(): Promise<Response> {
  const { data } = await sb.from('articles')
    .select('id,nom,ref,unite,stock,stock_min,cat')
    .is('deleted_at', null)
    .not('stock_min', 'is', null);
  const list = (data || []) as ArtRow[];
  const critical = list.filter(a => {
    const sm = Number(a.stock_min || 0);
    const s  = Number(a.stock || 0);
    return sm > 0 && s < sm;
  });
  if (!critical.length) {
    return new Response(JSON.stringify({ ok: true, job: 'stock_critical', skipped: 'none' }));
  }
  // Sort by ratio (smallest first = most critical, including out-of-stock=0)
  critical.sort((a, b) => {
    const ra = Number(a.stock || 0) / Math.max(1, Number(a.stock_min || 1));
    const rb = Number(b.stock || 0) / Math.max(1, Number(b.stock_min || 1));
    return ra - rb;
  });
  const top = critical.slice(0, 10);
  let text = `📦 *${critical.length} سلعة ف خطر مخزون*\n\n`;
  for (const a of top) {
    const s = Number(a.stock || 0);
    const sm = Number(a.stock_min || 0);
    const icon = s <= 0 ? '🔴' : '🟡';
    text += `${icon} *${a.nom}* — \`${s}\` / ${sm} ${a.unite || ''}\n`;
  }
  if (critical.length > 10) text += `\n_… و ${critical.length - 10} أخرى_`;
  text += '\n\n_💡 احجز عند موردك قبل ما يوقف الإنتاج._';
  const sent = await broadcastTelegram(text);
  await sendWebPush('📦 مخزون منخفض', `${critical.length} سلعة تحت الحد الأدنى`, './#articles', 'stock-critical');
  return new Response(JSON.stringify({ ok: true, job: 'stock_critical', telegram: sent, count: critical.length }));
}

// ── weekly_digest — Sunday 19h Casa ─────────────────────────────
// Week-over-week comparison (sun→sat) for spending, inflow, workers paid.
export async function jobWeeklyDigest(): Promise<Response> {
  const today = todayCasa();
  // Compute current week (Sun → today inclusive) and prior week (full Sun → Sat)
  const todayD = new Date(today + 'T12:00:00Z');
  const dow = todayD.getUTCDay(); // 0=Sun
  const curStart = new Date(todayD);
  curStart.setUTCDate(todayD.getUTCDate() - dow);
  const prevEnd = new Date(curStart);
  prevEnd.setUTCDate(curStart.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevEnd.getUTCDate() - 6);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const curFrom = iso(curStart), prevFrom = iso(prevStart), prevTo = iso(prevEnd);

  // Bons in each window (totalNet preferred, fallback total)
  type BonR = { date?: string; total?: number; total_net?: number };
  const { data: bonsAll } = await sb.from('bons').select('date,total,total_net').gte('date', prevFrom).lte('date', today).is('deleted_at', null);
  const bons = (bonsAll || []) as BonR[];
  // Cheques paid in each window (by paid_at, fallback date)
  type ChR = { date?: string; paid_at?: string; status?: string; montant?: number };
  const { data: chAll } = await sb.from('cheques').select('date,paid_at,status,montant').gte('date', prevFrom).lte('date', today);
  const cheques = (chAll || []) as ChR[];
  // Factures issued in each window
  type FacR = { date?: string; total_ttc?: number; statut?: string };
  const { data: facAll } = await sb.from('factures').select('date,total_ttc,statut').gte('date', prevFrom).lte('date', today).is('deleted_at', null);
  const factures = (facAll || []) as FacR[];

  const inRange = (d: string | undefined, from: string, to: string): boolean => {
    if (!d) return false;
    return d >= from && d <= to;
  };
  const sumBons = (from: string, to: string) =>
    bons.filter(b => inRange(b.date, from, to)).reduce((s, b) => s + safeNum(b.total_net ?? b.total), 0);
  const sumPaid = (from: string, to: string) =>
    cheques.filter(c => c.status === 'مدفوع' && inRange(c.paid_at || c.date, from, to)).reduce((s, c) => s + safeNum(c.montant), 0);
  const sumFact = (from: string, to: string) =>
    factures.filter(f => inRange(f.date, from, to)).reduce((s, f) => s + safeNum(f.total_ttc), 0);

  const curBons = sumBons(curFrom, today);
  const prvBons = sumBons(prevFrom, prevTo);
  const curPaid = sumPaid(curFrom, today);
  const prvPaid = sumPaid(prevFrom, prevTo);
  const curFact = sumFact(curFrom, today);
  const prvFact = sumFact(prevFrom, prevTo);
  const delta = (a: number, b: number) => b > 0.005 ? Math.round(((a - b) / b) * 100) : (a > 0.005 ? 100 : 0);
  const deltaTxt = (a: number, b: number) => {
    const d = delta(a, b);
    if (b <= 0.005 && a <= 0.005) return '';
    const arrow = d > 0 ? '📈' : d < 0 ? '📉' : '➡️';
    return ` ${arrow} ${d > 0 ? '+' : ''}${d}%`;
  };

  let text = `📊 *تقرير الأسبوع — ${curFrom} → ${today}*\n`;
  text += `\n📦 مشتريات (Bons): *${fmtMoney(curBons)} د.م.*${deltaTxt(curBons, prvBons)}\n`;
  text += `   _الأسبوع السابق: ${fmtMoney(prvBons)} د.م._\n`;
  text += `\n✅ مدفوع (Cheques): *${fmtMoney(curPaid)} د.م.*${deltaTxt(curPaid, prvPaid)}\n`;
  text += `   _الأسبوع السابق: ${fmtMoney(prvPaid)} د.م._\n`;
  text += `\n🧾 فواتير (CA): *${fmtMoney(curFact)} د.م.*${deltaTxt(curFact, prvFact)}\n`;
  text += `   _الأسبوع السابق: ${fmtMoney(prvFact)} د.م._\n`;
  const net = curFact - curBons;
  const netCol = net >= 0 ? '🟢' : '🔴';
  text += `\n${netCol} *الفرق (CA − دفعات): ${fmtMoney(net)} د.م.*\n`;
  const sent = await broadcastTelegram(text);
  await sendWebPush('📊 تقرير الأسبوع', `CA ${fmtMoney(curFact)} · مشتريات ${fmtMoney(curBons)}`, './#dashboard', 'weekly-digest');
  return new Response(JSON.stringify({ ok: true, job: 'weekly_digest', telegram: sent }));
}
