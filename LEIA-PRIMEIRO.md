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

## Fase 1 (unidade 5) — roster de monstro autoritativo + XP/contador de abate

A maior unidade da Fase 1 até agora: fecha exatamente o bloqueio descoberto na unidade 4.

**Roster autoritativo por mapa.** `MOB_MANIFEST` em `server.js` espelha, tipo/nível/quantidade exatos, os `packs` literais de cada `buildX()` do cliente (`buildFloresta`, `buildCripta`, `buildSerra`, `buildPantano`, `buildTorre`, `buildIlhas`, `buildVulcao` — 19 a 40 monstros por mapa, incluindo chefe e sequitos temporários) e `mobStats(tipo,nível,chefe,k)` espelha as fórmulas de hp/xp de cada tipo (`SLIME_STATS`, `gobStats`, `skStats`, `wfStats`, `btStats`, `txStats`, `caStats`, `skyStats`, `vlStats`). No `map_join`, o servidor não aceita mais o `maxhp`/`boss`/tipo que o cliente reivindica: usa só `id`/`x`/`y` do cliente (cosméticos, nunca decidem prêmio) casados por posição com o manifesto real — o cliente insere monstros em `MOBS` sempre na mesma ordem (pacotes, depois chefe, depois sequitos), então a posição bate. Um cliente adulterado não consegue mais inventar monstro extra (a contagem trava no tamanho do manifesto) nem declarar HP menor que o real (o HP vem sempre do `mobStats`, nunca do cliente).

`vila` (slime) é a exceção: a posição de cada spawn vem de amostragem por rejeição contra o mapa real (`blocked()`), sem um array literal pra espelhar sem portar o tilemap inteiro. Pra ela, a validação é mais solta — contagem ≤15, nível 1–3, HP sempre recalculado a partir do nível — mas ainda fecha o mesmo buraco (não dá pra inventar 200 slimes nem um slime de HP artificialmente baixo). Masmorras (`_d`) ficam de fora — usam `mazeGen`+`Math.random()`, sem roster fixo pra validar contra; continuam como estavam antes desta fase.

**XP e contador de abate reais.** Quando o servidor confirma que um monstro morreu de verdade (`mob.hp<=0` em `mob_damage`, o mesmo ponto que já existia desde a Fase C1), e a conexão tem `charId` (o cliente agora manda o personagem atual no `join`, além da conta), credita direto no Supabase: XP exato do tipo/nível (`mobStats`, metade pra sequitos temporários — mesmo `.5` que o cliente já aplicava) com o mesmo cálculo de level-up de `questNeed`, e o(s) contador(es) certo(s) por tipo (`killCounterFields` — espelha a cadeia de `if` no topo de `killMob()`: `sl` pra slime, `ke`/`ktt`/`bs` pra esqueleto, `kwt`/`bs` pra lobo, `kpt`/`kit`/`bs` pra morcego/tóxico, `kit`/`bs` pra ilhas, `kvt`/`bs` pra vulcão, `bs` sozinho pro Senhor das Chamas, `ktt`/`bs` pra conjurador, `gb`/`bs` pro goblin). O servidor manda de volta só pro matador um `kill_reward` (`{xp,lvl,fields}`); o cliente aplica em cima do que já tinha calculado localmente — é uma correção silenciosa, não repete o toast/efeito sonoro que o `killMob()` local já mostrou na hora.

Sem `charId` (sem conta, ou personagem nunca sincronizado) o crédito é pulado silenciosamente — o cálculo local de sempre continua sendo o único que existe, exatamente como era antes desta fase.

**Inconsistência real do cliente, espelhada de propósito:** morcego-de-cinzas (`cinza`, vulcão) tem o HP de spawn calculado com a fórmula de salamandra × 0.6 (`newCinza`), mas o XP de abate (`killVulcao`→`vlStats(s)`) cai no `default` da função, que é a fórmula de esqueleto calcinado (`calc`), não a de salamandra. Isso já é assim no cliente hoje — o servidor replica os dois comportamentos exatamente (`cinzaSpawnHp` só pro HP de spawn, `mobStats('cinza',...)` usa a fórmula de `calc` pro XP) em vez de "corrigir" um desequilíbrio que não foi pedido nesta fase.

