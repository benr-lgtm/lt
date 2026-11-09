-- Allow the Motive sources in addition to the existing Samsara sources.
-- Run in the Supabase SQL Editor before tracking Motive loads.
begin;

alter table public.loads drop constraint if exists loads_possource_chk;
alter table public.loads add constraint loads_possource_chk
  check (position_source is null or position_source in
    ('samsara_api', 'graphql', 'geocoded_text', 'motive_api', 'motive_share'));

commit;
