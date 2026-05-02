-- push_subscriptions only had `anon_all_push_subs` (for `anon` role). Since
-- the v41 RLS-anon-write fix the client sends INSERT/DELETE as `authenticated`
-- (with the user's JWT in Authorization), so anon policies don't apply and
-- POSTs fail with "row-level security policy violation".
--
-- Fix: add a permissive policy for `authenticated` (same shape as the other
-- data tables in the app: `for all using (true) with check (true)`).
-- Keeps the anon policy intact in case the bot worker / unauth path needs it.

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'push_subscriptions'
      and policyname = 'authenticated_all_push_subs'
  ) then
    create policy "authenticated_all_push_subs"
      on public.push_subscriptions for all to authenticated
      using (true) with check (true);
  end if;
end $$;

notify pgrst, 'reload schema';