Testado com um teste de unidade (`vm` sobre o trecho real do roster: todas as fórmulas de `mobStats` batem com o relatório extraído do cliente, contagem total por mapa bate com a contagem manual dos `packs` — 19/22/26/30/26/40/33 —, exatamente 1 chefe por mapa, toda entrada do manifesto produz stats válidos, mapeamento de contador por tipo) e dois testes de integração via WebSocket real contra o servidor local: (1) um cliente que tenta forjar um 20º monstro extra em floresta e HP=1 é ignorado — só 19 (do manifesto) são criados, com HP real (70 pro primeiro goblin), e o 20º nunca existe; um golpe básico não mata um goblin de HP real; (2) um cliente que tenta forjar 30 slimes de nível 99 em vila é limitado a 15, nenhum passa de HP 62 (teto real do nível 3), e o servidor não trava ao processar um abate de uma conexão sem `charId`.

**O que essa unidade NÃO cobre (limites explícitos):**
- **Ouro/gema/item por abate** e **sequência de missão via contagem de abate** — fechados na unidade 6, abaixo.
- **Sequitos temporários** (`temp:true` no manifesto — nascem `dead:true`, só "revivem" quando o chefe correspondente entra num estado de invocação, uma mecânica de IA que não existe no servidor) nunca chegam a ser dano-áveis via `mob_damage` hoje — ficam no manifesto por completude, mas não geram crédito na prática. Não é uma regressão (nunca foram rastreados antes) nem uma brecha (o jogador só deixa de ganhar o crédito do servidor pra esses abates específicos, cai no cálculo local). **Isso continua fora de alcance**: exigiria simular o estado de IA do chefe (quando ele "invoca reforços") no servidor — a Fase C completa, documentada como fora de escopo desde o início desta fase.
- **`lvl` do personagem** ainda é aceito direto do que o `PUT /api/characters/:id` manda (só limitado a 1–99) — continua bloqueado até XP virar cumulativo/rastreado por completo (quest + abate agora cobrem uma fração real, mas não 100%, do ganho de XP possível).

## Fase 1 (unidade 6) — loot de abate + sequência de missão validada contra abates reais

Fecha as duas lacunas restantes da unidade 5 que eram tratáveis (a terceira, sequitos/IA de chefe, é a Fase C completa e continua fora de alcance — ver acima).

**Ouro/gema/poção/maçã/pergaminho por abate.** `rollMobLoot(tipo,chefe,nível)` espelha exatamente `dropLoot`/`dropExtra` de cada `killX()` do cliente (moedas exatas × valor 1..máximo por moeda, chance de poção/maçã/pergaminho, gema garantida quando o chefe sempre dropa um número fixo ou probabilística quando é chance de 1). Confirmado que **nenhuma das 7 funções de abate de mapa de campo chama `dropItem`** — equipamento nesses mapas só vem de loja ou baú (`dropItem` só existe no loot de masmorra, que continua fora do escopo do roster). Sequitos temporários não dropam nada (o cliente pula o bloco inteiro de loot pra eles, diferente do XP que ainda paga metade) — espelhado aqui também. Chefe derrotado também solta 1 chave (`BOSS_CHEST_FIELD`), só se o baú daquele mapa ainda não foi aberto — mesma condição do cliente.

