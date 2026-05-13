// parse-bon — Vision-based extraction of a paper bon de commande.
//
// Flow:
//   POST /functions/v1/parse-bon
//     Authorization: Bearer <user JWT>
//     Body: { image: "data:image/...;base64,..." }
//   Response: { ok, bon: { num, date, fournisseur, note, lignes: [...] }, raw, model }
//
// The Edge Function forwards the image + a structured prompt to Anthropic's
// messages API (Claude vision). The model returns JSON, which we parse and
// hand back to the client to pre-fill the new-bon form.
//
// Authentication: required (user must be signed in). We do NOT check chat-id
// or cron-secret here — this is a user-triggered action, not a job.

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
// Claude Haiku 4.5 — fast + cheap + good vision. Swap to sonnet if accuracy
// turns out to be a problem on handwritten / Arabic bons.
const MODEL = Deno.env.get('PARSE_BON_MODEL') ?? 'claude-haiku-4-5-20251001';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Ligne = { nom?: string; ref?: string; unite?: string; qte?: number; prix?: number };
type ParsedBon = {
  num?: string;
  date?: string;
  fournisseur?: string;
  note?: string;
  lignes?: Ligne[];
};

const PROMPT = `أنت مساعد كتعاون فاستخراج معلومات من بون شراء (bon de commande / bon de livraison) ملي تتعطى لك صورة دلبون.

استخرج المعلومات هاد ورجعها فقط ك JSON صحيح، بلا أي شرح، بلا code-fence:

{
  "num": "رقم البون كما هو مكتوب (string، مثلا 'BON-2026-042' أو '526000532')",
  "date": "تاريخ البون ب صيغة YYYY-MM-DD",
  "fournisseur": "اسم المورد بالحروف اللي ظاهرين (UPPERCASE ila kanou)",
  "note": "أي ملاحظة ظاهرة فالبون، إذا كاينة، وإلا فارغ",
  "lignes": [
    {
      "nom": "وصف السلعة بالضبط",
      "ref": "المرجع/REF إلا كاين (مثلا MDF-001)، وإلا فارغ",
      "unite": "وحدة القياس: قطعة | كغ | لتر | م | م² | م³ | كيس | علبة (default قطعة)",
      "qte": عدد القطع (number),
      "prix": سعر الوحدة TTC بالدرهم (number)
    }
  ]
}

ملاحظات مهمة:
• إذا غاي حقل ما كاينش فالصورة، اتركو null أو "" (ما تختلق ولا حاجة).
• الأسعار رجعها أرقام decimal (بدون رمز "DH").
• إذا الكمية أو السعر غاي مكتوبين بخط اليد، حول لأرقام واضحة.
• الأسماء بالعربية كيف ما هي؛ إذا كانت بالفرنسية أو الإنجليزية فحقها فالكتالوغ تكون UPPERCASE.
• ما تردش غير الـ JSON. لا diff لا markdown لا تعليقات.`;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent[];
}
interface AnthropicContent {
  type: 'text' | 'image';
  text?: string;
  source?: { type: 'base64'; media_type: string; data: string };
}
interface AnthropicResponse {
  content: { type: string; text?: string }[];
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: { message: string };
}

function extractJsonObject(s: string): string {
  // The model is instructed to return raw JSON, but sometimes wraps in fences.
  // Pull the first {...} block we can find.
  const trimmed = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const first = trimmed.indexOf('{');
  if (first < 0) return trimmed;
  // Find matching closing brace by depth (handles nested objects in lignes).
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

  let body: { image?: string } = {};
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ ok: false, error: 'bad JSON' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }); }

  if (!body.image || typeof body.image !== 'string') {
    return new Response(JSON.stringify({ ok: false, error: 'image (base64 data-url) required' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }

  // Strip the data-url prefix → keep just media_type + base64 body
  const m = body.image.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/i);
  if (!m) {
    return new Response(JSON.stringify({ ok: false, error: 'image must be a data:image/...;base64,... URL' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
  const mediaType = m[1].toLowerCase();
  const base64    = m[2];

  const messages: AnthropicMessage[] = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      { type: 'text', text: PROMPT },
    ],
  }];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages }),
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
  let bon: ParsedBon = {};
  try { bon = JSON.parse(jsonStr); }
  catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'model output is not valid JSON', text, raw: jsonStr, parseError: String(e) }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }

  // Normalize: ensure lignes is an array, coerce numbers
  if (!Array.isArray(bon.lignes)) bon.lignes = [];
  bon.lignes = bon.lignes.map(l => ({
    nom: l?.nom ? String(l.nom) : '',
    ref: l?.ref ? String(l.ref) : '',
    unite: l?.unite ? String(l.unite) : 'قطعة',
    qte: Number(l?.qte) || 0,
    prix: Number(l?.prix) || 0,
  }));

  return new Response(JSON.stringify({
    ok: true,
    bon,
    model: parsed.model,
    usage: parsed.usage,
  }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
});
