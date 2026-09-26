-- Fase 5.14: indices de cobertura pras FKs sinalizadas pelo Performance
-- Advisor logo apos a migracao anterior -- so nas tabelas novas desta
-- fase (nao mexe em nada pre-existente, fora de escopo).
create index if not exists idx_admin_roles_granted_by on public.admin_roles(granted_by);
create index if not exists idx_admin_audit_log_target_character on public.admin_audit_log(target_character_id);
create index if not exists idx_player_bans_banned_by on public.player_bans(banned_by);
create index if not exists idx_player_bans_revoked_by on public.player_bans(revoked_by);
create index if not exists idx_player_mutes_muted_by on public.player_mutes(muted_by);
create index if not exists idx_player_mutes_revoked_by on public.player_mutes(revoked_by);
