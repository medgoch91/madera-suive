-- Bot state tables for the Edge Function port
-- - bot_conversations: multi-step /newbon and /cheque flows
-- - bot_subscribers  : Telegram chat_ids that opted into the daily digest

create table if not exists public.bot_conversations (
  chat_id     bigint primary key,
  command     text not null,
  step        text not null,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create index if not exists bot_conversations_updated_at_idx on public.bot_conversations (updated_at);

create table if not exists public.bot_subscribers (
  chat_id    bigint primary key,
  created_at timestamptz not null default now()
);

-- RLS off — only the Edge Function (service_role) touches these tables.
alter table public.bot_conversations disable row level security;
alter table public.bot_subscribers  disable row level security;
