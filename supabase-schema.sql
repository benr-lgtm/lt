-- Load Tracker schema. Paste this whole file into the Supabase SQL editor and Run.
-- Safe to run multiple times: it creates the tables if missing and adds any
-- columns that an older version didn't have.

create table if not exists public.loads (
  id           bigint generated always as identity primary key,
  position     int not null,
  unique (position)
);

-- Add/patch every column idempotently (fixes tables made by earlier versions).
alter table public.loads add column if not exists name         text;
alter table public.loads add column if not exists truck_number text;
alter table public.loads add column if not exists samsara_url  text;
alter table public.loads add column if not exists kind         text not null default 'delivery';
alter table public.loads add column if not exists deadline     text;
alter table public.loads add column if not exists destination  text;
alter table public.loads add column if not exists dest_lat     double precision;
alter table public.loads add column if not exists dest_lng     double precision;
alter table public.loads add column if not exists eta_iso      timestamptz;
alter table public.loads add column if not exists eta_display  text;
alter table public.loads add column if not exists truck_at     text;
alter table public.loads add column if not exists status       text not null default 'unknown';
alter table public.loads add column if not exists status_note  text;
alter table public.loads add column if not exists alerted      boolean not null default false;
alter table public.loads add column if not exists updated_at   timestamptz not null default now();

-- Saves use "upsert on conflict (position)", which REQUIRES this unique index.
-- Older tables may be missing it; this adds it safely.
create unique index if not exists loads_position_key on public.loads(position);

-- The app talks to Supabase only from the server using the service-role key,
-- so Row Level Security is left disabled by default.
