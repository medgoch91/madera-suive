// Web Push fan-out — sends VAPID-signed push notifications to every
// subscription stored in `push_subscriptions`. Dead endpoints (404/410)
// are cleaned up.

import webpush from 'npm:web-push@3.6.7';
import { sb } from './sb.ts';

const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:support@suivi.app';

const PUSH_OK = !!(VAPID_PRIVATE_KEY && VAPID_PUBLIC_KEY);
if (PUSH_OK) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export async function sendWebPush(title: string, body: string, url = './', tag = 'suivi'): Promise<{ sent: number; dead: number }> {
  if (!PUSH_OK) return { sent: 0, dead: 0 };

  const { data: subs, error } = await sb
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth');
  if (error || !subs) {
    console.error('fetch subs failed', error);
    return { sent: 0, dead: 0 };
  }

  const payload = JSON.stringify({ title, body, url, tag });
  let sent = 0;
  const dead: number[] = [];

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 3600 },
      );
      sent++;
    } catch (e: unknown) {
      const code = (e as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) dead.push(s.id);
      else console.error('push send failed', code, e);
    }
  }));

  // Cleanup dead endpoints
  if (dead.length) {
    await sb.from('push_subscriptions').delete().in('id', dead);
  }

  return { sent, dead: dead.length };
}
