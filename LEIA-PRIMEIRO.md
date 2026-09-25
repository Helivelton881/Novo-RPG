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
- IA e posição dos monstros autoritativas no servidor, compartilhadas por todos os clientes do mapa;
- layout determinístico das masmorras, para todos entrarem no mesmo labirinto;
- projéteis de mago, arqueiro e druida (disparo, trajetória, impacto);
- contador de jogadores online, heartbeat e validação básica de mensagens.

Inventário, progressão e parte da IA ainda são calculados no cliente. O dano por golpe/skill **não é mais** — o cliente só informa qual skill (ou "basic") e a própria classe/nível/ataque; o servidor recalcula o valor exato e é ele quem decide quanto HP o monstro perde. Ao salvar o personagem na nuvem (`PUT /api/characters/:id`) o servidor também reconstrói o save inteiro a partir de limites plausíveis — ouro, gemas, XP, contadores e os stats de cada item do inventário são recalculados a partir de `{type,tier}` server-side, nunca aceitos como o cliente manda.

## Dano exato por skill/cooldown (server-autoritativo)

O cliente manda `cast_skill` (`id`, `sk`=rank, `atk`) toda vez que usa uma habilidade — o servidor confere se ela pertence à classe do jogador, se o cooldown real já passou (`SKILL_CD_MS`, um mapa por skill, espelhando `SKILLS`/`CLASSES` do cliente) e, se passou, calcula o dano exato com a mesma fórmula do cliente (`skBase()*multiplicador do rank`, com `atk` limitado a um teto genérico de 35 — não dá pra alegar um ataque maior que o de qualquer equipamento real) e guarda esse valor como "pendente" por alguns segundos. Cada `mob_damage` que referencia aquela skill só aplica dano se existir um valor pendente válido — nunca aceita um número que o cliente mande diretamente. Ataques básicos são calculados na hora (sem cast prévio), com limite de ~6 golpes por janela de velocidade de ataque da classe, além do limite de 80ms por par jogador/monstro que já existia.

**O que isso NÃO cobre:** o servidor ainda não *simula* onde os monstros estão (isso seria a Fase C completa — IA de monstro rodando no servidor, um projeto multi-dia à parte, não feito). O que passou a ser impossível é reportar um dano maior do que a fórmula real permite, ou usar uma skill sem respeitar o cooldown dela.

## Fase C1 — validação de alcance (sem reescrever IA)

Na etapa histórica C1, antes da IA server-side, o servidor usava a última posição recebida por `mob_snapshot` para validar o alcance de 550px. Desde a Fase 2.1 esse pacote não é mais aceito: a mesma validação usa a posição simulada pelo próprio servidor.

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

Na auditoria inicial da Fase 2, a IA era formada por funções `updX(s,dt)` independentes no cliente. A antiga autoridade de movimento (`chooseAuthority`) enviava `mob_snapshot` a cada 200ms e os demais clientes faziam snap duro. Esse diagnóstico histórico motivou a migração server-side; a Fase 2.1 abaixo remove definitivamente o caminho de snapshot e adiciona interpolação visual.

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

## Fase 2.1 — estabilização de movimento e sincronização

O servidor agora é a única fonte da posição dos monstros online. O caminho antigo `mob_snapshot` foi removido dos dois lados: nenhum cliente, inclusive o antigo `authorityId`, pode sobrescrever `x/y/state`. `tickMobAI()` mede o tempo real com `performance.now()`, limita atrasos a 200ms e subdivide o movimento em passos de no máximo 50ms. Todos os 13 `stepX` passam deslocamento normal e dash por `moveMob()`, que rejeita valores não finitos, limita cada subpasso a 32px e mantém a posição dentro de `0..2880 × 0..2112`. Velocidades, raios, cooldowns e dano não foram rebalanceados.

O cliente guarda `serverX/serverY` separados de `x/y`: estes últimos são apenas a posição visual, aproximada com uma exponencial baseada em `dt` (`1-exp(-18*dt)`). O estado chega imediatamente, mas posição não sofre snap a cada broadcast. O fallback offline permanece nas funções `updX`; a saída antecipada com WebSocket conectado impede dupla simulação online.

Alvos continuam estáveis enquanto válidos. Se o alvo desconecta ou troca de mapa, estados de telegraph/dash não mudam de jogador no meio do ataque; após o estado terminar, `targetPlayer()` seleciona um jogador válido restante. Ao concluir `return`, `settleAtSpawn()` fixa exatamente `x=sx` e `y=sy`, limpa `tgt` e volta a `idle`. Respawn também limpa alvo, cooldown/timers e nasce exatamente em `sx/sy`.

**Colisão server-side nesta fase:** foi adicionada a camada mínima segura de limites do mapa, validação finita, limite de salto e aplicação centralizada também para dash. Paredes, pedras e construções internas ainda não são conhecidas pelo servidor porque `blocked()` consome geometria gerada exclusivamente em `index.html`. Portar isso corretamente exige extrair um manifesto compartilhado de terreno; não foi duplicado um segundo mapa divergente nesta correção. Portanto, a Fase 2.1 impede sair do mundo e reduz tunneling/saltos, mas colisão completa com obstáculos internos permanece uma tarefa arquitetural explícita.

# Fase 3 — testes automáticos + CI

Suite formal em `test/*.test.js`, usando o test runner nativo do Node (`node --test`, sem dependência nova — o projeto já exige Node ≥20). Rodar com `npm test`. `test/helpers.js` sobe uma instância real de `server.js` como processo filho numa porta dedicada por arquivo (evita disputa de estado entre arquivos, já que `node --test` roda arquivos em paralelo) e expõe `httpJson`/`wsConnect`/`joinWs`/`waitFor` pros testes montarem cenários reais — nada de mock: cada teste conversa com o servidor de verdade pela mesma API que o cliente usa.

**Cobertura, por arquivo:**
- `auth.test.js` — registro, duplicidade, senha/usuário inválido, login (certo/errado/inexistente), sessão (válida/ausente/forjada), logout invalida a sessão.
- `characters.test.js` — criação (válida/slot inválido/nome curto/slot duplicado), listagem, save+reload, **acesso indevido** (conta B não lê, não altera e não apaga personagem da conta A — os três testados separadamente, cada um confirmando que o dado da conta A ficou intacto), exclusão pelo dono, rota sem sessão.
- `progression.test.js` — recompensa de missão exata, repetir a mesma missão é rejeitado, pular estágio é rejeitado, level-up por XP acumulado, baú (ouro fixo, sem chave rejeita, reabrir rejeita), e a trava da unidade 7 (`PUT` bruto não forja `lvl`/`xp`/`quest` depois que o personagem já tem progresso real, mas o primeiro `PUT` de um personagem novo continua confiado — a promoção de personagem local pra nuvem continua funcionando).
- `shop.test.js` — compra (auto-equipa, ouro insuficiente rejeita, item inválido rejeita), compra em pilha, venda (preço certo, índice inválido rejeita), recompra, redistribuir habilidades, venda de gema.
- `combat.test.js` — alcance (>550px rejeitado, dentro do alcance funciona), anti-spam (dois golpes <80ms no mesmo par jogador/monstro contam como um), skill de outra classe não causa dano, skill real da própria classe causa dano, teto plausível de dano mesmo com `atk` forjado absurdo.
- `monsters.test.js` — roster autoritativo (monstro extra inventado é ignorado, HP forjado é substituído pelo real), IA persegue de verdade, dano de contato com valor exato da fórmula, morte real após HP zerado, `respawnAt` agendado corretamente, e **um teste de espera real (~30s)** confirmando que o monstro volta com HP cheio depois do tempo de respawn — não só que o agendamento existe.
- `multiplayer.test.js` — dois jogadores se veem entrar/se mover, desconexão gera `player_leave`, troca de mapa não vaza monstro de um mapa pra quem está em outro, PvP bloqueado na vila / liberado fora dela, jogador não consegue se auto-atacar.

**Isolamento de estado, achado real durante a escrita dos testes:** mapas no servidor são persistentes por instância (o roster só é criado na primeira vez que alguém entra naquele mapa) — dentro do mesmo arquivo de teste, todos os testes compartilham o mesmo servidor e portanto o mesmo estado de monstro. Os primeiros testes escritos reaproveitavam sempre "o primeiro monstro trash" (`mobs.find(m=>!m.boss)`), e testes que já tinham ferido/matado esse monstro faziam os testes seguintes falharem silenciosamente (o servidor rejeita `mob_damage` num monstro já morto, sem broadcast nenhum) — 4 falhas nessa exata causa, corrigidas dando um índice de monstro **próprio e nunca reaproveitado** pra cada teste que realmente causa dano ou mata. Não era bug do servidor, era isolamento de teste malfeito — documentado aqui porque é o tipo de armadilha que vai se repetir se mais testes forem adicionados sem essa disciplina.

**CI:** `.github/workflows/test.yml` — em todo push/PR: `npm install` → `node -c server.js` (sintaxe) → `npm test`, falha o workflow se qualquer teste falhar.

**Decisão que só o usuário pode tomar, não assumida:** os testes de `auth`/`characters`/`progression`/`shop` (40 dos 61 testes) precisam de `SUPABASE_URL`/`SUPABASE_SECRET_KEY` configurados — sem isso, são **pulados** automaticamente (não falham), tanto local quanto no CI. Se essas variáveis forem as mesmas credenciais de produção (as que o Render já usa), os testes passam a criar contas e personagens reais de teste (`qa_xxxxxxxx`) **no banco de produção** a cada execução — funcional, mas suja o banco real com dado de teste ao longo do tempo, e uma falha de isolamento futura poderia (em teoria) esbarrar em dado real. A alternativa mais segura é um projeto Supabase **dedicado a teste**, com as migrations de `supabase/migrations/` aplicadas nele, apontado por esses mesmos nomes de segredo no repositório GitHub. Não criei um projeto novo nem toquei nos segredos do repositório — isso exige acesso e decisão que são do usuário.

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

Essas rotas leem/gravam nas tabelas `users` e `sessions`, definidas nas migrations em `supabase/migrations/` junto com `characters` e `friends`. **Aplicar as migrations no seu projeto Supabase** (ver seção abaixo) antes de configurar as variáveis acima — sem essas tabelas as rotas de login vão falhar mesmo com o servidor configurado corretamente.

## Save do personagem na nuvem

Com uma conta online, o progresso completo do personagem (nível, XP, inventário, equipamento, missão atual, mapa, etc.) sincroniza com a tabela `characters` do Supabase pelas rotas `/api/characters` (listar/criar) e `/api/characters/:id` (salvar/excluir), sempre autenticadas pelo token de sessão — o servidor confere a dono do personagem em toda escrita.

- O `localStorage` continua como cache local instantâneo (o jogo funciona igual offline); o envio ao servidor é em segundo plano, agrupado a cada ~8s e também forçado ao fechar a aba.
- Ao logar em outro aparelho, o cliente busca os personagens da conta no servidor e substitui o cache local pelos dados mais recentes — inclusive promovendo para o servidor um personagem criado localmente antes de existir conta online.
- **Importante:** `characters.user_id` referencia `public.users` (nosso login próprio), não `auth.users` do Supabase Auth — este projeto não usa Supabase Auth. Por isso não existe mais policy pública de leitura/escrita (ver migration `fix_characters_user_id_fk_and_policies` abaixo): só o servidor acessa, via `SUPABASE_SECRET_KEY` (service role), igual a `users`/`sessions`.

# Fase 4 — banco de dados e migrations

**Achado real da auditoria:** `schema.sql` (agora removido de conteúdo, só um ponteiro) definia `characters` com uma foreign key pra `public.users` *antes* de `public.users` sequer existir no arquivo — rodar do zero, de cima a baixo, falhava com "relation public.users does not exist". Também representava a estrutura como se tivesse sido construída "limpa" desde o início, quando na verdade não foi: consultei o histórico real de migrations já aplicado em produção (via `list_migrations`/`schema_migrations`, não fabricado) e `characters.user_id` chegou a referenciar `auth.users` (Supabase Auth, que este projeto não usa) com policies públicas usando `auth.uid()`, corrigido só numa migration posterior.

## Supabase — migrations

`supabase/migrations/` tem os 5 arquivos que **realmente** foram aplicados em produção, na ordem real, puxados diretamente do `supabase_migrations.schema_migrations` do projeto — não uma reconstrução fictícia:

1. `20260922145956_replace_old_schema_with_mp_server` — cria `characters` (ainda referenciando `auth.users`, com policies públicas — o detour que existiu de verdade).
2. `20260922150012_secure_touch_updated_at_search_path` — endurece o `search_path` da função de trigger (segurança).
3. `20260922154406_add_users_sessions_for_online_login` — cria `users` e `sessions` (login próprio).
4. `20260922193217_fix_characters_user_id_fk_and_policies` — corrige a FK de `characters` pra apontar pra `public.users` e remove as policies públicas (que nunca funcionariam mesmo, já que `auth.uid()` nunca bate sem Supabase Auth) — é aqui que o design final (service-role-only) se estabelece.
5. `20260922195538_add_friends_table` — cria `friends`.

Replayar os 5 em ordem, num projeto Supabase novo, chega exatamente no estado atual de produção (`auth.users` existe em qualquer projeto Supabase por padrão, mesmo sem uso — os primeiros passos "erram" mas o resultado final bate). **Aplicar**: pela SQL Editor do Supabase (colar cada arquivo em ordem), pela ferramenta `apply_migration` do MCP do Supabase (como foi feito de verdade), ou pelo `supabase db push` se você configurar a CLI localmente (`supabase link` primeiro).

**Mudanças de schema daqui pra frente**: crie um novo arquivo em `supabase/migrations/` com timestamp+nome descritivo (`YYYYMMDDHHMMSS_descricao.sql`), nunca edite uma migration já aplicada. `schema.sql` não é mais a fonte de verdade — existe só como ponteiro pra esta seção.

**Recuperação/rollback**: não há rollback automático (o Postgres do Supabase não guarda um "down" por migration aqui) — pra desfazer uma mudança, escreva uma migration nova que reverte a anterior (ex.: `alter table ... drop column ...`), nunca edite/apague o arquivo já aplicado. Antes de qualquer migration que apague ou altere coluna existente, garanta um backup (o Supabase já faz backup automático diário nos planos pagos; no free tier, exporte manualmente via `pg_dump` ou a aba Backups do painel antes de migrations destrutivas).

**Decisão consciente, não esquecimento:** `inventory`, `character_items`, `equipment`, `quests`, `quest_progress`, `transactions`, `party`, `guilds` — nenhuma dessas tabelas foi criada. `characters.save` (jsonb) já guarda inventário/equipamento/progresso de missão, e as Fases 1-3 validaram extensivamente que esse formato funciona bem com validação server-autoritativa. Normalizar isso em tabelas próprias seria uma migração grande e arriscada sem benefício concreto hoje (a mandato da própria Fase 4 diz pra evitar normalizar prematuramente) — fica pra quando houver uma razão real (ex.: precisar consultar/agregar itens entre personagens, o que hoje ninguém pede). `party`/`guilds` continuam fora do banco de propósito — grupo já é efêmero em memória (documentado desde a Fase 1), guildas nem existem ainda no jogo (Fase 10 do roadmap).

## Produção (Render)

O Render serve o mesmo `server.js` (HTTP + WebSocket na mesma porta, via `PORT`). Sem as variáveis do Supabase configuradas, o jogo e o multiplayer de presença funcionam normalmente — só o login online fica indisponível.

# Fase 5 — vertical slice (validação end-to-end em produção)

**Escopo real desta fase:** o roadmap original pedia um "vertical slice" (algumas classes, alguns níveis, alguns monstros, quest, dungeon, boss, loot, economia). Esse conteúdo já existe no jogo desde antes desta série de fases — 4 classes, níveis 1-40+, 13 tipos de monstro, quests encadeadas, cripta/masmorra, bosses, loot, loja. O trabalho real da Fase 5 não era *criar* conteúdo, era **validar** que esse conteúdo inteiro continua funcionando de ponta a ponta depois de todas as mudanças server-autoritativas das Fases 1-2, já que praticamente todo sistema pós-Fase-1 só liga de verdade com `CUR_CHAR&&authToken()` (conta real) ou `NET.readyState===1` (WS real) — coisa que os testes automatizados da Fase 3 não exercitam (eles simulam WS diretamente, nunca passam pelo cliente/browser real) e que eu não tinha como testar localmente (sem credenciais Supabase no ambiente).

**Método:** playthrough real no browser contra produção (`https://novo-rpg.onrender.com/`, commit `f133ccd`, confirmado "live" via Render MCP antes de começar), usando o Claude Browser (não Chrome do usuário) com uma conta descartável (`qatester5fase`).

**Validado, com evidência:**
- **Cadastro + login + sessão**: criar conta, logout implícito por reload de página, e voltar sem re-digitar senha (sessão persistida) — funcionou sem erro.
- **Criação de personagem**: seleção de classe (Guerreiro), nome, criação — persistiu corretamente (visível na lista de personagens após reload).
- **Carregamento do mundo + WS ao vivo**: mapa `Vila Inicial` renderizou, indicador "1 online" confirmou WS conectado.
- **Movimento do cliente + colisão real**: `P.x`/`P.y` avançam com input de teclado (WASD), bloqueados corretamente por árvores e por uma cerca (`makeFenceV`) com um único vão de passagem — a função `blocked()` do cliente reflete o grid de colisão do mapa fielmente.
- **IA de monstro server-autoritativa em produção real**: um slime perseguiu e acertou o jogador (`HP 110→80`, floater de dano "-6" visível), confirmando que `mob_positions`/`mob_hit` (Fase 2) funcionam em produção, não só nos testes WS sintéticos.
- **Combate do jogador, level-up, recompensas**: `pressAttack()` (auto-mira + auto-ataque) matou múltiplos slimes reais; `P.sl` (contador de abates) subiu de 0→3; personagem subiu de nível (1→2), HP/MP máximos recalculados, ouro aumentou (10→14), habilidade nova desbloqueada ("Golpe Giratório", nível 2) com toast e ícone na barra — tudo aplicado via `applyQuestResult`/`recalc()` a partir de dados vindos do servidor, não calculado no cliente.
- **Persistência real via Supabase (valida a Fase 4 de ponta a ponta)**: dei reload completo na página, a sessão HTTP voltou sozinha, e o personagem recarregou com **exatamente** o mesmo nível (2), HP/MP máximos (132/48), ouro (14) e posição/mapa (`Planície dos Slimes`) de antes do reload — prova que `characters.save` (jsonb) grava e lê corretamente pelas migrations reconstruídas na Fase 4.
- **Gate de missão é design correto, não bug**: a missão tutorial mostra "Derrote 3 slimes (0/3)" fixo enquanto `P.quest===0`; o contador só vira `Math.min(P.kills,3)` depois de falar com a NPC "aldeã" (`P.quest` vira 1). Eu matei slimes antes de falar com ela, então o abate (real, confirmado por `P.sl`) não contou pra missão — confirmado lendo `questHtml()` no cliente, não é bug do servidor.
- **Zero erros de console** durante toda a sessão de combate/movimento, além de dois `503` obsoletos do cold-start do Render (serviço free tier "dormindo") no carregamento inicial — não relacionados ao código desta série de fases.
- **Suite automatizada (Fase 3) re-rodada ao final**: `node --test` → 77 testes, 33 passaram (os WS-only, que sempre rodam sem Supabase), 0 falharam, 44 pulados (dependem de credenciais Supabase, ausentes neste ambiente) — consistente com o comportamento observado ao vivo no browser.

**Não fechado nesta sessão (limitação de ferramenta, não do jogo):** não completei o loop inteiro da missão tutorial (falar com aldeã → matar 3 slimes com quest ativa → voltar → resgatar recompensa) porque a NPC "aldeã" ficou a ~1800px de distância do ponto onde cheguei, e mover o personagem via automação de browser usa eventos de teclado sintéticos (`keydown`+`keyup` instantâneos) que avançam ~0.1px por tecla — uma fração do que um jogador real com tecla segurada faria. Cobrir essa distância via automação exigiria dezenas de milhares de eventos sintéticos, custo desproporcional ao valor da validação (o mecanismo de progresso de missão já foi confirmado correto por leitura direta do código-fonte do cliente, `questHtml()`/`applyQuestResult()`). Não é um problema do servidor nem do jogo — é uma limitação conhecida de dirigir este tipo de jogo (WASD, sem clique-para-mover) por automação de teclas sintéticas.

**Conclusão da Fase 5:** o vertical slice existente sobrevive intacto a todas as mudanças server-autoritativas das Fases 1-4, validado em produção real (não em mock, não em teste isolado) — conta, personagem, mundo, movimento/colisão, IA de monstro, combate, level-up, recompensas e persistência via Supabase funcionam de ponta a ponta sem nenhuma funcionalidade quebrada ou regressão encontrada.

# Fase 5.1 — fundação de equipamentos (UID, nível x raridade, posse server-authoritative)

**Motivação:** antes da Fase 5.1, `sanitizeItem()` validava STATS de um item (impedia `atk:999999`) mas nunca validava POSSE — `handleCharacters` (PUT genérico) aceitava `save.bag`/`save.eq` inteiros vindos do cliente e só recalculava os números a partir do `tier`. Um personagem "rastreado" (`isTracked`) podia editar `localStorage`/memória e mandar um PUT com equipamento forjado (stats legítimos pro tier, mas nunca comprado) — a compra pela loja (`handleShop`) já era uma transação de verdade desde a Fase 3, mas o PUT genérico não fechava essa brecha. Esta fase fecha essa brecha *antes* de introduzir raridades valiosas (Raro/Épico/Lendário) ou drops, exatamente como pedido: fundação primeiro.

## Modelo canônico de item

```
{ uid, type, lv, rarity, enchant, n, atk, def, hp, blk, spd, req }
```

- **`uid`** — `crypto.randomUUID()` (Node), nunca `Math.random()`. Gerado uma única vez por item, no servidor, e nunca regenerado (nem em `sanitizeItem`, nem em `sanitizeSave`, nem no PUT genérico) — estável entre save/reload/equip/desequip/venda/recompra.
- **`type`** — mesmo domínio de sempre (`sword`/`bow`/`staffd`/`staffm`/`shield`/`armor`/`helmet`/`cape`/`jewel`/`boots`).
- **`lv`** — progressão do equipamento: uma das 11 faixas `1,4,8,12,16,20,24,28,32,36,40`. Separado de `rarity` de propósito (era o campo `tier` antigo, que acoplava as duas coisas).
- **`rarity`** — `basic`/`rare`/`epic`/`legendary` (exibido como Básico/Raro/Épico/Lendário). Multiplica a stat base (`basic=1.00, rare=1.10, epic=1.20, legendary=1.35`) mas **nunca** o `req` — progressão de nível continua sendo o que mais importa (Lendário Nv20 nunca supera Básico Nv40; validado em teste, ver `test/gear-data.test.js`).
- **`enchant`** — sempre `0` nesta fase (preparação pra Fase 5.4). `sanitizeItem` já trava o valor em `0..10` caso um dia apareça algo fora disso.
- **`req`** — nível mínimo de personagem pra equipar. Pra arma/armadura sempre `= lv` (igual sempre foi). Pra escudo/capacete/capa/joia/bota: `0` nas 5 faixas legadas (`lv<=20`, preserva o comportamento antigo — nunca tiveram gate) e `= lv` só nas 6 faixas novas (`lv>20`, conteúdo que nunca existiu antes, então não há comportamento antigo pra quebrar). Decisão deliberada, documentada aqui pra não parecer inconsistência.

## Fonte única de dados: `game-data/gear-data.js`

Antes, `GEAR_TIERS`/`GEAR_PRICES` viviam duplicados em `server.js` e `index.html` (risco real de divergência a cada gear novo). Agora `game-data/gear-data.js` é a única fonte — `server.js` faz `require('./game-data/gear-data.js')`, `index.html` carrega `<script src="/game-data/gear-data.js"></script>` antes do script principal (servido estaticamente, sem build step). Contém: `GEAR_LEVELS`, `RARITY`, `GEAR_STATS`/`statsFor()`, `GEAR_NAMES`/`nameFor()`, `GEAR_PRICES`/`priceFor()`, `SELL_PRICES`/`sellPriceFor()`, `LEGACY_TIER_LEVEL` (migração). `test/shop-catalog.test.js` verifica explicitamente que os dois lados carregam essa fonte (não duas cópias).

### Curva de nível 1-40 (como foi derivada, não chutada)

Os 5 pontos legados (`lv=1,4,8,12,20`) são os valores antigos **preservados byte-a-byte** (nenhum item existente muda de força ao migrar). Os 6 pontos novos (`16,24,28,32,36,40`) continuam a mesma taxa de crescimento por nível que já existia entre os dois últimos pontos reais (`lv12→lv20`) de cada stat — extrapolação linear simples a partir de números que já estavam balanceados, não uma tabela inventada. Exemplo (`sword.atk`): `2,5,9,14,18,22,26,30,34,38,42` (lv12→20 crescia 1.0 atk/nível; a extrapolação mantém esse 1.0/nível daí em diante). Todo tipo tem crescimento estritamente monotônico verificado em teste (`test/gear-data.test.js`).

### Preços (Mercador, raridade `basic` apenas)

`1/4/8/12` preservam os preços já praticados (`sword: 60/180/450/900`). `20` preenche uma lacuna real — o tier5 já existia em stats mas nunca tinha preço de loja (só vinha de baú). `16-40` seguem uma curva de razão decrescente (mesmo formato da curva 1→12 real: 3x, 2.5x, 2x, ... tapeia até ~1.24x), calibrada contra renda estimada de abate (`rollMobLoot`) + recompensa de missão (`QUEST_REWARDS`) por faixa de mapa, mirando ~15-40min de jogo normal por peça. **Isto não é garantia matematicamente exata** — não há telemetria real de produção ainda, é a melhor estimativa a partir da economia hoje; ajustar com dados reais depois é esperado, não uma falha desta fase.

| Nv | Espada/Arco/Cajado | Armadura | Escudo/Elmo/Bota | Capa | Joia |
|----|---:|---:|---:|---:|---:|
| 1  | 60   | 30   | 25   | 20   | 40   |
| 4  | 180  | 120  | 100  | 80   | 160  |
| 8  | 450  | 320  | 265  | 215  | 425  |
| 12 | 900  | 700  | 585  | 465  | 935  |
| 16 | 1500 | 1150 | 960  | 765  | 1535 |
| 20 | 2200 | 1650 | 1375 | 1100 | 2200 |
| 24 | 3200 | 2350 | 1960 | 1565 | 3135 |
| 28 | 4400 | 3200 | 2665 | 2135 | 4265 |
| 32 | 5800 | 4200 | 3500 | 2800 | 5600 |
| 36 | 7400 | 5350 | 4460 | 3565 | 7135 |
| 40 | 9200 | 6650 | 5540 | 4435 | 8865 |

## Mercador Nv 1-40

Vende **só `rarity:'basic'`**, nas 11 faixas, pra arma da classe (`guerreiro→sword`, `arqueiro→bow`, `mago→staffm`, `druida→staffd` — confirmado no código antes de mexer) + armadura + capa + joia + botas + escudo (só guerreiro). `buildShop()` no cliente e `handleShop`'s `buy_gear` no servidor usam a mesma `GEAR_DATA.GEAR_LEVELS`/`priceFor` — trocar o wire de `{type,tier}` pra `{type,lv}` foi intencional (cliente e servidor sempre andam juntos no deploy; dado *persistido* antigo continua migrando normalmente).

## UID e posse server-authoritative

`sanitizeItem()` aceita dois formatos: canônico (`{uid,type,lv,rarity,enchant}`, mantém o `uid` se for um UUID válido) e legado (`{type,tier}`, migra pra `lv` via `LEGACY_TIER_LEVEL` — os 5 valores reais de stats são idênticos, então nada muda de força — e ganha um `uid` novo **uma única vez**; nas leituras seguintes já bate no formato canônico e o uid persiste). Stats/nome são **sempre** recalculados a partir de `type+lv+rarity`, nunca aceitos do cliente.

**`lockOwnedItems(candidateSave, ownedSave)`** (server.js) é o bloqueador crítico, usado só pelo PUT genérico (`handleCharacters`) quando o personagem já tem progresso real (`isTracked`): um item só sobrevive no PUT se o `uid` dele já existia no save **persistido** antes desse PUT (mochila ou equipado, não importa o slot — só a posse). Item cujo uid o servidor nunca viu é descartado silenciosamente (nunca fabrica item). Item que sobrevive sempre usa a cópia canônica do servidor (ignora qualquer stat/rarity/enchant/lv forjado no payload). Item que o cliente "esqueceu" de mandar de volta volta pra mochila em vez de desaparecer (a trava nunca é motivo pra perder item). **Equipar/desequipar continua funcionando 100% sem nenhuma mudança no fluxo existente**, porque mover um uid já possuído entre `bag`/`eq` não muda o conjunto de uids, só a posição — passa pela trava livremente.

