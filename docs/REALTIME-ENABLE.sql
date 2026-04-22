-- Enable Supabase Realtime for the 6 tables that change during normal ops.
-- Idempotent: safe to run multiple times (drop + re-add if already present).
-- Run in Supabase Dashboard → SQL Editor.

do $$
declare
  t text;
  tables text[] := array['bons','cheques','factures','articles','chantiers','fournisseurs'];
begin
  foreach t in array tables loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then
        null; -- already in publication, skip
    end;
  end loop;
end $$;

-- Verify
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;