**Sequência de missão validada contra abates reais.** `advanceQuestOnKill` espelha a máquina de estados completa: dos 15 estágios ímpares (1,3,5,7,9,11,13,15,17,19,21,23,25,27,29), 8 avançam por contagem de abate real (`kills`,`gk`,`ks`,`kw`,`kp`,`kt`,`ki`,`kv` — dois desses, `kt` e `ki`, são alimentados por **duas fontes diferentes**: conjurador OU esqueleto de nível ≥25 pro `kt`; habitante das ilhas OU morcego de nível ≥30 pro `ki`, exatamente como o cliente já fazia) e 7 avançam só quando o chefe certo morre com o `quest` certo já setado (nunca pula estágio). Um detalhe do próprio cliente ficou mais rígido no servidor: `killLorde` (Senhor das Chamas) seta `P.quest=30` sem checar nada antes — no servidor, esse avanço só acontece se `quest` já estiver em 29, fechando um descuido que existia no cliente original.

Testado com um teste de unidade (`vm` sobre o trecho real): `rollMobLoot` com `Math.random` forçado em 0 e em 0.999 confirma os extremos (tudo garantido vs. nada garantido, moeda no mínimo vs. no máximo), gemas de chefe sempre exatas independente do sorteio, `bat` sem variante de chefe; os 15 checkpoints de `advanceQuestOnKill` um a um, incluindo as duas fontes duplas (`kt`/`ki`) e o novo gate em `killLorde`. E um teste de integração via WebSocket real contra o servidor local: mata o monstro trash e o chefe (quando o HP permite matar via ataque básico em tempo razoável) dos 7 mapas de campo, confirmando HP real batendo com o manifesto e nenhuma exceção em nenhuma combinação de tipo/chefe.

**Descoberta que fica documentada, não fechada nesta unidade:** mesmo com a contagem de abate agora real e validada, `save.quest` ainda é aceito direto do que o `PUT /api/characters/:id` genérico manda (só limitado a ≤40, sem checar sequência) — então um save forjado ainda pode pular pra `quest:28` via esse caminho e reivindicar a recompensa de missão legitimamente pelo endpoint da unidade 1, sem ter passado pelos abates reais. Fechar isso de vez exigiria o `PUT` distinguir "primeiro sync de um personagem que já tinha progresso legítimo offline" (onde aceitar um `quest` alto é correto) de "atualização de um personagem que o servidor já conhece" (onde só deveria aceitar avanço pelos dois caminhos validados: diálogo ou abate) — a mesma família de problema do `lvl` aceito direto no `PUT`, mesmo bloqueio: precisa de uma noção de "personagem já rastreado" que ainda não existe.

**Correção crítica feita logo depois, na mesma rodada:** a unidade 6 passou a creditar ouro/gema/poção/maçã/pergaminho/chave direto no abate confirmado, mas os `dropLoot`/`dropExtra`/`dropItem`/`drops.push({kind:'key',...})` do cliente continuavam gerando os mesmos itens no chão — um jogador online podia andar até eles e coletar de novo, duplicando a recompensa. `dropLoot`/`dropExtra`/`dropItem` agora checam `lootOnline()` (`CUR_CHAR&&authToken()`) e não geram nada pra abate de **mapa de campo** (`!s.dun`) quando há conta online, já que o servidor já creditou direto; loot de **masmorra** (`s.dun`) nunca é afetado, continua 100% local como sempre foi (fora do escopo do roster). Os 7 `drops.push({kind:'key',...})` de cada chefe ganharam a mesma checagem. Testado ao vivo no navegador: `dropLoot`/`dropExtra`/`dropItem` chamados com `s.dun:false` e conta simulada geram 0 itens; os mesmos chamados com `s.dun:true` continuam gerando itens normalmente; offline (sem `CUR_CHAR`/token) continua gerando itens como sempre.

## Fase 1 (unidade 7) — `lvl`/`quest` travados depois do primeiro sync real