Além disso, `handleShop` ganhou duas operações explícitas por uid — `equip_item`/`unequip_item` — pra personagens online (valida nível, classe, slot, mochila cheia) e persistem imediatamente (não dependem do PUT debounced de 8s). `sell_item`/`buyback` agora aceitam `uid` (preferencial) mantendo `bagIndex` como fallback; `buyback` sempre devolve exatamente o mesmo objeto vendido (mesmo uid, nunca gera um novo).

**Anti-duplicação:** `dedupeByUid()` garante que um uid nunca aparece duas vezes numa lista; `sanitizeSave` aplica isso dentro da mochila e no cruzamento mochila+equipado (mochila vence, cópia equipada é descartada). Save antigo com uid duplicado (não deveria existir, mas se existir) nunca gera 2 cópias — perde silenciosamente a segunda ocorrência, documentado e testado.

**Concorrência:** `withCharLock(charId, fn)` (mutex simples em memória, fila por personagem) serializa `handleShop` e `handleChest` — duas requisições do mesmo personagem nunca leem o mesmo estado "antigo" e se sobrescrevem. **Limitação documentada:** só protege dentro desta instância Node (Render roda uma instância hoje); com mais de uma instância precisaria virar lock real no banco (transação Postgres). `handleCharacters` (PUT) e `handleQuest` não estão sob o lock — risco menor (sync periódico debounced, não ação de usuário disparada rapidamente), mas é uma lacuna conhecida, não resolvida nesta fase.

## Ícones (sem sprites novos ainda)

Arma (`sword`/`bow`/`staffd`/`staffm`) reusa os 4 frames já existentes (`w_*1..4`), escolhidos pela faixa de nível (`lv<4→1, lv<8→2, lv<12→3, senão→4`) — variedade visual sem sprite novo. Raridade controla tint/gild (reaproveitando a paleta que já existia pra `tier`: `basic`=sem tint, `rare`=azul, `epic`=roxo, `legendary`=dourado+gild), independente do nível. Slots sem múltiplos frames (`shield`/`armor`/`helmet`/`cape`/`jewel`/`boots`) usam só o tint por raridade. Nenhum ícone quebra pra Nv16-40. Documentado aqui pra quando sprites próprios por faixa forem produzidos — plugam em `GEAR[type].icons` sem mexer na lógica de seleção.

## Nomes originais

Todos os 54 nomes novos (6 faixas × 9 tipos) seguem a zona de campo associada àquele nível (`serra→pantano→torre→ilhas→vulcão`), ex.: `Lâmina da Matilha` (Nv16, serra/lobos) → `Lâmina do Vulcão` (Nv40, endgame). Nenhum nome copiado de Lineage II/WoW/etc.

## Compatibilidade com personagens e itens antigos

Migração acontece **na leitura**, sem migration de banco (não precisa — o item já vive em `characters.save` jsonb, só o formato interno do item mudou). Fluxo: `sanitizeItem` vê um item sem `uid`/`lv`/`rarity` válidos → mapeia `tier→lv` via `LEGACY_TIER_LEVEL` (`1→1, 2→4, 3→8, 4→12, 5→20`) → `rarity='basic'` → gera `uid` novo → próxima gravação já persiste no formato novo. Nenhuma migration em `supabase/migrations/` foi necessária ou criada (mandato desta fase: não normalizar equipamento em tabela própria só pra isso).

## O que NÃO entrou nesta fase (de propósito)

- **Enchant funcional** (botão, risco de quebra +4..+10) — só o campo `enchant:0` existe. Entra na Fase 5.4, depois que TvT/World Boss não dependerem disso.
- **Drops de Raro/Épico/Lendário** — `createGear({type,lv,rarity})` já existe e já suporta as 4 raridades (testado), mas nenhum monstro/baú chama com raridade acima de `basic` ainda. A Fase 5.3 liga o drop.
- **World Boss, TvT, Guilda, página pública, Phantom Players** — inalterados, fora do escopo.

## Testes adicionados

- `test/gear-data.test.js` (13 testes, sempre roda, sem servidor/Supabase) — curva de nível, multiplicador de raridade, req independente de raridade, preços, nomes.
- `test/item-model.test.js` (22 testes, sempre roda — `server.js` exporta `sanitizeItem`/`sanitizeSave`/`lockOwnedItems`/`createGear`/`dedupeByUid` só pra isso, atrás de `require.main===module`, sem mudar como `node server.js` roda) — uid único/estável, migração legada, stats/nome sempre recalculados, tampering de rarity/enchant/lv/atk, posse (`lockOwnedItems`), duplicação, equip/desequip via troca de posição.
- `test/shop-catalog.test.js` (4 testes, sempre roda) — reescrito: antes fazia regex+`vm` em cima de literais que não existem mais; agora confirma que cliente e servidor carregam a mesma `game-data/gear-data.js` e que as 11 faixas existem pras 4 classes.
- `test/shop.test.js` (19 testes, `{skip:!hasSupabase()}`) — compra/venda/recompra/equip/unequip por uid, tampering via PUT bruto (item forjado, uid duplicado, rarity/enchant/lv/atk trocados), compras concorrentes (mutex).
- **Os 3 `setInterval` de escopo de módulo em `server.js`** (tick de IA, ping de WS, respawn) ganharam `.unref()` — sem isso, `require('../server.js')` num teste unitário nunca deixava o processo sair sozinho (achado real durante esta fase, não uma limitação assumida de antemão). Não muda nada rodando como servidor de verdade.

**Limitação honesta:** os 19 testes de `shop.test.js` (incluindo os de tampering, que são os mais importantes desta fase) **não puderam ser executados neste ambiente** — sem `SUPABASE_URL`/`SUPABASE_SECRET_KEY` locais (mesma limitação de todas as fases anteriores). Sintaxe validada, lógica equivalente já coberta por `item-model.test.js` (que testa `lockOwnedItems`/`sanitizeItem` diretamente, sem precisar de HTTP/Supabase), e a integração real foi confirmada pelo smoke test em produção (ver abaixo). Vão rodar de verdade no GitHub Actions (se os secrets estiverem configurados lá) e sempre que alguém rodar `npm test` com Supabase configurado.

## Próxima fase

Fase 5.2 (dungeon + inventário/economia completamente server-authoritative) é a sugestão natural do roadmap, mas fica pra quando for solicitada — esta fase não deve avançar sozinha pra Enchant, World Boss ou TvT sem essa fundação ser usada em produção primeiro.

# FASE 5.2 — DUNGEON E ECONOMIA SERVER-AUTHORITATIVE

**Motivação:** a Fase 5.1 fechou posse de item no PUT genérico, mas deixou três brechas abertas: (1) o `join` do WebSocket confiava cegamente em `userId`/`charId`/`cls`/`lvl` que o próprio cliente mandava; (2) o PUT genérico só travava `bag`/`eq`, mas `gold`/`gem`/`pv`/`pa`/`ap`/`key`/`scr`/`gunlock`/baús de chefe continuavam aceitando qualquer valor vindo do cliente (e um personagem novo/"primeiro PUT" tinha uma exceção histórica que confiava ainda mais no cliente); (3) mapas `*_d` (masmorra) eram explicitamente excluídos da IA/roster/colisão autoritativos do servidor — o labirinto, os monstros e o loot da masmorra eram gerados e resolvidos 100% no cliente. Esta fase fecha as três.

## Autenticação do WebSocket

`resolveUser(req)` foi dividido em `resolveUserByToken(token)` (puro, sem depender de um `req` HTTP) + `resolveUser(req)`, pra poder reautenticar o mesmo jeito dentro do WS. `join` agora manda `token` (o mesmo token de sessão HTTP) + `charId` opcional. `handleWsJoin`: sem token → visita anônima (mesmo comportamento de sempre, sem nenhuma operação econômica possível). Com token válido → `userId` vem do banco. Com token válido **e** `charId` que realmente pertence àquele `userId` (mesmo filtro `id=eq&user_id=eq` que as rotas REST usam) → `p.cls`/`p.lvl` vêm do personagem real no banco, nunca do que a mensagem `join` reivindica; `p.authed=true` passa a liberar `dungeon_enter` e qualquer operação futura que exija sessão real. `userId` nunca é um campo que o cliente controla — só existe depois de resolvido pelo token. Erro de Supabase durante a resolução (fora do ar, não configurado) nunca derruba a conexão: degrada pra visita anônima, mesmo padrão usado no resto do jogo sem conta online configurada. Reconexão sempre passa de novo por `handleWsJoin` (não existe estado de auth reaproveitado de uma conexão anterior) — cada `join` reautentica do zero.

`state` (posição periódica): personagem autenticado tem `lvl` travado no valor que o próprio servidor já conhece (nunca no que a mensagem `state` reivindica) — fecha a brecha de inflar `p.lvl` pra aumentar dano calculado (`baseDmgOf` usa `p.lvl`). Também bloqueia trocar pra uma instância de masmorra (`_d#id`) diferente da que o próprio `dungeon_enter` colocou o personagem (`p.map`), fechando a brecha de mandar `map:"vulcao_d"` direto numa mensagem `state`.

## Campos bloqueados no PUT genérico (`ECONOMY_LOCK_FIELDS`)

```
gold, gem, pv, pa, ap, key, scr, gunlock, chest, chest2, chest3, chest4, chest5, chest6, chest7
```

Sempre que o personagem já existe no banco, o PUT devolve esses 15 campos pro valor **persistido** (`currentSave`), descartando qualquer valor do payload — igual já acontecia com `bag`/`eq` (`lockOwnedItems`) e `QUEST_GATE_FIELDS`/`quest`/`xp` desde a Fase 5.1. **A exceção histórica do "primeiro PUT"/personagem não rastreado (`isTracked`) foi removida por completo.** Antes, um personagem sem progresso real no banco podia ter seu primeiro PUT aceito quase integralmente (mecanismo pensado pra promover personagem local antigo pra nuvem) — incompatível com economia autoritativa, porque um personagem "novo" na nuvem podia nascer com `gold:500000`/equipamento Lendário só mandando isso no primeiro PUT. Isso deixou de ser necessário porque `POST /api/characters` agora sempre grava `save:startingSave(cls,name)` — um save inicial **completo e real** (`gold:10, pv:3, pa:2, gem:0`, arma Nv1 básica da classe já equipada, `gunlock:{}`, `bag:[]`) — não existe mais "save vazio" que precise confiar no cliente pra nascer com algo. O PUT de importação de personagem local antigo continua funcionando sem erro (não quebra o fluxo existente), mas só `name`/`cls` sobrevivem — ouro/itens/nível/progresso local **nunca mais** são aceitos por essa via. Se import de personagem local legítimo for necessário no futuro, precisa de uma estratégia própria (migração administrativa/one-time autorizado) — não reabrir essa exceção no PUT genérico.

## Operações de inventário/consumíveis server-authoritative

`handleShop` (por UID, todas persistem imediato, sem depender do PUT debounado): `buy_gear`, `buy_stack`, `equip_item`, `unequip_item`, `sell_item`, `buyback`, `skill_reset`, `sell_gem`, `buy_portal` — já existiam desde a Fase 3/5.1. Novidade desta fase: **`use_item`** — consumir `pv`/`pa`/`ap`/`scr` virou uma intenção server-side (`{action:'use_item', key:'pv'}`); servidor confere quantidade real (rejeita se `<1` ou se `key` não é um dos 4 válidos) e decrementa no save persistido. O efeito em si (curar HP/MP, teleportar) continua calculado no cliente (não mudou o "sentir" do jogo), mas a contagem real do consumível agora é sempre a do servidor — o cliente manda a intenção em paralelo (fire-and-forget) sem depender da resposta pra continuar a jogabilidade local instantânea.

Chaves de baú de chefe de campo (`key`) continuam seguindo o fluxo já existente desde a Fase 1 (`handleChest`, chefe derrota → `chest*` vira disponível → abrir consome `key` e gera loot) — sem mudança nesta fase, só migrou pra dentro de `ECONOMY_LOCK_FIELDS` (não podia mais ser setado via PUT bruto).

## Concorrência (`withCharLock`)

Mutex em memória por `characterId` (`Map` de filas de Promise), já existia desde a Fase 5.1 pra `handleShop`/`handleChest`. Nesta fase, **`PUT /api/characters/:id` e `creditKillReward` também passaram a rodar dentro de `withCharLock`** — antes eram os dois únicos caminhos que liam/gravavam save sem serialização, risco real de corrida com abates/compras simultâneas. `creditDungeonReward` (nova, ver abaixo) também é `withCharLock`-wrapped. **Limitação documentada, sem mudança:** só protege dentro desta instância Node — Render roda uma única instância hoje (`novo-rpg`); se um dia rodar múltiplas instâncias simultâneas, precisaria de lock real no banco (transação Postgres/`SELECT FOR UPDATE`), não implementado porque não é necessário na topologia atual.

## Masmorra server-authoritative

### `game-data/dungeon-generation.js` (novo, compartilhado)

Módulo puro (sem DOM/canvas), `require()` pelo servidor e `<script>` pelo cliente (mesmo padrão de `gear-data.js`). Contém `mulberry(seed)` (PRNG determinístico), `mazeGen(cols,rows,seed)` (labirinto perfeito por DFS + BFS pra achar a sala mais distante, que vira a sala do chefe — **idêntico byte-a-byte** ao `mazeGen` que já existia só no cliente, só extraído), `dungeonWallRects()` (paredes em retângulos de colisão, espelha o desenho do cliente), `dungeonLayout(seed)` (empacota tudo). Cliente e servidor usam a mesma matemática — nunca duas implementações que podem divergir.

### Seed e instância

`DungeonInstance` (conceitual, vive só em `maps.get(id)`, **nunca persistido no Supabase** — runtime de masmorra é 100% memória): `id` (`zona_d#<8hex>`), `zone`, `seed` (`crypto.randomInt`, escolhido pelo servidor — cliente nunca escolhe seed), `layout` (maze+paredes+posições de início/chefe), `ownerCharId`/`ownerUserId`, `mobs` (roster completo), `bossDefeated`, `createdAt`/`lastActiveAt`. Reaproveita a infraestrutura genérica já existente de mapas (`maps`, `mapState`, `broadcastMap`, `tickMobAI`) dando a cada instância uma chave de mapa própria — zero engine paralela nova.

### Entrada (`dungeon_enter` → `handleDungeonEnter`)

Pedido explícito ao servidor (`{type:'dungeon_enter', zone}`), nunca mais o cliente só chamando `travel('X_d')` local. Exige `p.authed` (sessão real, ver Autenticação acima). Valida a zona contra `DUNGEON_CFG`. Valida o requisito de desbloqueio **lendo o save real no banco** (`save.quest >= DUNGEON_UNLOCK_QUEST[zone] || save.gunlock[zone]` — mesmo limiar que já existia pro portal de campo, nunca confia no botão do cliente estar habilitado). Reusa a instância já existente do personagem pra aquela zona (`ownedDungeonInstance`) ou cria uma nova. Responde `dungeon_state` com `{map, zone, seed, start, roster, bossDefeated}` — o roster já vem completo (id/tipo/nível/hp/maxhp/posição/boss), o cliente só renderiza.

### Roster e IA

Gerado inteiro dentro de `createDungeonInstance` a partir de um stream de RNG independente (`mulberry(seed+1)`), iterando a grade 7×5 (72% de chance de spawn por célula, exceto início/chefe), usando os MESMOS `DUNGEON_CFG`/`mobStats` que decidiam o roster no cliente (probabilidades portadas 1:1). HP/tipo/nível do mob **nunca** vêm do cliente. Chefe tem `3×` o HP normal (preserva a dificuldade que o design antigo já tinha). `tickMobAI()` perdeu a exclusão `if (state.id.endsWith('_d')) continue` — mob de masmorra agora roda pela mesma IA (`MOB_AI_STEP`/`moveMob`/`targetPlayer`) que mob de campo, sem engine de combate paralela.

### Colisão

`moveMob()` ganhou suporte a `mob.wallRects` (attachado no spawn, = `state.layout.rects`): tenta mover livre, se colidir tenta cada eixo separado (slide ao longo da parede) via `rectsBlock()` (AABB). Mob sem `wallRects` (todo mob de campo) mantém o comportamento de sempre (sem colisão de terreno) — limitação pré-existente **não** estendida nesta fase, foco ficou só em masmorra.

### Dano e morte

Jogador→mob continua usando `resolveAttackDamage` (cálculo já server-side desde a Fase 2, sem mudança). `mob.hp<=0` só é confirmado dentro do handler `mob_damage`, de forma síncrona (sem nenhum `await` antes de marcar `mob.dead=true`) — o event loop de um único processo Node garante que duas mensagens de dano pro mesmo mob nunca são processadas concorrentemente de verdade, mesmo que cheguem quase juntas (a segunda sempre vê `mob.dead===true` e retorna sem efeito). Chefe tem uma segunda trava explícita (`state.bossDefeated`), mais fácil de auditar/testar isoladamente. Mob de masmorra nunca respawna sozinho (`respawnAt=0`).

### Loot (chefe/comum) e "baú"

`creditDungeonReward(ws,p,{gold,gem,pv,ap,scr,items})` — nova, `withCharLock`-wrapped, aplica os deltas + `grantItem` (equipa se der, senão mochila) e manda `dungeon_reward` com o save completo (não delta). **Nunca concede XP** (achado direto no código do cliente: `killMob(s.dun)` original já não dava XP em masmorra — comportamento preservado, não inventado). `rollDungeonTrashLoot`/`rollDungeonBossLoot` portam as mesmas fórmulas/probabilidades que existiam no cliente (`pickTier`, ouro, chance de `pv`/`gem`/item) — **todo item gerado usa `rarity:'basic'`** (Raro/Épico/Lendário continuam fora do escopo, ver abaixo). Lendo o código do cliente, descobrimos que **o "baú" de masmorra sempre foi cosmético**: a recompensa real sempre saiu direto da morte do chefe (`killMob`), o baú só abria visualmente (`.open=true`) sem chave nem ação separada — implementado exatamente assim aqui (sem inventar um fluxo de "abrir baú com chave" que a masmorra nunca teve). Chave (`key`) de baú de **chefe de campo** é um mecanismo diferente e não mudou (ver seção de inventário acima).

### Limpeza de instância

`dungeonCleanupTick()` (chamado a cada 1s, junto do tick de respawn já existente) remove do `maps`/`dungeonByOwner` qualquer instância com **30min sem ninguém presente** (`DUNGEON_IDLE_MS`) ou **2h de vida total** (`DUNGEON_MAX_LIFE_MS`), o que vier primeiro. Reconexão dentro desses limites reencontra a mesma instância (mesmo seed/roster/`bossDefeated`) via `ownedDungeonInstance`.

### Party

Preservado exatamente como estava: masmorra hoje é solo (cada personagem tem sua própria instância, `ownedDungeonInstance` é chaveado por `charId`). Nenhuma infraestrutura cooperativa nova foi inventada — não fazia parte do design atual. World Boss em party é Fase 5.6, fora do escopo aqui.

## ATK server-side (Parte 9, parcial)

`clampAtk` (teto usado por `resolveAttackDamage`/`skBaseOf`) estava desatualizado em `35` — teto real pra atk legítimo Nv40 Básico (Fase 5.1) é ~72-80. Corrigido pra `120` (folga real acima do máximo legítimo, mas ainda limita claramente um valor absurdo tipo `9999`). **Limitação documentada, não resolvida nesta fase:** o servidor ainda não deriva ATK a partir do equipamento real (`p.atk` continua vindo do que o cliente reporta em `mob_damage`/`player_damage`, só *limitado* pelo teto, não recalculado do zero a partir de `save.eq`). Fazer isso direito exigiria o servidor ter acesso rápido ao equipamento real por conexão (cache por personagem ou leitura no banco por golpe) — julgado fora do escopo desta fase (dungeon + economia), registrado aqui como bloqueador claro pra uma fase futura de combate 100% server-derivado.

## HP do jogador (Parte 9, limitação registrada)

**Não resolvido nesta fase, de propósito** (evitar reescrita de todo o combate PvP/campo sem necessidade): HP/defesa/morte do jogador (`hurtPlayer()`) continuam parcialmente client-side mesmo dentro da masmorra — `mob_hit` manda o dano bruto calculado no servidor, mas a mitigação final e o `pv` do jogador são aplicados no cliente. Não declaramos "masmorra 100% server-authoritative em combate" por causa disso — é uma lacuna real e conhecida, registrada como bloqueador pra uma fase futura, não uma lacuna escondida.

## Offline vs. online

Modo offline (sem conta) preservado sem nenhuma mudança de comportamento — continua usando toda a lógica local de sempre (inclusive geração de masmorra local, loot local). A fronteira é clara: **todo o server-authoritative desta fase só existe pra conexão com `p.authed===true`** (token+charId reais validados no `join`). Progresso offline nunca é carregado numa sessão online de um jeito que sobrescreva a economia autoritativa — o PUT genérico (única porta de entrada de save local→nuvem) trava justamente os campos econômicos (ver acima), então mesmo que alguém tente sincronizar um save local adulterado, só `name`/`cls` sobrevivem pra um personagem que já existe no banco.

## Fallback

Nenhum fallback local foi adicionado para conta online (dungeon/economia): se `dungeon_enter`/`use_item`/qualquer ação de `handleShop` falhar pra um personagem autenticado, o cliente recebe erro (`dungeon_error`/`{error}` da API) e pode tentar de novo — não existe caminho que calcule a recompensa localmente e siga em frente pra uma conta online.

## Matriz de mutação econômica

| Campo | Quem aumenta | Quem diminui | Endpoint/evento | Server-authoritative? |
|---|---|---|---|---|
| `gold` | `creditKillReward`, `creditDungeonReward`, `sell_item`, `buyback`(estorna preço pago), `sell_gem` | `buy_gear`, `buy_stack`, `buy_portal`, `skill_reset` | `handleShop` (HTTP), `mob_damage`→WS (campo e masmorra) | **Sim** |
| `gem` | `creditKillReward`, `creditDungeonReward` (loot de chefe/comum) | `sell_gem` | `handleShop`, `mob_damage`→WS | **Sim** |
| `bag`/`eq` (itens, por uid) | `buy_gear`, `unequip_item`, `buyback`, `creditDungeonReward`(`grantItem`), `handleChest`(`rollChestItem`) | `sell_item`, `equip_item` (move, não remove) | `handleShop`, `handleChest`, `mob_damage`→WS | **Sim** (uid único, `lockOwnedItems`+`dedupeByUid` no PUT) |
| `pv`/`pa` (poções) | `buy_stack`, `creditDungeonReward` | `use_item` | `handleShop` | **Sim** |
| `ap` | `creditDungeonReward` (masmorra) | `use_item` | `handleShop`, `mob_damage`→WS | **Sim** |
| `key` (chave de baú de campo) | drop de chefe de campo (`creditKillReward`→`BOSS_CHEST_FIELD`) | `handleChest` (abrir baú) | `mob_damage`→WS, `handleChest` | **Sim** |
| `scr` | (mecanismo pré-existente, sem mudança de origem nesta fase) | `use_item` | `handleShop` | **Sim** |
| `gunlock[zona]` | `buy_portal` | — (nunca diminui) | `handleShop` | **Sim** |
| `chest`/`chest2..7` (baú de chefe de campo) | `creditKillReward` (chefe correspondente) | `handleChest` (abre e zera) | `mob_damage`→WS, `handleChest` | **Sim** |
| `quest`/`xp`/contadores (`kills,gk,ks,kw,kp,kt,ki,kv`) | `advanceQuestOnKill` (dentro de `creditKillReward`), `handleQuest` | — | `mob_damage`→WS, `handleQuest` (HTTP) | **Sim** (travado no PUT desde a Fase 5.1) |
| `lvl` | `applyXpGain` (dentro de `creditKillReward`) | — | `mob_damage`→WS | **Sim** (travado no PUT desde a Fase 5.2 — `lvl=current.lvl` incondicional) |

**PUT genérico (`handleCharacters`) não é origem de nenhuma linha desta tabela** pra personagem já existente — todo campo listado é sobrescrito pro valor persistido antes de gravar (ver "Campos bloqueados no PUT genérico" acima). Nenhuma outra brecha foi encontrada na auditoria desta fase (confirmado por leitura direta de `server.js` + consulta Graphify pós-mudança, ver relatório final da Fase 5.2).

## O que NÃO entrou nesta fase (de propósito)

- **Raro/Épico/Lendário em monstro/masmorra** — `rollDungeonTrashLoot`/`rollDungeonBossLoot` usam só `rarity:'basic'`. Fase 5.3 liga isso.
- **Enchant funcional** — inalterado desde a Fase 5.1 (`enchant:0`).
- **Ferreiro, World Boss, TvT, Guilda, Bestiário, Ranking, página pública, Phantom Players** — inalterados, fora do escopo.
- **ATK 100% derivado do equipamento real** e **HP/morte do jogador 100% server-side dentro da masmorra** — ver seções acima, registrados como limitação conhecida, não lacuna escondida.
- **Masmorra cooperativa (multi-jogador na mesma instância)** — preservado solo, infraestrutura de party não foi construída (não fazia parte do design atual).

## Testes adicionados

- `test/dungeon.test.js` (18 testes, sempre roda, sem Supabase) — `createDungeonInstance` (seed único, roster fiel a `mobStats`, chefe 3×hp, `respawnAt=0`, `wallRects` compartilhado, zona inválida, registro em `maps`), `moveMob`/`rectsBlock` (colisão com/sem `wallRects`), `dungeonCleanupTick` (idle vs. recente), `startingSave` (por classe), `ECONOMY_LOCK_FIELDS` (cobertura dos 15 campos), `DUNGEON_UNLOCK_QUEST`, `clampAtk`, `pickTier`, `rollDungeonTrashLoot`/`rollDungeonBossLoot` (sem xp, chefe sempre 3 itens+gem:6), `DUNGEON_GEN.dungeonLayout` (determinismo).
- `test/economy.test.js` (5 testes, `{skip:!hasSupabase()}`) — save inicial completo no primeiro save; primeiro PUT tentando forjar `gold:500000/gem:5000/pv:999/.../gunlock todo true/chest todo true/item Lendário` não persiste nada disso; mesmo tampering num personagem já existente; campos econômicos continuam travados após uma tentativa de forja; `use_item` rejeita quantidade zero e chave inválida.
- `test/ws-auth.test.js` (7 testes, `{skip:!hasSupabase()}`) — sem token (anônimo aceita cls/lvl da mensagem, comportamento preservado), token inválido (degrada pra anônimo), charId inexistente, charId de outra conta, token+charId válidos (cls/lvl reais do banco, forjados ignorados), userId forjado na mensagem é ignorado, reconexão reautentica do zero.
- `test/dungeon-integration.test.js` (7 testes, `{skip:!hasSupabase()}`) — `dungeon_enter` rejeitado sem sessão real/zona inválida/região não liberada; com região liberada devolve seed/roster/chefe gerados pelo servidor; reentrada reusa a mesma instância; abate de mob comum credita via `dungeon_reward` sem xp; **chefe recompensa exatamente 1 vez mesmo com golpes extras logo após a morte**; reconexão após derrotar o chefe mostra `bossDefeated:true`.
- `test/shop-catalog.test.js` — pequeno fix (não relacionado a conteúdo): leitura de `index.html` agora normaliza `\r\n→\n` antes de comparar substring — `core.autocrlf` deste repo reescreve o arquivo pra CRLF ao trocar de branch, o que já quebrou esse teste uma vez sem nenhum conteúdo ter mudado de verdade.

**Limitação honesta (igual às fases anteriores):** os testes `{skip:!hasSupabase()}` (economy/ws-auth/dungeon-integration/shop/characters, total 70 testes pulados) **não puderam ser executados neste ambiente** — sem `SUPABASE_URL`/`SUPABASE_SECRET_KEY` locais, e não existe um projeto Supabase de TESTE dedicado pra este jogo (só o oficial de produção, "MMORPG 2D V0.22 Online" — nunca usado pra testes destrutivos, conforme instruído). Sintaxe e lógica pura validadas via `node -c server.js` + os 18 testes sempre-ativos de `dungeon.test.js` (que exercitam `createDungeonInstance`/`moveMob`/`dungeonCleanupTick`/`startingSave`/etc. diretamente, sem precisar de HTTP/WS/Supabase). Os testes que precisam de Supabase vão rodar de verdade no GitHub Actions se os secrets estiverem configurados lá, e sempre que alguém rodar `npm test` com Supabase configurado localmente.

## Migração de banco

**Nenhuma migration nova foi necessária ou criada.** Todo o estado desta fase continua vivendo em `characters.save` (jsonb, mesma coluna desde a Fase 4) ou 100% em memória (`DungeonInstance` nunca é persistido — layout/roster/HP de mob de masmorra somem quando a instância expira, por design). As 5 migrations históricas em `supabase/migrations/` não foram tocadas.

