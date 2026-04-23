-- Extend audit_log to capture user_id (Supabase Auth UUID) and user_email explicitly.
-- Keep user_name for backward compat (existing rows + any non-auth path).
-- Idempotent.

alter table public.audit_log add column if not exists user_id uuid;
alter table public.audit_log add column if not exists user_email text;

-- Index on user_id for per-user activity queries
create index if not exists audit_log_user_id_idx on public.audit_log (user_id);
create index if not exists audit_log_user_email_idx on public.audit_log (user_email);
create index if not exists audit_log_created_at_idx on public.audit_log (created_at desc);

-- Verify
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'audit_log'
order by ordinal_position;
