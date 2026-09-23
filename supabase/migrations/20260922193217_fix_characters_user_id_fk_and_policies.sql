alter table public.characters drop constraint characters_user_id_fkey;
alter table public.characters add constraint characters_user_id_fkey foreign key (user_id) references public.users(id) on delete cascade;

drop policy if exists "characters: leitura pública" on public.characters;
drop policy if exists "characters: dono cria/edita/apaga" on public.characters;
