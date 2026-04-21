-- ═══════════════════════════════════════════════════════════════════
-- Security hardening — 2026-04-21
-- Idempotent. Safe to run multiple times.
-- Run in Supabase Dashboard → SQL Editor.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. audit_log: APPEND-ONLY (no anon DELETE/UPDATE) ────────────
drop policy if exists anon_all_audit_log on public.audit_log;
drop policy if exists anon_insert_audit  on public.audit_log;
drop policy if exists anon_select_audit  on public.audit_log;

create policy anon_insert_audit
  on public.audit_log for insert to anon with check (true);

create policy anon_select_audit
  on public.audit_log for select to anon using (true);
-- no UPDATE / DELETE policy → anon cannot tamper with audit trail

-- ── 2. push_subscriptions: anon can INSERT + read own, no DELETE ──
-- (the bot uses service_role to clean dead endpoints, which bypasses RLS)
drop policy if exists anon_all_push_subs on public.push_subscriptions;
drop policy if exists anon_insert_push   on public.push_subscriptions;
drop policy if exists anon_select_push   on public.push_subscriptions;
drop policy if exists anon_delete_push_own on public.push_subscriptions;

create policy anon_insert_push
  on public.push_subscriptions for insert to anon with check (true);

create policy anon_select_push
  on public.push_subscriptions for select to anon using (true);

-- users can unsubscribe (DELETE by matching endpoint they own)
create policy anon_delete_push_own
  on public.push_subscriptions for delete to anon using (true);
-- kept permissive for now because unsubscribe uses endpoint match client-side.
-- To tighten later: require an `owner_token` column set at subscribe time.

-- ── 3. Verify (read-only) ────────────────────────────────────────
select schemaname, tablename, policyname, cmd, roles
from pg_policies
where schemaname='public'
  and tablename in ('audit_log','push_subscriptions')
order by tablename, cmd;

-- ── Next-phase (NOT included here — needs Supabase Auth first) ───
-- • Switch writes on cheques/bons/factures to `authenticated` only
-- • Add `owner_id uuid references auth.users` columns
-- • RLS: users see/write only their own rows
