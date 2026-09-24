-- Fase 5.11 -- Mercado/Leilao: Auction House server-authoritative com
-- escrow. Fase mais sensivel economicamente do projeto -- prioridade
-- maxima: nenhuma duplicacao de item, nenhuma duplicacao de gold, nenhum
-- item perdido. Mesmo padrao de seguranca das demais tabelas: RLS
-- habilitado, zero policies (todo acesso passa por server.js com a
-- service-role key).

create table if not exists public.market_listings (
  id uuid primary key default gen_random_uuid(),
  seller_character_id uuid not null references public.characters(id) on delete restrict,
  item_uid text not null,
  item_json jsonb not null,
  item_type text not null,
  item_level integer not null,
  item_rarity text not null,
  item_enchant integer not null default 0,
  price integer not null check (price between 1 and 500000),
  status text not null default 'active' check (status in ('active','sold','cancelled','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '72 hours'),
  buyer_character_id uuid references public.characters(id) on delete restrict,
  sold_at timestamptz
);
-- um item fisico (uid) nunca pode estar em duas listings ATIVAS ao mesmo
-- tempo -- na pratica ja e garantido pelo fato do item sair do bag no
-- momento do escrow (market_list_item), mas o indice e defesa em
-- profundidade explicita, como pedido.
create unique index if not exists uq_market_listings_active_uid on public.market_listings(item_uid) where status = 'active';
create index if not exists idx_market_listings_status on public.market_listings(status);
create index if not exists idx_market_listings_price on public.market_listings(price);
create index if not exists idx_market_listings_created on public.market_listings(created_at desc);
create index if not exists idx_market_listings_type on public.market_listings(item_type);
create index if not exists idx_market_listings_level on public.market_listings(item_level);
create index if not exists idx_market_listings_rarity on public.market_listings(item_rarity);
create index if not exists idx_market_listings_enchant on public.market_listings(item_enchant);
create index if not exists idx_market_listings_seller on public.market_listings(seller_character_id);
alter table public.market_listings enable row level security;

-- Historico imutavel -- nunca UPDATE/DELETE depois de inserido.
create table if not exists public.market_transactions (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.market_listings(id) on delete restrict,
  seller_character_id uuid not null references public.characters(id) on delete restrict,
  buyer_character_id uuid not null references public.characters(id) on delete restrict,
  item_uid text not null,
  price integer not null,
  fee integer not null,
  seller_received integer not null,
  operation_id uuid not null,
  created_at timestamptz not null default now()
);
-- idempotencia real: reenviar a MESMA operationId nunca cria uma segunda
-- transacao -- market_buy confere isso antes de qualquer efeito colateral.
create unique index if not exists uq_market_transactions_operation on public.market_transactions(operation_id);
create index if not exists idx_market_transactions_seller on public.market_transactions(seller_character_id, created_at desc);
create index if not exists idx_market_transactions_buyer on public.market_transactions(buyer_character_id, created_at desc);
alter table public.market_transactions enable row level security;

-- Item/gold pendente de retirada -- usado quando a mochila esta cheia ou
-- o teto de ouro seria estourado (nunca trunca/perde valor silenciosamente).
create table if not exists public.market_claims (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters(id) on delete cascade,
  kind text not null check (kind in ('item','gold')),
  item_json jsonb,
  gold_amount integer,
  reason text not null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  check ((kind = 'item' and item_json is not null and gold_amount is null) or (kind = 'gold' and gold_amount is not null and item_json is null))
);
create index if not exists idx_market_claims_character on public.market_claims(character_id) where claimed_at is null;
alter table public.market_claims enable row level security;

-- ===== Funcoes RPC (SECURITY DEFINER, search_path fixo). Todas chamadas
-- via server.js com a service-role key, sempre dentro de withCharLock()
-- pro(s) personagem(ns) envolvido(s) -- fecha a corrida com o resto do
-- codigo economico existente (creditKillReward/handleShop/etc, que ainda
-- fazem leitura-altera-grava em duas chamadas REST separadas). O lock
-- real (`for update`) dentro da funcao SQL e quem garante atomicidade de
-- verdade no proprio Postgres, independente de quantas instancias Node
-- existirem no futuro. =====

-- Escrow: remove o item do bag do vendedor e cria a listing, tudo numa
-- transacao so. Nunca aceita item_json/rarity/enchant/atk/def do
-- cliente -- o item inteiro vem sempre do bag real, so o uid identifica
-- QUAL item.
create or replace function public.market_list_item(p_seller_character_id uuid, p_item_uid text, p_price integer)
returns public.market_listings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_save jsonb;
  v_bag jsonb;
  v_idx int;
  v_item jsonb;
  v_listing public.market_listings;
begin
  if p_price < 1 or p_price > 500000 then raise exception 'INVALID_PRICE'; end if;

  select save into v_save from public.characters where id = p_seller_character_id for update;
  if v_save is null then raise exception 'CHARACTER_NOT_FOUND'; end if;

  v_bag := coalesce(v_save->'bag', '[]'::jsonb);
  select (t.ord - 1) into v_idx
    from jsonb_array_elements(v_bag) with ordinality as t(elem, ord)
    where t.elem->>'uid' = p_item_uid
    limit 1;
  if v_idx is null then raise exception 'ITEM_NOT_IN_BAG'; end if;

  v_item := v_bag -> v_idx;
  v_save := jsonb_set(v_save, '{bag}', v_bag - v_idx);
  update public.characters set save = v_save where id = p_seller_character_id;

  insert into public.market_listings (seller_character_id, item_uid, item_json, item_type, item_level, item_rarity, item_enchant, price, status)
    values (p_seller_character_id, p_item_uid, v_item, v_item->>'type', (v_item->>'lv')::int, v_item->>'rarity', coalesce((v_item->>'enchant')::int, 0), p_price, 'active')
    returning * into v_listing;

  return v_listing;
exception
  when unique_violation then raise exception 'ITEM_ALREADY_LISTED';
end;
$$;

-- Cancelamento: so o vendedor, so listing ativa. Item sempre vai pra
-- claim (nunca direto pro bag) -- evita que cancelar falhe por mochila
-- cheia, como pedido explicitamente.
create or replace function public.market_cancel_listing(p_seller_character_id uuid, p_listing_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_listing public.market_listings;
begin
  select * into v_listing from public.market_listings where id = p_listing_id for update;
  if v_listing is null then raise exception 'LISTING_NOT_FOUND'; end if;
  if v_listing.seller_character_id <> p_seller_character_id then raise exception 'NOT_YOUR_LISTING'; end if;
  if v_listing.status <> 'active' then raise exception 'LISTING_NOT_ACTIVE'; end if;

  update public.market_listings set status = 'cancelled' where id = p_listing_id;
  insert into public.market_claims (character_id, kind, item_json, reason) values (p_seller_character_id, 'item', v_listing.item_json, 'market_cancelled');
end;
$$;

-- Compra: a operacao mais critica de toda a fase. Idempotente via
-- operation_id (repetir a mesma chamada nunca compra duas vezes), lock
-- em ordem canonica (menor uuid primeiro) entre comprador/vendedor pra
-- nunca dar deadlock entre duas compras concorrentes envolvendo os
-- mesmos dois personagens em papeis invertidos.
create or replace function public.market_buy(p_listing_id uuid, p_buyer_character_id uuid, p_operation_id uuid)
returns public.market_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.market_transactions;
  v_listing public.market_listings;
  v_first_id uuid;
  v_second_id uuid;
  v_buyer_save jsonb;
  v_seller_save jsonb;
  v_buyer_gold integer;
  v_seller_gold integer;
  v_fee integer;
  v_received integer;
  v_tx public.market_transactions;
begin
  select * into v_existing from public.market_transactions where operation_id = p_operation_id;
  if v_existing is not null then return v_existing; end if;

  select * into v_listing from public.market_listings where id = p_listing_id for update;
  if v_listing is null then raise exception 'LISTING_NOT_FOUND'; end if;
  if v_listing.status <> 'active' then raise exception 'LISTING_NOT_ACTIVE'; end if;
  if v_listing.seller_character_id = p_buyer_character_id then raise exception 'CANNOT_BUY_OWN_LISTING'; end if;

  if p_buyer_character_id < v_listing.seller_character_id then
    v_first_id := p_buyer_character_id; v_second_id := v_listing.seller_character_id;
  else
    v_first_id := v_listing.seller_character_id; v_second_id := p_buyer_character_id;
  end if;
  perform 1 from public.characters where id = v_first_id for update;
  perform 1 from public.characters where id = v_second_id for update;

  select save into v_buyer_save from public.characters where id = p_buyer_character_id;
  if v_buyer_save is null then raise exception 'BUYER_NOT_FOUND'; end if;
  v_buyer_gold := coalesce((v_buyer_save->>'gold')::int, 0);
  if v_buyer_gold < v_listing.price then raise exception 'INSUFFICIENT_GOLD'; end if;

  v_fee := floor(v_listing.price * 0.05);
  v_received := v_listing.price - v_fee;

  v_buyer_save := jsonb_set(v_buyer_save, '{gold}', to_jsonb(v_buyer_gold - v_listing.price));
  if jsonb_array_length(coalesce(v_buyer_save->'bag', '[]'::jsonb)) < 24 then
    v_buyer_save := jsonb_set(v_buyer_save, '{bag}', coalesce(v_buyer_save->'bag', '[]'::jsonb) || jsonb_build_array(v_listing.item_json));
  else
    insert into public.market_claims (character_id, kind, item_json, reason) values (p_buyer_character_id, 'item', v_listing.item_json, 'market_buy_bag_full');
  end if;
  update public.characters set save = v_buyer_save where id = p_buyer_character_id;

  select save into v_seller_save from public.characters where id = v_listing.seller_character_id;
  v_seller_gold := coalesce((v_seller_save->>'gold')::int, 0);
  if v_seller_gold + v_received <= 500000 then
    v_seller_save := jsonb_set(v_seller_save, '{gold}', to_jsonb(v_seller_gold + v_received));
    update public.characters set save = v_seller_save where id = v_listing.seller_character_id;
  else
    insert into public.market_claims (character_id, kind, gold_amount, reason) values (v_listing.seller_character_id, 'gold', v_received, 'market_sale_gold_cap');
  end if;

  update public.market_listings set status = 'sold', buyer_character_id = p_buyer_character_id, sold_at = now() where id = p_listing_id;

  insert into public.market_transactions (listing_id, seller_character_id, buyer_character_id, item_uid, price, fee, seller_received, operation_id)
    values (p_listing_id, v_listing.seller_character_id, p_buyer_character_id, v_listing.item_uid, v_listing.price, v_fee, v_received, p_operation_id)
    returning * into v_tx;

  return v_tx;
exception
  when unique_violation then
    select * into v_tx from public.market_transactions where operation_id = p_operation_id;
    if v_tx is not null then return v_tx; end if;
    raise;
end;
$$;

-- Expiracao (worker leve, idempotente): listings ativas vencidas viram
-- 'expired' e o item vai pra claim. So mexe em linhas com status='active'
-- no proprio WHERE do UPDATE -- rodar duas vezes seguidas e inofensivo.
create or replace function public.market_expire_listings()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row record; v_count integer := 0;
begin
  for v_row in
    update public.market_listings set status = 'expired'
    where status = 'active' and expires_at <= now()
    returning id, seller_character_id, item_json
  loop
    insert into public.market_claims (character_id, kind, item_json, reason) values (v_row.seller_character_id, 'item', v_row.item_json, 'market_expired');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Retirada de claim de item: nunca remove o claim se a mochila estiver
-- cheia (fica pendente pra tentar de novo depois).
create or replace function public.market_claim_item(p_character_id uuid, p_claim_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_claim public.market_claims; v_save jsonb;
begin
  select * into v_claim from public.market_claims where id = p_claim_id for update;
  if v_claim is null then raise exception 'CLAIM_NOT_FOUND'; end if;
  if v_claim.character_id <> p_character_id then raise exception 'NOT_YOUR_CLAIM'; end if;
  if v_claim.claimed_at is not null then raise exception 'ALREADY_CLAIMED'; end if;
  if v_claim.kind <> 'item' then raise exception 'WRONG_CLAIM_KIND'; end if;

  select save into v_save from public.characters where id = p_character_id for update;
  if v_save is null then raise exception 'CHARACTER_NOT_FOUND'; end if;
  if jsonb_array_length(coalesce(v_save->'bag', '[]'::jsonb)) >= 24 then raise exception 'BAG_FULL'; end if;

  v_save := jsonb_set(v_save, '{bag}', coalesce(v_save->'bag', '[]'::jsonb) || jsonb_build_array(v_claim.item_json));
  update public.characters set save = v_save where id = p_character_id;
  update public.market_claims set claimed_at = now() where id = p_claim_id;

  return v_claim.item_json;
end;
$$;

-- Retirada de claim de ouro: nunca credita parcial nem trunca -- so
-- credita se couber inteiro no teto; senao fica pendente.
create or replace function public.market_claim_gold(p_character_id uuid, p_claim_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_claim public.market_claims; v_save jsonb; v_gold integer;
begin
  select * into v_claim from public.market_claims where id = p_claim_id for update;
  if v_claim is null then raise exception 'CLAIM_NOT_FOUND'; end if;
  if v_claim.character_id <> p_character_id then raise exception 'NOT_YOUR_CLAIM'; end if;
  if v_claim.claimed_at is not null then raise exception 'ALREADY_CLAIMED'; end if;
  if v_claim.kind <> 'gold' then raise exception 'WRONG_CLAIM_KIND'; end if;

  select save into v_save from public.characters where id = p_character_id for update;
  if v_save is null then raise exception 'CHARACTER_NOT_FOUND'; end if;
  v_gold := coalesce((v_save->>'gold')::int, 0);
  if v_gold + v_claim.gold_amount > 500000 then raise exception 'GOLD_CAP_WOULD_OVERFLOW'; end if;

  v_save := jsonb_set(v_save, '{gold}', to_jsonb(v_gold + v_claim.gold_amount));
  update public.characters set save = v_save where id = p_character_id;
  update public.market_claims set claimed_at = now() where id = p_claim_id;

  return v_claim.gold_amount;
end;
$$;