## Próxima fase

Fase 5.3 — drops server-side por raridade (Raro/Épico em monstro de campo e masmorra, Lendário em chefe) com balanceamento de chance/nível-de-item/mapa. Fica pra quando for solicitada.

# FASE 5.3 — DROPS POR RARIDADE

**Motivação:** a Fase 5.1 já suportava as 4 raridades no modelo canônico do item (`sanitizeItem`/`createGear` sempre souberam calcular stats pra `rare`/`epic`/`legendary`), mas nada no jogo realmente as concedia — Mercador só vendia `basic`, e todo loot server-side (mob de campo, baú, masmorra) também só gerava `basic`. Esta fase liga a raridade de verdade: mob comum agora pode dropar Raro/Épico, chefe (campo e masmorra) pode dropar Lendário — sempre decidido pelo servidor, nunca pelo cliente.

## Regra de origem por raridade

| Raridade | Fonte |
|---|---|
| Basic | Mercador (compra) + baú de campo legado (preservado, ver seção própria abaixo) |
| Rare | Mob comum (campo ou trash de masmorra) |
| Epic | Mob comum (campo ou trash de masmorra) |
| Legendary | Boss (campo ou masmorra) |

Mercador continua vendendo **somente `basic`** — nenhum botão novo foi adicionado pra Rare/Epic/Legendary, e os preços de compra Basic não mudaram.

## Chances de drop (`GEAR_DROP_RATES`, fonte única em `server.js`)

```js
const GEAR_DROP_RATES = {
  common: { epic: 0.0025, rare: 0.025 }, // 0.25% / 2.5%
  boss:   { legendary: 0.05 },           // 5%
};
```

Mob comum: testa Epic primeiro (0.25%); só testa Rare (2.5%) se Epic falhar; se os dois falharem, nenhum equipamento — **nunca** Legendary, **nunca** Basic como drop. Cada teste consome seu próprio `roll()`, então os dois nunca "acertam" no mesmo abate (mutuamente exclusivos por construção, não por um `if/else` que poderia mascarar overlap). Boss: um único teste (5%) — Legendary ou nada, **nunca** substitui por Rare/Epic/Basic. No máximo 1 equipamento especial por morte confirmada, em qualquer caso.

**Simulação (documentada, não é o resultado real de um teste rodado — os testes automatizados usam RNG injetado, ver abaixo):** 1.000 kills comuns ⇒ esperado ~25 Rare + ~2.5 Epic. 100 bosses ⇒ esperado ~5 Legendary.

## Função central de drop — `rollGearDrop({mobLevel, boss, cls, rng})`

Server-side, pura, testável sem Supabase (`rng` é injetável — testes controlam exatamente qual branch cada chamada toma; produção usa `Math.random` por padrão, nunca um valor vindo do cliente). Retorna `null` ou `{rarity, type, lv, item}`. Usada pelos 4 pontos de morte confirmada (mob de campo, boss de campo, trash de masmorra, boss de masmorra) — **mesma política em campo e masmorra**, sem tabelas paralelas.

1. Decide `rarity` (regras acima).
2. Escolhe `type` aleatoriamente (25% cada) dentro de `DROP_TYPES_BY_CLASS[cls]` — a classe real do personagem, resolvida server-side (`p.cls`), nunca a que o cliente reivindica.
3. Calcula `lv` via `gearLevelForMob(mobLevel)`.
4. Gera o item via `createGear(type, lv, rarity)` — mesma fonte canônica de sempre (uid novo, stats/nome/req recalculados de `GEAR_DATA`, nunca construído campo a campo).

## Slots que participam (`DROP_TYPES_BY_CLASS`)

```js
const DROP_TYPES_BY_CLASS = {
  guerreiro: ['sword', 'armor', 'cape', 'boots'],
  arqueiro:  ['bow', 'armor', 'cape', 'boots'],
  mago:      ['staffm', 'armor', 'cape', 'boots'],
  druida:    ['staffd', 'armor', 'cape', 'boots'],
};
```

Decisão de design explícita (não omissão): escudo/capacete/joia continuam existindo normalmente (loja, baú de campo, `CLASS_ITEM_TYPES`) mas não entram no drop Rare/Epic/Legendary nesta fase.

## Nível do item dropado — `gearLevelForMob(lvl)`

Fonte central, usa `GEAR_DATA.GEAR_LEVELS` (nunca duplica a lista): devolve a maior faixa que não ultrapassa o nível real do mob/boss. Ex.: mob Lv18 → gear Lv16; mob Lv23 → gear Lv20; boss Lv40 → gear Lv40.

**Níveis de boss auditados (todos os 7 mapas, campo e masmorra têm os mesmos níveis por zona):**

| Zona | Boss | Nível | Gear Lv resultante |
|---|---|---|---|
| Floresta | Goblin Brutamontes | 10 | 8 |
| Cripta | Capitão Esqueleto | 15 | 12 |
| Serra | Lobo Alfa | 20 | 20 |
| Pântano | Rei Lodoso | 25 | 24 |
| Torre | Feiticeiro Sombrio | 30 | 28 |
| Ilhas | Senhora das Tempestades | 35 | 32 |
| Vulcão | Senhor das Chamas (lorde) | 40 | 40 |

Progressão coerente e crescente ao longo do mapa (8→12→20→24→28→32→40) — nenhum boss produz uma recompensa fora da curva do mapa, então **nenhuma tabela de exceção por boss foi necessária**.

## Mob de campo

`mob_damage` (branch não-dungeon): quando `mob.hp<=0` é confirmado e `!mob.temp`, roda `rollGearDrop({mobLevel:mob.lvl, boss:!!mob.boss, cls:p.cls})` (mesma condição que já decidia se `loot` econômico rolava — sequitos temporários nunca dropam nada, comportamento preservado). `mob.boss` sempre vem do roster autoritativo do servidor (`MOB_MANIFEST` pro mapa real, nunca de `defs` que o cliente manda em `map_join`) — nunca confia num `boss:true` que o cliente possa ter mandado. O drop passa por `creditKillReward` (agora recebe um 8º parâmetro `drop` opcional), que aplica via `applyGearDrops`/`grantItem` dentro do mesmo `withCharLock` de sempre, e devolve `{drop, dropLost, bag, eq}` na mensagem `kill_reward` **só quando houve item de verdade** (a maioria dos abates não dropa nada — não vale mandar o inventário inteiro toda hora).

## Mob de campo — boss

Mesmo caminho acima, só que com `boss:true` — testa só Legendary (5%). Preserva **tudo** que o boss já concedia (XP, gold, gem, chave de baú via `BOSS_CHEST_FIELD`, avanço de quest) — o drop de equipamento é um adicional, nunca substitui nada.

## Trash de masmorra (`rollDungeonTrashLoot`)

O Basic garantido a 35% (compatibilidade temporária da Fase 5.2, documentada na época como algo a remover aqui) foi **removido por completo**. Agora chama `rollGearDrop({mobLevel:lvl, boss:false, cls, rng})` — mesma política de mob comum de campo. `gold`/`gem`/`pv` preservados exatamente como estavam.

## Boss de masmorra (`rollDungeonBossLoot`)

Os 3 equipamentos Basic garantidos (mesma compatibilidade temporária) foram **removidos**. Agora 1 único roll de Legendary a 5% (`rollGearDrop` com `boss:true`), usando `gearLevelForMob(bossLvl)` — antes o nível do item era fixo em `lv12` independente da zona; agora segue a progressão real do chefe daquela masmorra (mesma tabela da seção "Níveis de boss" acima, já que os bosses de masmorra têm o mesmo nível dos bosses de campo). `gold` (22 moedas), `gem` (6 fixo) e `pv` (1) preservados exatamente.

## Mochila cheia — item nunca desaparece silenciosamente

`applyGearDrops(save, lvl, items)` (novo, usado por `creditKillReward` e `creditDungeonReward`) chama `grantItem` pra cada item e nunca perde silenciosamente um Rare/Epic/Legendary: se a mochila estiver cheia (24 itens) e não puder auto-equipar, o item é descartado (nunca persistido, nunca duplicado, nunca sobrescreve outro slot) e o servidor manda `dropLost:{rarity,n}` na mensagem — o cliente mostra `"Mochila cheia — equipamento <Raridade> não foi coletado."`. Item dropado acima do nível do personagem nunca é auto-equipado (mesma checagem de sempre em `grantItem`): vai pra mochila se houver espaço.

## Feedback visual do drop

`kill_reward`/`dungeon_reward` ganham os campos opcionais `drop:{rarity,n}` (quando um item foi concedido) e `dropLost:{rarity,n}` (quando não coube). Cliente (`dropToastText`) monta: `"Item Raro obtido: <nome>"`, `"Item Épico obtido: <nome>"`, `"ITEM LENDÁRIO: <nome>"` (maiúsculo, mais chamativo — só pra Legendary). Cores/tint de raridade já existiam desde a Fase 5.1 (`RARITY_COLOR`: básico neutro, raro azul, épico roxo, lendário dourado) e não precisaram de nenhuma mudança — `rarityOf(it)` já lê `it.rarity` direto.

## UID e modelo canônico

Todo drop passa por `createGear(type, lv, rarity)` — nunca construído campo a campo. `enchant` sempre `0` (funcional só na Fase 5.4). `uid` sempre novo (`crypto.randomUUID()`), mesmo pra dois drops idênticos (mesmo tipo/nível/raridade) — testado explicitamente. Lendário de nível baixo não supera Básico de nível alto (princípio da Fase 5.1, `GEAR_DATA` não foi rebalanceado nesta fase).

## Venda por raridade (`sellPriceForItem`, `game-data/gear-data.js`)

```js
const SELL_RARITY_MUL = { basic: 1, rare: 2, epic: 4, legendary: 8 };
function sellPriceForItem(item) { return Math.round(sellPriceFor(item.lv) * SELL_RARITY_MUL[item.rarity]); }
```

Fonte central — `server.js` (`sell_item`) sempre chama `sellPriceForItem(it)`, nunca `sellPriceFor(it.lv)` sozinho pra um item que não seja garantidamente `basic`. Preço de **compra** Basic não mudou. Exemplo: Nv20 Basic vende por 320 ⇒ Rare 640, Epic 1280, Legendary 2560. `buyback` continua devolvendo exatamente o mesmo objeto vendido (mesmo uid/rarity/lv/enchant) — preço de recompra derivado do preço de venda × 1.5 (inalterado), agora automaticamente correto porque herda o preço já ajustado por raridade.

## `sell_common` — correção crítica

A venda em massa ("Vender itens comuns") detectava item "comum" por `lv === 1`. Depois da Fase 5.3 isso é um bug real de perda de item: um Rare/Epic/Legendary Nv1 (possível desde que virou possível dropar raridade alta em nível baixo) seria vendido em massa junto com o lixo de verdade. Corrigido pra `rarity === 'basic'` (de **qualquer** nível — a condição agora é sobre raridade, não sobre progressão) tanto no servidor (`handleShop` action `sell_common`) quanto no espelho client-side (`isLowestGear`, usado pra montar a lista/preview do botão "Vender itens comuns"). Coberto explicitamente em teste (Rare/Epic/Legendary Nv1 nunca entram; Basic de qualquer nível entra).

## Baú de campo — exceção documentada (não é bug)

Os 7 baús de campo (`CHEST_REWARDS`/`rollChestItem`) continuam entregando **Basic**, sem mudança nesta fase — comportamento legado preservado de propósito, não convertido em fonte de Lendário. A regra da fase é: Mercador = Basic normal; baú de campo = Basic legado preservado; mob comum = Rare/Epic; boss = Legendary.

## Tampering

`sanitizeItem` já aceitava as 4 raridades desde a Fase 5.1 (necessário pra recalcular stats de qualquer item legítimo) — a proteção real sempre foi `lockOwnedItems` no PUT genérico, que só deixa sobreviver um `uid` que já existia no save **persistido**. Isso já fechava (sem nenhuma mudança nesta fase) tentativas de: pedir Legendary direto, trocar `rarity` de um item já possuído, alterar `lv`/`enchant`/stats — testado explicitamente (item Basic comprado, `rarity` forjada pra `legendary` via PUT bruto, volta pra `basic`). `mob.boss`/`mob.lvl` nunca vêm do cliente (roster autoritativo, ver Fase 5.2) — só mob confirmado boss pelo servidor roda o roll de Legendary.

## Anti-farm / duplicação

O roll só acontece dentro do handler `mob_damage`, de forma síncrona, no exato momento em que `mob.hp` cruza de `>0` pra `<=0` (`mob.dead=true` setado antes de qualquer `await` — mesma garantia estrutural da Fase 5.2). Golpes extras num mob já morto retornam cedo (`if(!mob||mob.dead)return`) sem rolar de novo. Respawn (mapa de campo) inicia um ciclo de vida novo, com novo roll normal. Boss: 1 kill = no máximo 1 roll de Legendary (mesma trava dupla da Fase 5.2 — síncrona + `state.bossDefeated` pra masmorra).

## RNG

`Math.random()` pra probabilidade de gameplay (mesmo padrão já usado em todo o resto do loot do jogo). `crypto.randomUUID()` continua exclusivo pra UID. Nenhuma chance ou seed vinda do cliente jamais influencia o resultado.

## Offline

Preservado sem nenhuma mudança de comportamento. Mob de **campo** nunca dropou equipamento offline (antes ou depois desta fase — `dropItem` nunca era chamado no ramo não-masmorra de `killMob`, só coins/poção/gema) — permanece assim, não foi expandido. Masmorra **offline** (`!lootOnline()`) mantém a simulação local antiga (Basic garantido) — decisão deliberada de não tocar no fallback local só-visual, documentada aqui como assimetria intencional (online usa a política nova de raridade; offline preserva o comportamento legado, já que a fronteira online/offline da Fase 5.2 já impede que progresso offline seja injetado numa conta online).

## Testes adicionados

- `test/loot-rarity.test.js` (25 testes, sempre roda, sem Supabase) — `gearLevelForMob` (tabela completa + nunca fora de `GEAR_LEVELS`), `GEAR_DROP_RATES`/`DROP_TYPES_BY_CLASS` (valores exatos), `rollGearDrop` com RNG injetado (Epic/Rare/nada pra comum, nunca Legendary/Basic; Legendary/nada pra boss, nunca Rare/Epic/Basic; tipo sempre dentro da classe; modelo canônico completo — enchant 0, uid válido, stats/req/nome corretos; dois drops idênticos com UIDs diferentes; Legendário baixo não supera Básico alto), `applyGearDrops` (concedido, mochila cheia sem duplicar/perder outro item, item acima do nível vai pra mochila sem auto-equipar), `rollDungeonTrashLoot`/`rollDungeonBossLoot` (sem Basic garantido, no máximo 1 item, nível segue `gearLevelForMob`), `sellPriceForItem` (multiplicadores exatos, sempre inteiro).
- `test/rarity-shop.test.js` (4 testes, `{skip:!hasSupabase()}`) — venda por raridade (1x/2x/4x/8x reais via `handleShop`), `sell_common` nunca vende Rare/Epic/Legendary Nv1 (só Basic, de qualquer nível), `buyback` preserva uid/rarity/lv/enchant de um Epic vendido, tampering de `rarity` via PUT bruto não sobrevive.
- `test/dungeon.test.js` — teste antigo de `rollDungeonBossLoot` ("chefe sempre dá 3 itens") atualizado pra refletir a nova política (0 ou 1 item, sempre Legendary quando existe).
- `test/dungeon-integration.test.js` — asserção do teste de recompensa de chefe atualizada (não assume mais 3 itens Basic garantidos; confirma que, quando `drop` existe, é sempre `legendary`).

**Limitação honesta (igual às fases anteriores):** `test/rarity-shop.test.js` e os demais testes `{skip:!hasSupabase()}` não puderam ser executados neste ambiente (sem `SUPABASE_URL`/`SUPABASE_SECRET_KEY` locais, sem projeto de teste dedicado). Toda a lógica probabilística/determinística de raridade (a parte mais crítica desta fase) está coberta por `loot-rarity.test.js`, que roda sempre, com RNG controlado — não depende de sorte nem de rodar milhares de kills reais.

## O que NÃO entrou nesta fase (de propósito)

- **Enchant funcional** (+1..+10, chance de quebra) — Fase 5.4.
- **Ferreiro, World Boss, TvT, Guildas, Bestiário, Ranking, página pública, Phantom Players** — inalterados, fora do escopo.
- **Escudo/capacete/joia no drop especial** — decisão de design explícita desta fase, não esquecimento.

## Migração de banco

**Nenhuma migration nova foi necessária ou criada.** Toda raridade nova continua vivendo no mesmo `characters.save` (jsonb) — `sanitizeItem`/`createGear` já suportavam as 4 raridades desde a Fase 5.1, só nada as concedia ainda. As 5 migrations históricas em `supabase/migrations/` não foram tocadas.

## Próxima fase

Fase 5.4 — Ferreiro + Enchant (+0 até +10, chance de sucesso decrescente acima de +3, equipamento quebra em caso de falha). Fica pra quando for solicitada.

# FASE 5.4 — FERREIRO + ENCHANT

**Motivação:** desde a Fase 5.1 o modelo canônico do item já reservava um campo `enchant` (sempre `0`), preparado exatamente para esta fase. Agora ele passa a fazer alguma coisa de verdade: um NPC Ferreiro na Vila deixa o jogador arriscar melhorar um equipamento em até +10, com chance decrescente e risco real de perda acima de +3 — sempre decidido pelo servidor, nunca pelo cliente.

## NPC Ferreiro

Reaproveita o sistema de NPC já existente (`npcDefs`/`NPCS`/`openDialog`) — nada de framework paralelo. Adicionado à Vila em `x:25*T,y:12.9*T` (perto do Mercador, mesma área de comércio), sem sprite próprio (sem asset novo nesta fase): usa `spriteKey:'guarda'` pra reaproveitar o visual do NPC "Guarda Real" já carregado, mecanismo genérico adicionado ao `forEach` de `npcDefs` (`n.spriteKey||n.id`) que qualquer NPC futuro sem sprite dedicado também pode usar. Interagir abre uma janela própria (`#blacksmith`/`openBlacksmith`), não o sistema de diálogo de texto — mesmo padrão que o Mercador já usa pra `openShop`.

## Itens elegíveis

Só os 4 grupos do design: arma da classe (`sword`/`bow`/`staffd`/`staffm`), `armor`, `cape`, `boots` — `GEAR_DATA.ENCHANTABLE_TYPES` (fonte única, cliente e servidor leem a mesma lista). `shield`/`helmet`/`jewel` continuam funcionando normalmente em todo o resto do jogo, só não aparecem na lista do Ferreiro nem aceitam a ação `enchant_item` (rejeitados explicitamente, sem cobrar). Todas as 4 raridades (`basic/rare/epic/legendary`) podem ser encantadas — **enchant nunca altera `rarity`** (Epic +6 continua Epic), nem `lv`/`req`/`type`/`uid`/`n` (nome canônico persistido nunca muda; a UI mostra "+N Nome" só na exibição).

## Tabela de chance (`GEAR_DATA.ENCHANT_SUCCESS`)

```
+1..+3 = 100% ("safe enchant", nunca quebra)
+4 = 70%   +5 = 60%   +6 = 50%   +7 = 40%
+8 = 30%   +9 = 20%   +10 = 10%
```

Acima de +3, falhar **destrói o equipamento definitivamente** — sem downgrade, sem devolver pra +0, sem proteção, sem cópia substituta. O uid simplesmente deixa de existir. Nenhuma exceção foi implementada nesta fase (Enchant Scroll/Blessed Scroll/seguro ficam para o futuro, fora de escopo aqui).

## Custo (`GEAR_DATA.ENCHANT_COST_RATE` + `enchantCost`)

Sempre um percentual do **preço Basic** de compra (`GEAR_DATA.priceFor(type, lv)`) do mesmo type+lv — nunca multiplicado pela raridade real do item (Rare/Epic/Legendary pagam o mesmo custo de tentativa que um Basic equivalente, decisão explícita pra não punir duas vezes um item já raro). Alvo `+1..+10` → `5%/7%/10%/15%/20%/30%/40%/55%/75%/100%` do preço Basic, com piso de **25 ouro**. Cobrado **uma única vez por tentativa válida**, sucesso ou falha — só um pedido inválido (item não encontrado/não elegível/já +10/estado obsoleto) nunca cobra nada.

## Stats (não composto, sempre a partir do valor base original)

`GEAR_DATA.statsFor(type, lv, rarity, enchant)` — novo 4º parâmetro opcional (omitir = `0`, mesmo resultado de sempre: **regressão +0 garantida e testada explicitamente**). Fórmula: `stat = round(base × rarityMul × (1 + bônusPorTipo × enchant))`, sempre recalculada do `GEAR_STATS` base — nunca compõe sobre o stat atual do item entre tentativas (evita drift de arredondamento acumulado). `ENCHANT_BONUS` (fonte única):

- **Arma** (`sword/bow/staffd/staffm`): `+3% atk` por ponto (`+0=100%, +1=103%, +3=109%, +5=115%, +10=130%`).
- **Armadura/Capa**: `+2% def e hp` por ponto (`+10 = 120%`).
- **Botas**: `+2% def` por ponto — **`spd` propositalmente NÃO recebe bônus de enchant** (stat sensível demais; raridade continua podendo afetar `spd`, só enchant não).

## Fluxo server-authoritative (`enchant_item`)

Nova ação em `handleShop` (mesmo endpoint/mutex/sessão da loja — nenhuma rota paralela), dentro do mesmo `withCharLock(charId, ...)` que já serializa toda economia. Núcleo extraído como função pura testável, `attemptEnchant(save, uid, expectedEnchant, rng)` (mesmo padrão de `rollGearDrop`/`applyGearDrops` da Fase 5.3): localiza o uid em `bag` **ou** `eq`, valida elegibilidade/`+10`/estado esperado, cobra o custo, rola `rollEnchantSuccess(target, rng)` (`rng` injetável nos testes; produção usa `crypto.randomInt` via `secureRandom()` — nunca `Math.random`, porque a operação pode destruir equipamento valioso) e muta `save` diretamente. Sucesso: `applyEnchant(item, target)` reconstrói o item preservando `uid/type/lv/rarity/n` e recalculando stats — no mesmo slot (`eq`) ou substituindo o mesmo índice (`bag`). Falha (+4 ou mais): remove de `save.eq[slot]=null` ou `save.bag.splice(...)` — o uid nunca mais aparece em lugar nenhum do save.

## Proteção contra clique duplo/request obsoleta (`expectedEnchant`)

Toda tentativa manda `{uid, expectedEnchant}` — o servidor exige `expectedEnchant === item.enchant` (o valor **realmente persistido**, nunca o que o cliente supõe). A primeira requisição que executa dentro do `withCharLock` muda o enchant de verdade; qualquer segunda tentativa com o `expectedEnchant` antigo (duplo clique, requisição duplicada) recebe `STALE_ENCHANT_STATE` **sem cobrar nada** — testado com duas requisições literalmente concorrentes (`Promise.all`) confirmando que só uma executa. Cliente também tem uma guarda própria (`bsBusy`, desabilita o botão durante a viagem de ida e volta), mas a proteção real é essa validação server-side, não a UI.

## Proteção por UID

`attemptEnchant` só localiza o item pelo `uid` real dentro do `save` já carregado do banco (nunca aceita `type`/`lv`/`rarity` vindos do payload pra "montar" um item) — uid inexistente, uid de outro personagem, ou tipo/estado incompatível são sempre rejeitados antes de qualquer cobrança ou roll.

## Mutex

Reaproveita o `withCharLock` já existente desde a Fase 5.1/5.2 — nenhum lock novo, nenhuma fila paralela. `enchant_item` roda serializado com qualquer outra operação econômica do mesmo personagem (compra, venda, loot), do mesmo jeito que as outras ações de `handleShop` já rodavam.

## `sell_common` — proteção crítica contra vender item encantado sem querer

Desde a Fase 5.3, `sell_common` só vende `rarity === 'basic'`. Agora **também exige `enchant === 0`** — um Basic +8 é fruto de risco/gasto real no Ferreiro e nunca pode ser varrido junto com lixo comum sem confirmação explícita do jogador. Corrigido tanto no servidor (`handleShop`) quanto no espelho client-side (`isLowestGear`, usado pra montar a lista/preview do botão "Vender itens comuns"). `sellPriceForItem` continua **propositalmente não considerando `enchant`** no preço (só `lv`+`rarity`, herdado da Fase 5.3) — se encantar aumentasse o valor de venda, a tentativa viraria um mecanismo de gerar ouro adicional, o que não é a intenção do sistema.

## Buyback

Sem nenhuma mudança de código — `buyback` já devolvia exatamente o mesmo objeto vendido (mesmo `uid`) desde a Fase 5.1, então um item Epic +7 vendido volta Epic +7, mesmo uid, mesmo `lv`, testado explicitamente.

## Tampering / PUT genérico

`sanitizeItem` foi ajustado pra passar o `enchant` real pra `statsFor` **toda vez que o item passa por ele** (compra, leitura de save, equipar/desequipar, PUT) — sem isso, um item encantado "esqueceria" o bônus assim que o save fosse relido. A proteção contra **forjar** enchant já existia desde a Fase 5.1: `lockOwnedItems` sempre substitui um item pela cópia **canônica persistida no banco** quando o uid já era conhecido, nunca aceitando nenhum campo (incluindo `enchant`) que o payload do PUT tenta sobrescrever — confirmado com teste explícito (item real `enchant:0`, PUT manda `enchant:10`, continua `0` depois do reload).

## RNG

`Math.random()` client-side nunca influencia o resultado — produção usa `crypto.randomInt` (`secureRandom()`), a mesma família de RNG seguro já usada pro seed de masmorra (Fase 5.2). `rollEnchantSuccess`/`attemptEnchant` aceitam um `rng` injetável só pra teste determinístico (nunca exposto por nenhuma rota, nunca controlável pelo cliente).

## Auditoria de ATK (clampAtk)

Máximo teórico calculado nesta fase: arma Legendary Nv40 +10 → `round(42 × 1.35 × 1.30) = 74` de atk no item. Somado ao multiplicador de classe (`CLS.wm`, maior é Mago em `1.3`) → `round(74×1.3) = 96`, mais joia Basic Nv40 (`17`, joia não é enchantável nesta fase) → **113 de ATK máximo legítimo**. `clampAtk = 120` (Fase 5.2) já cobre esse valor com folga (7 de margem) — **nenhum ajuste foi necessário**. Cálculo documentado aqui em vez de simplesmente subir o teto sem justificativa.

## Limitações conhecidas (honestas, não escondidas)

- **HP/mitigação final do jogador ainda é parcialmente client-side** (limitação já documentada desde a Fase 5.2) — o bônus de enchant em `armor`/`cape`/`boots` funciona corretamente no `recalc()` existente (soma de `def`/`hp` dos itens equipados), mas a aplicação final do dano/mitigação continua não 100% server-derivada. Não foi objetivo desta fase reescrever combate.
- **Efeito visual do enchant é só CSS** (`filter:drop-shadow`, 3 faixas: `+4..+6` discreto, `+7..+9` mais forte, `+10` especial) aplicado ao ícone do item — sem sprite/asset novo, sem canvas extra, sem custo de FPS perceptível. Uma aura mais elaborada (partículas, animação no personagem) fica como melhoria futura, não implementada aqui de propósito (evitar reestruturação grande de renderização por uma fase que é sobre economia/servidor).
- **Ferreiro offline**: preservado sem mudança de comportamento — o offline nunca teve sistema de enchant antes, e esta fase não adicionou um fallback local pra ele (não fazia parte do escopo; a fronteira online/economia server-authoritative da Fase 5.2 já impede que qualquer progresso offline seja injetado numa conta online via PUT).

## Testes adicionados

- `test/enchant.test.js` (31 testes, sempre roda, sem Supabase) — tabela de chance exata, fronteiras de `rollEnchantSuccess` (`0.6999`→sucesso / `0.7000`→falha em +4, mesma lógica em +10), custo (fórmula + piso de 25), **regressão +0 explícita** (com e sem o 4º parâmetro), stats por tipo (arma/armadura/capa/botas, incluindo `spd` de botas nunca mudando), raridade+enchant combinados (Basic/Rare/Epic/Legendary +10), `applyEnchant` preservando uid/type/lv/rarity/req/n, e o fluxo completo de `attemptEnchant` contra saves simulados: safe enchant sequencial, quebra forçada (+4, +5, +9→+10), MAX_ENCHANT, ouro insuficiente, `STALE_ENCHANT_STATE`, item equipado vs. mochila, tipo não permitido, uid forjado, anti-duplicação.
- `test/blacksmith.test.js` (12 testes, `{skip:!hasSupabase()}`) — fluxo real via HTTP (`handleShop` de verdade): `+1` e sequência `+1→+2→+3` sempre bem-sucedidos (únicos alvos deterministicamente testáveis contra o RNG seguro real, que não é injetável pelo cliente por design), item equipado, tipos não elegíveis, uid inexistente/de outra conta, ouro insuficiente, `MAX_ENCHANT`, `STALE_ENCHANT_STATE`, **duas requisições concorrentes reais** (`Promise.all`) confirmando que só uma executa, tampering via PUT bruto, `buyback` preservando enchant, `sell_common` nunca vendendo item encantado.
- `test/portal.test.js` — `ctx` do teste isolado de `winSig()` atualizado com `bsOpen`/`bsSel` (novas variáveis que a função passou a referenciar).