Fecha a descoberta documentada na unidade 6 (e o mesmo problema, mais antigo, do `lvl`). `PUT /api/characters/:id` agora lê o personagem atual antes de gravar e decide se ele já é **"rastreado"**: `lvl>1` OU `quest>0` OU `xp>0` já persistidos. Se ainda não é (personagem recém-criado, `save` ainda vazio — inclusive o fluxo de promover um personagem local antigo pra nuvem pela primeira vez), o `PUT` continua confiando integralmente no que o cliente manda, exatamente como sempre foi. A partir do momento em que o personagem tem progresso real, todo `PUT` seguinte **trava** `lvl`, `save.xp`, `save.quest` e os 8 contadores que travam missão (`kills,gk,ks,kw,kp,kt,ki,kv`) no valor que o servidor já tem — o cliente pode mandar qualquer coisa nesses campos que é ignorado. Daí em diante, esses campos só avançam pelos dois caminhos já validados: `handleQuest` (recompensa de diálogo) e `creditKillReward` (abate confirmado), que gravam direto e não passam por essa trava.

Ouro, gemas, inventário, equipamento e os demais contadores **não são travados por essa regra** — cada um já tem sua própria história de validação (loja, baú, missão, abate) ou segue com os limites genéricos de sempre; travar tudo de uma vez seria maior que o que essa unidade audita com confiança.

Testado com um teste de unidade (`vm` sobre o trecho real de decisão, sem os dois `supabase()` que dependem de credencial): personagem novo confia integralmente no primeiro `PUT` alto (promoção); personagem rastreado por nível trava `lvl`/`quest`/`xp`/contadores mesmo que o cliente mande valores maiores; rastreado só por `quest>0` (nível ainda 1) trava do mesmo jeito; rastreado só por `xp>0` (quest ainda no mesmo estágio) também; personagem genuinamente intocado (tudo zero) não trava nada, porque ainda não há progresso real pra proteger; ouro explicitamente não é afetado; personagem inexistente não aplica a trava (o 404 já vem do próprio `supabase()`).

**Contrapartida aceita, documentada:** um jogador com a conexão WebSocket momentaneamente caída (ela reconecta sozinha em ~2.5s) que avança `xp`/`quest`/contador nesse intervalo só via cálculo local — sem passar por `creditKillReward`/`handleQuest`, que exigem WS ativo — vai ter esse avanço específico ignorado pelo próximo `PUT` de rotina até que os caminhos validados alcancem o mesmo estado. Não é perda permanente (o jogo continua, os próximos abates/diálogos validados corrigem o valor), só uma janela estreita e autolimitada — o mesmo padrão de tolerância já aceito nesta sessão pra falhas pontuais de `creditKillReward`.

# Fase 2 — IA de monstro no servidor

Com a Fase 1 (progressão/economia) substancialmente fechada, a Fase 2 ataca a peça que ficou de fora o tempo todo: hoje o servidor só arbitra HP/morte/respawn de monstro, mas **posição, perseguição e dano de monstro→jogador são 100% do cliente** — `hurtPlayer()` nunca manda nada pro servidor, então um cliente adulterado pode simplesmente nunca perder HP de monstro (mesmo continuando a ganhar XP/ouro/loot validados dos próprios abates que reporta). Diferente de toda a Fase 1 — onde dava pra validar o que o cliente reporta — aqui não existe atalho: quem se beneficiaria de sub-relatar dano recebido é a vítima, então autorrelato nunca é confiável nessa direção. Fechar isso de verdade exige o servidor decidir sozinho quando um ataque de monstro acerta, ou seja, simular posição de verdade — não um validador leve como o resto da Fase 1.

A IA hoje é **12 funções `updX(s,dt)` independentes** no cliente (uma por tipo de monstro), cada uma reimplementando o mesmo padrão comum (`idle`→`chase`→`wind`/telegraph→resolve→`recover`→`chase`, com leash de retorno pro spawn) mais 1-3 estados de ataque especial próprios. `aggro(s)`/`alertPack(s)` fazem uma varredura de TODOS os monstros do mapa (sem índice espacial, sem checagem de distância no alerta de grupo) sempre que o jogador acerta um golpe. A autoridade de movimento (`chooseAuthority`, cliente mais antigo conectado no mapa) manda posição a cada 200ms via `mob_snapshot`; os demais clientes fazem **snap duro**, sem interpolação — não existe suavização pra preservar. Confirmado que `authorityId`/`NET_AUTH`/`mob_snapshot` não são usados por mais nada no projeto — seguros de remover conforme cada tipo migrar pro servidor.

