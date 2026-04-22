-- ═══════════════════════════════════════════════════════════════════
-- RLS migration: anon_all_* → authenticated_all_*
-- Date: 2026-04-22
-- Idempotent. Safe to run multiple times.
-- Prereq: Supabase Auth user(s) created — anon key alone can no longer write.
-- Run in Supabase Dashboard → SQL Editor.
-- ═══════════════════════════════════════════════════════════════════

-- Tables to lock down to authenticated writes.
-- audit_log already restricted by SECURITY-HARDENING.sql (insert+select only).
-- push_subscriptions handled separately (anon insert/select still needed for browser subscribe).
-- Everything else: only authenticated users can read/write.

do $$
declare
  t text;
  tables text[] := array[
    'fournisseurs','articles','prix','bons','cheques','salaries',
    'salarie_presences','salarie_avances','salarie_taswiyas','sal_catalogue',
    'ouvriers_pc','ouvrier_pc_assign','ouvrier_pc_presences',
    'fact_clients','fact_produits','fact_societe','factures',
    'supplier_products',
    'technicians','products','product_recipe','material_dispatches',
    'subcontracting_orders','material_returns','technician_payments',
    'chantiers'
  ];
begin
  foreach t in array tables loop
    execute format('drop policy if exists anon_all_%s on public.%I', t, t);
    execute format('drop policy if exists authenticated_all_%s on public.%I', t, t);
    execute format('create policy authenticated_all_%s on public.%I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;

-- Verify (read-only)
select schemaname, tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in (
    'fournisseurs','articles','prix','bons','cheques','salaries',
    'salarie_presences','salarie_avances','salarie_taswiyas','sal_catalogue',
    'ouvriers_pc','ouvrier_pc_assign','ouvrier_pc_presences',
    'fact_clients','fact_produits','fact_societe','factures',
    'supplier_products',
    'technicians','products','product_recipe','material_dispatches',
    'subcontracting_orders','material_returns','technician_payments',
    'chantiers'
  )
order by tablename, cmd;
