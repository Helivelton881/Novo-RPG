create table if not exists public.characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  slot int not null check (slot between 0 and 3),
  name text not null,
  cls text not null default 'guerreiro',
  lvl int not null default 1,
  map text not null default 'vila',
  save jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, slot),
  unique(user_id, name)
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_characters_touch on public.characters;
create trigger trg_characters_touch
  before update on public.characters
  for each row execute function public.touch_updated_at();

alter table public.characters enable row level security;

drop policy if exists "characters: leitura pública" on public.characters;
create policy "characters: leitura pública" on public.characters
  for select using (true);

drop policy if exists "characters: dono cria/edita/apaga" on public.characters;
create policy "characters: dono cria/edita/apaga" on public.characters
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists idx_characters_user on public.characters(user_id);
create index if not exists idx_characters_lvl on public.characters(lvl desc);

do $$
begin
  alter publication supabase_realtime add table public.characters;
exception when duplicate_object then
  null;
end $$;