**Bloqueio adicional real:** o servidor não tem nenhum dado de colisão/terreno (`blocked()` só existe no cliente) — simular movimento sem isso faz monstro atravessar parede. Fica como limitação conhecida por enquanto, não escondida.

## Fase 2 (unidade 1) — IA de slime no servidor

Primeira unidade, escolhida por ser o único dos 12 tipos sem máquina de estado (só perseguição direta por distância + dano por contato com cooldown fixo — `updSlime` no cliente). `tickSlimes()` roda a cada 150ms em `server.js`, por mapa (masmorra fica de fora, mesmo limite do roster da Fase 1): pra cada slime vivo, acha o jogador mais próximo real (não mais "só quem é autoridade" — correção incidental de um bug de design antigo, agora é agressão contra qualquer jogador do mapa), decide `idle`/`chase`/`return` com os mesmos raios/velocidades do cliente (alcance de aggro 140px, leash de 300px do spawn, retorno com velocidade 40, perseguição a 62), move `mob.x/y` com o mesmo padrão de "pulo" (`Math.sin(anim*7)`) e credita dano de contato exato (`mobStats('slime',nível,false).dmg`) direto pro jogador via uma mensagem nova `mob_hit`, sem esperar o cliente reportar nada.

O cliente aplica `mob_positions` (substituindo posição/estado direto, sem interpolação — mesmo comportamento de antes) e `mob_hit` (chama o `hurtPlayer()` já existente, que continua aplicando mitigação/bloqueio/escudo localmente — mesmo padrão já usado em PvP). `updSlime()` local só roda se **não** houver rede ativa (`s.netId && NET && NET.readyState===1` interrompe cedo, mantendo animação mas pulando movimento e dano) — offline/single-player continua 100% igual a antes.

**Limites explícitos desta unidade:** sem dado de colisão, o slime pode atravessar objeto estático que não seja a borda da vila (a única fronteira replicada é o limite fixo `x>29*T`/`x>29.4*T` que já existia no cliente pra não deixar o slime entrar na praça). Raiz/lentidão (`s.slow`/`s.root`) não são sincronizados pro servidor — mesma limitação já documentada pra PvP (só dano, não status). `s.kx/s.ky` (knockback do golpe do jogador) continua puramente visual no cliente, corrigido pela próxima posição do servidor a cada 150ms.

**Bug pego durante o teste:** `mob.cd` nunca era inicializado, e em JS `undefined <= 0` é sempre falso — o dano de contato nunca disparava (travado silenciosamente pro sempre). Corrigido pra sempre inicializar em 0.

Testado com um teste de integração via WebSocket real contra o servidor local: nível forjado (99) grampeado a 3 (hp/dano reais do nível 3); slime fora do alcance de aggro não persegue; dentro do alcance persegue de verdade (posição muda, `state=chase`); dano de contato exato (12, nível 3) chega via `mob_hit` quando o jogador fica perto. E testado ao vivo no navegador: `updSlime()` não move nem causa dano localmente quando `NET.readyState===1` (mas continua animando); `mob_positions`/`mob_hit` aplicados corretamente num `MOBS` fake via `NET.onmessage`.

**Próxima unidade sugerida (não iniciada):** generalizar pro padrão comum (`idle`/`chase`/`wind`/`recover`/`return`) dos outros 11 tipos, um de cada vez, reaproveitando `tickSlimes` como referência de estrutura — cada tipo tem seu próprio ataque especial que precisa de atenção individual (telegraph, combo, área de efeito).

## Fase 2 (unidade 2) — IA de goblin no servidor (padrão comum idle/chase/wind/recover/return)

