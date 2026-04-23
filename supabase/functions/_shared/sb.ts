// Supabase client for Edge Functions — uses service_role so RLS is bypassed
// (this is a trusted backend like the old Python bot).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SB_URL') ?? 'https://tpjrzgubttpqtxieioxe.supabase.co';
const SB_SERVICE_KEY = Deno.env.get('SB_SERVICE_KEY')!;

export const sb = createClient(SB_URL, SB_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Convenience: REST URL so we can bypass the client for custom queries
export const SB_REST = `${SB_URL}/rest/v1`;
export const SB_HEADERS = {
  apikey: SB_SERVICE_KEY,
  Authorization: `Bearer ${SB_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};
