-- Stores the single company-wide Motive OAuth connection.
-- Tokens are encrypted by the app before insertion and are accessed only with
-- the Supabase service-role client.

create table if not exists public.motive_oauth_tokens (
  id text primary key check (id = 'shared'),
  access_token_enc text not null,
  refresh_token_enc text not null,
  token_expires_at timestamptz not null,
  authorized_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.motive_oauth_tokens enable row level security;
revoke all on table public.motive_oauth_tokens from public, anon, authenticated;
grant all on table public.motive_oauth_tokens to service_role;
