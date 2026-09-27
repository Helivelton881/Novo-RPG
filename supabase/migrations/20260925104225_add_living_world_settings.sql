-- Fase 5.16.1: configuracao operacional persistente do Living World.
-- Entidades de IA continuam exclusivamente em memoria.
create table if not exists public.living_world_settings (
  id smallint primary key default 1 check (id = 1),
  field_spawn_enabled boolean not null default true,
  dungeon_fill_enabled boolean not null default true,
  tvt_fill_enabled boolean not null default true,
  field_world_cap integer not null default 10 check (field_world_cap between 0 and 40),
  per_map_cap integer not null default 4 check (per_map_cap between 0 and 10),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null
);

alter table public.living_world_settings enable row level security;
revoke all on table public.living_world_settings from anon, authenticated;

insert into public.living_world_settings (id)
values (1)
on conflict (id) do nothing;

