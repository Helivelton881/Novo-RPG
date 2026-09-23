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

## Fase 1 (unidade 1) — recompensa de missão server-autoritativa

Os 8 estágios de `NPC_SCRIPT.aldea` que pagam prêmio (missão 2, 4, 8, 12, 16, 20, 24, 28 — ouro/gema/XP, um deles também dá uma poção) não chamam mais `P.gold+=X;P.gem+=Y;gainXp(Z)` direto. Com conta online, o cliente manda só a intenção (`POST /api/characters/:id/quest`, `{from: N}`); o servidor lê o `save.quest` real gravado no Supabase, confere se bate exatamente com `N` (rejeita repetir a mesma recompensa ou pular estágio), aplica a tabela de prêmios espelhada (`QUEST_REWARDS`) e o mesmo cálculo de XP/level-up do cliente (`questNeed(l)=30*l`, igual ao `need()` do `index.html`) e só então grava. A resposta manda de volta o personagem já atualizado; o cliente aplica os valores autoritativos em vez de ter calculado sozinho.

Sem conta online — ou se a chamada ao servidor falhar por qualquer motivo (rede, sessão expirada) — o cliente cai no cálculo local de sempre, byte a byte igual ao que já existia. O progresso da missão nunca fica travado por causa da rede; a diferença é só que, com conta online, o valor final vem do servidor.

Testado com um script de unidade que roda o trecho real de `server.js` (`QUEST_REWARDS`/`questNeed`/`applyQuestXp`) via `vm` — confirma os 8 estágios, o `next` de cada um e o level-up múltiplo (missão 28 a partir de `xp:25,lvl:1` sobe pra `lvl:13,xp:185`) — e testado ao vivo no navegador chamando `claimQuestReward()` sem conta (caminho offline), confirmando o mesmo resultado que o cálculo do cliente sempre deu.

**O que essa unidade NÃO cobre:** XP/ouro/item ganho ao matar monstro (`killMob()` e as ~10 funções `killX()` por tipo) continuam 100% client-side — é a maior fatia da lacuna e fica pra próxima unidade da Fase 1, junto com o `lvl` do personagem ainda ser aceito direto do que o cliente manda no `PUT /api/characters/:id` (só limitado a 1–99, sem validar contra XP acumulado).

## Fase 1 (unidade 2) — arma equipada não pode ficar acima do nível real

Ao reconstruir o save (`sanitizeSave`), se uma arma equipada (`eq.sword` — só armas têm `req`; escudo/armadura/capacete/capa/joia/bota nunca tiveram exigência de nível no jogo real) tem `req` maior que o `lvl` real do personagem, ela é desequipada e devolvida pra mochila (nunca descartada; se a mochila já estiver no limite de 24, aí sim é descartada, igual a qualquer outro excesso de itens). Isso nunca deveria acontecer com um cliente honesto — tanto `giveItem` quanto a compra na loja só equipam automaticamente se `lvl>=req` — então só existe pra fechar a brecha de editar o save/localStorage direto pra equipar um item acima do nível.

Testado com um teste de unidade rodando o trecho real de `sanitizeSave`/`sanitizeItem` via `vm`: item acima do nível é desequipado e preservado na mochila; no nível exato do requisito continua equipado; itens sem `req` (armadura, escudo, etc.) nunca são afetados; mochila cheia não estoura o limite de 24.

## Fase 1 (unidade 3) — pontos de habilidade não podem passar do nível real

`sanitizeSave` agora soma quanto cada personagem gastou em rank de skill (`Σ(rank-1)` das 3 skills da própria classe — `CLASS_SKILLS`, já usado desde a Fase B pra validar `cast_skill`) e compara contra o orçamento real (`lvl-1`, a mesma conta que `skillPoints()` faz no cliente). Se o gasto excede o orçamento — só possível editando o save direto, já que o cliente nunca deixa subir rank sem ponto livre — as 3 skills da classe voltam pro rank base (1), o mesmo resultado que a ação "redistribuir habilidades" da loja já produz normalmente. Skills de outra classe que sobrarem no save (ex.: troca de classe nunca existiu no jogo, mas um save adulterado podia ter lixo) são descartadas nesse mesmo passo.

Testado com um teste de unidade rodando o trecho real de `sanitizeSave` via `vm`: nível 1 com as 3 skills adulteradas pro máximo reseta; nível 7 com o máximo *legítimo* (6 pontos = orçamento exato) se mantém; gasto parcial dentro do orçamento se mantém; gasto estourando o orçamento reseta; skill de outra classe é descartada; save novo/vazio recebe o baseline rank 1 nas 3 skills da classe.

## Fase 1 (unidade 4) — abertura de baú server-autoritativa

Os 7 baús de mapa (um por área de campo, floresta até vulcão — cada um trancado até a chave do respectivo chefe) agora passam por `POST /api/characters/:id/chest` (`{flag}`, o mesmo nome que o cliente já usa em `P.chestOpen`/`P.chestOpen2`.."7"). O servidor confere se aquele baú específico já foi aberto (campo `chest`/`chest2`.."chest7" do save, um por baú, trava depois da primeira vez), se há pelo menos 1 chave, desconta a chave, credita o ouro fixo daquele baú e sorteia 1 item (tier fixo por baú) dentre os tipos válidos pra classe do personagem — mesma regra de equipar automaticamente se o slot estiver livre e o nível bater, senão vai pra mochila, senão é descartado (mochila cheia é a única situação onde o item se perde; ouro e chave sempre são creditados). O baú de masmorra (`Baú da Masmorra`, layout que reinicia a cada instância) fica de fora — usa outro fluxo, sem flag persistido.

Sem conta online, ou se a chamada falhar, cai no cálculo local de sempre (mesmo código de antes, inalterado). Testado com um teste de unidade rodando o trecho real de `sanitizeSave`/`CHEST_REWARDS`/`rollChestItem` via `vm` (abertura legítima, reabertura rejeitada, sem chave, flag inválida, baú de tier 5, mochila cheia não perde ouro/chave) e ao vivo no navegador chamando `openChest()` sem conta (caminho offline).

**Descoberta importante durante a investigação desta fase, que muda a ordem planejada:** o servidor **não tem um roster de monstros próprio** — `map_join` aceita a lista de monstros (`id`, `maxhp`, posição, `boss`) que o *primeiro cliente a entrar no mapa* manda (`server.js`, handler de `map_join`). Isso é inofensivo hoje porque matar um monstro só zera o HP dele no servidor, sem conceder nada. Mas é um bloqueio direto pra "XP por abate de monstro" (a próxima unidade cogitada): sem um roster autoritativo, um cliente adulterado poderia inventar um monstro fake com 1 de HP e farmar XP infinita. Mover XP/loot de abate pro servidor vai exigir resolver isso primeiro (roster de monstro autoritativo por mapa) — maior que uma unidade isolada, então a Fase 1 seguiu por um alvo menor e mais seguro nesta rodada (requisito de equipamento) em vez disso.

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
