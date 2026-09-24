-- Fase 5.10 -- Rankings: estatisticas agregadas server-side, nunca
-- calculadas fazendo query completa em characters.save a cada abertura.
-- Mesmo padrao de seguranca das demais tabelas do projeto: RLS
-- habilitado, zero policies (todo acesso passa por server.js com a
-- service-role key).

create table if not exists public.character_rank_stats (
  character_id uuid primary key references public.characters(id) on delete cascade,
  level integer not null default 1,
  xp integer not null default 0,
  pvp_kills integer not null default 0,
  pvp_deaths integer not null default 0,
  tvt_wins integer not null default 0,
  tvt_losses integer not null default 0,
  tvt_draws integer not null default 0,
  tvt_kills integer not null default 0,
  tvt_deaths integer not null default 0,
  world_boss_kills integer not null default 0,
  world_boss_participations integer not null default 0,
  bestiary_discovered integer not null default 0,
  updated_at timestamptz not null default now()
);
create trigger trg_character_rank_stats_touch before update on public.character_rank_stats for each row execute function public.touch_updated_at();
alter table public.character_rank_stats enable row level security;
create index if not exists idx_rank_stats_level on public.character_rank_stats(level desc, xp desc);
create index if not exists idx_rank_stats_tvt on public.character_rank_stats(tvt_wins desc, tvt_kills desc, tvt_losses asc);
create index if not exists idx_rank_stats_wb on public.character_rank_stats(world_boss_kills desc, world_boss_participations desc);
create index if not exists idx_rank_stats_bestiary on public.character_rank_stats(bestiary_discovered desc);
create index if not exists idx_rank_stats_pvp on public.character_rank_stats(pvp_kills desc, pvp_deaths asc);

-- Backfill seguro: preenche level/xp reais dos personagens ja existentes
-- (unico dado historico realmente inferivel de characters). Campos sem
-- historico anterior (pvp/tvt/world_boss/bestiary) comecam em 0 -- o
-- default da coluna, nunca um numero inventado.
insert into public.character_rank_stats (character_id, level, xp)
  select id, lvl, coalesce((save->>'xp')::int, 0) from public.characters
  on conflict (character_id) do nothing;

-- Define level/xp pro valor absoluto mais recente conhecido (nao e um
-- incremento -- o chamador ja sabe o valor real apos aplicar XP).
create or replace function public.rank_stats_set_level_xp(p_character_id uuid, p_level integer, p_xp integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.character_rank_stats (character_id, level, xp)
    values (p_character_id, p_level, p_xp)
  on conflict (character_id) do update set level = excluded.level, xp = excluded.xp;
end;
$$;

-- Incremento atomico pra um campo dentre uma lista fechada (nunca SQL
-- dinamico com nome de coluna vindo de fora -- so os branches abaixo).
create or replace function public.rank_stats_bump(p_character_id uuid, p_field text, p_delta integer default 1)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.character_rank_stats (character_id) values (p_character_id) on conflict (character_id) do nothing;
  if p_field = 'pvp_kills' then update public.character_rank_stats set pvp_kills = pvp_kills + p_delta where character_id = p_character_id;
  elsif p_field = 'pvp_deaths' then update public.character_rank_stats set pvp_deaths = pvp_deaths + p_delta where character_id = p_character_id;
  elsif p_field = 'tvt_wins' then update public.character_rank_stats set tvt_wins = tvt_wins + p_delta where character_id = p_character_id;
  elsif p_field = 'tvt_losses' then update public.character_rank_stats set tvt_losses = tvt_losses + p_delta where character_id = p_character_id;
  elsif p_field = 'tvt_draws' then update public.character_rank_stats set tvt_draws = tvt_draws + p_delta where character_id = p_character_id;
  elsif p_field = 'tvt_kills' then update public.character_rank_stats set tvt_kills = tvt_kills + p_delta where character_id = p_character_id;
  elsif p_field = 'tvt_deaths' then update public.character_rank_stats set tvt_deaths = tvt_deaths + p_delta where character_id = p_character_id;
  elsif p_field = 'world_boss_kills' then update public.character_rank_stats set world_boss_kills = world_boss_kills + p_delta where character_id = p_character_id;
  elsif p_field = 'world_boss_participations' then update public.character_rank_stats set world_boss_participations = world_boss_participations + p_delta where character_id = p_character_id;
  else raise exception 'INVALID_FIELD';
  end if;
end;
$$;

-- Recalcula bestiary_discovered a partir da contagem real de
-- character_bestiary (nunca incrementado as cegas -- sempre a contagem
-- verdadeira, atomica dentro da mesma funcao).
create or replace function public.rank_stats_sync_bestiary_discovered(p_character_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  select count(*) into v_count from public.character_bestiary where character_id = p_character_id;
  insert into public.character_rank_stats (character_id, bestiary_discovered) values (p_character_id, v_count)
  on conflict (character_id) do update set bestiary_discovered = v_count;
end;
$$;
