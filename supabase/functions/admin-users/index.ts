// Admin user management for Maderadeco. Authenticated callers can list, create
// and delete Supabase Auth users — driven from the in-app إدارة المستخدمين page.
//
// Routes:
//   GET    /functions/v1/admin-users           → list users (id, email, created_at)
//   POST   /functions/v1/admin-users           → create user { email, password, nom }
//   DELETE /functions/v1/admin-users?id=<uuid> → remove user
//
// Auth: caller must present a JWT in `Authorization: Bearer <token>` from a
// signed-in Supabase user. We verify with the anon client. The actual admin
// operations use the service-role client. Anonymous (no JWT) is rejected.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SB_URL') ?? 'https://tpjrzgubttpqtxieioxe.supabase.co';
const SB_SERVICE_KEY = Deno.env.get('SB_SERVICE_KEY')!;
const SB_ANON_KEY = Deno.env.get('SB_ANON_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';

// service-role client (bypasses RLS, has admin.* methods)
const admin = createClient(SB_URL, SB_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function requireAuth(req: Request): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, res: json({ error: 'missing Authorization header' }, 401) };
  }
  const token = authHeader.slice(7);
  if (!SB_ANON_KEY) {
    // We can verify with the service-role client too; createClient + getUser(token).
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return { ok: false, res: json({ error: 'invalid token' }, 401) };
    return { ok: true, userId: data.user.id };
  }
  // Prefer the anon client + caller's token so getUser uses the public path.
  const anonClient = createClient(SB_URL, SB_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await anonClient.auth.getUser();
  if (error || !data.user) return { ok: false, res: json({ error: 'invalid token' }, 401) };
  return { ok: true, userId: data.user.id };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.res;
  const callerId = auth.userId;

  const url = new URL(req.url);

  try {
    if (req.method === 'GET') {
      const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
      if (error) return json({ error: error.message }, 500);
      const users = (data.users || []).map(u => {
        const meta = u.user_metadata || {};
        return {
          id: u.id,
          email: u.email,
          nom: meta.nom || meta.name || null,
          role: meta.role || 'admin',           // legacy users default to admin
          permissions: meta.permissions || null,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at,
          confirmed: !!u.email_confirmed_at,
          is_self: u.id === callerId,
        };
      });
      return json({ users });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      const nom = String(body.nom || '').trim();
      if (!email || !password) return json({ error: 'email and password are required' }, 400);
      if (password.length < 6) return json({ error: 'password must be at least 6 characters' }, 400);
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: nom ? { nom } : {},
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, id: data.user?.id, email: data.user?.email });
    }

    if (req.method === 'PATCH') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'missing ?id=' }, 400);
      const body = await req.json().catch(() => ({}));
      const updates: { user_metadata?: Record<string, unknown>; password?: string; email?: string } = {};
      // Read current metadata so we patch instead of overwrite.
      const { data: cur, error: getErr } = await admin.auth.admin.getUserById(id);
      if (getErr) return json({ error: getErr.message }, 400);
      const meta: Record<string, unknown> = { ...((cur && cur.user && cur.user.user_metadata) || {}) };
      let touched = false;
      if (typeof body.nom === 'string') { meta.nom = body.nom.trim(); touched = true; }
      if (typeof body.role === 'string') { meta.role = body.role; touched = true; }
      if ('permissions' in body) { meta.permissions = body.permissions; touched = true; }
      if (touched) updates.user_metadata = meta;
      if (typeof body.password === 'string' && body.password.length >= 6) updates.password = body.password;
      if (typeof body.email === 'string' && body.email.trim()) updates.email = body.email.trim();
      if (Object.keys(updates).length === 0) return json({ error: 'no fields to update' }, 400);
      const { error } = await admin.auth.admin.updateUserById(id, updates);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'missing ?id=' }, 400);
      if (id === callerId) return json({ error: 'cannot delete yourself' }, 400);
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    console.error('admin-users error:', e);
    return json({ error: (e as Error).message || String(e) }, 500);
  }
});
