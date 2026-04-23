// Telegram Bot API helpers — raw fetch, no external deps
// Docs: https://core.telegram.org/bots/api

const BOT_TOKEN = Deno.env.get('BOT_TOKEN')!;
const BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
};

export type TgMessage = {
  message_id: number;
  from: { id: number; first_name?: string; username?: string; language_code?: string };
  chat: { id: number; type: string };
  date: number;
  text?: string;
  entities?: { type: string; offset: number; length: number }[];
};

export type TgCallbackQuery = {
  id: string;
  from: { id: number; first_name?: string; username?: string };
  message?: TgMessage;
  data?: string;
};

export type TgInlineKeyboard = { inline_keyboard: { text: string; callback_data: string; url?: string }[][] };
export type TgReplyKeyboard = {
  keyboard: { text: string }[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  selective?: boolean;
};
export type TgRemoveKeyboard = { remove_keyboard: true; selective?: boolean };
export type TgReplyMarkup = TgInlineKeyboard | TgReplyKeyboard | TgRemoveKeyboard;

// Arrange flat list into rows of N for ReplyKeyboard layout
export function kbRows(items: string[], perRow = 2): { text: string }[][] {
  const rows: { text: string }[][] = [];
  for (let i = 0; i < items.length; i += perRow) {
    rows.push(items.slice(i, i + perRow).map((t) => ({ text: t })));
  }
  return rows;
}

export async function sendMessage(chatId: number, text: string, opts: {
  parseMode?: 'Markdown' | 'HTML';
  replyMarkup?: TgReplyMarkup;
  disablePreview?: boolean;
} = {}): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;
  if (opts.disablePreview) body.disable_web_page_preview = true;
  const res = await fetch(`${BASE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error('tg sendMessage failed', res.status, await res.text());
}

export async function editMessageText(chatId: number, messageId: number, text: string, opts: {
  parseMode?: 'Markdown' | 'HTML';
  replyMarkup?: TgReplyMarkup;
} = {}): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;
  const res = await fetch(`${BASE}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error('tg editMessageText failed', res.status, await res.text());
}

export async function answerCallbackQuery(id: string, text?: string): Promise<void> {
  await fetch(`${BASE}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id, text }),
  });
}

// Parse "/command arg1 arg2" into { cmd, args }
export function parseCommand(text: string | undefined): { cmd: string; args: string[] } | null {
  if (!text || !text.startsWith('/')) return null;
  const parts = text.trim().split(/\s+/);
  const first = parts[0].slice(1).split('@')[0].toLowerCase(); // strip /cmd@botname suffix
  return { cmd: first, args: parts.slice(1) };
}
