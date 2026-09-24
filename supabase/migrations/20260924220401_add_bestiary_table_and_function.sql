-- Fase 5.9 -- Bestiario: progresso de descoberta/abates por personagem.
-- Mesmo padrao de seguranca das demais tabelas do projeto: RLS habilitado,
-- zero policies (todo acesso passa por server.js com a service-role key).

create table if not exists public.character_bestiary (
  character_id uuid not null references public.characters(id) on delete cascade,
  monster_id text not null,
  discovered_at timestamptz not null default now(),
  kills integer not null default 0,
  first_kill_at timestamptz not null default now(),
  last_kill_at timestamptz not null default now(),
  primary key (character_id, monster_id)
);
create index if not exists idx_character_bestiary_character on public.character_bestiary(character_id);
alter table public.character_bestiary enable row level security;

-- Upsert atomico: um abate real (confirmado server-side, nunca pelo
-- cliente) sempre incrementa exatamente uma vez, mesmo sob concorrencia
-- (dois hits quase simultaneos no mesmo mob por engano nunca perderiam um
-- incremento com INSERT ... ON CONFLICT DO UPDATE, que e atomico no
-- proprio Postgres). first_kill_at/discovered_at sao setados so na
-- primeira vez (DEFAULT do INSERT); last_kill_at e kills sempre avancam.
create or replace function public.bestiary_record_kill(p_character_id uuid, p_monster_id text)
returns public.character_bestiary
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare row public.character_bestiary;
begin
  insert into public.character_bestiary (character_id, monster_id, kills, first_kill_at, last_kill_at)
    values (p_character_id, p_monster_id, 1, now(), now())
  on conflict (character_id, monster_id) do update
    set kills = public.character_bestiary.kills + 1, last_kill_at = now()
  returning * into row;
  return row;
end;
$$;
