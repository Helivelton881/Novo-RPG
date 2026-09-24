-- Fase 5.8 -- Guildas / Cla: estrutura relacional (nao guarda a guilda
-- dentro de characters.save). Segue o mesmo padrao de seguranca ja
-- estabelecido no projeto: RLS habilitado, ZERO policies (o jogo nao usa
-- Supabase Auth no cliente -- todo acesso passa por server.js com a
-- service-role key; RLS aqui e uma trava dura contra qualquer acesso
-- direto anon/authenticated, nao um mecanismo de autorizacao por policy).

create table if not exists public.guilds (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_lower text not null,
  tag text not null,
  tag_lower text not null,
  leader_character_id uuid not null references public.characters(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guilds_name_len check (char_length(name) between 3 and 24),
  constraint guilds_tag_len check (char_length(tag) between 2 and 5)
);
create unique index if not exists uq_guilds_name_lower on public.guilds(name_lower);
create unique index if not exists uq_guilds_tag_lower on public.guilds(tag_lower);
create trigger trg_guilds_touch before update on public.guilds for each row execute function public.touch_updated_at();
alter table public.guilds enable row level security;

-- character_id como PK (nao composta com guild_id) garante, no proprio
-- banco, que um personagem nunca pertence a mais de uma guilda ao mesmo
-- tempo -- nao depende so de checagem em JS.
create table if not exists public.guild_members (
  guild_id uuid not null references public.guilds(id) on delete cascade,
  character_id uuid primary key references public.characters(id) on delete cascade,
  role text not null default 'member' check (role in ('leader','officer','member')),
  joined_at timestamptz not null default now()
);
create index if not exists idx_guild_members_guild on public.guild_members(guild_id);
alter table public.guild_members enable row level security;

create table if not exists public.guild_invites (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references public.guilds(id) on delete cascade,
  inviter_character_id uuid not null references public.characters(id) on delete cascade,
  target_character_id uuid not null references public.characters(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined','cancelled','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create index if not exists idx_guild_invites_target on public.guild_invites(target_character_id, status);
create index if not exists idx_guild_invites_guild on public.guild_invites(guild_id, status);
-- No maximo um convite PENDENTE por (guilda, alvo) -- evita spam de
-- convites duplicados pro mesmo personagem pela mesma guilda.
create unique index if not exists uq_guild_invite_pending on public.guild_invites(guild_id, target_character_id) where status = 'pending';
alter table public.guild_invites enable row level security;

-- ===== Funcoes RPC (SECURITY DEFINER, search_path fixo -- mesmo padrao de
-- endurecimento ja aplicado em touch_updated_at pela migration
-- 20260922150012). Chamadas via POST /rest/v1/rpc/<nome> com a
-- service-role key, nunca pelo cliente. Cada uma encapsula uma operacao
-- que precisa ser atomica (criar guilda+lider, aceitar convite, transferir
-- lideranca, remover membro/sair, dissolver) -- evita corrida entre duas
-- requisicoes concorrentes (dupla lideranca, entrar em duas guildas, etc). =====

create or replace function public.guild_create(p_character_id uuid, p_name text, p_tag text)
returns public.guilds
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare g public.guilds; v_constraint text;
begin
  if exists (select 1 from public.guild_members where character_id = p_character_id) then
    raise exception 'ALREADY_IN_GUILD';
  end if;
  insert into public.guilds (name, name_lower, tag, tag_lower, leader_character_id)
    values (p_name, lower(p_name), p_tag, lower(p_tag), p_character_id)
    returning * into g;
  insert into public.guild_members (guild_id, character_id, role) values (g.id, p_character_id, 'leader');
  return g;
exception
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'guild_members_pkey' then raise exception 'ALREADY_IN_GUILD';
    else raise exception 'NAME_OR_TAG_TAKEN'; end if;
end;
$$;

create or replace function public.guild_accept_invite(p_invite_id uuid, p_character_id uuid)
returns public.guild_members
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare inv public.guild_invites; gm public.guild_members; member_count int;
begin
  select * into inv from public.guild_invites where id = p_invite_id for update;
  if inv is null then raise exception 'INVITE_NOT_FOUND'; end if;
  if inv.target_character_id <> p_character_id then raise exception 'INVITE_NOT_YOURS'; end if;
  if inv.status <> 'pending' then raise exception 'INVITE_NOT_PENDING'; end if;
  if inv.expires_at <= now() then
    update public.guild_invites set status = 'expired' where id = p_invite_id;
    raise exception 'INVITE_EXPIRED';
  end if;
  if exists (select 1 from public.guild_members where character_id = p_character_id) then
    raise exception 'ALREADY_IN_GUILD';
  end if;
  select count(*) into member_count from public.guild_members where guild_id = inv.guild_id;
  if member_count >= 20 then raise exception 'GUILD_FULL'; end if;
  insert into public.guild_members (guild_id, character_id, role) values (inv.guild_id, p_character_id, 'member') returning * into gm;
  update public.guild_invites set status = 'accepted' where id = p_invite_id;
  -- outros convites pendentes pro mesmo personagem (de qualquer guilda) sao
  -- cancelados automaticamente, ja que ele acabou de entrar numa guilda.
  update public.guild_invites set status = 'cancelled' where target_character_id = p_character_id and status = 'pending' and id <> p_invite_id;
  return gm;
end;
$$;

create or replace function public.guild_remove_member(p_actor_character_id uuid, p_target_character_id uuid, p_is_leave boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare actor_role text; target_role text; g_id uuid; member_count int;
begin
  select gm.role, gm.guild_id into actor_role, g_id from public.guild_members gm where gm.character_id = p_actor_character_id;
  if actor_role is null then raise exception 'NOT_A_MEMBER'; end if;
  if p_is_leave then
    if p_actor_character_id <> p_target_character_id then raise exception 'INVALID_REQUEST'; end if;
    if actor_role = 'leader' then
      select count(*) into member_count from public.guild_members where guild_id = g_id;
      if member_count > 1 then raise exception 'LEADER_MUST_TRANSFER_OR_DISSOLVE'; end if;
      -- unico membro: sair == dissolver.
      delete from public.guilds where id = g_id;
      return;
    end if;
    delete from public.guild_members where character_id = p_target_character_id;
    return;
  end if;
  -- kick
  select gm.role into target_role from public.guild_members gm where gm.character_id = p_target_character_id and gm.guild_id = g_id;
  if target_role is null then raise exception 'TARGET_NOT_IN_GUILD'; end if;
  if actor_role = 'leader' and target_role <> 'leader' then
    delete from public.guild_members where character_id = p_target_character_id;
    return;
  end if;
  if actor_role = 'officer' and target_role = 'member' then
    delete from public.guild_members where character_id = p_target_character_id;
    return;
  end if;
  raise exception 'INSUFFICIENT_ROLE';
end;
$$;

create or replace function public.guild_set_role(p_actor_character_id uuid, p_target_character_id uuid, p_new_role text)
returns public.guild_members
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare actor_role text; target_role text; g_id uuid; gm public.guild_members;
begin
  if p_new_role not in ('officer','member') then raise exception 'INVALID_ROLE'; end if;
  select gm.role, gm.guild_id into actor_role, g_id from public.guild_members gm where gm.character_id = p_actor_character_id;
  if actor_role <> 'leader' then raise exception 'INSUFFICIENT_ROLE'; end if;
  select gm.role into target_role from public.guild_members gm where gm.character_id = p_target_character_id and gm.guild_id = g_id;
  if target_role is null then raise exception 'TARGET_NOT_IN_GUILD'; end if;
  if target_role = 'leader' then raise exception 'CANNOT_CHANGE_LEADER_ROLE'; end if;
  if target_role = p_new_role then raise exception 'ALREADY_THAT_ROLE'; end if;
  update public.guild_members set role = p_new_role where character_id = p_target_character_id returning * into gm;
  return gm;
end;
$$;

create or replace function public.guild_transfer_leadership(p_actor_character_id uuid, p_new_leader_character_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare g_id uuid; target_guild uuid;
begin
  select gm.guild_id into g_id from public.guild_members gm where gm.character_id = p_actor_character_id and gm.role = 'leader';
  if g_id is null then raise exception 'INSUFFICIENT_ROLE'; end if;
  select gm.guild_id into target_guild from public.guild_members gm where gm.character_id = p_new_leader_character_id;
  if target_guild is null or target_guild <> g_id then raise exception 'TARGET_NOT_IN_GUILD'; end if;
  if p_new_leader_character_id = p_actor_character_id then raise exception 'ALREADY_LEADER'; end if;
  update public.guild_members set role = 'officer' where character_id = p_actor_character_id;
  update public.guild_members set role = 'leader' where character_id = p_new_leader_character_id;
  update public.guilds set leader_character_id = p_new_leader_character_id where id = g_id;
end;
$$;

create or replace function public.guild_dissolve(p_actor_character_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare g_id uuid; actor_role text;
begin
  select gm.guild_id, gm.role into g_id, actor_role from public.guild_members gm where gm.character_id = p_actor_character_id;
  if g_id is null or actor_role <> 'leader' then raise exception 'INSUFFICIENT_ROLE'; end if;
  delete from public.guilds where id = g_id; -- cascade cuida de members/invites
end;
$$;