**Limitação honesta (igual às fases anteriores):** os alvos `+4` a `+10` (a parte probabilística real) só têm cobertura determinística via `test/enchant.test.js`, com RNG injetado — não existe teste HTTP forçando uma quebra real, porque o RNG de produção é propositalmente `crypto.randomInt` server-only, não injetável pelo cliente (a instrução desta fase é explícita: nenhum "código pra forçar enchant em produção", nenhum "debug RNG"). `test/blacksmith.test.js` não pôde ser executado neste ambiente (sem `SUPABASE_URL`/`SUPABASE_SECRET_KEY` locais, sem projeto de teste dedicado) — mesma lacuna documentada desde a Fase 5.2.

## O que NÃO entrou nesta fase (de propósito)

- **Enchant Scroll / Blessed Scroll / Protected Scroll / proteção contra quebra / downgrade em falha** — Ferreiro usa só ouro nesta fase; scrolls especiais ficam pro futuro.
- **World Boss, Event Manager, Team vs Team, Guildas, Bestiário, Ranking, página pública, Phantom Players** — inalterados, fora do escopo.

## Migração de banco

**Nenhuma migration nova foi necessária ou criada.** `enchant` já vivia no objeto do item dentro de `characters.save` (jsonb) desde a Fase 5.1 — esta fase só passou a usá-lo de verdade. As 5 migrations históricas em `supabase/migrations/` não foram tocadas.

# FASE 5.5 — EVENT MANAGER

## Objetivo e fronteira

A infraestrutura de eventos agora é server-authoritative e vive em memória, sem criar World Boss ou Team vs Team jogáveis. O `EventManager` não importa nem altera mapas, monstros, PvP, Party, recompensas ou `characters.save`. Ele gerencia somente agenda, lifecycle, inscrições, anúncios e sincronização pública. Não foi criada migration nem tabela de eventos.

## Fonte única e timezone

`game-data/event-manager.js` concentra `EVENT_CONFIG`: timezone oficial `America/Sao_Paulo`, intervalo de 2 horas, antecedência de inscrição de 15 minutos, anúncios em 15/5/1 minutos e metadados dos tipos. `world_boss` tem `registrationMode: party4`; `team_vs_team`, `registrationMode: individual`. Ambos permanecem `playable: false` até as Fases 5.6 e 5.7.

A matemática usa `Intl.DateTimeFormat` com timezone IANA, nunca o relógio local do host Render. Os slots são 00/04/08/12/16/20 para World Boss e 02/06/10/14/18/22 para Team vs Team. `nextEventAfter` e `scheduleAfter` atravessam meia-noite sem produzir 24:00. A ocorrência tem ID determinístico `<tipo>:<timestamp-do-slot>`.

## Lifecycle, restart e cleanup

Estados públicos: `upcoming`, `registration`, `active`, `ended`, `cancelled` e `unavailable`. A fase é sempre derivada de timestamps absolutos (`startAt - now`), não de contador acumulado. Assim, uma nova instância criada durante a janela reconstrói o mesmo ID e estado. Sem handler jogável, um slot iniciado fica `unavailable`; o servidor nunca inventa evento ativo.

`EventManager.registerEventHandler(type, handler)` é o ponto de extensão para gameplay futuro. Um handler pode declarar duração e callbacks `onStart`/`onEnd`, sem reescrever scheduler. `cancel(eventId)` limpa inscrições e registra a transição. Estado de inscrições/anúncios/transições com mais de quatro horas é removido por `cleanup`, evitando Maps sem limite.

Inscrições ficam em `Map<eventId, Map<charId, registration>>`. Só usam `p.userId`/`p.charId` autenticados pelo join WebSocket; campos de identidade enviados pelo cliente são ignorados. Registro repetido é idempotente. Restart pode limpar inscrições em memória, limitação aceita enquanto a janela é curta e não há evento jogável.

## Anúncios e feature gating

Para handlers futuros habilitados, o tick de 1 segundo suporta anúncios globais em 15, 5 e 1 minuto, com um `Set` por ocorrência para disparar cada marco exatamente uma vez. O timer usa `.unref()` e não escreve log a cada segundo. Logs concisos existem apenas para `event_registration_open`, `event_start`, `event_end` e `event_cancelled`.

World Boss e TvT atuais não têm handler e continuam `playable:false`: não anunciam início, não aceitam inscrição, não teleportam, não criam mapa/monstro/time e não concedem ouro, gema, XP ou item.

## HTTP, WebSocket e cliente

`GET /api/events/status` devolve apenas `serverNow`, timezone, evento atual/próximo e seis slots públicos, sem participantes. Após todo `join`, inclusive F5/reconnect, o servidor envia `event_state`. O protocolo também suporta `event_status`, `event_register`, `event_unregister`, `event_registration` e `event_announcement`.

O cliente mantém uma única estrutura `EVENT_STATE` e calcula `EVENT_CLOCK_OFFSET = serverNow - Date.now()`. O countdown usa o `startAt` absoluto recebido; o cliente não calcula tipo nem agenda. O botão **EVENTOS** abre painel leve com próximo evento, horário de Brasília, countdown e seis slots. Enquanto `playable:false`, aparece **EM BREVE** e nenhum pedido de inscrição é enviado. Anúncios futuros usam toast e chat de sistema, sem modal bloqueante.

## Testes e limitações

`test/event-manager.test.js` cobre os 12 slots, alternância, meia-noite, ID estável, bordas 19:44:59/19:45/19:59:59/20:00, restart simulado, deduplicação 15/5/1 com centenas de ticks, feature gating, autenticação/idempotência/unregister fora e dentro da janela, cleanup e privacidade do snapshot. `test/event-ws.test.js` cobre status HTTP, `event_state` no join e rejeição de inscrição anônima; cenários autenticados permanecem condicionados ao ambiente Supabase de teste.

Limitações intencionais: inscrições somem em restart; não há histórico; não há persistência; não há handler jogável; não há teleporte nem recompensa. A Fase 5.6 registrará o handler de World Boss e aplicará a regra de party exatamente 4. A Fase 5.7 registrará o handler de Team vs Team e implementará equipes, mapa, placar, respawn e resultado.

## Próxima fase

Fase 5.6 — World Boss, conectado ao EventManager da Fase 5.5 sem reescrever agenda, countdown, anúncios ou inscrições.

# FASE 5.6 — WORLD BOSS

## Agenda, inscrição e Party

O World Boss agora é o único evento jogável: continua nos horários oficiais 00:00, 04:00, 08:00, 12:00, 16:00 e 20:00 de `America/Sao_Paulo`, com inscrição nos 15 minutos anteriores e anúncios em 15/5/1 minuto. O Team vs Team permanece `playable:false` e **Em breve**.

Somente o líder pode inscrever uma Party real com exatamente quatro membros. O servidor deriva a composição por `memberParty`/`parties`, encontra o personagem autenticado ativo de cada conta, rejeita seleção ambígua, anônimo, membro offline, char duplicado e mochila sem capacidade segura. A inscrição cria um snapshot imutável de `partyCode`, dono, evento e quatro identidades server-side; pedido repetido é idempotente e o cancelamento do líder remove e atualiza os quatro membros.

## Instâncias e Arena do Titã

No início, o servidor revalida os quatro membros e recarrega cada personagem do Supabase. Cada grupo válido recebe uma `WorldBossInstance` independente, com mapa curto `wb#<evento>#<party>`, boss e HP próprios, posições anteriores, contribuição e estado de recompensa. `WORLD_BOSS_MAP_RE` permite somente esse formato e uma mensagem `state` não permite entrar na arena de outro grupo.

A Arena do Titã é fechada, ampla, usa apenas tiles originais e nasce no cliente a partir do teleporte server-driven. O **Titã Ancestral** usa o tipo exclusivo `ancient_titan`; provisoriamente reutiliza o sprite original do Senhor das Chamas em escala 2,15x, mantendo identidade lógica, hitbox e HUD próprios.

## Snapshot, DPS, HP e TTK

`combatSnapshot` deriva classe, nível, skills, ataque, defesa, HP, block e equipamento canônico, incluindo rarity e enchant. O mesmo snapshot congelado calibra e executa a luta: trocar equipamento depois não reduz HP para então atacar com atributos maiores.

`estimateWorldBossDps` soma ataque básico e skills ofensivas legítimas pelos cooldowns reais. `calculateWorldBossHp` usa o DPS de referência total da Party multiplicado por 300 segundos, com limites finitos e positivos. Portanto o TTK determinístico de referência é 300s (5 minutos), dentro da meta de 270–330s; o timeout máximo continua separado, em 10 minutos.

## Combate autoritativo e IA

Ataques contra o Titã passam por `resolveWorldBossDamage`: o servidor valida participante, vida, distância, classe, skill e cooldown, e calcula o dano pelo snapshot. `msg.atk`, HP do boss e contribuição enviados pelo navegador nunca são autoridade. Anti-spam e range são mantidos, e HP/maxHP do boss só mudam no runtime do servidor.

A IA server-side seleciona apenas participantes vivos e presentes na mesma instância. Ela alterna **Golpe do Titã** (normal), **Impacto Ancestral** (pesado) e **Onda Sísmica** (AoE), com wind-up/telegraph e alcance próprios. Defesa e block vêm do snapshot real; cada hit recebe teto final de 35% do maxHP, impedindo one-shot. O cliente só desenha o boss, telegraphs, barra e estados recebidos.

## HP do jogador, morte, disconnect e reconnect

Dentro da arena, HP, maxHP, defesa, block, morte e respawn são específicos e autoritativos no servidor. Morrer não remove XP, ouro, item ou enchant. O personagem reaparece após 10 segundos na entrada, com HP cheio; quatro mortos não resetam boss nem relógio.

Disconnect apenas marca o participante offline e preserva instância/HP. Reconnect autenticado com a mesma conta e charId recupera a mesma arena, posição, Party e boss sem criar uma nova instância. Durante a luta o cliente não salva coordenadas da arena no save normal. Ao término, retorna à localização anterior validada, ou à Vila Inicial como fallback seguro.

## Contribuição, timeout e recompensas

`damageByChar` contabiliza somente dano realmente aplicado pelo servidor. É elegível quem causou ao menos 1% do maxHP; o valor interno de contribuição não é exposto ao cliente. Se o Titã sobreviver 10 minutos, a instância termina sem Legendary e todos retornam.

Na vitória, cada elegível recebe uma vez 360 ouro, 18 gemas e 18.000 XP. Exatamente um elegível com capacidade recebe um equipamento `legendary`, `enchant:0`, UID novo, tipo compatível com a classe e nível canônico. O sorteio e a criação são server-side. `rewardGranted` bloqueia repetição na instância; `save.wbRewards`, limitado aos 12 IDs recentes, é sanitizado, protegido pelo lock econômico e persistido sob `withCharLock`, impedindo retry/reconnect e PUT genérico de duplicarem a recompensa.

## Cleanup, testes e limitações

Fim por derrota ou timeout remove arena, boss e índices runtime. Nenhuma migration foi criada: o pequeno histórico vive em `characters.save` JSONB. A lógica pura cobre Party, snapshot, DPS/TTK, isolamento, dano forjado, skills/cooldown, três ataques, teto defensivo, morte/respawn, disconnect, morte única, contribuição, sorteio e privacidade. A suíte inteira também preserva autenticação, personagens, shop, itens, raridade, enchant, dungeon, quests, portais, mobs, PvP, Party e EventManager.

Limitação conhecida: instâncias e inscrições são memória local. Um restart do processo durante a luta perde a instância; saves permanecem válidos e o próximo carregamento cai em mapa persistente seguro. A marca persistida reduz duplicação de recompensa, mas uma interrupção externa exatamente entre efeitos separados continua sujeita às garantias transacionais disponíveis no JSONB/Supabase atual. Não foi criada arquitetura distribuída nesta fase.

## Próxima fase

Fase 5.7 — Team vs Team, usando o mesmo EventManager. Não iniciada nesta entrega.

# FASE 5.7 — TEAM VS TEAM

## Agenda e EventManager

Reaproveita 100% o `EventManager` da Fase 5.5 (`game-data/event-manager.js`) — nenhum scheduler, calendário, countdown ou sistema de anúncio novo. `EVENT_CONFIG.types.team_vs_team.playable` vira `true` (única mudança de configuração); os horários oficiais continuam 02:00/06:00/10:00/14:00/18:00/22:00 (`America/Sao_Paulo`), inscrição 15min antes, anúncios 15/5/1min — exatamente como já valiam desde a Fase 5.5, só agora com um handler de verdade plugado via `eventManager.registerEventHandler('team_vs_team', {durationMs, onStart, onEnd})`. World Boss (00/04/08/12/16/20h) continua inalterado.

## Lógica pura: `game-data/tvt.js`

Novo módulo, mesmo espírito de `game-data/world-boss.js` (Fase 5.6): sem HTTP/WS/Supabase, testável isoladamente. **Reaproveita o World Boss em vez de duplicar** — `require('./world-boss.js')` pra `combatSnapshot` (deriva classe/nível/skills/atk/def/maxHp/block do equipamento canônico real, incluindo rarity/enchant, exatamente igual ao World Boss) e `CLASS_BASE`/`BASIC_CD_MS`/`CLASS_SKILLS`/`DAMAGE_SKILLS`. `world-boss.js` **não foi modificado** — zero risco de regressão, confirmado pela suíte de `test/world-boss.test.js` inteira continuando verde. O que o World Boss nunca precisou (heal em aliado, buffs/debuffs com timestamp, times, placar, respawn) é implementado do zero em `tvt.js`, auditado contra o comportamento real de cada skill no cliente (`index.html`: `SKILL_FX`, `healAmt`, `barrierAmt`) antes de portar.

## Configuração

Máximo 8 jogadores, mínimo 4, formatos 2v2/3v3/4v4, partida de 10 minutos. Inscrição **individual** (`registrationMode:'individual'`, já preparado desde a Fase 5.5) — Party do jogador nunca decide time; o matchmaking é sempre independente da Party real.

## Inscrição, reserva e cancelamento

Igual a qualquer evento individual do EventManager (`eventManager.register`/`unregister`), com um teto de 8 específico do TvT que o EventManager genérico não conhece (`tvtRegistrationFull`, checado em `server.js` antes de chamar `register`, devolve `"Team vs Team lotado."` sem criar nada). No início (`startTvtEvent`), os inscritos são ordenados por `registeredAt` (ordem de chegada, nunca sorteio):

- **0 a 3 inscritos**: partida cancelada (`tvt_cancelled`, `"Team vs Team cancelado: mínimo de 4 jogadores."`), nenhuma recompensa.
- **5 ou 7 inscritos**: o(s) último(s) por `registeredAt` vira(m) **reserva** (`tvt_reserve`, `"Você ficou como reserva nesta rodada."`) — nunca teleportado, nunca recebe recompensa de participante. 5→4 jogam+1 reserva; 7→6 jogam+1 reserva.
- **4, 6 ou 8 inscritos**: todos jogam (par exato).

## Snapshot server-side

No início, cada personagem é **recarregado do Supabase** (`loadTvtCharacter`, mesmo padrão de `loadWorldBossCharacter`) — nunca confia no que já estava em memória. `combatSnapshot` (reaproveitado do World Boss) congela classe/nível/skills/atk/def/maxHp/block a partir do equipamento canônico real (`save.eq`, com rarity/enchant já aplicados pelas Fases 5.1/5.3/5.4). Trocar de equipamento depois de inscrito não afeta a luta já calibrada.

## PowerScore (só matchmaking — nunca dano, nunca HP)

`powerScore(snapshot, eq)` combina nível×10 + atk×2.2 + def×3 + maxHp×0.35 + block×400 + soma dos ranks de skill×8, multiplicado por um fator de qualidade de equipamento (`gearQualityFactor`) que pesa rarity (`basic 1.0 / rare 1.15 / epic 1.3 / legendary 1.5`) e enchant (+2%/ponto) **além** do que já está embutido em atk/def/maxHp — testado explicitamente que nível sozinho não determina o score, e que powerScore nunca é igual a dano nem a HP.

## Balanceamento — enumeração exata, não greedy

`balanceTvtTeams(players)`: pra até 8 jogadores (metade = até 4), enumera **todas** as combinações de metade dos índices (`combinationsContainingFirst`, evita contar o par complementar duas vezes) e escolhe a divisão com menor diferença absoluta de powerScore total; empates são desempatados por uma penalidade pequena de composição de classe (`classComposePenalty`, só pesa quando a diferença de uma classe é ≥2, ex. 3 Druidas vs 0) — powerScore sempre domina, composição nunca sacrifica o equilíbrio real por causa da classe. Determinístico: mesma entrada sempre produz a mesma divisão.

## Times: Rubra e Azul

IDs internos `red`/`blue`, labels `Equipe Rubra`/`Equipe Azul` — decididos inteiramente pelo servidor (`balanceTvtTeams` + `createTvtInstance`), nunca pelo cliente. Times são **imutáveis** durante toda a partida (reconexão volta pro mesmo time, nunca troca).

## `TvTInstance` e Arena

`createTvtInstance({eventId, members, now})` gera `mapId` no formato `tvt#<hash-curto-do-eventId>` (mesmo padrão de derivação de `worldBossMapId`), com `players` (Map charId→estado de combate), `score:{red,blue}`, `scoreLimit` (derivado do tamanho do time), `startedAt`/`expiresAt`, `previousLocations`, `finished`/`rewardsGranted`/`state`. `TVT_MAP_RE` (`^tvt#[0-9a-z]{6,10}$`) é explícita e restrita — `isAllowedMap` a soma às regras já existentes (campo, masmorra, World Boss) sem afrouxar `ALLOWED_MAP` genericamente.

A Arena TvT é fechada, simétrica e aberta (`buildTvtArena`, mesmo padrão de construção da Arena do Titã: `newWorld`+`netMap`+blocos de limite, mesmo tema de chão já usado — sem asset novo). Spawn Rubra a oeste (`x:350,y:700`), Azul a leste (`x:1850,y:700`) — mais de 1500px de distância, muito acima do maior alcance de ataque real do jogo (~550px), evitando spawn kill.

## Entrada: teleporte 100% server-driven

`startTvtEvent` salva `previousMap`/`previousX`/`previousY` de cada participante (`instance.previousLocations`), então move `p.map`/`p.x`/`p.y` no servidor e manda `tvt_enter` (spawn, time, `scoreLimit`, `expiresAt`) — o cliente nunca clica um portal, nunca escolhe `map:"tvt#..."` por conta própria.

## Anti-teleport

Mesma proteção do World Boss/masmorra: `TVT_MAP_RE.test(map)` numa mensagem `state` só é aceito se `tvtByChar.get(p.charId)===map` **e** `map===p.map` — só quem realmente pertence àquela instância pode reportar posição nela.

## Combate autoritativo: `resolveTvtIntent`

Dentro do TvT, dano nunca é parcialmente client-side (diferente do PvP normal de campo, que ainda deixa o alvo aplicar a própria mitigação). `TVT.resolveTvtIntent(instance, attackerCharId, {skill, targetId}, now, rng)` decide tudo: existe? vivo? time? alcance (≤550px)? cooldown? alvo válido pro tipo de skill? Calcula dano a partir do **snapshot real** (nunca de `msg.atk`), aplica mitigação (def do alvo + bônus de warcry + absorção de barreira + chance de bloqueio real), atualiza HP, detecta morte, credita kill/death/score. Testado explicitamente: `msg.atk=999999` não muda o dano; `msg.team`/`msg.score`/`msg.hp` não existem como parâmetros lidos por `resolveTvtIntent` — não têm como influenciar nada.

No servidor, reaproveita o mesmo caminho de mensagem que o PvP de campo já usa pra "o golpe realmente acertou" (`player_damage`) — só que, dentro de uma instância TvT, o handler intercepta **antes** da lógica de PvP normal e delega inteiramente pra `resolveTvtIntent` (nunca cai no cálculo client-side de mitigação). Buffs/heal sem alvo de dano (`warcry`/`barrier`/`evade`/`heal`) continuam vindo por `cast_skill`, que ganhou um campo opcional `targetId` (usado só por `heal`).

## Friendly fire, self-hit, range

`target.team === attacker.team` → `FRIENDLY_FIRE`. `targetId === attackerCharId` → `INVALID_TARGET`. Distância > 550px → `OUT_OF_RANGE` (cobre até o spawn-kill: os dois spawns nascem fora desse alcance). Todos testados explicitamente, inclusive com `targetId` forjado tentando contornar.

## Cooldowns

Server-side, por instância (`member.skillCd`/`member.lastAttackAt`, nunca o cooldown global do mapa de campo) — básico e as 12 skills reais das 4 classes, mesmos valores de `SKILL_CD_MS` já usados em todo o resto do jogo (`spin:5000, dash:4000, warcry:18000, heal:7000, roots:9000, thorns:10000, fireball:4000, frost:7000, barrier:16000, multi:4000, evade:5000, pierce:8000`, replicados em `TVT_SKILL_CD_MS` porque `game-data/*.js` não importa `server.js`, mesmo padrão que `world-boss.js` já usa pra suas próprias constantes). Spam de básico ou de skill é rejeitado com `COOLDOWN`.

## Skills por classe (auditadas contra `index.html` antes de portar)

- **Guerreiro**: `spin`/`dash` (dano, mesmos multiplicadores de sempre) e `warcry` (buff self: `+30%+10%×(rank-1)` de dano, `+4+2×(rank-1)` de defesa, `6+2×(rank-1)` segundos — fórmula exata de `SKILL_FX.warcry` no cliente).
- **Druida**: `heal` (cura **aliado válido**, nunca inimigo, nunca ultrapassa `maxHp`, fórmula real `45+5×lvl+18×(rank-1)` de `healAmt`), `roots` (dano + `rootUntil` no alvo, `2+.5×(rank-1)`s), `thorns` (dano + `thornsUntil` no alvo, adaptação single-target da zona de área original — ver limitação abaixo).
- **Mago**: `fireball`/`frost` (dano; `frost` também aplica `slowUntil`, `3+(rank-1)`s) e `barrier` (buff self: absorve `40+6×lvl+20×(rank-1)` de dano por 8s, fórmula real de `barrierAmt`).
- **Arqueiro**: `multi`/`pierce` (dano) e `evade` (buff self: `evadeUntil` por 500ms, imunidade total a dano durante a janela).

Skill de outra classe é sempre `INVALID_SKILL`, testado nas 4 classes.

## Status effects (timestamps server-side)

`rootUntil`, `slowUntil`, `barrierUntil`+`barrierAmt`, `evadeUntil`, `warcryUntil`+`warcryAtkMul`+`warcryDefBonus`, `thornsUntil`+`thornsMul`+`thornsOwner` — todos em `member.statuses`, todos com `Date.now()` real, nunca timer do cliente. `tickTvtStatusExpiry` (chamado a cada 1s, junto do tick já existente) zera cada campo assim que `now>=Until`. `thorns` tem um tick próprio (`tickTvtThorns`, dano periódico a cada 600ms enquanto ativo, adaptação single-target — ver limitação).

## HP, morte, kill/death, score

`hp`/`maxHp`/`dead`/`respawnAt` são exclusivos da instância (`member`), nunca o `P.hp` do mapa de campo. Morte é confirmada **de forma síncrona** dentro de `resolveTvtIntent` (mesma garantia estrutural das Fases 5.2/5.6: nenhum `await` entre o hit que zera o HP e a marcação `dead=true`) — hits extras num alvo já morto retornam `TARGET_UNAVAILABLE` sem pontuar de novo, testado explicitamente. 1 morte = 1 ponto pro time do killer, sempre. **Morrer no TvT nunca tira XP, ouro, gema, item, rarity ou enchant** — só afeta o placar da partida.

## Respawn e proteção de spawn

5 segundos (`TVT_RESPAWN_MS`) pra voltar com HP cheio no spawn do próprio time (`tickTvtRespawns`, mesmo padrão de tick do World Boss). Depois do respawn, 3 segundos de proteção (`TVT_SPAWN_PROTECTION_MS`, `protectedUntil`) durante os quais o jogador **não pode receber dano** (`blocked:'protection'` no resultado, dano zero) — se o próprio protegido atacar antes disso, a proteção termina imediatamente (`clearProtectionOnAction`), testado.

## Placar e fim de partida

`scoreLimitForTeamSize(size)`: 2v2→10, 3v3→15, 4v4→20 (função pura, testada nos 3 tamanhos). Fim por placar (`checkTvtEnd` detecta o time no limite, fim imediato, hits depois disso não são mais aceitos porque `instance.state` já não é `'active'`) **ou** por tempo (10 minutos, `expiresAt`) — no timeout, maior placar vence; empate exato vira `draw` (`winner:null`), sem overtime nesta fase. `eventManager`'s próprio `onEnd` (disparado por `event.startAt+durationMs`) é só uma rede de segurança redundante — `tickTvt` a cada 1s já fecha a partida sozinho assim que detecta o fim; ambos os caminhos são idempotentes (`finishTvtInstance`/`grantTvtRewards` têm guardas de estado), nunca duplicam nada mesmo se os dois disparassem.

## Disconnect e reconnect

Desconectar **nunca** termina a partida nem pontua morte — só marca `online:false` (mesma regra do World Boss). O personagem continua pertencendo à instância. Reconectar com o mesmo `userId`+`charId` durante a partida ativa recupera automaticamente a mesma arena, time, HP e placar (`handleWsJoin`, mesmo padrão do World Boss) — nunca cria instância nova, nunca troca de time.

## Anti-AFK e elegibilidade de recompensa

`lastActivityAt` atualiza só em ação legítima que passou pela validação real (`resolveTvtIntent` atualiza em qualquer intent aceito — ataque, skill, heal). `isTvtEligible(member, instance, now)`: elegível se `tvtContributionScore >= 30` (dano + cura×1.5 + kills-legítimos×50 — **cura conta**, então Druida puro-suporte nunca é penalizado por não ter abates) **ou** se esteve ativo nos últimos 90 segundos mesmo com contribuição baixa (cobre quem entrou tarde ou teve pouca oportunidade de agir). Reserva nunca é elegível (nunca entra na instância). Quem nunca contribuiu e ficou inativo além da janela perde a recompensa daquela partida.

## Anti-feed (documentado, afeta só elegibilidade — nunca bane)

Detecção leve e explícita: uma morte é marcada como possivelmente "farmada" quando a vítima nunca agiu desde seu último respawn/entrada (`lastActivityAt <= respawnGrantedAt`) **e** morreu dentro de uma janela curta após a proteção de spawn acabar (`TVT_SPAWN_PROTECTION_MS + 1500ms`). Nesse caso, o dano da morte continua contando normalmente (não é "gameplay ilegítimo"), mas o **bônus de kill** (`legitKills`, usado só na contribuição pra recompensa) não é creditado ao atacante por aquela morte específica — critério pequeno, testável, documentado, sem banimento automático nem alteração do placar real da partida.

## Recompensas — proposta inicial, derivação documentada

```
Vencedor: 120 gold, 6 gem, 6000 XP
Perdedor:  60 gold, 3 gem, 3000 XP
Empate:    90 gold, 4 gem, 4500 XP
```

**Sem Legendary** (World Boss continua sendo a fonte mais forte de Legendary, de propósito). Comparação feita antes de congelar: World Boss paga 360 gold/18 gem/18000 XP por uma luta calibrada pra ~5min (TTK de 300s) de Party coordenada de 4 — em taxa por minuto, TvT vencedor fica bem abaixo (~1/6) do World Boss, coerente com ser solo/individual, sem pré-requisito de grupo e mais fácil de repetir. Contra quests de nível alto (`QUEST_REWARDS`, até 1000 gold/2500 XP **uma única vez**), o TvT paga menos por partida mas é repetível 6×/dia. Contra loot de chefe de masmorra (~22 moedas de 1-9, ~100-130 gold médio), o prêmio de vitória do TvT fica na mesma faixa — parâmetro razoável pra uma partida competitiva de até 10 minutos. Números tratados como proposta inicial, ajustáveis com telemetria real de produção depois, exatamente como já foi feito com os preços de equipamento na Fase 5.1.

