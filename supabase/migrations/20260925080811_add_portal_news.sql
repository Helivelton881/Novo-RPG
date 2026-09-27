-- Fase 5.15: sistema de noticias simples, gerenciavel pelo admin, pra
-- alimentar o Portal Publico. Aditivo -- nenhuma tabela existente
-- alterada. Leitura e publica (via backend, cache curto -- nunca
-- policy pra anon direto no Postgres, mesmo padrao das outras 17
-- tabelas), escrita so pelo painel admin (admin/owner).
create table public.portal_news (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  author_user_id uuid references public.users(id),
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.portal_news enable row level security;
create index idx_portal_news_published on public.portal_news(published_at desc);
create index idx_portal_news_author on public.portal_news(author_user_id);
