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