## `tvtRewards` — idempotência e proteção

Mesmo mecanismo de `wbRewards` (Fase 5.6): `save.tvtRewards` (array de `eventId`, sanitizado, limitado aos últimos 12) entra em `ECONOMY_LOCK_FIELDS` — o PUT genérico nunca consegue remover, forjar ou reabrir esse histórico pra repetir uma recompensa. `grantTvtRewards` roda inteiro dentro de `withCharLock(charId, ...)`, recarrega o personagem real do Supabase, confere `save.tvtRewards.includes(instance.eventId)` antes de conceder — cada participante elegível recebe a recompensa da partida **uma única vez**, mesmo com reconexão ou retry.

## Cleanup

Ao terminar (`finishTvtInstance`): retorna cada jogador pra `previousLocations` validada (nunca aceita um mapa de instância como destino — `isAllowedMap(prev.map)&&!WORLD_BOSS_MAP_RE.test&&!TVT_MAP_RE.test`) com fallback pra Vila Inicial; remove o `mapId` de `maps`; remove a instância de `tvtInstances`; remove cada `charId` de `tvtByChar`. Nenhum `Map` cresce sem limite.

## Limitações conhecidas (honestas, não escondidas)

- **Simplificação single-target**: no jogo normal, `spin`/`frost`/`roots`/`thorns` atingem todos os inimigos num raio (AoE). No TvT, todo skill (mesmo os originalmente AoE) age sobre **um** alvo declarado (`targetId`) — decisão deliberada: o protocolo de intenção do TvT já é baseado em alvo explícito, e resolver múltiplos alvos simultâneos com a mesma garantia de anti-forjamento aumentaria muito o escopo sem mudar nenhuma garantia de autoridade pedida nesta fase. `thorns` (zona de dano no chão no jogo normal) vira um DoT no alvo marcado (`thornsUntil`+tick), não uma área persistente no espaço.
- **Heal só em si mesmo nesta interface**: o servidor (`resolveTvtIntent`) já suporta e testa cura em qualquer aliado válido via `targetId`, mas a interface desta fase só expõe auto-cura (mesma UX que o heal já tinha no resto do jogo) — mirar um aliado específico fica como melhoria futura de UI, não uma limitação de autoridade do servidor.
- **Instância em memória**: igual ao World Boss, um restart do processo Render durante uma partida ativa perde a instância (sem recompensa concedida, sem penalidade persistida) — saves continuam válidos, próximo carregamento cai em mapa seguro. Nenhuma arquitetura distribuída foi criada nesta fase.
- **Sem overtime**: empate exato ao fim do tempo é sempre `draw`, nunca prorrogação.
- **Uma partida principal por vez**: esta primeira versão cria uma única `TvTInstance` de até 8 jogadores por ocorrência do evento — não há múltiplas arenas simultâneas de 8. A arquitetura (instância isolada por `mapId`) permite expansão futura, mas isso não foi implementado agora, de propósito (simplifica matchmaking e recompensa).
- **Testes de fluxo completo via WS real**: registrar 8 contas e observar a partida inteira via WebSocket real dependeria da janela de inscrição real estar aberta no momento exato em que a suíte roda (sem hook de tempo injetável no processo do servidor) — mesma lacuna já aceita pela Fase 5.5/5.6 pra World Boss. A cobertura funcional real está inteira em `test/tvt.test.js` (RNG e relógio sempre injetados, determinístico).

## Testes adicionados

- `test/tvt.test.js` (51 testes, sempre roda, sem Supabase): config (min/max/duração/respawn/proteção/`TVT_MAP_RE`), powerScore (nunca só nível, rarity/enchant pesam, nunca é dano/HP), balanceamento (times iguais, todos aparecem uma vez, diferença mínima de powerScore não-greedy, composição de classe só desempata, determinístico), instância (mapId, spawns opostos e afastados, HP inicial), combate (dano forjado ignorado, friendly fire, self-hit, range, cooldown básico/skill, `msg.team`/`score`/`hp` sem efeito), as 4 classes e suas 12 skills reais, heal (aliado válido, nunca inimigo, nunca ultrapassa maxHp, alvo inválido rejeitado, só Druida), status (expiração de todos os 6 campos, evasão nega dano, barreira absorve parcial), morte (1 kill/1 death/1 ponto, hit extra não duplica), respawn (5s, HP cheio, spawn do time), proteção (3s, atacar encerra), fim de partida (score, tempo, empate, não reabre), elegibilidade/anti-AFK (dano ou cura contam, ativo recente conta, AFK total não conta), recompensas (win/loss/draw com valores corretos, nunca Legendary), `publicTvtState` (nunca vaza `userId`).
- `test/tvt-ws.test.js` (2 testes, 1 sempre roda + 1 `{skip:!hasSupabase()}`): agenda pública mostra `team_vs_team.playable:true` e `world_boss.playable:true` sem vazar identidade; identidade anônima é sempre rejeitada (`AUTH_REQUIRED`), independente do horário real.
- `test/event-manager.test.js`/`test/event-ws.test.js`: os 2 testes que antes confirmavam TvT **indisponível** (contrato da Fase 5.5) foram atualizados pra confirmar TvT **jogável** agora — mudança de comportamento esperada desta fase, não regressão.
- **Regressão do World Boss confirmada**: `test/world-boss.test.js` (24 testes) roda inteiro e verde, sem nenhuma mudança — `game-data/world-boss.js` não foi tocado por esta fase.

## Migração de banco

**Nenhuma migration nova foi necessária ou criada.** `tvtRewards` vive no mesmo `characters.save` (jsonb), mesmo padrão de `wbRewards`. As 5 migrations históricas em `supabase/migrations/` não foram tocadas.

## Próxima fase

Bloco principal de Eventos completo (EventManager + World Boss + Team vs Team). Próxima grande fase recomendada: Guildas/Clãs — não iniciada nesta entrega.

# FASE 5.8 — GUILDAS / CLÃ

## Arquitetura: tabelas relacionais, não `characters.save`

Diferente de tudo até aqui (party, amigos-em-memória, `wbRewards`/`tvtRewards` dentro do JSONB), guilda é **persistente e relacional**: três tabelas novas (`guilds`, `guild_members`, `guild_invites`, ver `supabase/migrations/20260924214726_add_guild_tables_and_functions.sql`). Nenhum dado de guilda vive em `characters.save`. Lógica pura (validação de nome/tag, matriz de permissões, TTL de convite) fica em `game-data/guild.js`, testável sem Supabase — mesmo padrão de `game-data/tvt.js`/`event-manager.js`.

## Segurança: RLS habilitado, zero policies (mesmo padrão do projeto)

O jogo nunca usou Supabase Auth no cliente — não existe JWT de usuário, só o sistema próprio de `users`/`sessions` por token, inteiramente mediado por `server.js` com a **service-role key**. Confirmado antes de escrever qualquer SQL: as 4 tabelas pré-existentes (`users`, `characters`, `sessions`, `friends`) têm RLS habilitado e **nenhuma policy** — todo acesso `anon`/`authenticated` já era negado por padrão; a migration da Fase 5.2 chegou a remover as únicas duas policies que existiam (baseadas em `auth.uid()`, que nunca correspondiam a nada real neste projeto). As 3 tabelas novas de guilda seguem exatamente o mesmo modelo: `alter table ... enable row level security`, zero `create policy`. Isso não é uma omissão — é a trava dura já estabelecida, e escrever policies com `auth.uid()` aqui seria security theater (nenhuma credencial de usuário jamais chega ao Postgres diretamente).

## Operações atômicas via função SQL (RPC), não só `withCharLock`

Criar guilda+líder, aceitar convite, promover/rebaixar, transferir liderança, sair/expulsar e dissolver usam **funções PL/pgSQL `SECURITY DEFINER`** (`guild_create`, `guild_accept_invite`, `guild_remove_member`, `guild_set_role`, `guild_transfer_leadership`, `guild_dissolve`), chamadas via `POST /rest/v1/rpc/<nome>` com a service-role key — nunca pelo cliente diretamente. Cada uma roda como uma transação real no Postgres, corrigindo uma limitação que `withCharLock` sozinho não resolveria (ele só serializa all dentro desta única instância Node; a função SQL é atômica no próprio banco, correta mesmo se um dia existirem múltiplas instâncias). Todas as funções têm `set search_path = public, pg_temp` fixo, mesmo endurecimento já aplicado a `touch_updated_at()` pela migration da Fase 3.

## Constraint de unicidade real: um personagem, no máximo uma guilda

`guild_members.character_id` é **chave primária** (não composta com `guild_id`) — o próprio banco impede fisicamente um personagem pertencer a duas guildas, não só uma checagem em JS. Nome e tag são únicos **case-insensitive** via índices únicos em colunas `name_lower`/`tag_lower` computadas no insert. Nome: 3–24 caracteres; Tag: 2–5 caracteres — validados em `game-data/guild.js` (`validateGuildName`/`validateGuildTag`, com normalização de espaços/maiúsculas) antes mesmo de chegar no banco, e de novo via `check` constraint no SQL como segunda linha de defesa.

## Cargos e permissões (matriz pura, testável)

`leader` / `officer` / `member`, sempre lidos da linha real de `guild_members` — o cliente nunca envia uma role e o servidor nunca aceita uma. Matriz (`game-data/guild.js`):

- **Leader**: convida, remove officer ou member (nunca outro leader — não existe "outro leader"), promove member→officer, rebaixa officer→member, transfere liderança, dissolve.
- **Officer**: convida, remove **apenas member comum** (nunca outro officer, nunca o leader).
- **Member**: sai livremente, participa do chat, vê a lista de membros.

Transferência de liderança é atômica (`guild_transfer_leadership`): o líder antigo vira `officer`, o novo vira `leader`, `guilds.leader_character_id` é atualizado — tudo em uma função só, nunca existe momento com 0 ou 2 líderes (verificado manualmente contra o banco real de teste: `select count(*) from guild_members where role='leader'` sempre retornou exatamente 1 antes e depois da transferência).

## Sair e dissolver

Member/officer saem a qualquer momento. Leader só sai diretamente se for o **único** membro (nesse caso, sair == dissolver automaticamente). Com outros membros presentes, o leader precisa transferir a liderança ou dissolver explicitamente — `guild_remove_member` recusa com `LEADER_MUST_TRANSFER_OR_DISSOLVE` caso contrário. Dissolver (`guild_dissolve`, só leader) apaga a guilda; `guild_members` e `guild_invites` somem via `on delete cascade` — uma única instrução, sempre consistente.

## Convites

Tabela `guild_invites`: `pending` → `accepted`/`declined`/`cancelled`/`expired`. TTL de 24h (`GUILD_INVITE_TTL_MS`). No máximo um convite **pendente** por (guilda, alvo) — índice único parcial (`where status='pending'`) barra spam de convite duplicado. `guild_accept_invite` é atômico: confere alvo correto, pendente, não expirado, personagem ainda sem guilda, guilda ainda com vaga (<20) — tudo numa função só, com `select ... for update` na linha do convite pra evitar corrida com um cancelamento/expiração simultâneo. Aceitar um convite cancela automaticamente qualquer outro convite pendente pro mesmo personagem (não faz sentido ficar "quase aceito" em duas guildas ao mesmo tempo). Convites vencidos viram `expired` num sweep leve a cada 60s (`sweepExpiredGuildInvites`, separado do tick de 1s de combate/eventos — não é tempo-crítico).

## Limite de membros

`GUILD_MAX_MEMBERS = 20`, constante única em `game-data/guild.js`, consultada tanto na criação de convite (checagem antecipada, UX melhor) quanto dentro de `guild_accept_invite` (checagem real, atômica — a que de fato impede estourar o limite mesmo sob concorrência).

## Chat de guilda

Mensagem WS `guild_chat`. Cada conexão mantém `p.guildId`/`p.guildRole`/`p.guildTag`/`p.guildName` em cache (carregado do banco no join/reconnect, atualizado a cada mutação de guilda que afeta alguém online) — a mensagem só é aceita se `p.guildId` já está preenchido (nunca confia num `guildId` que o cliente mandasse) e é retransmitida só pra quem tem o mesmo `p.guildId` em cache. **Não fica persistida no banco** (mesma decisão de escopo do chat global existente) — rate limit básico (8 mensagens/10s por conexão), texto sanitizado via `cleanText`.

## Painel de Guilda (cliente)

Novo botão "Guilda" no menu principal. Sem guilda: formulário de criação + lista de convites recebidos (aceitar/recusar). Como membro: nome/tag da guilda, cargo próprio, lista de membros (online/offline, classe, nível, cargo) com botões de ação condicionados à própria role (promover/rebaixar/transferir/expulsar só aparecem quando a permissão real permite — mesma matriz do servidor, verificado renderizando `scrGuild()` nos três papéis via console do navegador antes do commit), caixa de busca de personagem pra convidar (`GET /api/guild/:charId/players?q=`, exclui quem já está em alguma guilda), chat da guilda, e sair/dissolver conforme o cargo.

## Testes

`test/guild.test.js`: 17 testes de lógica pura (sempre rodam — validação de nome/tag incluindo normalização e rejeição pós-normalização, matriz de permissões completa para os 3 cargos, `canLeaveDirectly`, expiração de convite) + 20 testes de integração via HTTP real (`{skip:!hasSupabase()}`, pulados neste ambiente sem credenciais locais — cobrem criação, nome/tag duplicados case-insensitive, personagem já em guilda, convite/aceitar/recusar, convite pra quem já está em guilda, permissão real (member não convida, officer não promove/rebaixa/remove officer-ou-leader), promoção/rebaixamento pelo leader, transferência de liderança (nunca 0 ou 2 líderes), sair (member/officer livre, leader bloqueado com outros membros, leader único sai), dissolver (só leader, limpa membros e convites), tampering de role via payload forjado, concorrência (duas criações com o mesmo nome simultâneas — só uma vence), chat isolado por guilda real via WebSocket, e o limite de 20 membros com o 21º convite rejeitado). Além disso, as 6 funções RPC foram exercitadas manualmente contra o banco Supabase real de produção usando registros descartáveis criados e removidos na mesma sessão (nunca tocando nenhuma das contas reais existentes) — confirmando `ALREADY_IN_GUILD`, aceite de convite, bloqueio de saída do líder com membros, transferência com exatamente 1 líder antes/depois, e bloqueio/sucesso de dissolução por permissão.

## Migração de banco

Uma migration nova: `20260924214726_add_guild_tables_and_functions.sql` — aditiva, sem `drop` destrutivo, sem apagar nenhum dado existente. Cria `guilds`, `guild_members`, `guild_invites` e as 6 funções RPC. Aplicada e revisada antes da aplicação.

## Limitações conhecidas

- Busca de personagem pra convite é por nome (`ilike`), e nomes de personagem só são únicos **por conta** (`unique(user_id, name)`), não globalmente — por isso a busca sempre retorna uma lista (até 10 resultados) pro convidador escolher o personagem certo, nunca assume unicidade global de nome.
- Sem Guild Bank, Guild Skills, Guild Wars, Castelos/Siege ou temporadas nesta fase — implementação explicitamente fora de escopo (ver spec da Fase 5.8-5.11).

# FASE 5.9 — BESTIÁRIO

## Catálogo canônico, sem duplicar stats

`game-data/bestiary.js` lista os **14 tipos reais** do jogo (`slime`, `goblin`, `skeleton`, `wolf`, `bat`, `toxic`, `caster`, `sky`, `sala`, `elem`, `calc`, `cinza`, `lorde`, `ancient_titan`) — os mesmos `type` usados em `mobStats()`/`MOB_AI_STEP`/`DUNGEON_CFG` (server.js) e o World Boss (`WORLD_BOSS_MAP_RE`), auditados um por um antes de escrever o catálogo. Cada entrada é só metadado descritivo: nome de exibição, região, faixa de nível, se é chefe, e quais categorias de drop são possíveis (`basic`/`rare`/`epic`/`legendary`). **HP, dano e XP continuam vindo exclusivamente de `mobStats()`** — o Bestiário nunca duplica esses números, só referencia o mesmo `type`.

## Progresso persistido: `character_bestiary`

Tabela nova (`character_id, monster_id, discovered_at, kills, first_kill_at, last_kill_at`, chave primária composta), mesmo modelo de segurança do resto do projeto (RLS habilitado, zero policies, acesso só via `server.js` com a service-role key). Crédito de abate é uma função RPC atômica, `bestiary_record_kill(character_id, monster_id)`: `INSERT ... ON CONFLICT (character_id, monster_id) DO UPDATE SET kills = kills + 1, last_kill_at = now()` — atômico no próprio Postgres, nunca perde incremento mesmo sob concorrência real (verificado com 5 chamadas disparadas em paralelo contra o mesmo par personagem/monstro: `kills` fechou em exatamente 5). `first_kill_at`/`discovered_at` são gravados só no primeiro `INSERT`; abates seguintes só avançam `kills`/`last_kill_at`.

## Autoridade: só o servidor credita

`creditBestiaryKill(charId, monsterId)` é chamada exclusivamente nos pontos onde o servidor **já** confirma um abate real (nunca num ponto novo criado só pro Bestiário):

- **Mob de campo**: dentro do `mob_damage` handler, no mesmo `if(mob.hp<=0)` que já credita XP/loot/quest via `creditKillReward` — usa o `mob.type` real que o servidor simulou, nunca o que o cliente reivindica.
- **Masmorra** (trash e chefe): mesmo ponto onde `creditDungeonReward` já é chamado — `mob.type` também já existe ali (roster gerado por `DUNGEON_CFG`), então dungeon conta pro Bestiário exatamente como campo aberto.
- **World Boss**: dentro de `grantWorldBossRewards`, protegido pelo mesmo `instance.rewardGranted` (setado de forma síncrona antes de qualquer `await`, então só executa uma vez por instância) — cada participante elegível da instância vencedora credita `ancient_titan`.
- **Team vs Team**: não integra o Bestiário — TvT é PvP (jogador contra jogador), não existe "monstro" pra descobrir ali.

`monster_id` recebido é sempre validado contra o catálogo (`BESTIARY.isValidMonsterId`) antes de chamar a função RPC — um `type` desconhecido nunca chega a criar uma linha lixo na tabela.

## API

- `GET /api/bestiary/catalog` — público, sem autenticação, sem dado de nenhum personagem (só o catálogo estático). Usado pra listar o total possível sem expor progresso de ninguém.
- `GET /api/bestiary/:charId` — autenticado, exige que `charId` pertença à conta da sessão (mesmo padrão de `ownCharacter` usado em Guildas). Retorna o catálogo mesclado com o progresso real: criatura não descoberta vira só `{id, discovered:false}` (sem nome/região/descrição — "???" no cliente), criatura descoberta inclui nome/região/nível/drops possíveis/abates/datas. Nunca aceita `kills`/`discovered`/`monster_id` do cliente como verdade — é sempre leitura, nunca escrita, dessa rota.

## Progresso e percentual

`discovered` (contagem) e `total` (`BESTIARY_TOTAL = 14`, constante única) vêm na resposta; o percentual é calculado no cliente (`Math.round(100*discovered/total)`) — nunca armazenado, sempre derivado.

## Painel de Bestiário (cliente)

Novo botão "Bestiário" no menu principal. Cabeçalho mostra `X / 14 descobertos (Y%)`. Lista: criatura não descoberta aparece como "???" / "Criatura não descoberta" (sem vazar nome/região antes da primeira descoberta real); criatura descoberta mostra nome, ícone de coroa se for chefe, região, faixa de nível, categorias de drop possíveis (sem percentual exato de drop — só quais raridades são possíveis, como pedido) e total de abates. Atualiza ao abrir o painel e de novo automaticamente quando chega uma recompensa de abate (`kill_reward`) ou do World Boss (`world_boss_reward`) enquanto o painel está aberto.

## Testes

`test/bestiary.test.js`: 7 testes sempre rodam (catálogo com exatamente 14 entradas batendo 1:1 com os `type` reais do servidor, sem id duplicado, `isValidMonsterId` aceita real/rejeita inventado, endpoint público `/api/bestiary/catalog` sem autenticação e sem vazar progresso, nenhum monstro comum promete Legendário) + 8 testes de integração real via HTTP + RPC (`{skip:!hasSupabase()}`): autorização (sem token rejeitado, personagem de outra conta rejeitado com 404 — nunca vaza progresso alheio), progresso inicial 0/14, primeiro abate descobre a criatura com `first_kill_at === last_kill_at === discovered_at`, segundo abate incrementa `kills` sem mudar `first_kill_at` mas avançando `last_kill_at`, 5 créditos disparados em paralelo no mesmo par nunca perdem incremento (fecha em exatamente 5), integração com World Boss (`ancient_titan`), percentual correto com múltiplas criaturas descobertas. Os testes de integração chamam a **mesma função RPC** que `server.js` chama em produção (`adminRpc`, mesmo espírito de `adminPatchCharacter` já usado desde a Fase 3) — o ponto de chamada real dentro de `mob_damage`/masmorra/World Boss é coberto pela regressão de `combat.test.js`/`monsters.test.js`/`world-boss.test.js`, que continuam 100% verdes sem nenhuma mudança de comportamento de combate.

## Migração de banco

Uma migration nova: `20260924220401_add_bestiary_table_and_function.sql` — aditiva, sem `drop`, sem apagar dado existente. Cria `character_bestiary` e a função `bestiary_record_kill`.

## Limitações conhecidas

- Bestiário não mostra chance de drop precisa por design (só quais raridades são possíveis) — se essa granularidade for pedida numa fase futura, precisa vir de `GEAR_DROP_RATES`/`rollGearDrop` (fonte real), nunca de um número novo inventado no Bestiário.
- Sem Ranking de Bestiário nesta fase (isso é Fase 5.10).

# FASE 5.10 — RANKINGS

## Estatísticas agregadas próprias, nunca `characters.save` inteiro

Nova tabela `character_rank_stats` (`character_id` PK, `level`, `xp`, `pvp_kills`, `pvp_deaths`, `tvt_wins`, `tvt_losses`, `tvt_draws`, `tvt_kills`, `tvt_deaths`, `world_boss_kills`, `world_boss_participations`, `bestiary_discovered`) — índices dedicados por tipo de ranking (`(level desc, xp desc)`, `(tvt_wins desc, tvt_kills desc, tvt_losses asc)`, etc). Nenhuma abertura de ranking faz `select save from characters` — sempre lê só a linha pequena e indexada de `character_rank_stats`. Mesmo modelo de segurança do resto do projeto: RLS habilitado, zero policies.

## Guilda: calculada ao vivo, sem tabela redundante

Em vez de manter `guild_rank_stats` sincronizado a cada mutação de guilda (mais um lugar pra divergir), o ranking de guilda usa uma **view** (`guild_rank_view`, `security_invoker=true`) que agrega `guild_members` + `character_rank_stats` por guilda (`member_count`, `total_level`, `tvt_wins`, `world_boss_kills`) em tempo de consulta — sempre consistente, sem gatilho de escrita adicional. A ordenação usa soma de níveis e depois número de membros; **nunca chamada de "melhor guilda" no código ou na UI**, é só uma ordenação estatística objetiva, como pedido.

## Quando o servidor atualiza (nunca o cliente)

- **Nível/XP**: `syncRankLevelXp(charId, lvl, xp)` roda toda vez que o servidor já teria persistido esse nível/XP de qualquer forma — no PUT genérico de personagem (`handleCharacters`, cobre autosave a cada ~30s e qualquer sincronização manual), em `creditKillReward` (abate de campo/masmorra), em `grantWorldBossRewards` e em `grantTvtRewards` (por participante recompensado). `rank_stats_set_level_xp` grava o **valor absoluto mais recente**, não um incremento — sempre reflete o real.
- **TvT termina**: dentro de `grantTvtRewards`, por participante elegível: `tvt_wins`/`tvt_losses`/`tvt_draws` (conforme `TVT.outcomeForTeam`) e `tvt_kills`/`tvt_deaths` (contagem real da partida) via `rank_stats_bump` — atômico, incremento real no Postgres.
- **World Boss termina**: dentro de `grantWorldBossRewards`, por participante elegível da instância vencedora: `world_boss_kills` e `world_boss_participations` (+1 cada) — como toda recompensa de World Boss hoje só é concedida em vitória (`instance.defeated`), os dois números coincidem nesta fase; a coluna de participação existe pronta pra quando/​se existir recompensa parcial por participação sem abate.
- **Bestiário descobre**: `syncRankBestiaryDiscovered` roda depois de todo crédito bem-sucedido em `creditBestiaryKill`, recalculando `bestiary_discovered` a partir da contagem real de `character_bestiary` (nunca incrementado às cegas).
- **Guilda muda**: não precisa de gatilho — o ranking de guilda é sempre calculado ao vivo (ver acima), então qualquer entrada/saída/dissolução já reflete no próximo cálculo, sem sincronização extra.

## PvP de campo aberto: limitação honesta, não uma lacuna escondida

`pvp_kills`/`pvp_deaths` existem na tabela e a aba "PvP" existe na UI, mas **ficam sempre em 0 nesta fase**: o PvP fora do TvT nunca teve confirmação de abate server-side (desde a Fase 1 — o alvo aplica a própria mitigação localmente e o servidor só valida cooldown/alcance, ver `player_hit`/`resolveAttackDamage` fora da arena de TvT). Adicionar um "eu morri" auto-reportado pelo cliente como fonte de um ranking público seria abrir uma estatística falsificável — inaceitável dado "não sacrifique segurança econômica pra terminar mais rápido". A tabela e a aba ficam prontas pra quando o PvP de campo aberto ganhar confirmação server-side (fora do escopo desta fase); até lá, nunca um número inventado.

## Backfill

Rodado dentro da própria migration: `insert into character_rank_stats (character_id, level, xp) select id, lvl, (save->>'xp')::int from characters` — preenche nível/XP reais dos personagens que já existiam antes desta fase (o único dado historicamente inferível de `characters`). Campos sem histórico anterior (PvP, TvT, World Boss, Bestiário) começam no `default 0` da própria coluna — nunca um número inventado para preencher lacuna.

## API pública, paginada, com cache

`GET /api/rankings?type=<level|pvp|tvt|world_boss|bestiary|guild>&page=N` — sem autenticação (é uma classificação pública). `type` inválido → 400. Paginação obrigatória, 20 por página (`RANK_PAGE_SIZE`). Cache server-side em memória por `tipo:página`, TTL de 45s (`RANK_CACHE_MS`, dentro da janela de 30–60s pedida) — não recalcula a cada hit, só expira e deixa o próximo pedido recomputar. Resposta nunca inclui `character_id` de identidade real, `userId`, token ou o `save` inteiro — só `name`/`cls`/`level`/`guildTag`/métricas públicas (confirmado por teste que varre o JSON da resposta procurando essas strings).

## Ordenação e desempate (puro, testável)

`game-data/rankings.js` (`RANK_COMPARATORS`/`sortForType`): Nível → `level DESC, xp DESC, nome`; PvP → `kills DESC, deaths ASC, nome`; TvT → `wins DESC, kills DESC, losses ASC, nome`; World Boss → `kills DESC, participations DESC, nome`; Bestiário → `discovered DESC, nome`; Guilda → `total_level DESC, member_count DESC, nome`. Nome sempre como desempate final e estável (nunca ordem "como o banco devolveu"). K/D (`kdRatio`) é sempre **calculado na resposta**, nunca armazenado como coluna — evita o valor ficar desatualizado ou divergir de `kills`/`deaths`.

## Painel de Ranking (cliente)

Novo botão "Ranking" no menu principal, com abas Nível/PvP/TvT/World Boss/Bestiário/Guildas. Cada linha mostra posição, nome, classe, tag de guilda (quando existir) e a métrica principal da aba. Paginação com botões Anterior/Próxima, desabilitados nos limites. Renderização verificada nas duas formas (individual e guilda) via console do navegador antes do commit.

## Testes

`test/rankings.test.js`: 13 testes de lógica pura sempre rodam (config, tipos válidos, `kdRatio` sem divisão por zero, `paginate` com página além do limite, os 6 comparadores de ordenação/desempate, cache TTL hit/miss) + 6 testes de integração real (`{skip:!hasSupabase()}`): tipo inválido rejeitado (400), resposta pública nunca vaza `userId`/`save`/token, personagem de nível alto aparece na página certa, estatísticas de TvT refletidas com K/D calculado, paginação sem sobreposição entre páginas, e `rank_stats_bump` rejeitando um nome de campo inventado (protege contra SQL dinâmico — a função só tem os branches explícitos, nunca interpola nome de coluna).

## Migrações de banco

Duas migrations novas: `20260924221254_add_rank_stats_table_and_functions.sql` (tabela + backfill + 3 funções RPC: `rank_stats_set_level_xp`, `rank_stats_bump`, `rank_stats_sync_bestiary_discovered`) e `20260924221408_add_guild_rank_view.sql` (view agregada de guilda). Ambas aditivas, sem `drop`, sem apagar dado existente.