Segunda unidade: porta `updGoblin` (o "padrão canônico" que a maioria dos outros 11 tipos reusa com variações numéricas). `tickSlimes()` virou `tickMobAI()`, um dispatcher genérico (`MOB_AI_STEP={slime:stepSlime,goblin:stepGoblin}`) que itera `state.mobs` de cada mapa e chama a função do tipo certo — mesma estrutura que o `updMob()`/dispatcher do cliente, preparada pra receber os próximos 10 tipos sem precisar refatorar de novo.

`stepGoblin` espelha os 6 estados do cliente (`idle`→`chase`→`wind`[telegraph]→`dash` ou resolução direta de `slam` em área [só chefe]→`recover`→`return`), com os mesmos raios/velocidades/tempos exatos (aggro 150/210px chefe, ataque a 72/92px, dash 470px/s, `slam` com raio elíptico 80 e dano ×1.15). Diferente do slime (que só reage à distância crua a cada tick), o goblin agora trava um **alvo** (`mob.tgt`, o id do jogador) ao entrar em `chase`/`wind`, pra não trocar de alvo no meio de um golpe já telegrafado — resolvido de novo a cada vez que entra em `idle`/`return`→`chase`.

**Dois bugs reais pegos durante o teste, mesma classe do bug da unidade 1:** `mob.ret` (trava de "acabei de retornar, não re-agressione ainda") nunca era inicializado, e `undefined <= 0` sempre falso em JS travava a primeira agressão de todo goblin novo pra sempre — corrigido pro mesmo padrão `Math.max(0,(mob.ret||0)-dt)` já usado pro `cd`. E: a unidade 1 só tinha adicionado `sx`/`sy` (origem do spawn, necessário pra perseguição/retorno) na ramificação de slime (vila) do `map_join` — a ramificação do manifesto (floresta/cripta/serra/...) nunca ganhou isso, então **todo** monstro de mapa de campo além do slime ficava sem `sx`/`sy` e nunca era sequer considerado pra IA (guarda `!Number.isFinite(mob.sx)` retornava cedo silenciosamente). Corrigido — agora toda entrada do manifesto grava `sx`/`sy` na criação.

Testado com um teste de integração via WebSocket real: goblin trash entra em perseguição real ao alcance; causa dano de contato exato (`14`, nível 5) via `dash`; goblin chefe causa dano exato tanto no caminho de `dash` (30) quanto no de `slam` (`round(30*1.15)=35`, confirmado nas duas variantes em execuções diferentes, já que a escolha é 50/50 aleatória). E ao vivo no navegador: `updGoblin()` não move nem causa dano localmente quando `NET.readyState===1` (mas continua animando); `mob_positions`/`mob_hit` aplicados corretamente (reusa o mesmo handler genérico da unidade 1, nenhuma mudança de cliente precisou ser feita além de suprimir a lógica local).

**Limites explícitos, mesmos da unidade 1:** sem dado de colisão server-side (`dash` sempre completa a distância cheia, nunca é interrompido por parede). Raiz/lentidão não sincronizados. Campos só-visuais do cliente (`face`, `moving`, direção de sprite) não são replicados pelo servidor — a posição/estado chegam certos, mas o goblin pode não virar de frente pro alvo com a mesma precisão visual de antes; não afeta dano/perseguição, só polimento cosmético pra uma unidade futura.

## Fase 2 (unidades 3–13) — os 11 tipos restantes, Fase 2 completa

Todo tipo de monstro do jogo (13 no total) agora tem IA autoritativa no servidor: posição, agressão, alvo, telegraph de ataque e dano primário nunca mais dependem do que o cliente relata. `MOB_AI_STEP` (o dispatcher de `tickMobAI`) cobre `slime, goblin, skeleton, wolf, bat, cinza, toxic, caster, sky, sala, elem, calc, lorde` — o mesmo conjunto de 13 que `updMob()` despacha no cliente.

