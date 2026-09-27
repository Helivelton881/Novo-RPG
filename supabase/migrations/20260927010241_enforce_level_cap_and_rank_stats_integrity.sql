-- Fase 5.17.3 -- Integridade do level cap (40) e de character_rank_stats.
--
-- Contexto (auditoria de producao, 2026-09-27): 1 personagem legado com
-- lvl 41 (gravado antes da Fase 5.17, quando o cap era 99), a linha de
-- ranking correspondente com level 41, e 1 personagem sem linha em
-- character_rank_stats (POST /api/characters nunca criava a linha; ela so
-- nascia no primeiro syncRankLevelXp, de forma assincrona).
--
-- Regra oficial (game-data/balance-data.js, BALANCE.normalizeProgress):
--   lvl sempre em 1..40; no cap (40) a XP e SEMPRE 0 (XP excedente e
--   descartada, nunca acumulada). O SQL precisa do literal 40 -- a fonte
--   da regra continua sendo BALANCE.LEVEL_CAP no codigo.
--
-- Idempotente: rodar de novo nao altera nada (todos os UPDATE/INSERT so
-- tocam linhas fora da regra; constraints/trigger sao recriados com
-- DROP ... IF EXISTS). Nao toca em nenhuma tabela do Living World.
--
-- Preview (rodar ANTES, somente leitura):
--   select count(*) filter (where lvl > 40 or lvl < 1) as chars_out_of_range,
--          count(*) filter (where lvl = 40 and coalesce(nullif(save->>'xp',''),'0') <> '0') as chars_cap_with_xp,
--          count(*) filter (where save->>'lvl' is distinct from lvl::text) as save_lvl_mismatch
--     from public.characters;
--   select count(*) filter (where level > 40 or level < 1) as rank_out_of_range,
--          count(*) filter (where level = 40 and xp <> 0) as rank_cap_with_xp
--     from public.character_rank_stats;
--   select count(*) as missing_rank from public.characters c
--    where not exists (select 1 from public.character_rank_stats r where r.character_id = c.id);

-- 1) characters: lvl em 1..40
update public.characters
   set lvl = least(greatest(lvl, 1), 40)
 where lvl > 40 or lvl < 1;

-- 2) save JSONB consistente com a coluna: save.lvl = lvl; no cap, save.xp = 0
update public.characters
   set save = jsonb_set(coalesce(save, '{}'::jsonb), '{lvl}', to_jsonb(lvl), true)
 where save is null or save->>'lvl' is distinct from lvl::text;

update public.characters
   set save = jsonb_set(save, '{xp}', '0'::jsonb, true)
 where lvl = 40 and coalesce(nullif(save->>'xp', ''), '0') <> '0';

-- 3) character_rank_stats: mesmo estado normalizado
update public.character_rank_stats
   set level = least(greatest(level, 1), 40)
 where level > 40 or level < 1;

update public.character_rank_stats
   set xp = 0
 where (level = 40 and xp <> 0) or xp < 0;

-- 4) backfill das linhas de ranking ausentes (level/xp reais normalizados;
--    pvp/tvt/world boss/bestiary ficam no default -- nunca inventados)
insert into public.character_rank_stats (character_id, level, xp)
select c.id,
       least(greatest(c.lvl, 1), 40),
       case when c.lvl >= 40 then 0
            when (c.save->>'xp') ~ '^[0-9]{1,9}$' then (c.save->>'xp')::int
            else 0 end
  from public.characters c
 where not exists (select 1 from public.character_rank_stats r where r.character_id = c.id)
on conflict (character_id) do nothing;

-- 5) RPC do servidor nunca mais persiste level > 40 (defesa em profundidade:
--    o codigo ja normaliza antes de chamar)
create or replace function public.rank_stats_set_level_xp(p_character_id uuid, p_level integer, p_xp integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_level integer := least(greatest(coalesce(p_level, 1), 1), 40);
  v_xp integer := case when least(greatest(coalesce(p_level, 1), 1), 40) >= 40 then 0 else greatest(coalesce(p_xp, 0), 0) end;
begin
  insert into public.character_rank_stats (character_id, level, xp)
    values (p_character_id, v_level, v_xp)
  on conflict (character_id) do update set level = excluded.level, xp = excluded.xp;
end;
$$;
revoke execute on function public.rank_stats_set_level_xp(uuid, integer, integer) from public, anon, authenticated;

-- 6) todo personagem novo nasce com a linha de ranking, na MESMA transacao
--    do INSERT (sem janela inconsistente, sem depender de JS assincrono)
create or replace function public.character_rank_stats_on_character_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.character_rank_stats (character_id, level, xp)
    values (new.id,
            least(greatest(coalesce(new.lvl, 1), 1), 40),
            case when coalesce(new.lvl, 1) >= 40 then 0
                 when (new.save->>'xp') ~ '^[0-9]{1,9}$' then (new.save->>'xp')::int
                 else 0 end)
  on conflict (character_id) do nothing;
  return new;
end;
$$;
revoke execute on function public.character_rank_stats_on_character_insert() from public, anon, authenticated;

drop trigger if exists trg_characters_create_rank_stats on public.characters;
create trigger trg_characters_create_rank_stats
  after insert on public.characters
  for each row execute function public.character_rank_stats_on_character_insert();

-- 7) o banco tambem protege a regra (depois do backfill acima)
alter table public.characters drop constraint if exists characters_lvl_range;
alter table public.characters add constraint characters_lvl_range check (lvl between 1 and 40);

alter table public.character_rank_stats drop constraint if exists character_rank_stats_level_range;
alter table public.character_rank_stats add constraint character_rank_stats_level_range check (level between 1 and 40);

alter table public.character_rank_stats drop constraint if exists character_rank_stats_xp_nonnegative;
alter table public.character_rank_stats add constraint character_rank_stats_xp_nonnegative check (xp >= 0);

-- Validacao (rodar DEPOIS, esperado 0/0/0/0/0):
--   select (select count(*) from public.characters where lvl > 40) as chars_over_cap,
--          (select count(*) from public.characters where save->>'lvl' is distinct from lvl::text) as save_mismatch,
--          (select count(*) from public.character_rank_stats where level > 40) as rank_over_cap,
--          (select count(*) from public.characters c where not exists (select 1 from public.character_rank_stats r where r.character_id = c.id)) as missing_rank,
--          (select count(*) from (select character_id from public.character_rank_stats group by 1 having count(*) > 1) d) as dup_rank;