## Limitações conhecidas

- PvP de campo aberto sempre mostra 0 kills/deaths (ver seção acima) — limitação arquitetural pré-existente, não desta fase.
- Cache de 45s significa que uma mudança de posição pode levar até 45s pra aparecer pra outro jogador olhando o ranking — aceito explicitamente pelo pedido de não recalcular a cada hit.
- Sem sistema de temporada/season nesta fase — ranking é sempre "desde sempre" (cumulativo).

# FASE 5.11 — MERCADO / LEILÃO

## Arquitetura e autoridade

O Mercado é um Auction House backend-first. O navegador envia somente intenção (`itemUid`, `price`, `listingId` e `operationId`); sessão e personagem são resolvidos por `server.js`, e toda mutação econômica ocorre em RPC transacional no Postgres. As tabelas `market_listings`, `market_transactions` e `market_claims` têm RLS habilitado e zero policies: não existe acesso direto do cliente Supabase.

As 16 RPCs privilegiadas das Fases 5.8–5.11 tiveram `EXECUTE` revogado de `PUBLIC`, `anon` e `authenticated` pela migration `20260924232253_harden_server_only_rpc_permissions.sql`; somente `service_role` executa. Todas usam `SECURITY DEFINER` com `search_path = public, pg_temp` fixo. A mesma migration adiciona índices nas FKs novas apontadas pelo Performance Advisor e preserva os índices recém-criados, mesmo ainda sem uso de produção.

## Escrow, UID e anúncio

`market_list_item` bloqueia a linha real de `characters`, encontra o UID exclusivamente na mochila canônica e move o objeto JSON inteiro para escrow na mesma transação que cria o anúncio. O cliente nunca fornece rarity, enchant ou stats. Se a inserção falhar, a transação inteira é revertida e o item continua com o vendedor. Item equipado ou UID inexistente é rejeitado; o índice parcial `uq_market_listings_active_uid` impede duas listings ativas do mesmo item físico.

O UID nunca é regenerado em venda, compra, cancelamento, expiração ou claim. Legendary e item +10 preservam exatamente o mesmo objeto canônico.

## Compra, taxa e idempotência

`market_buy` bloqueia a listing com `FOR UPDATE`, rejeita status não ativo, self-buy e saldo insuficiente, e trava comprador/vendedor em ordem determinística. A taxa oficial é 5% (`floor(price * 0.05)`): uma venda de 1.000 moedas gera taxa 50 e líquido 950. O cálculo válido é o SQL; o cliente só mostra a prévia.

`operation_id` possui índice único. O wrapper de hardening usa advisory lock por operationId e exige que um retry corresponda ao mesmo comprador e à mesma listing: retry idêntico devolve a transação original; reutilização cruzada retorna `OPERATION_ID_CONFLICT`, sem débito ou transferência. Corridas buy/buy, buy/cancel e buy/expire convergem para um único estado porque operam sobre a mesma linha bloqueada.

## Claims, cancelamento e expiração

Se a mochila do comprador estiver cheia, o item vira claim persistente. Se o crédito do vendedor ultrapassaria o teto de 500.000 moedas, o valor líquido inteiro vira claim de ouro — nunca há truncamento silencioso. Claims são bloqueados com `FOR UPDATE`; retirada dupla produz um único efeito. Claim de item com bag cheia e claim de ouro com overflow permanecem pendentes.

Cancelar só é permitido ao vendedor de listing ativa e sempre devolve o item por claim, independentemente do espaço da mochila. Listings vencem em 72 horas; o sweep de 60s chama `market_expire_listings`, que altera apenas linhas ainda ativas e cria exatamente um claim por item.

## Busca, privacidade e interface

Busca pública suporta nome, tipo, nível mínimo/máximo, rarity, enchant mínimo/máximo e preço mínimo/máximo; ordena por menor preço, maior preço, mais recente ou maior enchant, com páginas de 20. A resposta pública contém apenas dados de exibição do item e nome do vendedor. Histórico autenticado retorna só transações relacionadas ao personagem e nunca inclui `user_id`, email, token ou save.

O menu principal possui **Mercado**, com cinco abas utilizáveis: **Comprar**, **Meus anúncios**, **Anunciar**, **Itens a retirar** e **Histórico**. Cards mostram nome, rarity, enchant, nível, stats, preço e vendedor. Compra e anúncio exigem confirmação; anúncio mostra taxa e líquido. Após mutações, o cliente recarrega o personagem real do backend para refletir bag e ouro sem confiar em cálculo local.

## Concorrência, testes e limitações

Cobertura pura/estrutural valida preço, taxa, filtros, grants server-only, locks, vínculo do operationId, índices e presença completa da UI. Os testes de integração cobrem ownership, UID forjado, item equipado, escrow, busca/paginação, cancelamento, compra, self-buy, saldo insuficiente, retry idempotente, bag cheia, claim, preservação de UID/rarity/enchant/Legendary +10, histórico e privacidade. Casos destrutivos de concorrência real só rodam com `SUPABASE_TEST_SAFE=1`; sem ambiente dedicado ficam explicitamente skipped e nunca usam a economia oficial.

Limitações: o sweep de expiração depende do processo Render estar ativo (é idempotente e recupera vencidos no próximo ciclo); não há trading direto, mail, Cash Shop ou temporadas. As tabelas/RPCs persistem no Supabase, mas cache de Ranking e chats de Guilda continuam em memória conforme documentado nas fases próprias.

# FASE 5.12 — HARDENING GLOBAL SERVER-AUTHORITATIVE

O cliente online passou a enviar somente intenções de combate. O servidor monta o `combatSnapshot` a partir do personagem, equipamento e skills persistidos; `msg.atk`, `msg.sk`, `msg.hp` e `msg.damage` não participam do resultado. O mesmo snapshot já validado por World Boss/TvT agora fornece ataque, defesa, bloqueio, HP máximo, velocidade, ranks e cooldown básico ao campo global.

Ataques contra mobs validam personagem vivo, mapa, alvo vivo, alcance por ataque/skill, classe, skill desbloqueada e cooldown server-side. A transição `mob.dead=false -> true` continua síncrona antes de qualquer recompensa assíncrona, portanto XP, loot, Bestiário e progresso são concedidos uma vez. PvP fora da vila agora calcula mitigação, bloqueio, HP, morte e respawn no servidor; TvT e World Boss continuam usando seus resolvers próprios.

O runtime global mantém `hp`, `maxHp`, `dead`, `respawnAt`, cooldowns e posição. Mobs e jogadores enviam ao navegador o HP final; o navegador apenas apresenta o resultado. Morte bloqueia movimento, ataques e poções, e o respawn preserva a regra existente: após 2,2 s, vila, metade do HP. Reconexões no mesmo processo restauram vida/morte/cooldowns por 30 minutos, sem cura ou ressurreição por reconnect.

Movimento autenticado valida números finitos, bounds, delta de tempo, velocidade real e tolerância de rede. Saltos são corrigidos com `position_resync`; dash recebe janela autorizada. Mudanças normais de mapa exigem portal e desbloqueio, enquanto dungeon, World Boss, TvT, respawn e pergaminho continuam server-driven. Visitantes anônimos mantêm o sandbox legado e não possuem economia persistente.

A política de sessão é “última conexão autenticada vence”. A anterior recebe `session_replaced`, perde autoridade imediatamente e é fechada; cada pacote mutável confirma o socket ativo. Operações HTTP de loja, equipamento, enchant e consumíveis também exigem o identificador efêmero da sessão ativa. Rate limits curtos protegem movimento, ataques, skills, eventos e entrada de dungeon, com rejeição/log (`FORGED_COMBAT`, `INVALID_SKILL`, `INVALID_RANGE`, `INVALID_MOVEMENT`, `INVALID_MAP`, `STALE_SESSION`, `RATE_LIMIT`) sem ban automático e sem dados secretos.

Poções online são consumidas dentro de `withCharLock` e só aplicam cura depois do PATCH persistente; overheal é limitado, morto não usa consumível e dois pedidos para uma unidade produzem no máximo um consumo. Pergaminho é teleport server-driven. Mana ainda não possui runtime global completo: o servidor autoriza e consome a poção, retornando o efeito ao cliente.

Auditoria econômica residual manteve Mercado nas RPCs transacionais PostgreSQL. `withCharLock` continua process-local para shop/enchant/consumíveis; isso é suficiente na instância Render atual, mas não substitui lock distribuído se o serviço horizontalizar. O runtime global (HP, cooldown e sessão) também é process-local e se perde num restart/deploy; nenhuma migration foi necessária nesta fase.

# FASE 5.13 — DUNGEON MAP V2

**Escopo estritamente visual/estrutural**: só o mapa, colisão e posicionamento da masmorra mudaram. Nenhuma linha de `DungeonInstance`, `dungeon_enter`/`dungeon_state`, combate, HP, morte, respawn, loot, reward, IA de mob/chefe, Bestiário, Rare/Epic/Legendary, Party, autenticação, anti-teleport ou Supabase foi reescrita — confirmado pelos 18 testes pré-existentes de `test/dungeon.test.js` (roster server-autoritativo, HP real, 3× HP de chefe, `respawnAt=0`, `wallRects` compartilhado, cleanup por idle/tempo-de-vida, loot sem XP) continuando **verdes sem nenhuma alteração de asserção**.

## O que existia (mapa antigo)

O labirinto era **procedural**: `mazeGen(cols,rows,seed)` (DFS perfeito 7×5 + BFS achando a sala mais distante = sala do chefe) em `game-data/dungeon-generation.js`, com o mesmo seed usado pelo cliente (`buildMasmorra`, chamando `mazeGen` direto) e pelo servidor (`dungeonWallRects`/`dungeonLayout`, pra colisão de IA) — cada personagem via um labirinto snake sorteado a cada entrada, mesma matemática dos dois lados.

## Por que virou fixo, e por que o layout precisou ser redesenhado do proposto original

O layout pedido (Entrada → 6 salas nomeadas → Saída, com tamanhos de até 22×18) foi desenhado primeiro **fora** do código (script de planejamento, iterativo) e só então portado — porque existe um teto **global e não-negociável** de tamanho de mundo: `MW=60, MH=44` tiles (`WPX=2880px, HPX=2112px` em `index.html`), o **mesmo** limite que o anti-teleport do servidor já usa pra **qualquer** mapa do jogo (Vila, campo, masmorra, tudo). O labirinto 7×5 antigo cabia com folga nesse teto; o layout pedido, somado em linha reta (salas + corredores empilhados), passava de 130 tiles de altura — muito além dos 44 disponíveis. A solução foi dobrar o caminho num formato de "S" (3 "bandas" horizontais conectadas por dois cotovelos verticais curtos), preservando 100% a sequência linear pedida (nenhuma bifurcação, nenhum ciclo — verificado por teste), e reduzir algumas dimensões em relação à proposta original pra caber com folga de segurança. Layout final: **58×43 tiles** (dentro do limite de 60×44, com margem).

Tabela do que mudou de tamanho (tiles, proposta → final):

| Sala | Proposta | Final |
|---|---|---|
| Entrada | 10×8 | 10×8 (igual) |
| Sala 1 — Recepção | 14×12 | 14×10 |
| Corredor 1 | larg.3×8-10 | 8×3 (horizontal) |
| Sala 2 — Combate Inicial | 16×12 | 16×10 |
| Sala 3 — Câmara Lateral | 12×10 | 12×10 (igual) |
| Sala 4 — Sala Central | 18×16 | 18×12 |
| Sala 5 — Elite/Guarda | 14×10 | 14×10 (igual) |
| Checkpoint | 10×8 | 10×8 (igual) |
| Corredor Final | larg.4×10-14 | 8×4 (horizontal) |
| Sala 6 — Arena do Chefe | 22×18 | 20×12 |
| Saída | 10×8 | 10×8 (igual) |

Mesmo reduzida, a Arena do Chefe (20×12=240 tiles) continua a **maior sala** da masmorra (a Sala Central, 18×12=216, fica em segundo). Também: **entrada e saída pelo mesmo lado da arena** (leste/oeste), em vez de "parte inferior/parte superior" como pedido — mesma ideia funcional (passagem limpa entre paredes opostas, nunca um beco sem saída), só a orientação que precisou virar pra caber no dobramento em S. Ambas as adaptações estão documentadas aqui de propósito, não escondidas.

## Fonte única: mesmo dado pra render E colisão

`game-data/dungeon-generation.js` (compartilhado, `require()` no servidor e `<script>` no cliente — mesmo padrão desde a Fase 5.2) ganhou `DUNGEON_ROOMS_V2` (13 salas/corredores nomeados, coordenadas em tiles) e `DUNGEON_CONNECTIONS_V2` (12 conexões, cada uma com o lado e a largura da porta). `dungeonLayout(seed)` — **mesma assinatura de sempre**, `seed` preservado só por compatibilidade de chamada (o roster de monstros ainda usa `mulberry(seed+1)` como stream próprio, independente da geometria) — agora sempre devolve o **mesmo** layout fixo, calculado uma vez e cacheado (`buildFixedDungeonLayout`), com `{rects, start, boss, exitPoint, rooms, mobRooms}`.

`rects` (retângulos de parede, com o vão/porta exato em cada conexão, calculado por subtração de intervalo — mesma ideia da Fase 5.2, generalizada de "célula uniforme" pra "sala de tamanho arbitrário") é a **mesma lista** que:
- o **cliente** usa pra colisão do jogador (`buildMasmorra` chama `addBlock(r.x,r.y,r.w,r.h)` pra cada rect — nada de recalcular parede a parede como antes);
- o **servidor** usa pra colisão de IA de monstro (`mob.wallRects = layout.rects`, `moveMob`/`rectsBlock` inalterados).

Nunca duas matemáticas que podem divergir — o mesmo princípio que já valia desde a Fase 5.2, só que agora a fonte é uma lista de retângulos pré-computada em vez de uma fórmula por célula.

`mazeGen()` continua exportada em `game-data/dungeon-generation.js` (matemática pura, sem custo mantê-la, e removê-la sem necessidade estaria além do escopo desta fase) — mas `dungeonLayout()` **não a chama mais**.

## Layout: sequência linear (confirmada por teste)

```
ENTRADA → SALA 1 (Recepção) → CORREDOR 1 → SALA 2 (Combate Inicial)
  → [cotovelo] → SALA 3 (Câmara Lateral) → SALA 4 (Central) → SALA 5 (Elite/Guarda)
  → [folga] → CHECKPOINT → CORREDOR FINAL → SALA 6 (Arena do Chefe) → SAÍDA
```

Um teste (`DUNGEON_GEN: sequencia de conexoes forma um unico caminho linear...`) confirma matematicamente que cada sala aparece exatamente 1× (entrada/saída, pontas) ou 2× (meio, uma entrada uma saída) no total de conexões — a definição formal de "caminho único, sem ramificação nem ciclo", sem depender de inspeção visual.

## Colisão

Todo retângulo de `layout.rects` vira um bloqueador real (`addBlock` no cliente, `mob.wallRects` no servidor) — o que parece parede bloqueia, o que parece piso é pintado como chão caminhável (`paintRect(...,3)` dentro de cada sala, `paintRect(...,4)` no fundo). Testes cobrem: nenhuma sala se sobrepõe a outra; toda sala tem pelo menos uma porta; o ponto médio de cada uma das 12 conexões está fora de qualquer rect de parede (a porta é realmente caminhável); `start`/`boss`/`exitPoint` nunca caem dentro de parede; nenhum mob (comum ou chefe) nasce dentro de um rect de colisão.

## Spawn do jogador, saída e portal

`w.start` = ponto fixo dentro da Entrada (nunca mais derivado de `mz.sx/sy`). `w.portal` (o objeto que, ao ser tocado, chama `travel(zoneId)` de volta pro mapa de campo) **mudou de posição**: antes ficava na própria Entrada (entrada e saída eram o mesmo ponto); agora fica na sala de Saída, depois da Arena do Chefe — atende ao pedido de "prefira uma pequena sala de saída" sem precisar de nenhuma mudança de lógica (o objeto portal sempre foi 100% client-side/posicional; só as coordenadas mudaram).

## Spawn de monstros — por sala nomeada, não mais por célula

A distribuição antiga (72% de chance por célula de uma grade 7×5, uniforme) virou distribuição **por sala nomeada** (`DUNGEON_ROOM_MOB_COUNTS` em `server.js`, dentro de `createDungeonInstance`): Sala 1: 2–3, Sala 2: 4–6, Sala 3: 3–4, Sala 4: 5–7, Sala 5: 2 (interpretação de "1 elite ou 2 guardas fortes" — ver limitação abaixo). O **tipo/nível de cada mob continua vindo exatamente da mesma fonte** (`cfg.trash(rnd)`/`mobStats`, sem nenhuma fórmula nova) — só a distribuição espacial mudou, usando `DUNGEON_GEN.roomRandomPoint(room, rnd)` (ponto aleatório dentro da área caminhável da sala, encolhida pela espessura da parede) em vez de "centro da célula + jitter de 70px". O chefe nasce exatamente no centro da Arena (`layout.boss`), como sempre. `rnd` continua o mesmo stream `mulberry(seed+1)`, determinístico por instância.

Checkpoint, corredores e a sala de Saída **nunca** recebem monstro comum (`DUNGEON_MOB_ROOMS_V2` lista só as 5 salas de combate) — Checkpoint é área segura de propósito.

## Decoração (100% cosmética)

Reescrita pra iterar salas nomeadas em vez de células de uma grade. Usa sprites reais já existentes em `tileset-masmorras-original.png` (inspecionado visualmente antes de escolher os índices, nenhum sprite novo baixado): tocha acesa (linha 7, coluna 0) na Entrada (2), Sala 5 (2, flanqueando) e Corredor Final (2, "tochas grandes" na entrada da arena); coluna/pilar (linha 1, coluna 0 — um pilar de pedra arredondado standalone) na Sala 1 (1–2), 4 nos **cantos internos** da Sala 4 (nunca no centro exato, como pedido) e 4 próximos às **extremidades** da Arena do Chefe (arena limpa no meio); banner/estandarte (linha 7, coluna 6) como objeto central da Sala 3 e símbolo do Checkpoint junto com um cristal (linha 4, coluna 5) representando "iluminação/símbolo diferente". Props temáticos por zona (cogumelos/ossos/cristais conforme o tema, tabela reduzida de `DUNGEON_THEME_PROPS`) continuam espalhados dentro de cada sala via o mesmo stream de RNG de decoração (`mulberry`), nunca no vão de passagem entre salas.

## Minimapa

`buildMini` já era genérico (lê o mesmo grid `kind` pintado por `paintRect`, sem lógica dungeon-específica) — não precisou de reescrita. O único ponto hardcoded encontrado (um marcador vermelho de "posição do chefe" fixo em `(46*T,10*T)`, **que não correspondia à posição real do chefe** no mapa procedural antigo) foi corrigido pra ler `DUNGEON_GEN.dungeonLayout().boss` de verdade — agora o minimapa aponta pro chefe real, não um palpite fixo desatualizado.

## Verificação (sem jogar manualmente)

Toda a geometria foi validada por execução real de código, não só leitura: um script de planejamento (Node, fora do repositório) calculou a bounding box e testou sobreposição/conectividade antes da implementação; depois de implementado, o layout foi carregado de verdade no navegador (via console, sem submeter nenhuma conta real) confirmando visualmente Entrada com as 2 tochas, coluna renderizada na Sala 4, chefe + baú posicionados corretamente na Arena, e checagens de colisão (`hitBlock`) confirmando que `start`/`boss`/os 12 pontos médios de porta/os centros das 13 salas **não** estão bloqueados, e que uma parede real (fora de uma porta) **está** bloqueada.

## Testes

10 testes novos em `test/dungeon.test.js` (sempre rodam, sem Supabase): layout idêntico independente do seed (fixo); bounding box dentro do teto global (2880×2112px); nenhuma sobreposição entre as 13 salas/corredores; toda sala aparece em pelo menos uma conexão; a sequência de conexões forma matematicamente um caminho único sem ramificação; `start`/`boss`/`exitPoint` fora de qualquer parede; o ponto médio de cada uma das 12 portas é caminhável; mobs comuns nascem dentro da sala certa e na quantidade certa (`DUNGEON_ROOM_MOB_COUNTS`); o chefe nasce exatamente no centro da Arena; nenhum mob nasce dentro de colisão. Os 18 testes pré-existentes de `test/dungeon.test.js` continuam verdes **sem nenhuma alteração de asserção** (só o título de um teste foi atualizado pra descrever com precisão o novo comportamento "sempre fixo", a asserção em si não mudou).

## Limitações conhecidas

- **Dimensões reduzidas em relação à proposta original** (ver tabela acima) — necessário pra caber no teto global de mundo de 60×44 tiles, que nunca tinha sido binding pra masmorra antes (o labirinto procedural 7×5 antigo cabia com folga). Documentado explicitamente, não uma omissão silenciosa.
- **Entrada/saída da Arena do Chefe por lados opostos leste-oeste**, não "inferior/superior" como pedido — mesma função (passagem limpa, sem beco sem saída), orientação adaptada pro dobramento em S do layout.
- **Sala 5 (Elite/Guarda) usa 2 mobs comuns**, não um "elite" com stats diferenciados — nenhum tier de elite existe hoje em `mobStats`/`DUNGEON_CFG`, e inventar um sistema novo estaria fora do escopo desta fase (só mapa/colisão/posicionamento). Fica pronto pra uma fase futura de conteúdo, se pedido.
- **Total de monstros por instância caiu** (~17–21, distribuição curada por sala) em relação à média antiga (~35, chance uniforme por célula) — decisão deliberada seguindo a distribuição explicitamente pedida por sala, não um corte de recompensa (a fórmula de recompensa por abate não mudou nem um pouco, só quantos monstros existem pra abater).
- **Checkpoint continua sem lógica de save-point própria** (nenhuma existia antes) — a sala foi preparada visualmente (área segura, sem monstro, decoração própria) mas nenhum sistema novo de "salvar progresso no meio da masmorra" foi implementado, como pedido explicitamente ("se não existir, não implementar sistema novo").
- **Mesma limitação de sempre**: a masmorra continua solo (uma instância por personagem, `ownedDungeonInstance` por `charId`) — cooperativo multi-jogador não é desta fase, nunca foi.

# HOTFIX 5.12.1 — SESSION REPLACED UX

## Bug em produção

O servidor já fazia a parte certa desde a Fase 5.12 (`server.js`, dentro de `handleWsJoin`): quando a mesma conta+personagem conecta em um segundo aparelho sem fechar o primeiro, o socket antigo recebe `{type:'session_replaced'}` e é fechado com o código `4001` (`"Sessão substituída"`). O bug era **inteiramente client-side**: `NET.onclose` sempre agendava uma reconexão (`netRetry=setTimeout(netConnect,2500)`), **mesmo quando o fechamento foi o próprio servidor expulsando aquele socket de propósito** — o cliente nunca distinguia "caiu a rede, reconecta" de "fui substituído, não deveria voltar". Resultado: os dois aparelhos entravam num loop reconectando e reexpulsando um ao outro.

## Correção

Um flag de estado terminal (`sessionReplaced`, `index.html`) é setado assim que a mensagem `session_replaced` chega, **antes** do `close` disparar — `NET.onclose` passou a checar esse flag primeiro e retornar sem agendar nada quando ele está ativo, preservando o comportamento de sempre (reconectar) pra qualquer outro motivo de fechamento (queda de rede, restart do servidor, etc.). Um modal (`#sessionReplacedModal`, novo) aparece com a mensagem pedida ("Usuário conectado em outro aparelho.") e um botão OK; `running=false` interrompe o loop de jogo imediatamente. Clicar OK reusa exatamente o padrão já existente de logout/troca de personagem (`logoutOnline(); location.reload();`) — limpa o token local (impede auto-login/auto-reconnect nessa aba) sem apagar nenhum dado de personagem, e a recarga da página devolve à tela de login do zero.

## Verificação

A metade **client-side** (a causa real do bug) foi verificada ao vivo no navegador via console: uma conexão WS real anônima foi estabelecida, a mensagem `session_replaced` foi injetada manualmente — confirmado que o flag liga, o modal aparece (com a mensagem exata pedida, screenshot conferido), `running` para, e chamar `NET.onclose()` depois **não** agenda reconexão (`netRetry` permanece `0`); o mesmo teste repetido com o flag desligado confirma que o fechamento normal **continua** reconectando (sem regressão). A metade **server-side** (que já estava correta desde a Fase 5.12, mas nunca tinha teste automatizado) ganhou um teste real de dois sockets: `test/ws-auth.test.js` conecta A, depois conecta B com o mesmo token+charId sem fechar A, e confirma que A recebe `session_replaced` e é fechado com código `4001`/motivo `"Sessão substituída"`, enquanto B continua respondendo normalmente.

## Testes

`test/ws-auth.test.js`: 1 teste novo (`{skip:!hasSupabase()}`) — segunda conexão com o mesmo token+charId expulsa a primeira com o código/motivo certos, sem afetar a segunda.

## Migração de banco

Nenhuma — mudança inteiramente de comportamento client-side (JS/CSS/HTML), servidor não foi alterado.

# FASE 5.13.1 — DUNGEON EM PARTY

**Escopo**: tornar a masmorra (até então estritamente solo — última limitação conhecida documentada no fim da Fase 5.13, acima) cooperativa para 1–4 jogadores, **reusando o sistema de Party já existente** (`parties`/`memberParty`, `/api/party`) sem inventar nenhuma estrutura paralela. Mapa/colisão/spawn da Fase 5.13 não foram tocados — só a camada de "quem pode entrar e é dono da instância" e "como a recompensa é distribuída" mudou.

## Núcleo: `createDungeonInstance` virou um wrapper fino sobre `buildDungeonInstance`

`buildDungeonInstance(zone, members[])` (novo, `server.js`) é a função real — recebe uma lista de `{charId, userId, cls}` em vez de um único dono. `createDungeonInstance(zone, ownerCharId, ownerUserId)` (assinatura antiga, usada por todo o teste pré-existente) virou uma casca de uma linha que chama `buildDungeonInstance(zone, [{charId, userId}])` — **comportamento solo bit-a-bit idêntico ao de antes**, confirmado pelos 28 testes de masmorra pré-existentes continuando verdes sem nenhuma alteração de asserção.

`state.members` (campo que já existia, um `Set` nunca lido por ninguém, deixado de propósito por uma fase anterior) virou um `Map<charId, {userId, cls, online, joinedAt, damageDone, lastActivityAt}>` — a fonte real de quem pertence à instância. `ownerCharId`/`ownerUserId` continuam preenchidos (primeiro membro) só por compatibilidade com código antigo que ainda espera um "dono" único (ex.: `dungeonCleanupTick` ao limpar `dungeonByOwner`); `members` é sempre a verdade.

## Escala de HP por participante — nunca no dano do jogador

`DUNGEON_PARTY_SCALE` (`game-data/dungeon-generation.js`, núcleo puro): `{1: 1.00, 2: 1.55, 3: 2.05, 4: 2.50}`, aplicado via `dungeonScaleFor(n)` (grampeado a 1–4, nunca NaN/negativo). O multiplicador entra **só** no HP de mob/chefe (`Math.round(stats.hp * scale)` em `buildDungeonInstance`) — o dano que o jogador causa continua vindo 100% de `resolveAttackDamage`/`clampAtk`, código de combate da Fase 5.12 **inalterado**. TTK não foi medido em produção real (sem ambiente de carga disponível nesta sessão), mas os números de partida (1.55×/2.05×/2.50×) foram os pedidos explicitamente como ponto de partida.

## Entrada: só o líder inicia, membros reais resolvidos pelo servidor

`handleDungeonEnter` reescrito: se o personagem que pediu já tem uma instância viva daquela zona (`ownedDungeonInstance`), **sempre reusa** — nunca reconstrói a lista de membros numa chamada repetida (é assim que o late-join fica bloqueado, ver abaixo). Senão, se ele está numa Party real (`party.members.size > 1`), só o **líder** (`party.ownerId`) pode iniciar — qualquer outro membro recebe `dungeon_error: "Apenas o líder do grupo pode iniciar a masmorra."`. Os candidatos a membro são resolvidos via `activeCharacterForUser(userId)` para cada `userId` da Party — **nunca** uma lista de IDs vinda do cliente — e cada candidato tem o desbloqueio da região revalidado com uma leitura fresca do banco (`save.quest`/`save.gunlock`, nunca o que já está em memória). Quem não está liberado simplesmente fica de fora do grupo que entra; se ninguém estiver liberado, ou se o próprio líder não estiver, a masmorra não abre.

## Late join: quem entra na Party depois que a masmorra já começou nunca entra naquela instância

