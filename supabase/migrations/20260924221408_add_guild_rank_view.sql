-- Fase 5.10 -- ranking de guilda: calculado ao vivo a partir dos membros
-- (nao existe guild_rank_stats separado, evita mais um lugar pra manter
-- sincronizado). View simples, consultavel via GET /rest/v1/guild_rank_view
-- igual as demais tabelas -- mesma cache de 45s aplicada em server.js.
create or replace view public.guild_rank_view
with (security_invoker = true)
as
select
  g.id as guild_id,
  g.name,
  g.tag,
  count(gm.character_id)::int as member_count,
  coalesce(sum(rs.level), 0)::int as total_level,
  coalesce(sum(rs.tvt_wins), 0)::int as tvt_wins,
  coalesce(sum(rs.world_boss_kills), 0)::int as world_boss_kills
from public.guilds g
join public.guild_members gm on gm.guild_id = g.id
left join public.character_rank_stats rs on rs.character_id = gm.character_id
group by g.id, g.name, g.tag;

alter view public.guild_rank_view owner to postgres;
