-- Tracking controls, motion state, and safe row compaction. Run once in the
-- Supabase SQL editor; all statements are safe to re-run.

alter table public.loads
  add column if not exists tracking_enabled boolean not null default true;
alter table public.loads
  alter column tracking_enabled set default false;
alter table public.loads
  add column if not exists motion text;
alter table public.loads
  add column if not exists motion_updated_at timestamptz;

create or replace function public.compact_load_positions(p_assignments jsonb, p_user_id uuid)
returns void
language plpgsql
as $$
begin
  update public.loads
  set position = -id
  where user_id = p_user_id
    and deleted_at is null
    and id in (
      select (assignment->>'id')::bigint
      from jsonb_array_elements(p_assignments) as assignment
    );

  update public.loads as load
  set position = (assignment->>'position')::integer
  from jsonb_array_elements(p_assignments) as assignment
  where load.id = (assignment->>'id')::bigint
    and load.user_id = p_user_id
    and load.deleted_at is null;
end;
$$;