Não existe um mecanismo dedicado de "bloqueio" — é uma consequência direta de como a entrada funciona: `buildDungeonInstance` recebe a lista de membros **uma única vez**, no momento da criação, e `state.members` nunca é atualizado depois por eventos de Party (entrar/sair). Um personagem que entra na Party depois: (a) se tentar `dungeon_enter` ele mesmo, não é o líder (a menos que vire dono da Party) e é barrado pelo mesmo erro acima; (b) mesmo que o líder chame `dungeon_enter` de novo, a instância já existente é **reusada** (branch `ownedDungeonInstance`), nunca reconstruída com a lista atual da Party.

## Presença compartilhada, HP/morte/loot continuam individuais

Todos os membros resolvidos recebem `p.map = state.id` (o mesmo mapId) e o mesmo `dungeon_state` (com `party:true` quando é uma entrada de grupo real) — o resto do mundo compartilhado (outros jogadores visíveis, mobs sincronizados via `mob_state`/`broadcastMap`) usa exatamente o mesmo pipeline genérico de multiplayer já usado por TvT e World Boss (jogadores no mesmo `p.map` já se veem desde sempre) — **nenhuma mudança em `index.html`** foi necessária pra isso. HP/dano/morte/respawn de jogador continuam 100% o sistema server-authoritative da Fase 5.12, sem nenhum código novo — só o HP dos MOBS foi escalado.

## Recompensa individual — cada membro elegível, seu próprio roll

Dentro de `mob_damage`, quando um mob morre dentro de uma instância de masmorra, o loop de recompensa deixou de creditar só quem desferiu o golpe final e passou a iterar `state.members` inteiro, chamando `creditDungeonReward` **uma vez por membro elegível**, cada um com seu próprio `charId`/`userId`/`cls` (o roll de loot usa a classe de CADA membro, não a de quem bateu) — `creditDungeonReward` já era (desde a Fase 5.2/5.3) um `withCharLock`+leitura+PATCH atômico e independente por personagem, então chamá-lo em loop, um por membro, não precisou de nenhuma mudança nele. Membro offline no momento da morte recebe a recompensa do mesmo jeito (persistida no banco) através de um WS "morto" (`DUNGEON_OFFLINE_WS = {readyState:3}`) que deixa `send()` fazer nada com segurança — só não vê a notificação em tempo real. Mochila cheia usa exatamente o mecanismo já existente (`applyGearDrops`/`dropLost`), sem nenhum código novo.

**Elegibilidade nunca exige abate** (mesmo espírito de `isTvtEligible` da Fase 5.7): `dungeonMemberEligible(member, now)` aceita quem já causou dano real (`damageDone>0`) OU esteve ativo nos últimos 90s (`DUNGEON_ELIGIBLE_IDLE_MS`) — um membro que ficou parado a masmorra inteira sem participar não rouba recompensa de quem lutou, mas ninguém precisa ter batido o golpe fatal especificamente.

**Corrida de morte do chefe** (dois golpes quase simultâneos): `mob.dead=true` e `state.bossDefeated=true` são setados de forma síncrona, antes de qualquer `await` — como Node processa uma mensagem WS até completar antes da próxima, uma segunda mensagem `mob_damage` pro mesmo mob (mesmo chegando logo em seguida) sempre encontra `mob.dead===true` no guard do topo do handler e retorna sem reprocessar. Mesma proteção que já cobria o caso solo (testada em `test/dungeon-integration.test.js`), agora também correta pra N membros batendo ao mesmo tempo — nenhuma trava nova foi necessária.

## Desconexão, reconexão e "dono" que não trava a instância

Desconectar (líder ou qualquer outro membro) **nunca** termina a instância nem afeta quem mais está dentro — só marca aquele membro `online=false` (mesmo padrão de World Boss/TvT, novo bloco dentro do `ws.on('close', ...)`). `dungeonCleanupTick` decide se uma instância morre por presença real no mapa (`playersOnMap`), não por quem é "dono" — então o líder cair não derruba o grupo. Reconectar com o mesmo `userId`+`charId` (novo bloco dentro de `handleWsJoin`, espelhando o padrão já usado por World Boss/TvT) percorre `dungeonByOwner.get(charId)` procurando uma instância que ainda esteja viva e onde esse personagem seja membro de verdade — encontrando, marca `online=true` de novo e manda `dungeon_state` com `reconnect:true`, sem duplicar personagem nem criar instância nova.

## Sair da Party durante uma masmorra ativa

Sair da Party (`leaveParty`) é uma operação inteiramente no nível de Party — não tem nenhum gancho para dentro de `state.members` da masmorra. Como a lista de membros da instância foi fixada na criação (ver "late join" acima) e nunca é sincronizada de volta a partir da Party, sair do grupo não expulsa ninguém de uma masmorra em andamento nem abre brecha para reentrar em várias Parties e coletar a mesma recompensa mais de uma vez — a elegibilidade (`dungeonMemberEligible`) e o `withCharLock` por personagem em `creditDungeonReward` já impedem duplicação, com ou sem mudança de Party no meio do caminho.

## Isolamento entre Parties

Cada `dungeon_enter` bem-sucedido gera um `mapId` novo (`zone + '_d#' + hex aleatório de 4 bytes`) e só os membros resolvidos daquela chamada específica recebem `p.map` apontando pra ele — duas Parties diferentes entrando na mesma zona ao mesmo tempo sempre caem em instâncias `mapId` distintas, sem nenhum código de isolamento dedicado (é uma consequência direta de cada instância ser um `mapState` novo, mesmo princípio já usado por World Boss/TvT). Um personagem fora da Party nunca recebe `dungeon_state` daquela instância (só quem está na lista `validMembers` resolvida a partir da própria Party é notificado) e, mesmo sabendo o `mapId` por fora, não tem como se colocar dentro dela — nenhuma mensagem do cliente altera `p.map` diretamente.

## Testes

`test/dungeon-party.test.js` (novo arquivo, mesmo padrão de `test/dungeon-integration.test.js`): 6 testes puros de `dungeonScaleFor`/`buildDungeonInstance` (**sempre rodam, sem Supabase** — cobrem os 4 valores de escala pedidos, grampeamento fora de 1–4, forma solo idêntica à antiga, HP de mob/chefe escalado em 2.50× pra 4 membros sem alterar dano do jogador, `wallRects` compartilhado, zona/lista inválida retornando `null`) + 8 testes de integração real via Party+WebSocket (`{skip:!hasSupabase()}`, mesma convenção de todo o resto da suite): solo sem Party (regressão), Party de 2 caindo no mesmo mapId, Party de 4 caindo no mesmo mapId com chefe escalado, membro não-líder impedido de iniciar, duas Parties isoladas em mapIds diferentes, intruso nunca recebendo `dungeon_state` da instância alheia, reconexão voltando pra mesma instância (`reconnect:true`), recompensa individual creditando os DOIS membros mesmo quando só um bateu no chefe. Os 28 testes pré-existentes de masmorra (solo) continuam verdes sem nenhuma alteração de asserção — suite completa: 456 testes / 302 passando / 0 falhando / 154 pulados (todos os pulados exigem Supabase real, nenhum contado como passado).

## Verificação

Os 6 testes puros rodam de verdade nesta sessão (sandbox sem credenciais Supabase configuradas) e passam. Os 8 testes de integração real via WebSocket foram escritos para exercitar o fluxo completo (`/api/party` real, `dungeon_enter`/`mob_damage` reais, nunca bypass) mas **não puderam ser executados nesta sessão** — não há `SUPABASE_URL`/`SUPABASE_SECRET_KEY` disponíveis neste ambiente (mesma situação de TODOS os outros testes com `{skip:!hasSupabase()}` já existentes no repositório, incluindo o de `test/dungeon-integration.test.js` e o de `session_replaced` da Fase 5.12.1 — não é uma limitação nova desta fase). A correção foi verificada por revisão estática cuidadosa de cada trecho alterado (guard de `mob.dead` síncrono antes de qualquer `await`, `withCharLock` independente por `charId`, `state.members` nunca ressincronizado a partir da Party, presença por `playersOnMap` em vez de "dono") e por comparação direta com os padrões já comprovados de World Boss/TvT (reconexão, desconexão, isolamento por `mapId`). **Recomenda-se rodar `npm test` com `SUPABASE_URL`/`SUPABASE_SECRET_KEY` de um projeto de TESTE antes do merge em `main`**, para confirmar os 8 cenários fim-a-fim.

## Limitações conhecidas

- **Sem HUD dedicado de grupo dentro da masmorra** (barra de HP dos outros membros, indicador de "em grupo") — o pedido original cobre mecânica (escala/loot/reconexão), não UI nova; jogadores do mesmo grupo já se veem/se movem/lutam juntos pelo pipeline genérico de multiplayer (mesmo usado em TvT/World Boss), só não há um painel dedicado. Fica pronto pra uma fase futura de polish, se pedido.
- **TTK (time-to-kill) não medido em produção real** — sem ambiente de carga/grupo real disponível nesta sessão; os multiplicadores de escala usados são os valores de partida pedidos explicitamente (1.55×/2.05×/2.50×), não uma calibração validada por playtesting.
- **Os 8 testes de integração real (Party+WebSocket) não foram executados nesta sessão** — ver "Verificação" acima. Escritos e prontos, mas pendentes de confirmação com Supabase real antes do merge.
- **Nenhuma migração de banco** — toda a mudança é em memória (`server.js`/`game-data/dungeon-generation.js`); o formato salvo em `characters.save` (gold/gem/bag/eq) não mudou.

# FASE 5.13.2 — MATCHMAKING DE DUNGEON

**Escopo**: fila de matchmaking somente-humano pra formar grupos de masmorra automaticamente (preenchimento por IA fica pra Fase 5.16 — aqui só existe o campo `allowAiFill`, guardado por entrada mas nunca lido por nada que spawne IA). Fila em memória, sem tabela, mesmo espírito efêmero de Party/instância de masmorra. A entrada direta de sempre (sozinho ou com a Party atual, Fase 5.13.1) continua funcionando sem nenhuma mudança — matchmaking é uma opção **a mais**, nunca uma substituição.

## Estrutura

`dungeonQueue` (`Map<zone, Map<userId, {charId,cls,queuedAt,allowAiFill,soloOptIn,disconnectedAt}>>`) e `userQueueZone` (`Map<userId, zone>`, garante nunca duas entradas simultâneas pro mesmo usuário — entrar numa fila nova sempre remove qualquer entrada anterior primeiro, `dungeonQueueLeaveInternal`). Chaveado por `userId`, não `charId` — mesma granularidade de Party e `activeCharacterForUser`, porque quem importa pro pareamento é a conta ativa agora, não um personagem específico guardado em memória.

## Tamanho preferido (4), fallback por tempo de espera (3, depois 2), solo só com opt-in

`dungeonQueueTick()` roda a cada 1s (junto do resto da limpeza periódica). Pra cada zona, mede quantos estão realmente disponíveis (online, sem tolerância de desconexão ativa) e decide o maior grupo viável: 4 ou mais na fila fecha **na hora** (não precisa esperar nada); exatamente 3 só fecha depois de `DUNGEON_QUEUE_FALLBACK_3_MS` (25s) de espera do mais antigo; exatamente 2 só depois de `DUNGEON_QUEUE_FALLBACK_2_MS` (45s); sozinho **nunca** fecha, a menos que o próprio jogador tenha marcado `soloOptIn:true` na entrada — e mesmo assim só depois de `DUNGEON_QUEUE_FALLBACK_SOLO_MS` (60s). Se sobrar mais gente que o grupo fechado (ex.: 5 na fila), o loop continua tentando fechar outro grupo com quem restou, no mesmo tick.

## Diversidade de classe sem bloquear ninguém

`dungeonQueuePickGroup(entries, n)` sempre inclui quem está esperando há mais tempo (justiça por ordem de chegada), depois prioriza entradas com uma classe ainda não escolhida no grupo, e só preenche o resto com quem sobrar (mais antigo primeiro) se a diversidade se esgotar — nunca deixa um grupo incompleto ou atrasado só por falta de variedade de classe.

## Tolerância de desconexão

Cair da fila (rede instável, troca de aba) não remove a posição na hora — `disconnectedAt` é marcado no fechamento do WebSocket e a entrada continua na fila, mas **nunca** entra num grupo formado enquanto isso (o tick filtra por `!disconnectedAt` antes de contar quem está disponível). Reconectar com o mesmo `userId` dentro de `DUNGEON_QUEUE_DISCONNECT_GRACE_MS` (20s) limpa o flag e a espera acumulada continua valendo; passado esse prazo sem reconectar, a entrada é removida de vez no próximo tick.

## Pareamento vira uma Party de verdade

`formDungeonGroup(zone, group)` revalida o desbloqueio de **cada** membro com uma leitura fresca do banco (o check feito na entrada da fila pode ter ficado velho) — quem não está mais liberado simplesmente não entra no grupo final. Membros validados (2+) são desligados de qualquer Party manual anterior (`leaveParty`) e uma Party nova é montada pra eles com o mesmo sistema da Fase 5.13.1 (`parties`/`memberParty`, nunca uma estrutura paralela) — o mais antigo da fila vira o dono. A masmorra é então criada e cada membro online recebe `dungeon_queue_matched` seguido do `dungeon_state` normal, pelo mesmo `buildDungeonInstance`/`sendDungeonStateTo` de sempre. **Simplificação deliberada**: o nome exibido na Party montada pelo matchmaking usa o nome do personagem (`p.name`, já disponível na conexão), não o username da conta (que exigiria uma consulta extra ao Supabase só pra isso) — cosmético, sem efeito em nenhuma lógica de posse/permissão.

## Cliente (`index.html`)

Botão "Buscar Grupo (matchmaking)" na tela da masmorra (`scrMasmorra`), ao lado do "Entrar" de sempre (que continua igual). Enquanto na fila, o botão de entrada direta fica desabilitado e um status (`X/4 jogador(es) reais, aguardando há Ys`) aparece com um botão "Cancelar busca" — o contador de segundos é fixado no momento da última atualização do servidor (join/leave), não um relógio ticando em tempo real no cliente (ver limitações). `dungeon_queue_matched` mostra um toast ("Grupo encontrado!") e prepara a mesma transição de tela (`$('#fade')`, `traveling=true`) que a entrada direta já usava, deixando o `dungeon_state` que chega logo em seguida cair no mesmo `applyDungeonState` de sempre — nenhum código de transição novo foi necessário.

## Testes

`test/dungeon-queue.test.js` (novo arquivo): **11 testes puros** (sempre rodam, sem Supabase, sem esperar os prazos reais de 25s/45s/60s — os timestamps `queuedAt`/`disconnectedAt` são forjados no passado via manipulação direta dos `Map`s exportados) cobrindo cada limiar de fallback (4 fecha na hora; 3 não fecha antes de 25s e fecha depois; 2 não fecha antes de 45s e fecha depois; solo nunca fecha sem opt-in, fecha só depois de 60s com opt-in), a tolerância de desconexão (nunca entra num grupo dentro da tolerância, é removido depois dela) e a limpeza de fila/zona vazia — mais **5 testes de integração real via WebSocket** (`{skip:!hasSupabase()}`, mesma convenção do resto da suite): entrar/sair da fila, 4 jogadores pareando quase imediatamente e virando uma Party real, sozinho nunca pareando sem opt-in, reentrada na mesma zona não duplicando, e diversidade de classe garantindo que a única classe diferente (mago entre 4 guerreiros) entra no primeiro grupo fechado. A lógica de renderização do cliente (`scrMasmorra`, os dois estados — fora e dentro da fila) foi verificada isolando a função com estado forjado (Node, fora do navegador) e conferindo a string HTML gerada nos dois casos, sem precisar de um servidor real rodando.

## Verificação

Os 11 testes puros rodam de verdade nesta sessão e passam — cobrem exaustivamente a aritmética de fallback (a parte mais fácil de errar). Os 5 testes de integração via WebSocket foram escritos pra exercitar o fluxo completo (`dungeon_queue_join`/`dungeon_queue_leave` reais, nunca bypass) mas não puderam ser executados aqui pela mesma razão já documentada na Fase 5.13.1 (sem `SUPABASE_URL`/`SUPABASE_SECRET_KEY` neste sandbox). **Recomenda-se rodar `npm test` com Supabase de TESTE antes do merge**, junto com os 8 pendentes da Fase 5.13.1.

## Limitações conhecidas

- **Contador de espera não atualiza em tempo real no cliente** — fica parado no valor de quando o servidor confirmou a entrada/saída da fila, só muda de novo se o jogador reabrir o painel (o que dispara `renderScr()` com `Date.now()` fresco só quando um novo `dungeon_queue_state` chega do servidor). Um relógio local ticando seria puramente cosmético; não implementado pra não adicionar estado novo além do pedido.
- **Sem persistência entre sessões** — sair do jogo remove a entrada da fila como qualquer desconexão (com a mesma tolerância de 20s); não existe "voltar pra fila de onde parei" depois de fechar a aba de propósito.
- **`allowAiFill` e `soloOptIn` preparados mas sem UI dedicada pra ligar/desligar** — o cliente atual nunca manda `allowAiFill` (fica sempre `false`) nem `soloOptIn` (fica sempre `false`, então o fallback solo nunca dispara na prática hoje); os campos existem no protocolo servidor-cliente exatamente como pedido ("flag allowAiFill preparada, IA não spawna ainda"), prontos pra Fase 5.16 ligar preenchimento por IA e pra uma fase futura de UI adicionar as opções, sem precisar mexer no núcleo da fila de novo.
- **Nenhuma migração de banco** — toda a fila é em memória; nada foi persistido no Supabase.

# FASE 5.14 — ADMIN + OBSERVABILIDADE

**Escopo**: painel administrativo separado (`/admin`, `admin.html`) com RBAC de 4 níveis, moderação persistente e auditada (kick/mute/ban/unban), visão somente-leitura de economia/guildas/eventos, e um log de segurança com lista explícita do que nunca é gravado.

## Banco de dados: auditado antes de qualquer migração

Antes de escrever qualquer SQL, o schema real do Supabase do projeto (`MMORPG 2D V0.22 Online`, o único projeto `ACTIVE_HEALTHY`, com dados reais — 10 usuários, 10 personagens) foi lido via `list_tables`: `users`, `characters`, `sessions`, `friends`, `guilds`/`guild_members`/`guild_invites`, `character_bestiary`, `character_rank_stats`, `market_listings`/`market_transactions`/`market_claims`. Nenhuma das tabelas candidatas (`admin_roles`, `moderation_actions`, `player_bans`, `player_mutes`, `admin_audit_log`) existia — confirmando que a migração é 100% nova, nunca um conflito com algo já lá.

**Decisão registrada com o usuário**: como é o banco de produção real (não um projeto de teste), foi oferecida a opção de criar uma branch de desenvolvimento do Supabase antes de aplicar qualquer coisa (custo: $0.01344/hora) — o usuário optou por aplicar direto na produção, confiando que a migração é puramente aditiva (só `CREATE TABLE`, nenhuma tabela existente alterada). A migração foi aplicada com `apply_migration` (não um arquivo SQL só documentado — rodou de verdade no projeto real) e os Advisors de Segurança/Performance foram executados logo em seguida, como exigido.

## Schema (100% aditivo)

4 tabelas novas, nenhuma tabela existente tocada — `moderation_actions` foi **deliberadamente fundida** em `admin_audit_log` (toda ação de moderação já é uma entrada de auditoria; não fazia sentido manter duas tabelas espelhadas para a mesma informação):
- `admin_roles(user_id PK, role, granted_by, granted_at)` — `role` restrito por `check` a `owner`/`admin`/`moderator`/`support`.
- `player_bans(id, user_id, reason, banned_by, created_at, expires_at NULL=permanente, revoked_at, revoked_by)`.
- `player_mutes` — mesma forma de `player_bans`, para chat.
- `admin_audit_log(id, actor_user_id, action, target_user_id, target_character_id, reason, metadata jsonb, created_at)` — toda ação administrativa (kick/mute/ban/unban/concessão de cargo) grava uma linha aqui.

RLS habilitado em todas, **sem nenhuma policy** para `anon`/`authenticated` — exatamente o mesmo padrão já usado nas 12 tabelas pré-existentes (confirmado pelo Advisor: a mesma checagem informativa `rls_enabled_no_policy` já existia pras 12 tabelas antigas, não é uma novidade desta fase). Só o backend, autenticado com a service-role key (que ignora RLS por padrão no Supabase), lê/escreve — nunca o cliente direto. O Performance Advisor sinalizou 6 foreign keys sem índice de cobertura (`granted_by`/`banned_by`/`revoked_by`/`muted_by`/`revoked_by`/`target_character_id`) — corrigido numa segunda migração pequena, só nas tabelas novas desta fase (índices em tabelas pré-existentes que o Advisor também sinalizou, como `friends.friend_id`, ficaram de fora por estarem fora do escopo desta fase).

## RBAC: matriz de permissão centralizada, nunca `role==='admin'` espalhado

`ADMIN_PERMS` (`server.js`) mapeia cada um dos 4 cargos pra uma lista de permissões nomeadas (`view_dashboard`, `search_players`, `kick`, `mute`, `ban`, `unban`, `view_economy`, `manage_roles`, `view_guilds`, `view_events`, `view_security_log`) — toda rota do painel checa `adminHasPerm(role, 'permissão_nomeada')`, nunca uma comparação direta de string espalhada pelo código. `support` é somente-leitura (dashboard/busca/guildas/eventos); `moderator` ganha kick/mute/ban/unban; `admin` ganha tudo do moderator mais visão de economia e log de segurança; só `owner` tem `manage_roles` (conceder/revogar qualquer cargo, incluindo outros admins).

## Auth: sempre server-side, nunca localStorage

`resolveAdmin(req)` reusa o **mesmo** token Bearer de sessão de sempre (`resolveUser`, Fase 1) e faz uma leitura fresca de `admin_roles` a **cada requisição** — o cargo nunca é guardado no cliente nem cacheado em memória entre requisições. `admin.html` guarda só o token de sessão (o mesmo que qualquer login do jogo emite) — não existe "senha de admin" separada; quem tem uma conta com uma linha em `admin_roles` vê o painel, quem não tem recebe 403 (`Acesso restrito`) em toda rota `/api/admin/*`.

## Moderação: persistente, auditada, aplicada em login E no WebSocket

Ban é checado em **dois** pontos, como pedido explicitamente: `/api/auth/login` (rejeita a emissão de uma sessão nova pra conta banida, com o motivo e a data de expiração se houver) e dentro de `handleWsJoin` (cobre quem já tinha uma sessão válida emitida **antes** do ban — nunca degrada pra "visitante anônimo", fecha a conexão de verdade com o código `4003` e uma mensagem `banned` explícita). Banir uma conta **já conectada** força a desconexão imediata (`kickUserSockets`, reusado por kick e ban) — nunca espera a próxima reconexão pra começar a valer. Mute é checado no join (`p.muted`) e reforçado **em tempo real** pra quem já está conectado (`/api/admin/mute` varre `accountSockets` e liga o flag na conexão viva na hora, sem exigir reconexão) — os dois handlers de chat (`chat` e `guild_chat`) recusam com uma mensagem `muted` em vez de propagar a mensagem. `unban`/`unmute` marcam `revoked_at`/`revoked_by` (histórico nunca é apagado, só desativado) e, no caso do mute, também desligam o flag em tempo real.

## Prazo: calculado na leitura, nunca um job apagando histórico

Ban/mute com `expires_at` vencido continua com `revoked_at is null` no banco pra sempre (nunca reescrito nem apagado) — `activeAmong` (núcleo puro, testado exaustivamente) decide na hora da leitura se uma linha ainda vale (`!revoked_at && (!expires_at || expires_at > agora)`), tanto pro gate de login/WS quanto pro contador do dashboard. Histórico completo fica sempre disponível via `/api/admin/audit`, nunca truncado.

## Cargos: proteção contra travar o painel sozinho

`/api/admin/roles/revoke` recusa remover o **último** `owner` restante (checagem explícita antes de deletar) — sem essa trava, um único erro de clique zeraria `admin_roles` inteiro e ninguém mais conseguiria conceder cargo nenhum, exigindo acesso direto ao banco pra recuperar.

## Economia: somente leitura, de propósito

`/api/admin/economy` soma `gold`/`gem` de todas as `characters.save` reais e conta anúncios ativos/transações do Mercado — **nenhuma ação corretiva foi implementada** (dar/tirar ouro, cancelar transação à força) nesta fase, de propósito: o pedido é explícito que o painel nunca vire um "console de cheat". Se uma ação corretiva pontual for pedida numa fase futura, ela merece seu próprio fluxo auditado com motivo obrigatório e confirmação — não uma rota genérica de "editar economia".

## Log de segurança: lista explícita do que é gravado e do que NUNCA é

`admin_audit_log` grava `action` (kick/ban/unban/mute/unmute/role_grant/role_revoke), quem fez, alvo, motivo e uma `metadata` jsonb livre (ex.: prazo do ban, quantos sockets foram fechados). `sanitizeAuditMetadata` (núcleo puro, testado) filtra qualquer chave cujo nome contenha `password`, `token`, `service_role` ou `session` antes de gravar — mesmo que uma chamada futura passasse um desses campos por engano dentro de `metadata`, ele nunca chegaria no banco.

## Cliente: `admin.html` (separado do jogo)

Página isolada em `/admin` (servida pelo mesmo `server.js`, mapeada especificamente pra `admin.html` — nunca dentro de `index.html`/do canvas do jogo). Login reusa `/api/auth/login`; depois de autenticar, busca `/api/admin/me` pra saber cargo/permissões e monta a navegação só com as abas que o cargo realmente tem acesso (Painel, Jogadores, Economia, Guildas, Eventos, Cargos, Auditoria). Busca de jogador por nome de personagem com ações inline (kick/mute/ban/desmutar/desbanir) quando o cargo permite.

## Bootstrap do primeiro owner

`admin_roles` nasceu vazia — não existe nenhuma rota que crie o primeiro `owner` sozinha (seria um jeito de qualquer conta se auto-promover). O primeiro `owner` precisa ser inserido manualmente uma única vez (SQL direto no projeto, `insert into public.admin_roles (user_id, role) values ('<uuid da conta>', 'owner');`) — depois disso, essa conta usa o próprio painel (`/api/admin/roles`) pra conceder os demais cargos normalmente.

## Testes

`test/admin.test.js` (novo arquivo): **11 testes puros** (sempre rodam, sem Supabase) cobrindo a matriz de permissão inteira (cada cargo x cada permissão relevante), a sanitização de metadata (nunca deixa passar password/token/service_role/session) e o cálculo de ban/mute ativo (permanente ativo, prazo vencido nunca ativo, prazo futuro ativo, revogado sempre inativo, lista vazia nunca quebra) — mais **9 testes de integração real via HTTP/WebSocket** (`{skip:!hasSupabase()}`, mesma convenção do resto da suite): sem cargo nenhum é 403 em tudo; `support` vê dashboard/busca mas 403 em ban/economia/cargos; ban derruba quem está conectado na hora e bloqueia login novo; unban restaura o login; mute bloqueia chat em tempo real sem precisar reconectar; kick derruba uma conexão ativa; `owner` concede `moderator` a outra conta que passa a poder kickar mas não gerenciar cargos; nunca remove o último owner; toda ação de ban gera uma entrada de auditoria sem nenhum campo sensível.

## Verificação

Os 11 testes puros rodam de verdade e passam. Os 9 testes de integração foram escritos pra exercitar o fluxo HTTP/WS completo (login real, join real, chat real) mas **não puderam ser executados aqui**: rodá-los exigiria configurar `SUPABASE_URL`/`SUPABASE_SECRET_KEY` apontando pro projeto real (o único disponível — não existe um projeto de teste separado) e cada teste cria contas reais descartáveis (`newAccount`) e insere linhas reais em `admin_roles`/`player_bans`/`player_mutes` — a mesma convenção que todo outro teste `{skip:!hasSupabase()}` deste repositório segue ("projeto de TESTE, nunca o oficial") teria sido violada rodando contra o único projeto disponível. A correção foi verificada por revisão estática cuidadosa de cada rota (guard de permissão em toda rota, mute/ban aplicados em tempo real via `accountSockets`, prazo calculado só na leitura) e comparação direta com os padrões já comprovados do resto do código (`resolveUser`, `activeCharacterSockets`, `kickUserSockets` espelhando o fechamento de socket já usado por `session_replaced`). **Recomenda-se rodar `npm test` com `SUPABASE_URL`/`SUPABASE_SECRET_KEY` de um projeto de TESTE de verdade antes do próximo merge**, junto com os pendentes das Fases 5.13.1/5.13.2.

## Limitações conhecidas

