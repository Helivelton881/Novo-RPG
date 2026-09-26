-- Fase 5.14: RBAC de admin (owner/admin/moderator/support) + moderacao
-- (ban/mute) + trilha de auditoria. 100% aditivo -- nenhuma tabela
-- existente e alterada. RLS habilitado sem nenhuma policy pra
-- anon/authenticated: so o backend (service_role, que ignora RLS por
-- padrao no Supabase) le/escreve, nunca o cliente direto.

create table public.admin_roles (
  user_id uuid primary key references public.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','moderator','support')),
  granted_by uuid references public.users(id),
  granted_at timestamptz not null default now()
);
alter table public.admin_roles enable row level security;

create table public.player_bans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  reason text not null,
  banned_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz, -- null = permanente
  revoked_at timestamptz,
  revoked_by uuid references public.users(id)
);
alter table public.player_bans enable row level security;
create index idx_player_bans_user on public.player_bans(user_id);

create table public.player_mutes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  reason text not null,
  muted_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.users(id)
);
alter table public.player_mutes enable row level security;
create index idx_player_mutes_user on public.player_mutes(user_id);

-- Trilha de auditoria de TODA acao administrativa (kick/mute/ban/unban/
-- grant de cargo/visualizacao de economia, etc.) -- uma tabela so, sem
-- uma tabela paralela "moderation_actions": toda acao de moderacao JA E
-- uma entrada de audit log, filtravel por `action`.
create table public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.users(id),
  action text not null,
  target_user_id uuid references public.users(id),
  target_character_id uuid references public.characters(id),
  reason text,
  metadata jsonb,
  created_at timestamptz not null default now()
);
alter table public.admin_audit_log enable row level security;
create index idx_admin_audit_log_created on public.admin_audit_log(created_at desc);
create index idx_admin_audit_log_target_user on public.admin_audit_log(target_user_id);
create index idx_admin_audit_log_actor on public.admin_audit_log(actor_user_id);
