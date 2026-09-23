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

Inventário, progressão e parte da IA ainda são calculados no cliente. O dano por golpe/skill **não é mais** — o cliente só informa qual skill (ou "basic") e a própria classe/nível/ataque; o servidor recalcula o valor exato e é ele quem decide quanto HP o monstro perde. Ao salvar o personagem na nuvem (`PUT /api/characters/:id`) o servidor também reconstrói o save inteiro a partir de limites plausíveis — ouro, gemas, XP, contadores e os stats de cada item do inventário são recalculados a partir de `{type,tier}` server-side, nunca aceitos como o cliente manda.

## Dano exato por skill/cooldown (server-autoritativo)

O cliente manda `cast_skill` (`id`, `sk`=rank, `atk`) toda vez que usa uma habilidade — o servidor confere se ela pertence à classe do jogador, se o cooldown real já passou (`SKILL_CD_MS`, um mapa por skill, espelhando `SKILLS`/`CLASSES` do cliente) e, se passou, calcula o dano exato com a mesma fórmula do cliente (`skBase()*multiplicador do rank`, com `atk` limitado a um teto genérico de 35 — não dá pra alegar um ataque maior que o de qualquer equipamento real) e guarda esse valor como "pendente" por alguns segundos. Cada `mob_damage` que referencia aquela skill só aplica dano se existir um valor pendente válido — nunca aceita um número que o cliente mande diretamente. Ataques básicos são calculados na hora (sem cast prévio), com limite de ~6 golpes por janela de velocidade de ataque da classe, além do limite de 80ms por par jogador/monstro que já existia.

**O que isso NÃO cobre:** o servidor ainda não *simula* onde os monstros estão (isso seria a Fase C completa — IA de monstro rodando no servidor, um projeto multi-dia à parte, não feito). O que passou a ser impossível é reportar um dano maior do que a fórmula real permite, ou usar uma skill sem respeitar o cooldown dela.

## Fase C1 — validação de alcance (sem reescrever IA)

Sem simular monstro nenhum: o servidor já sabe a posição real do jogador (via `state`, enviado a cada ~90ms) e a última posição conhecida do monstro (via `mob_snapshot`, hoje só retransmitida do cliente-autoridade). Em todo `mob_damage`, rejeita o golpe se a distância entre as duas for maior que 550 — generoso o bastante pra cobrir o pior caso real do jogo (Flecha Perfurante viaja ~476; Raízes/Campo de Espinhos podem mirar um alvo a até 320 de distância + 90 de raio), mas suficiente pra travar "bater em monstro que está do outro lado do mapa" ou que nem existe de verdade pra você. Testado com um monstro movido artificialmente pra longe via `mob_snapshot` falso: o golpe foi corretamente rejeitado; movido pra uma distância moderada, voltou a funcionar.

Isso não substitui a Fase C completa — a posição do monstro em si ainda vem do cliente-autoridade, não de uma simulação do servidor. É uma auditoria sobre o que já se recebe, não uma fonte de verdade nova.

## PvP

Liberado em qualquer mapa exceto `vila`. Reaproveita 100% a validação de dano/cooldown/alcance server-autoritativa que já existe pra PvE (`resolveAttackDamage`, compartilhada entre `mob_damage` e `player_damage`) — o servidor nunca rastreia o HP do alvo: manda o dano bruto calculado, e quem recebe aplica a própria mitigação (defesa/bloqueio/escudo) localmente, exatamente como já faz contra ataque de monstro (`hurtPlayer`). Morte/respawn reaproveitam o fluxo existente sem nenhum código novo.

Bloqueado dos dois lados: o cliente nem manda `player_damage` estando na vila (`pvpOn()`), e o servidor rejeita de qualquer forma se `map==='vila'`. Membros do mesmo grupo (`/api/party`) são imunes entre si. Todo ponto que já causava dano em monstro (ataque básico, Golpe Giratório, Investida, Raízes, Campo de Espinhos, Nova de Gelo, Bola de Fogo + respingo, Tiro Múltiplo, Flecha Perfurante) agora também acerta jogadores remotos dentro da mesma área/alcance.

**Limite:** efeitos de controle (raiz, lentidão) não são sincronizados pro alvo em PvP — só o dano. Sincronizar isso exigiria mais um canal de status-effect entre jogadores, fora do escopo desta entrega.

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
