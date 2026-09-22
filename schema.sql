-- user_id references public.users (nosso login proprio, com senha em scrypt/bcrypt
-- e sessoes por token), nao auth.users (Supabase Auth) -- este projeto nao usa
-- Supabase Auth/GoTrue. Ver server.js: /api/characters/*, acessado so pelo
-- servidor via SUPABASE_SECRET_KEY (service role), que ignora RLS.
create table if not exists public.characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
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

-- Sem Supabase Auth, auth.uid() nunca bate com nosso user_id -- por isso
-- nenhuma policy publica: só o servidor acessa, via service role.
drop policy if exists "characters: leitura pública" on public.characters;
drop policy if exists "characters: dono cria/edita/apaga" on public.characters;

create index if not exists idx_characters_user on public.characters(user_id);
create index if not exists idx_characters_lvl on public.characters(lvl desc);

do $$
begin
  alter publication supabase_realtime add table public.characters;
exception when duplicate_object then
  null;
end $$;

-- Login online (server.js: /api/auth/register, /login, /session, /logout).
-- Acessadas só pelo servidor via SUPABASE_SECRET_KEY (service role), que
-- ignora RLS — por isso nenhuma policy pública é criada de propósito.

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-z0-9_]{3,16}$'),
  password_hash text not null,
  last_login timestamptz,
  created_at timestamptz not null default now()
);

alter table public.users enable row level security;

create table if not exists public.sessions (
  token text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.sessions enable row level security;

create index if not exists idx_sessions_user on public.sessions(user_id);
create index if not exists idx_sessions_expires on public.sessions(expires_at);

-- Lista de amigos (server.js: /api/friends). Grupo/party e efemero e fica
-- so em memoria no servidor (nao precisa de tabela).
create table if not exists public.friends (
  user_id uuid not null references public.users(id) on delete cascade,
  friend_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);

alter table public.friends enable row level security;

create index if not exists idx_friends_user on public.friends(user_id);
