-- Fase 5.17.3 -- Performance Advisor (0001_unindexed_foreign_keys):
-- public.friends.friend_id (FK friends_friend_id_fkey -> users) nao tinha
-- indice que cubra a FK (so existiam friends_pkey (user_id, friend_id) e
-- idx_friends_user (user_id)). Nenhum indice e removido nesta fase.
create index if not exists idx_friends_friend_id on public.friends(friend_id);
