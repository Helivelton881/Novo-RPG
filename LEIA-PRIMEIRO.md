# MMORPG: Vila Inicial

Jogo em `index.html` (arquivo único) com progresso salvo no `localStorage` do navegador. O `server.js` serve esse arquivo e também abre um WebSocket para presença multiplayer em tempo real (outros jogadores, monstros e chat) — e, opcionalmente, contas online via Supabase.

## Rodar o servidor

```
npm install
npm start
```

Abre em `http://localhost:8080`. Para testar o multiplayer, abra a mesma URL em duas abas ou dispositivos da mesma rede.

O cliente descobre o endereço do WebSocket sozinho (`wss://` ou `ws://` + o host atual + `/game`) — não existe mais uma constante `MP_URL` para editar. Funciona igual em local e em produção, sem precisar trocar nada no `index.html`.

## O que o servidor sincroniza

- entrada, saída, posição, direção, animação, classe e nível dos jogadores no mesmo mapa;
- HP, dano, morte e respawn dos monstros — o servidor arbitra o estado real;
- uma autoridade de movimentação dos monstros por mapa (um dos clientes conectados), com troca automática se ela desconectar;
- layout determinístico das masmorras, para todos entrarem no mesmo labirinto;
- projéteis de mago, arqueiro e druida (disparo, trajetória, impacto);
- contador de jogadores online, heartbeat e validação básica de mensagens.

Inventário, progressão, cálculo de dano e parte da IA ainda são calculados no cliente. O servidor já limita os pontos mais fáceis de explorar: dano por golpe é limitado por nível (com anti-spam por par jogador/monstro), e ao salvar o personagem na nuvem (`PUT /api/characters/:id`) o servidor reconstrói o save inteiro a partir de limites plausíveis — ouro, gemas, XP, contadores e os stats de cada item do inventário são recalculados a partir de `{type,tier}` server-side, nunca aceitos como o cliente manda. Isso não impede trapaça durante a partida em si (a lógica de combate roda no cliente), mas impede que ela persista/sincronize entre dispositivos.

## Loja/economia server-autoritativa

Comprar, vender, recomprar, redistribuir habilidades (30 moedas) e liberar portal com moedas passam por `POST /api/characters/:id/shop` (`action`: `buy_gear`, `buy_stack`, `sell_item`, `sell_common`, `sell_gem`, `buyback`, `skill_reset`, `buy_portal`). O servidor lê o save atual do banco, confere o preço contra uma tabela própria (`GEAR_PRICES`/`STK_PRICES`/`SELL_PRICES`/`PORTAL_PRICES`, espelhando `buildShop()`/`shopDo()` do cliente), recalcula o item do zero a partir de `{type,tier}` e só depois grava — nunca confia em "eu tenho X moedas" nem no preço que o cliente manda. Testado byte a byte via curl e um teste de WebSocket dedicado (ver histórico de commits).

O diálogo antigo do mercador (`NPC_SCRIPT.mercador`) era código morto — `openDialog` sempre redireciona pro `openShop()` antes de chegar nele — e foi removido.

**Limite dessa fase:** isso fecha a brecha de "comprar sem ter o ouro" e "vender item que não existe com stats inflados". Não fecha 100%: recompensas de missão (`P.gold+=X` no `end()` de cada diálogo) ainda são só client-side, então um save editado via console ainda pode inflar ouro até o teto genérico (500.000) do `sanitizeSave`. Fechar isso de vez exigiria mover recompensa de missão pro servidor também — fora do escopo desta fase.

## Amigos e Grupo

Reais, não só decorativos: `/api/friends` (listar/adicionar/remover, por usuário da conta) e `/api/party` (`POST` cria, `/join` entra com código, `/leave` sai). Status "Online" é verdadeiro — o servidor rastreia quais contas têm um WebSocket conectado agora (`accountSockets`, populado pelo `userId` que o cliente manda no `join`). A tela Social faz polling a cada 5s enquanto aberta. Grupo é efêmero (fica só em memória no servidor, como a autoridade de monstros — não sobrevive a um restart); Amigos persiste na tabela `friends` do Supabase.

## Login online (Supabase) — opcional

Configure estas variáveis **apenas no servidor** (no Render, nunca no `index.html` ou no GitHub):

```
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
```

(`SUPABASE_SERVICE_ROLE_KEY` também é aceita, para projetos com a chave legada.) Use `.env.example` como modelo — copie para `.env` localmente (o `.gitignore` já ignora `.env`).

As rotas `/api/auth/register`, `/api/auth/login`, `/api/auth/session` e `/api/auth/logout` gravam contas e sessões no Supabase. Senhas novas usam `scrypt`; hashes `bcrypt` de uma versão anterior continuam válidos e são migrados no próximo login.

Essas rotas leem/gravam nas tabelas `users` e `sessions`, definidas no `schema.sql` junto com `characters`. **Rodar o `schema.sql` atualizado no seu projeto Supabase** (SQL Editor ou `supabase db push`) antes de configurar as variáveis acima — sem essas tabelas as rotas de login vão falhar mesmo com o servidor configurado corretamente.

## Save do personagem na nuvem

Com uma conta online, o progresso completo do personagem (nível, XP, inventário, equipamento, missão atual, mapa, etc.) sincroniza com a tabela `characters` do Supabase pelas rotas `/api/characters` (listar/criar) e `/api/characters/:id` (salvar/excluir), sempre autenticadas pelo token de sessão — o servidor confere a dono do personagem em toda escrita.

- O `localStorage` continua como cache local instantâneo (o jogo funciona igual offline); o envio ao servidor é em segundo plano, agrupado a cada ~8s e também forçado ao fechar a aba.
- Ao logar em outro aparelho, o cliente busca os personagens da conta no servidor e substitui o cache local pelos dados mais recentes — inclusive promovendo para o servidor um personagem criado localmente antes de existir conta online.
- **Importante:** `characters.user_id` referencia `public.users` (nosso login próprio), não `auth.users` do Supabase Auth — este projeto não usa Supabase Auth. Por isso `schema.sql` não tem mais policy pública de leitura/escrita: só o servidor acessa, via `SUPABASE_SECRET_KEY` (service role), igual a `users`/`sessions`.

## Supabase — schema.sql

`schema.sql` cria as tabelas `users`, `sessions`, `characters` e `friends` (com RLS habilitado e sem policy pública — acesso só via service role pelo servidor). `characters` guarda nível, mapa e o save completo (jsonb) por personagem.

## Produção (Render)

O Render serve o mesmo `server.js` (HTTP + WebSocket na mesma porta, via `PORT`). Sem as variáveis do Supabase configuradas, o jogo e o multiplayer de presença funcionam normalmente — só o login online fica indisponível.
