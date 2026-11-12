-- Apply before deploying the matching application code.
-- A lease prevents concurrent check workers from processing the same load.
alter table public.loads
  add column if not exists check_lease_token uuid,
  add column if not exists check_lease_until timestamptz;

-- A private snapshot keeps Telegram group membership stable between button taps.
create table if not exists public.telegram_update_batches (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  groups jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.telegram_update_batches enable row level security;
revoke all on public.telegram_update_batches from anon, authenticated;
grant select, insert, update on public.telegram_update_batches to service_role;