**Escopo desta rodada, deliberado e documentado:** cada `stepX` porta posição/estado/agressão/**ataque primário** (o achado central da auditoria: fechar a exposição real a dano de monstro, que antes nunca chegava ao servidor). Ficam de fora, mesmo padrão já aceito pra raiz/lentidão desde a Fase 1/PvP — nenhum desses é simulado localmente quando `NET` está conectado, o cliente só deixa de existir, não vira uma versão falsa:
- **Efeitos de status como dano contínuo** (sangramento do lobo, veneno do tóxico, queimadura de sala/elem/calc/cinza/lorde) — o hit primário ainda acerta, só o DoT que se seguiria não é aplicado.
- **Cura de aliado** (xamã do céu) e **empurrão de nocaute** (rajadas, investida do guardião).
- **Teleporte/blink** (conjurador) e **barreira/absorção** (chefe conjurador).
- **Revivência de sequitos de chefe** (uivo do lobo, "o capitão chama os mortos", "o rei lodoso se divide", "invoca acólitos", "invoca salamandras") — mesma limitação já documentada desde a Fase 1 unidade 5: os sequitos nascem `dead:true` no manifesto e nunca são efetivamente reanimados sem simular o estado de IA do chefe que os invoca (a peça que continua fora de alcance).
- **Tornado persistente** (chefe do céu) e **poças/áreas que causam dano contínuo por tempo** (`HAZ`, veneno de tóxico/campo de sala) — só o hit direto do ataque que gera a área é aplicado, a área em si não persiste dano no servidor.
- **Ataque à distância**: em vez de simular o projétil de verdade, o servidor manda o `mob_hit` depois de um atraso calculado (`distância/velocidade`) pra preservar a janela de esquiva por tempo — sem replicar a trajetória visual do projétil pros outros jogadores verem.
- **Chefe conjurador (Feiticeiro Sombrio) especificamente**: portado com moveset reduzido ao ataque básico à distância — sem chuva de área, barreira, blink ou invocação. Ainda causa dano de verdade (fecha o "modo deus"), mas não é o moveset completo do chefe original. É a maior simplificação desta rodada, feita conscientemente por escala.

**Detalhe de fidelidade preservado:** o morcego-de-cinzas (`cinza`) usa a fórmula de dano da **salamandra** × 0.7 (não a própria, que nem existe) — o mesmo comportamento peculiar já documentado desde a Fase 1 unidade 5 (o cliente original também "empresta" a fórmula de `sala` pro `cinza`).

Testado com um teste de integração via WebSocket real cobrindo os 6 mapas restantes (cripta, serra, pantano, torre, ilhas, vulcão): perseguição + dano exato pra pelo menos 1 trash de cada mapa (2 subtipos quando o mapa mistura, ex. morcego+tóxico no pântano, esqueleto+conjurador na torre), mais os chefes lobo-alfa (95), feiticeiro-sombrio (130, moveset reduzido) e Senhor das Chamas (170 no golpe direto / 153 na "chuva"), todos com a fórmula exata batendo. E ao vivo no navegador: os 11 `updX()` confirmados suprimindo movimento/dano local sem exceção quando `NET.readyState===1`, animação continua.

**Descoberta durante o teste, não um bug:** morcego (e os subtipos do céu com ataque à distância/investida) têm um alcance **mínimo** de engajamento (`d>50`) no próprio design original — eles mergulham de uma certa distância, não atacam colados. Um teste que persegue a posição exata do monstro nunca dispara o ataque por design, não por falha do servidor; corrigido no teste (mantém ~120px de distância), não no comportamento.

Isso encerra o que esta sessão considera **Fase 2 completável sem uma extensão de arquitetura maior**. O que resta é genuinamente fora de alcance com a base atual: colisão de terreno no servidor (portar `blocked()`/dados de mapa) e simulação de IA de chefe completa (revivência de sequitos, barreiras, invocações) — cada um comparável em tamanho a esta fase inteira.

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
