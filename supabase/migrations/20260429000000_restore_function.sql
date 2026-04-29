-- Disaster-recovery RPC: restore the whole business dataset from a JSON blob
-- shaped like the daily Telegram backup.
--
-- Input:  p_data jsonb  — { fournisseurs: [...], bons: [...], ... } per-table arrays
-- Output: jsonb         — { table: row_count, ..., _truncated_at: timestamptz }
--
-- Behavior:
--   1. Single transaction. If any INSERT fails, the whole restore rolls back.
--   2. TRUNCATE all business tables RESTART IDENTITY CASCADE — the restore is a
--      full replace, not a merge. Caller is expected to have made a fresh backup
--      RIGHT BEFORE calling this (the new state will replace the current state).
--   3. INSERTs preserve the original ids from the backup.
--   4. After insert, sequences get bumped past max(id) so subsequent app inserts
--      don't collide.
--   5. Tables not in p_data stay empty after the truncate (caller's responsibility).
--
-- Security:
--   security definer + auth.role() check — only an authenticated caller can run it,
--   not anon. Service-role can also call (auth.role() is 'service_role' there too).

create or replace function public.restore_data(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result      jsonb := jsonb_build_object('_truncated_at', now());
  rows_count  int;
  -- Order matters when CASCADE drops dependents — we list them so the result
  -- shows row counts per table. Same set as the wipe migration on 2026-04-27.
  tbls text[] := array[
    'bons','cheques',
    'fournisseurs','articles','prix','supplier_products',
    'salaries','salarie_presences','salarie_avances','salarie_taswiyas','sal_catalogue',
    'ouvriers_pc','ouvrier_pc_assign','ouvrier_pc_presences',
    'factures','fact_clients','fact_produits',
    'chantiers',
    'technicians','products','product_recipe',
    'material_dispatches','subcontracting_orders','material_returns','technician_payments',
    'bot_conversations'
  ];
  t text;
begin
  -- Authentication gate: must be logged-in or service-role.
  if auth.role() not in ('authenticated','service_role') then
    raise exception 'restore_data: unauthorized (role=%)', auth.role();
  end if;

  -- 1. Wipe everything in one statement so FK CASCADE dependencies fire cleanly.
  --    RESTART IDENTITY resets sequences to 1; we'll bump them past max(id) below.
  execute 'truncate table '
    || array_to_string(array(select quote_ident(x) from unnest(tbls) x), ', ')
    || ' restart identity cascade';

  -- 2. Per-table insert. jsonb_populate_recordset coerces JSON keys → table columns.
  --    Tables absent from p_data are simply skipped (stay empty).
  foreach t in array tbls loop
    if p_data ? t and jsonb_typeof(p_data -> t) = 'array' then
      execute format(
        'insert into %I select * from jsonb_populate_recordset(null::%I, %L::jsonb)',
        t, t, p_data -> t
      );
      get diagnostics rows_count = row_count;
      result := result || jsonb_build_object(t, rows_count);
    else
      result := result || jsonb_build_object(t, 0);
    end if;
  end loop;

  -- 3. Bump every identity sequence past the restored max(id) so future inserts
  --    don't collide with restored ids.
  foreach t in array tbls loop
    execute format(
      'select setval(pg_get_serial_sequence(%L, ''id''), greatest((select coalesce(max(id), 0) from %I), 0) + 1, false)',
      t, t
    );
  end loop;

  return result;
end;
$$;

-- Allow the logged-in user to call it via PostgREST's /rpc/ endpoint.
revoke all on function public.restore_data(jsonb) from public;
grant execute on function public.restore_data(jsonb) to authenticated;
