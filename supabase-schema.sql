-- Load Tracker schema. Paste this into the Supabase SQL editor and run it.

-- One row per tracked load. Up to 30 rows are shown in the UI.
create table if not exists public.loads (
  id            bigint generated always as identity primary key,
  position      int not null,                    -- row order 0..29
  name          text,                            -- optional label
  truck_number  text,                            -- matches the Samsara vehicle name (API mode)
  samsara_url   text,                            -- pasted Live Share link (scrape mode)
  kind          text not null default 'delivery',-- 'delivery' | 'pickup'
  deadline      text,                            -- local datetime, e.g. 2026-07-19T06:00
  destination   text,                            -- pasted address (API mode only)
  dest_lat      double precision,                -- geocoded once, cached
  dest_lng      double precision,
  eta_iso       timestamptz,                     -- computed absolute ETA
  eta_display   text,                            -- e.g. "6:15 AM CDT"
  truck_at      text,                            -- last known truck location (readable)
  status        text not null default 'unknown', -- unknown | on_time | late | error
  status_note   text,                            -- error detail, if any
  alerted       boolean not null default false,  -- late email already sent for current state
  updated_at    timestamptz not null default now(),
  unique (position)
);

-- If you created the table with an earlier version, add the newer column:
alter table public.loads add column if not exists samsara_url text;

-- Single-row app settings.
create table if not exists public.settings (
  id           int primary key default 1,
  notify_email text,
  timezone     text not null default 'America/Chicago',
  updated_at   timestamptz not null default now(),
  constraint settings_singleton check (id = 1)
);

insert into public.settings (id, notify_email, timezone)
values (1, null, 'America/Chicago')
on conflict (id) do nothing;

-- The app talks to Supabase only from the server using the service-role key,
-- so Row Level Security is left disabled by default.
