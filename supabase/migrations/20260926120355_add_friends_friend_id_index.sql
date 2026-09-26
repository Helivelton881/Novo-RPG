-- Fase 5.16.7: indice de cobertura pra friends_friend_id_fkey, sinalizado
-- pelo Performance Advisor (unindexed_foreign_keys). idx_friends_user ja
-- cobre user_id desde a migration original -- essa so cobre o outro lado
-- da amizade (friend_id), usado em buscas "quem me adicionou".
create index if not exists idx_friends_friend_id on public.friends(friend_id);
