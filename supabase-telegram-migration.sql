-- Run once in Supabase SQL Editor to enable Telegram account linking and alerts.
-- Safe to re-run.

alter table public.profiles add column if not exists telegram_chat_id text;
alter table public.profiles add column if not exists telegram_link_token_hash text;
alter table public.profiles add column if not exists telegram_link_token_created_at timestamptz;
alter table public.profiles add column if not exists telegram_pending_group_id uuid;
alter table public.profiles add column if not exists telegram_pending_group_expires_at timestamptz;
create unique index if not exists profiles_telegram_chat_id_key
	on public.profiles(telegram_chat_id)
	where telegram_chat_id is not null;

alter table public.loads add column if not exists telegram_enabled boolean not null default false;
alter table public.loads add column if not exists telegram_interval_minutes smallint not null default 0;
alter table public.loads add column if not exists telegram_next_at timestamptz;
alter table public.loads add column if not exists telegram_last_sent_at timestamptz;
alter table public.loads add column if not exists telegram_pending_status text;
alter table public.loads add column if not exists telegram_late_notified_at timestamptz;
alter table public.loads add column if not exists telegram_arrived_notified_at timestamptz;
alter table public.loads add column if not exists telegram_group_id uuid;
alter table public.loads add column if not exists load_number text;

create index if not exists loads_telegram_group_id_idx
	on public.loads(telegram_group_id)
	where telegram_group_id is not null;