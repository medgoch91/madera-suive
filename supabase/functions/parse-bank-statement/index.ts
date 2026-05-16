// parse-bank-statement — Extract cheque/effet payments from a CDM relevé.
//
// Flow:
//   POST /functions/v1/parse-bank-statement
//     Authorization: Bearer <user JWT>
//     Body: { pdf: "data:application/pdf;base64,..." }
//   Response: { ok, transactions: [...], raw, model }
//
// We send the PDF to Anthropic (Claude) and ask it to extract every line
// matching "PAIEMENT CHEQUE <num>" or "PAIEMENT EFFET <num>" along with the
// transaction date and the débit amount. CDM relevés are highly structured
// — the cheque/effet number lands directly in the Libellé column, so
// matching back against our cheques table by num is exact.
//
// We DELIBERATELY ignore the other transaction types (VIREMENT, RETRAIT,
// PRELEVEMENT, FRAIS, AGIOS) — they don't map to records in our cheques
// table. They could be wired into a fuller bank-reconciliation v2 later.

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const MODEL = Deno.env.get('PARSE_BANK_MODEL') ?? 'claude-haiku-4-5-20251001';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Tx = {
  date: string;        // 'YYYY-MM-DD'
  type: 'cheque' | 'effet';
  num: string;         // e.g. '2616665' or '9940471'
  montant: number;     // DH, always positive (it's a débit)
};

const PROMPT = `أنت مساعد كتعاون فاستخراج معلومات من كشف بنكي (relevé de compte / extrait de compte) ديال البنك Crédit du Maroc.

الكشف فيه جدول بأعمدة: Date Opération | Valeur | Libellé | Débit | Crédit.

استخرج <فقط> العمليات اللي فيها <PAIEMENT CHEQUE> أو <PAIEMENT EFFET> (هاديك العمليات اللي كيخرج فيها فلوس من الحساب لخلاص شيك أو إيفي).

تجاهل باقي العمليات (VIREMENT, RETRAIT, PRELEVEMENT, FRAIS, AGIOS, إلخ).

رجع النتيجة فقط ك JSON صحيح بهاد الشكل، بلا أي شرح، بلا code-fence:

{
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "type": "cheque" | "effet",
      "num": "string (الرقم اللي مكتوب بعد PAIEMENT CHEQUE/EFFET)",
      "montant": number (المبلغ من عمود Débit، بالأرقام decimal بلا فواصل)
    }
  ]
}

ملاحظات مهمة:
• الـ "date" حولها من DD MM YY (اللي ف العمود Date Opération) إلى YYYY-MM-DD. مثلا "10 04 26" يولي "2026-04-10".
• الـ "num" هو الرقم اللي مكتوب مباشرة بعد PAIEMENT CHEQUE أو PAIEMENT EFFET (string فيها أرقام فقط).
• الـ "montant" هو القيمة من عمود Débit، حولها رقم decimal بلا "DH" بلا فواصل ألف (مثلا "59 127,50" يولي 59127.50).
• ما تردش غير الـ JSON. لا diff لا markdown لا تعليقات.`;

interface AnthropicResponse {
  content: { type: string; text?: string }[];
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: { message: string };
}

function extractJsonObject(s: string): string {
  const trimmed = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const first = trimmed.indexOf('{');
  if (first < 0) return trimmed;
  let depth = 0;
  for (let i = first; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return trimmed.slice(first, i + 1); }
  }
  return trimmed.slice(first);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return new Response('POST only', { status: 405, headers: CORS_HEADERS });

  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'ANTHROPIC_API_KEY not configured on the server.' }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  let body: { pdf?: string } = {};
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ ok: false, error: 'bad JSON' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }); }

  if (!body.pdf || typeof body.pdf !== 'string') {
    return new Response(JSON.stringify({ ok: false, error: 'pdf (base64 data-url) required' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }

  // Accept either data:application/pdf;base64,... or raw base64
  let base64 = body.pdf;
  const m = base64.match(/^data:(application\/pdf|[^;]+);base64,(.+)$/i);
  if (m) base64 = m[2];

  const messages = [{
    role: 'user' as const,
    content: [
      { type: 'document' as const, source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text' as const, text: PROMPT },
    ],
  }];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'pdfs-2024-09-25',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages }),
  });

  const raw = await res.text();
  let parsed: AnthropicResponse;
  try { parsed = JSON.parse(raw); }
  catch {
    return new Response(JSON.stringify({ ok: false, error: 'anthropic returned non-JSON', raw }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
  if (!res.ok || parsed.error) {
    return new Response(JSON.stringify({ ok: false, error: parsed.error?.message || raw }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
  const text = (parsed.content?.[0]?.text ?? '').trim();
  const jsonStr = extractJsonObject(text);
  let result: { transactions?: Tx[] } = {};
  try { result = JSON.parse(jsonStr); }
  catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'model output is not valid JSON', text, raw: jsonStr, parseError: String(e) }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }

  const transactions = (Array.isArray(result.transactions) ? result.transactions : []).map(t => ({
    date: String(t.date || ''),
    type: t.type === 'effet' ? 'effet' : 'cheque',
    num: String(t.num || '').trim(),
    montant: Number(t.montant) || 0,
  })).filter(t => t.num && t.montant > 0 && /^\d{4}-\d{2}-\d{2}$/.test(t.date));

  return new Response(JSON.stringify({
    ok: true,
    transactions,
    model: parsed.model,
    usage: parsed.usage,
  }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
});