- **Sem ação corretiva de economia** — de propósito, ver "Economia" acima.
- **Sem UI de duração de ban/mute no painel** (usa `prompt()` simples pro motivo, sem campo de prazo) — o protocolo servidor (`durationMs`) já aceita prazo, só a UI ainda não expõe um seletor; ban/mute via painel hoje sempre saem permanentes a menos que a API seja chamada diretamente com `durationMs`.
- **Bootstrap do primeiro owner é manual** (SQL direto), ver acima — decisão deliberada pra nunca existir uma rota de auto-promoção.
- **9 testes de integração não executados nesta sessão** — ver "Verificação" acima.
- **Nenhuma métrica de observabilidade além do dashboard básico** (online agora, bans/mutes ativos, atividade recente) — latência/erro-rate/uptime não fazem parte desta fase; o pedido de "métricas leves de observabilidade" foi interpretado como o dashboard administrativo em si, não um sistema de monitoramento de infraestrutura separado.

# FASE 5.15 — PORTAL PÚBLICO

**Escopo**: site público (`/portal`, `portal.html`) sem quebrar a URL do jogo (`/`) nem a do admin (`/admin`) — profissional, com status do servidor, rankings, guildas, eventos e um sistema simples de notícias gerenciável pelo painel admin (Fase 5.14).

## Reuso em vez de reconstrução: rankings e guildas já eram públicos

Antes de escrever qualquer rota nova, `/api/rankings` (Fase 5.10) foi revisado — já é **100% público** (nenhuma autenticação exigida) e já retorna só campos de exibição seguros (nome/classe/nível/tag de guilda/estatísticas, nunca `userId`/`characterId` real/token/save). `type=guild` já devolve exatamente `name`/`tag`/`memberCount`/`totalLevel`/`tvtWins`/`worldBossKills` — a informação pública de guilda pedida. O portal **reusa esse endpoint sem nenhuma mudança nele**, tanto para os rankings de jogador quanto para a lista de guildas — nenhuma rota nova foi criada para isso, e o cache de 45s que ele já tinha (`RANKINGS.createRankCache`, Fase 5.10) já atende à janela de 30-60s pedida.

## API nova: só o que realmente faltava

`handlePublic` (`server.js`, montado em `/api/public/*`, sem autenticação nenhuma):
- `GET /api/public/status` — população (`{human, ai}` — `ai` sempre `0` porque a Fase 5.16/Aventureiros IA ainda não existe; o formato já fica pronto pra quando existir, sem precisar mudar o contrato depois), se o World Boss está ativo agora, horário do próximo World Boss/próximo Team vs Team (reusa `EVENT_DATA.scheduleAfter`, Fase 5.5, sem nenhuma mudança nele), contagem de guildas.
- `GET /api/public/events` — próximos 8 eventos agendados (mesma fonte de sempre).
- `GET /api/public/news` — notícias publicadas, mais recentes primeiro (`title`/`body`/`published_at` — nunca `author_user_id`, que fica só na tabela e nas rotas administrativas).

Todas as três usam a **mesma fábrica de cache TTL** já criada na Fase 5.10 (`RANKINGS.createRankCache()`, uma instância nova `publicCache`) — 45s por padrão, dentro da janela de 30-60s pedida — mais o header HTTP `Cache-Control: public, max-age=30` (status/eventos) ou `max-age=60` (notícias) pra CDNs/navegadores também poderem cachear.

## Privacidade: nunca os campos proibidos

Nenhuma rota de `/api/public/*` toca em `resolveUser`/token/sessão — são as únicas rotas do projeto que respondem sem checar credencial nenhuma, de propósito. `user_id`, `email`, `save` (inventário/ouro/gemas reais), token, sessão, cargo de admin e qualquer ação de moderação nunca aparecem em nenhuma resposta — testado explicitamente (`test/portal-public.test.js`, varre a resposta inteira procurando essas substrings). `/api/public/news` nunca inclui `author_user_id` (só é lido internamente pra auditoria).

## Notícias: gerenciável pelo admin, publicado na hora

`portal_news` (migração aditiva, RLS sem policy — mesmo padrão das 17 tabelas já existentes) + duas rotas novas em `handleAdmin` (`POST /api/admin/news`, `POST /api/admin/news/delete`), gated pela permissão nova `manage_news` (só `owner`/`admin` — nunca `moderator`/`support`). Publicar ou excluir uma notícia limpa o `publicCache` inteiro (`publicCache.clear()`) — a notícia aparece na API pública **imediatamente**, sem esperar o TTL de 60s expirar sozinho. `admin.html` ganhou uma aba "Notícias" (formulário simples título+texto, lista com botão excluir) reusando a mesma leitura pública (`/api/public/news`) pra não duplicar lógica de listagem.

## Cliente: `portal.html` (separado do jogo e do admin)

Página pública em `/portal` — hero com call-to-action "Jogar agora" (linka pra `/`, nunca quebra a URL do jogo), cards de status, abas de ranking (reusando `/api/rankings` direto do navegador), tabela de próximos eventos, lista de notícias. SEO básico: `<title>` descritivo, `<meta name="description">`, tags Open Graph mínimas. Responsivo (grid flexível `auto-fit`, tipografia com `clamp()`, um breakpoint simples de mobile) — sem framework, mesmo espírito leve de `admin.html`.

## Testes

`test/portal-public.test.js` (novo arquivo — nome distinto de `test/portal.test.js`, que já existia e testa a tela de viagem "portal" dentro do jogo, um conceito diferente): **1 teste puro** (sempre roda, sem Supabase — contrato do cache TTL: hit dentro da janela nunca reexecuta a função de origem) + **7 testes de integração real via HTTP** (`{skip:!hasSupabase()}`, mesma convenção do resto da suite): status/eventos/notícias respondem sem autenticação nenhuma, o formato de população humano/IA está presente (IA sempre 0), nenhum campo proibido vaza em nenhuma resposta pública, notícia publicada pelo admin aparece na API pública na hora (cache limpo no publish), e `moderator` (sem `manage_news`) não consegue publicar.

## Verificação

O teste puro roda de verdade e passa. Os 7 de integração foram escritos pra exercitar o fluxo HTTP completo mas não puderam ser executados aqui — mesma razão já documentada nas Fases 5.13.1/5.13.2/5.14 (sem Supabase de teste configurado neste sandbox, e o único projeto Supabase disponível é o de produção real, onde não se deve rodar testes que criam contas descartáveis). A correção foi verificada por revisão estática (toda rota pública revisada campo a campo contra a lista de proibidos, cache invalidado explicitamente no publish/delete de notícia) e por reuso direto de rotas já testadas e comprovadamente públicas (`/api/rankings`, Fase 5.10). **Recomenda-se rodar `npm test` com Supabase de TESTE de verdade antes do merge**, junto com os pendentes das fases anteriores.

## Efeito colateral: corrigido um problema pré-existente na suite de testes

Durante a verificação desta fase, percebi que `test/blacksmith.test.js` e `test/monster-movement.test.js` usavam a **mesma porta** (8113) — uma colisão pré-existente (não introduzida nesta sessão) que podia causar `EADDRINUSE` intermitente quando os dois rodam em paralelo (comportamento padrão do `node:test`). Corrigido movendo `monster-movement.test.js` pra uma porta livre (8115). Contagem final da suite completa, confirmada por soma independente de cada arquivo: **498 testes / 323 passando / 0 falhando / 175 pulados**.

## Limitações conhecidas

- **`ai` sempre 0 em `/api/public/status`** — de propósito, ver acima; passa a refletir a realidade automaticamente quando a Fase 5.16 existir, sem precisar mudar o contrato da API.
- **Notícias sem edição** (só publicar/excluir) — pedido era um sistema "simples", editar um título/texto publicado não foi considerado essencial; excluir e republicar já cobre o caso de correção.
- **7 testes de integração não executados nesta sessão** — ver "Verificação" acima.
- **Nenhuma migração de banco além de `portal_news`** — aditiva, mesmo padrão das fases anteriores.

# FASE 5.16 (TIER 1) — LIVING WORLD / AVENTUREIROS IA (NÚCLEO)

**Escopo**: camada de IA server-side (nunca navegador, nunca conta Supabase) que povoa as zonas de campo com "Aventureiros" simulados — um FSM determinístico, combate real usando a mesma autoridade dos humanos, isolamento econômico absoluto. Esta seção documenta o **núcleo** (entidade/FSM/combate de campo/visibilidade/isolamento). O preenchimento de masmorra e TvT por IA (Dungeon Fill / TvT Fill) é uma fase seguinte, documentada em separado quando pronta.

## Nunca um processo de navegador, nunca uma conta fake — e nunca um LLM em runtime

Cada Aventureiro IA é só um objeto em memória (`aiEntities`, `Map<id, entity>`) — nenhum WebSocket, nenhuma linha em `users`/`characters`, nenhum processo/aba de navegador. Simulado por um tick determinístico (`aiTick`, reaproveitando o mesmo `setInterval` de 1s que já existia — dentro da janela de 500-1000ms pedida, sem criar um timer novo). **Nenhuma chamada a LLM em lugar nenhum** — o "cérebro" da IA é um FSM com heurísticas simples (raio de agressividade, limiar de fuga por personalidade, seleção por zona menos povoada), nunca uma API de IA generativa.

## FSM: os 12 estados pedidos, todos realmente alcançáveis

`idle` → decide (mob por perto? `hunt`; senão `wander` ou raramente `travel`) · `wander` → passeio aleatório, pode virar `hunt` se um mob aparecer no raio · `travel` → realocação pra outra zona (ver limitação de "viagem" abaixo) · `hunt` → persegue o mob alvo · `combat` → ataca (ou foge, se HP abaixo do limiar de personalidade) · `retreat` → foge do alvo por alguns segundos · `rest` → recupera HP passivamente antes de voltar a `idle` · `dead`/`respawn` → aguarda o prazo e reaparece. `party`/`queue`/`dungeon`/`tvt` são os estados reservados pro preenchimento de masmorra/TvT (Fase seguinte) — o switch já os reconhece (no-op controlado externamente), preparados sem serem enfeite morto.

## Combate: a MESMA autoridade dos humanos, nunca uma fórmula paralela

`aiDoCombat` chama `resolveAttackDamage(ai, {skill:'basic'}, now)` — a função exportada desde a Fase 5.12 e usada por **todo** dano do jogo — com o próprio objeto da IA no lugar de `p`. Cooldown, teto de dano, fórmula por classe/nível: tudo idêntico. Mobs de campo também **revidam de verdade**: `tickMobAI` agora inclui `aiPresentOnMap(mapId)` na lista de alvos possíveis, e `hitTarget` ganhou um ramo pra IA (`aiEntities.get(p.id)===p` no lugar do `clients.get(ws)===p` de um jogador real) — combate nos dois sentidos, a IA pode morrer de verdade e não é uma entidade fantasma que só bate e nunca apanha.

## Equipamento simulado — nunca um item real

`buildAiSave`/`buildAiCombat` geram um `save` descartável em memória, com `createGear()` (a mesma função real) numa arma da classe — nunca gravado em `bag`/`eq` de personagem nenhum, sem UID reconhecido por `lockOwnedItems`/Mercado/encantamento. **Detalhe técnico descoberto durante a implementação**: `GEAR_DATA.statsFor` só tem tabela de stats pros níveis de tier reais do jogo (1/4/8/12/16/20/24/28/32/36/40) — um nível arbitrário (ex. 15) retorna `null` e `createGear` silenciosamente não equipa nada. `aiGearTierFor(lvl)` arredonda sempre **pra baixo** pro tier válido mais próximo (nunca pra cima — nunca "empresta" um requisito de nível maior que o real da IA) antes de gerar o item.

## Nível/zona: derivado do próprio manifesto de mobs, nunca uma tabela paralela

`aiZoneLevelRange(zone)` lê o `MOB_MANIFEST[zone]` já existente (a mesma fonte que define os mobs reais de cada zona) pra descobrir a faixa de nível apropriada — uma IA em `floresta` luta como `floresta` pede, sem duplicar a curva de dificuldade em lugar nenhum.

## Distribuição de população: sempre a zona menos povoada, nunca concentrada

`aiPopulationTick` conta quantas IA já existem por zona (`AI_FIELD_ZONES`, as 7 zonas de campo — nunca `vila`, hub social sem mobs) e sempre spawna na zona com **menos** IA no momento — nunca deixa a população inteira se acumular numa zona só. Teto conservador de partida: `AI_MAX_POPULATION=10` (ver limitações — não foi possível medir carga real nesta sessão pra calibrar um teto por benchmark, como pedido).

## Visibilidade: mesmo pipeline de sempre, indicador discreto

Uma IA aparece pra jogadores reais via `player_join`/`state`/`player_leave` — **exatamente** as mesmas mensagens que um jogador real já usava — com um campo `kind:'ai'` a mais (`aiPublicPlayer`, espelha `publicPlayer` campo a campo). Isso significa **zero código novo de desenho no cliente**: o mesmo `drawRemote` que já desenhava outros jogadores desenha a IA automaticamente. A única mudança de cliente foi o rótulo (`index.html`, `drawRemote`): cor diferente + sufixo `[IA]` quando `p.kind==='ai'` — nunca esconde, nunca finge ser humano. `charId` é sempre `null` no payload público — nenhuma IA pode ser confundida com um personagem real em nenhuma tela.

## Isolamento econômico — a REGRA ABSOLUTA, garantida estruturalmente

Uma entidade de IA **nunca** tem `userId`/`charId` reais (sempre `null`) — cada função que credita economia (`creditKillReward`, `creditDungeonReward`, `applyGearDrops`, `creditBestiaryKill`, qualquer rota de Mercado) já rejeita entrada sem `charId`/`userId` válidos por construção própria, **e** o próprio caminho de combate da IA (`aiDoCombat`) nunca chama nenhuma dessas funções — quando a IA mata um mob (de campo ou de masmorra), o mob morre pro mundo (broadcast idêntico a um abate real) mas a recompensa da IA é sempre ZERO, nunca uma checagem condicional que poderia ser esquecida num caminho novo. A lógica de recompensa de masmorra foi **extraída** pra uma função só (`dungeonHandleMobDeath`, reusada pelo handler `mob_damage` de sempre E pelo combate da IA) com um guard explícito `if (member.kind==='ai') continue;` **antes** de qualquer chamada de crédito — testado com um membro de IA com `userId`/`charId` propositalmente parecendo válidos, pra provar que a exclusão é pelo `kind`, não um acidente de campo vazio.

## Observabilidade: sempre marcada, nunca escondida, nunca inflando o humano

`/api/admin/dashboard` ganhou `aiOnline` (separado de `online`, nunca somado) e uma rota nova `GET /api/admin/ai` (lista completa, cada entrada sempre `kind:'ai'`). `/api/public/status` (Fase 5.15) agora reporta `population.ai` real (`aiEntities.size`) em vez do `0` fixo temporário — nunca misturado com `population.human` (fontes totalmente separadas: `clients` vs `aiEntities`), o número de humanos online nunca é falsificado pela presença de IA.

## Limpeza rigorosa — sem vazamento

Nenhuma IA tem seu próprio `setTimeout`/`setInterval` — tudo roda no único tick de 1s compartilhado, então não existe timer nenhum pra vazar por entidade. `aiDespawnEntity` só remove do `Map` e manda `player_leave` — sem referência pendurada em lugar nenhum.

## Gate de testes: `AI_ENABLED` desligado por padrão em toda suite

Durante a verificação, uma IA que nasceu automaticamente (`aiPopulationTick`) dentro do processo filho de `test/monster-movement.test.js` interferiu num teste sensível a tempo (`alvo desconectado e trocado sem paralisar a perseguição`) — um ator não controlado apareceu no mapa compartilhado do teste, quebrando uma suposição implícita sobre quem está presente. Corrigido com `aiEnabled()` (função, não uma const congelada — lê `process.env.AI_ENABLED` a cada chamada) e `test/helpers.js` passando `AI_ENABLED:'0'` pra **todo** servidor de teste por padrão — nenhuma suite depende de atores não controlados aparecendo sozinhos. Criar uma IA manualmente (`aiSpawnEntity` direto, como os testes puros fazem, ou um preenchimento de fila/TvT futuro) nunca depende dessa flag — só o spawn automático em segundo plano é afetado. Confirmado com 3 execuções consecutivas e limpas da suite completa após a correção.

## Testes

`test/ai.test.js` (novo arquivo): **16 testes puros** (sempre rodam, sem Supabase, sem esperar o tick real de 1s — FSM exercitado chamando `aiStep`/`aiDoCombat` diretamente com timestamps forjados): geração de stats/equipamento simulado por classe (nunca `maxHp` zero, nunca `userId`/`charId` reais), tier de equipamento sempre arredondado pra baixo, faixa de nível derivada do manifesto real, perfis de personalidade realmente distintos, spawn/despawn sem deixar rastro no Map, teto de população respeitado, formato `publicPlayer`-compatível com `kind:'ai'`, distribuição pra zona menos povoada, gate `AI_ENABLED` respeitado, ciclo completo idle→hunt→combat→mob morto, fuga por HP baixo, morte/respawn no prazo certo, e as duas REGRAS ABSOLUTAS (nenhuma recompensa creditada a um membro `kind:'ai'` mesmo com campos parecendo válidos; nenhuma função de economia mencionada no código-fonte do FSM de combate) — mais **2 testes de integração real via WebSocket/HTTP** (`{skip:!hasSupabase()}`, mesma convenção do resto da suite, usando um servidor com `AI_ENABLED:'1'` explícito): uma IA aparece pra um jogador humano real via `player_join` dentro de 15s, e `/api/admin/ai`/`aiOnline` no dashboard funcionam de ponta a ponta.

## Verificação

Os 16 testes puros rodam de verdade e passam — cobrem o núcleo inteiro (geração de stats, FSM, distribuição, as duas regras absolutas) sem depender de Supabase. Adicionalmente, o ciclo completo foi verificado manualmente em Node antes de escrever o teste formal (`aiSpawnEntity`→`aiStep` repetido→mob morto, `aiDespawnEntity`→Map vazio), e a suite completa do projeto (518 testes) rodou **3 vezes consecutivas sem nenhuma falha** após corrigir o problema de interferência entre processos. Os 2 testes de integração via WebSocket foram escritos pra provar o fluxo real mas não puderam ser executados aqui pela mesma razão já documentada nas fases anteriores (sem Supabase de teste configurado neste sandbox). **Recomenda-se rodar `npm test` com Supabase de TESTE antes do merge**, junto com os pendentes das fases anteriores.

## Limitações conhecidas

- **Sem colisão de parede pra IA em mapa de campo** — mesma limitação pré-existente de todo mob de campo (documentada desde fases anteriores: "a geometria de paredes de mapa de campo ainda vive só no cliente"); IA pode visualmente atravessar cenário decorativo, nunca um problema de segurança/economia.
- **"Viajar" entre zonas é uma realocação direta, não uma caminhada real** — zonas de campo não são espacialmente contíguas no servidor (cada uma é um `mapState()` isolado); documentado no próprio código, nunca escondido.
- **Zona nunca visitada por humano fica sem mobs pra IA caçar** (`state.mobs` só é populado quando o primeiro `map_join` real de um jogador chega, com posições que só o cliente conhece) — IA nessas zonas só vagueia (`wander`) até um jogador real aparecer; decisão deliberada pra não inventar um sistema paralelo de posicionamento de mob sem colisão real. Nunca acontece nas zonas onde já existe atividade humana (o caso comum).
- **Teto de população (10) não veio de um benchmark de carga real** — o pedido era "benchmark-então-teto"; não havia como gerar carga real de produção nesta sessão. Valor de partida conservador, documentado como tal, pronto pra ser recalibrado com dados reais depois do deploy.
- **Dano recebido de mob não gera feedback visual pra outros jogadores olhando a IA** (`mob_hit` não é transmitido quando o alvo é IA) — simplificação deliberada: a IA não tem HP visível em `publicPlayer` mesmo (igual jogador remoto real, que também não mostra barra de vida pros outros), então o feedback visual não faria diferença nenhuma hoje.
- **Nenhuma migração de banco** — toda a camada de IA é em memória; nada foi persistido no Supabase (e nunca deveria ser, pela própria regra absoluta).

# FASE 5.16 (TIER 2) — AI DUNGEON FILL + AI TVT FILL

**Escopo**: integra o núcleo de IA (Tier 1) com o matchmaking de masmorra (Fase 5.13.2) e com Team vs Team — preenchendo vagas restantes só depois de esgotada a prioridade humana, nunca substituindo um humano disponível.

## AI Dungeon Fill: só entra se pedido, só depois dos humanos resolvidos

`formDungeonGroup` (Fase 5.13.2) já recebia `group` com o flag `allowAiFill` de cada entrada da fila. Depois de validar e montar a Party só com os humanos reais (nenhuma mudança nessa parte), se **alguém do grupo pediu `allowAiFill`** e ainda sobra vaga até 4, a IA entra pro resto — nunca antes disso, nunca reduzindo quantos humanos entrariam. Seleção de classe **consciente**: prioriza uma classe que o grupo ainda não tem (`AI_CLASS_POOL.find(c => !haveClasses.has(c))`), só cai pra aleatória se todas já estiverem representadas — nunca aleatória pura. A entidade de IA nasce direto dentro da instância (`map: state.id`, `fsm:'idle'`) — o mesmo idle→hunt→combat do núcleo de campo já funciona ali sem nenhuma mudança, porque uma instância de masmorra é só mais um `mapState()` com `.mobs` como qualquer outra. **IA nunca vira membro persistente de Party nenhuma** — só entra em `state.members` (memória da instância), nunca em `parties`/`memberParty`.

`buildDungeonInstance` (Fase 5.13.1) ganhou um campo `kind` no `state.members` (`'human'` por padrão, `'ai'` quando vem de `formDungeonGroup`) — usado por `dungeonHandleMobDeath` pra nunca creditar um membro de IA, e a IA **conta pro cálculo de escala de HP** igual um humano (participante ativo de verdade, testado explicitamente: 1 humano + 1 IA escala pra 1.55×, igual 2 humanos escalariam).

## AI TvT Fill: reservas humanas sempre primeiro, times sempre balanceados

`startTvtEvent` mudou de "cancela se não bater o mínimo" pra: reserva humana tratada **antes** de qualquer IA existir (nenhuma mudança nisso), carrega os personagens reais, e só então `tvtFillTargetSize(loaded.length)` (núcleo puro, testado exaustivamente) decide o tamanho final do time — sempre par, sempre pelo menos `TVT_MIN_PLAYERS`, nunca acima de `TVT_MAX_PLAYERS`, **nunca descarta um humano que se inscreveu** pra caber num número par (o corte por imparidade que existia antes foi removido — agora a IA fecha a diferença). Nível da IA = média dos humanos reais carregados, pra ficar equilibrado. Os times (humanos + IA misturados) passam pelo **mesmo** `TVT.balanceTvtTeams` de sempre (powerScore + composição de classe) — a IA participa do balanceamento como qualquer jogador, nunca um "extra" desequilibrando o time.

## Combate de TvT: a MESMA função autoritativa, nunca um caminho paralelo

`aiDoTvt` chama `TVT.resolveTvtIntent(instance, ai.id, {skill:'basic', targetId}, now, secureRandom)` — a **exata mesma função** que resolve o ataque de um jogador humano real (mesmo cooldown via `attacker.lastAttackAt`/`snapshot.basicCdMs`, mesma fórmula de dano, mesma mitigação por `def`/bloqueio/barreira, mesma proteção de spawn de 3s). `instance.players` é sempre a fonte de verdade de HP/posição/morte — a entidade de IA só espelha esse estado (`ai.hp = tp.hp`, etc.) pra fins de broadcast/renderização, nunca o contrário.

**Proibições explícitas de trapaça, cumpridas por construção**:
- **Sem wallhack**: a IA só considera alvos que já estão em `instance.players` (a mesma informação que o cliente de um jogador real recebe via `tvt_state`), nunca nada fora disso.
- **Sem mira instantânea**: precisa se mover de verdade até o alcance (mesma velocidade do núcleo de campo, `AI_MOVE_SPEED`) — nunca teleporta até o alvo.
- **Sem bypass de cooldown**: `resolveTvtIntent` aplica o cooldown em cima do próprio `attacker.lastAttackAt`/`skillCd` — o mesmo campo que travaria um humano tentando atacar rápido demais.
- **Sem bônus escondido**: usa o mesmo `snapshot` (atk/def/maxHp) derivado de `combatSnapshot`, a mesma fórmula de dano — nada de multiplicador secreto pra IA.
- **Latência de reação simulada**: `ai.tvtEngageAt` atrasa 200-600ms o primeiro ataque contra um alvo recém-adquirido — testado explicitamente que a IA **nunca** ataca no mesmo tick em que avista alguém pela primeira vez.

Abates/dano da IA contam pro **placar da partida** (`instance.score`, mesmo mecanismo de sempre — a IA participa do resultado de verdade) mas nunca são somados às estatísticas competitivas humanas permanentes: `grantTvtRewards` ganhou um guard `if (member.kind==='ai') continue;` logo no início do loop — nenhuma IA nunca chega perto de `bumpRankStat('tvt_kills', ...)`/`syncRankLevelXp`/gold/gem, mesmo que tenha acumulado `damageDone`/`kills` reais na partida.

## Visibilidade e limpeza — reusa tudo do Tier 1

`game-data/tvt.js` ganhou um campo `kind` em `createTvtInstance` (no player) e em `publicTvtState` (no payload público) — o cliente já reusa o mesmo `drawRemote` com o rótulo `[IA]` do Tier 1 pra jogadores dentro da arena, sem nenhum código novo. `aiTick` agora transmite `state` pra **toda** IA a cada tick (antes só fazia isso pra IA "livre" de campo — corrigido, senão IA preenchendo masmorra/TvT ficaria parada visualmente pros outros jogadores). Ao fim da partida/instância, `finishTvtInstance` e `dungeonCleanupTick` despacham (`aiDespawnEntity`) qualquer IA que estivesse alocada ali — nunca fica presa apontando pra uma instância que já acabou.

## Testes

`test/ai-fill.test.js` (novo arquivo): **11 testes puros** (sempre rodam, sem Supabase, sem esperar tick real): `tvtFillTargetSize` em toda a faixa relevante (par suficiente, abaixo do mínimo, ímpar acima do mínimo sempre arredonda pra cima nunca descarta humano, nunca ultrapassa o máximo), `buildDungeonInstance` com humano+IA misturados (`kind` correto, escala de HP conta a IA), a REGRA ABSOLUTA da masmorra com membros mistos (só o humano gera tentativa de crédito), `aiDoTvt` completo (nunca ataca no primeiro tick, ataca de verdade após a latência via `resolveTvtIntent`, nunca ataca morta), e a REGRA ABSOLUTA do TvT (`grantTvtRewards` tem o guard explícito) — mais **1 teste de integração real via matchmaking de masmorra** (`{skip:!hasSupabase()}`, 3 humanos reais + `allowAiFill`, esperando o prazo real de fallback de 25s — lento de propósito, mesmo espírito de outros testes de integração já existentes que priorizam correção sobre velocidade).

## Verificação

Os 11 testes puros rodam de verdade e passam. Além disso, o ciclo completo foi verificado manualmente em Node antes do teste formal: `buildDungeonInstance` com humano+IA misturados, e uma instância de TvT real (`TVT.createTvtInstance`) com um combate de verdade entre humano e IA rodado via `aiDoTvt` repetido — confirmando dano real aplicado e contribuição registrada em `instance.players`. Um teste WS de AI Dungeon Fill foi escrito mas não executado aqui (sem Supabase de teste neste sandbox); o teste de AI TvT Fill via fluxo HTTP/WS completo (agendamento real de evento) não foi escrito nesta sessão — a cobertura do combate de TvT em si (a parte de maior risco) já é extensiva nos testes puros. **Recomenda-se rodar `npm test` com Supabase de TESTE antes do merge**, junto com os pendentes de todas as fases anteriores.

## Limitações conhecidas

- **AI TvT Fill não tem teste de integração HTTP/WS de ponta a ponta** (agendamento real do evento, `startTvtEvent` chamado pelo EventManager de verdade) — só o núcleo de combate (`aiDoTvt`+`resolveTvtIntent`) e o dimensionamento (`tvtFillTargetSize`) foram testados isoladamente, com alta confiança, mas não o fluxo inteiro de agendamento-até-partida.
- **AI Dungeon Fill: só um teste de integração real, com o caminho mais rápido (fallback de 3, 25s)** — os caminhos de 2 e 1 (solo com opt-in) usam a mesma lógica de preenchimento (código compartilhado), não foram testados separadamente via WS pela mesma lentidão real desses prazos (45s/60s).
- **Nível da IA de TvT é sempre a média dos humanos da partida** — nunca varia por "papel"/build dentro da classe; uma calibração mais fina de dificuldade fica pra uma iteração futura, se pedida.
- **Nenhuma migração de banco** — toda a integração é em memória.
