-- Fases 5.8-5.11: hardening aditivo das RPCs server-only.
-- O cliente do Novo-RPG nunca chama o Data API diretamente: apenas o
-- backend, autenticado com secret/service_role, pode executar estas funcoes.

-- Serializa accepts pelo id da guilda antes da funcao original contar os
-- membros. Assim, dois convites aceitos ao mesmo tempo nunca ultrapassam 20.
alter function public.guild_accept_invite(uuid, uuid)
  rename to guild_accept_invite_internal_20260924;

create function public.guild_accept_invite(p_invite_id uuid, p_character_id uuid)
returns public.guild_members
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_guild_id uuid;
begin
  select guild_id into v_guild_id
    from public.guild_invites where id = p_invite_id;
  if v_guild_id is null then raise exception 'INVITE_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_guild_id::text, 5801));
  return public.guild_accept_invite_internal_20260924(p_invite_id, p_character_id);
end;
$$;

-- Transferencias concorrentes da mesma guilda usam a mesma trava logica.
alter function public.guild_transfer_leadership(uuid, uuid)
  rename to guild_transfer_leadership_internal_20260924;

create function public.guild_transfer_leadership(p_actor_character_id uuid, p_new_leader_character_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_guild_id uuid;
begin
  select guild_id into v_guild_id
    from public.guild_members where character_id = p_actor_character_id;
  if v_guild_id is null then raise exception 'INSUFFICIENT_ROLE'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_guild_id::text, 5801));
  perform public.guild_transfer_leadership_internal_20260924(p_actor_character_id, p_new_leader_character_id);
end;
$$;

-- Um operation_id identifica exatamente uma compra. A trava evita que dois
-- retries simultaneos atravessem a verificacao; reutilizacao para outro
-- comprador ou listing falha sem qualquer efeito economico.
alter function public.market_buy(uuid, uuid, uuid)
  rename to market_buy_internal_20260924;

create function public.market_buy(p_listing_id uuid, p_buyer_character_id uuid, p_operation_id uuid)
returns public.market_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_existing public.market_transactions;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_operation_id::text, 5111));
  select * into v_existing
    from public.market_transactions where operation_id = p_operation_id;
  if v_existing is not null then
    if v_existing.listing_id <> p_listing_id
       or v_existing.buyer_character_id <> p_buyer_character_id then
      raise exception 'OPERATION_ID_CONFLICT';
    end if;
    return v_existing;
  end if;
  return public.market_buy_internal_20260924(p_listing_id, p_buyer_character_id, p_operation_id);
end;
$$;

-- Indices de cobertura para FKs das novas fases sinalizadas pelo Advisor.
create index if not exists idx_guild_invites_inviter_character
  on public.guild_invites(inviter_character_id);
create index if not exists idx_guilds_leader_character
  on public.guilds(leader_character_id);
create index if not exists idx_market_listings_buyer_character
  on public.market_listings(buyer_character_id);
create index if not exists idx_market_transactions_listing
  on public.market_transactions(listing_id);

-- O PostgreSQL concede EXECUTE a PUBLIC por padrao. Revoga explicitamente
-- nas 16 APIs privilegiadas e nas 3 implementacoes internas preservadas.
revoke execute on function public.bestiary_record_kill(uuid, text) from public, anon, authenticated;
revoke execute on function public.guild_create(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.guild_accept_invite(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.guild_remove_member(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.guild_set_role(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.guild_transfer_leadership(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.guild_dissolve(uuid) from public, anon, authenticated;
revoke execute on function public.rank_stats_set_level_xp(uuid, integer, integer) from public, anon, authenticated;
revoke execute on function public.rank_stats_bump(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.rank_stats_sync_bestiary_discovered(uuid) from public, anon, authenticated;
revoke execute on function public.market_list_item(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.market_cancel_listing(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.market_buy(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.market_expire_listings() from public, anon, authenticated;
revoke execute on function public.market_claim_item(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.market_claim_gold(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.guild_accept_invite_internal_20260924(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.guild_transfer_leadership_internal_20260924(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.market_buy_internal_20260924(uuid, uuid, uuid) from public, anon, authenticated;

grant execute on function public.bestiary_record_kill(uuid, text) to service_role;
grant execute on function public.guild_create(uuid, text, text) to service_role;
grant execute on function public.guild_accept_invite(uuid, uuid) to service_role;
grant execute on function public.guild_remove_member(uuid, uuid, boolean) to service_role;
grant execute on function public.guild_set_role(uuid, uuid, text) to service_role;
grant execute on function public.guild_transfer_leadership(uuid, uuid) to service_role;
grant execute on function public.guild_dissolve(uuid) to service_role;
grant execute on function public.rank_stats_set_level_xp(uuid, integer, integer) to service_role;
grant execute on function public.rank_stats_bump(uuid, text, integer) to service_role;
grant execute on function public.rank_stats_sync_bestiary_discovered(uuid) to service_role;
grant execute on function public.market_list_item(uuid, text, integer) to service_role;
grant execute on function public.market_cancel_listing(uuid, uuid) to service_role;
grant execute on function public.market_buy(uuid, uuid, uuid) to service_role;
grant execute on function public.market_expire_listings() to service_role;
grant execute on function public.market_claim_item(uuid, uuid) to service_role;
grant execute on function public.market_claim_gold(uuid, uuid) to service_role;
grant execute on function public.guild_accept_invite_internal_20260924(uuid, uuid) to service_role;
grant execute on function public.guild_transfer_leadership_internal_20260924(uuid, uuid) to service_role;
grant execute on function public.market_buy_internal_20260924(uuid, uuid, uuid) to service_role;
