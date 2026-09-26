# FASE 5.17 — Progressão Hardcore & Economia x1

> Substitui a antiga "5.17 Guild Wars". **Guild Wars passa a ser a Fase 5.18** (planejada, não implementada aqui).

Fonte única de todos os números desta fase: [`game-data/balance-data.js`](../game-data/balance-data.js).
Simulador reprodutível: `node tools/balance-sim.js` (`--derive` propõe uma nova `XP_TO_NEXT`; `--raw` mostra os valores brutos por nível).

## 1. Filosofia

- **x1 de verdade:** level pesa, equipamento vale, raridade é rara, gema é moeda de progressão.
- **Tempo, não parede:** as regiões são faixas de balanceamento, não bloqueios. O jogador pode caçar acima ou abaixo da faixa; a XP por diferença de level faz o trabalho.
- **Nada de grind único:** combate é a base, mas quest, masmorra, World Boss e TvT somam. Mob fraco rende pouco ou nada, e nenhuma atividade repetível gera gema sem limite.
- **Servidor autoritativo:** o servidor decide XP, level, ouro, gema, raridade dropada, sucesso, chance e custo de enchant. O cliente só **exibe** esses números, lidos do mesmo `balance-data.js`.

## 2. Level cap

- `LEVEL_CAP = 40` é absoluto: nenhum caminho gera Lv41.
  - `BALANCE.applyXp` para em 40.
  - `sanitizeSave` limita o level.
  - PUT, WS join, `patchCharacterFields`, GET `/api/characters`, `world-boss.js` e os levels de IA usam `clampLevel`.
- No Lv40, a XP recebida é **descartada** (sem XP escondida). A XP salva fica sempre em 0.
- HUD: mostra `Lv 40 MAX`, barra em 100% e o texto "XP MAX (Nv 40)" na ficha.
- Rankings continuam iguais: recebem `lvl/xp` normalizados a cada gravação.

## 3. Curva de XP (Lv1–39 → próximo)

| Lv | XP p/ próximo | XP acumulada | Região |
|---:|---:|---:|---|
| 1 | 2.360 | 0 | Vila |
| 2 | 4.330 | 2.360 | Vila |
| 3 | 7.040 | 6.690 | Vila |
| 4 | 7.330 | 13.730 | Vila |
| 5 | 14.100 | 21.060 | Floresta |
| 6 | 19.700 | 35.160 | Floresta |
| 7 | 28.300 | 54.860 | Floresta |
| 8 | 36.800 | 83.160 | Floresta |
| 9 | 47.900 | 119.960 | Floresta |
| 10 | 61.900 | 167.860 | Cripta |
| 11 | 79.100 | 229.760 | Cripta |
| 12 | 100.000 | 308.860 | Cripta |
| 13 | 111.000 | 408.860 | Cripta |
| 14 | 124.000 | 519.860 | Cripta |
| 15 | 137.000 | 643.860 | Serra |
| 16 | 150.000 | 780.860 | Serra |
| 17 | 165.000 | 930.860 | Serra |
| 18 | 186.000 | 1.095.860 | Serra |
| 19 | 209.000 | 1.281.860 | Serra |
| 20 | 236.000 | 1.490.860 | Pântano |
| 21 | 266.000 | 1.726.860 | Pântano |
| 22 | 301.000 | 1.992.860 | Pântano |
| 23 | 328.000 | 2.293.860 | Pântano |
| 24 | 354.000 | 2.621.860 | Pântano |
| 25 | 380.000 | 2.975.860 | Torre |
| 26 | 407.000 | 3.355.860 | Torre |
| 27 | 433.000 | 3.762.860 | Torre |
| 28 | 454.000 | 4.195.860 | Torre |
| 29 | 477.000 | 4.649.860 | Torre |
| 30 | 506.000 | 5.126.860 | Ilhas |
| 31 | 536.000 | 5.632.860 | Ilhas |
| 32 | 568.000 | 6.168.860 | Ilhas |
| 33 | 621.000 | 6.736.860 | Ilhas |
| 34 | 682.000 | 7.357.860 | Ilhas |
| 35 | 747.000 | 8.039.860 | Vulcão |
| 36 | 819.000 | 8.786.860 | Vulcão |
| 37 | 899.000 | 9.605.860 | Vulcão |
| 38 | 996.000 | 10.504.860 | Vulcão |
| 39 | 1.090.000 | 11.500.860 | Vulcão |
| 40 | MAX | 12.590.860 | — |

**Como a curva foi derivada** (`tools/balance-sim.js --derive`). A antiga `30 × level` foi removida.
1. Para cada nível L, o simulador calcula a XP/h de combate:
   - HP e XP reais dos mobs da região (`mobStats`);
   - DPS médio das 4 classes, usando as fórmulas do servidor e gear Basic do nível;
   - overhead por abate;
   - chefes de campo;
   - fontes proporcionais ao need (masmorra, World Boss, TvT).
2. `need(L) = horas-alvo(L) × XP/h`. As horas-alvo são o ponto médio da região, distribuídas com peso crescente dentro dela.
3. Suavização em escala log (média móvel de 5 níveis) e monotonia estrita (+4% mínimo por nível). A Vila (Lv1–4) fica sem suavização, porque é o tutorial.
4. Arredondamento para 3 algarismos significativos.

## 4. Regiões e horas-alvo

Estimativas do simulador: premissas em `PROFILES`, seed fixa.

| Região | Níveis | Alvo (ativo) | Muito eficiente | **Ativo normal** | Casual/solo |
|---|---|---|---:|---:|---:|
| Vila | 1–5 | 2–3h | 1,6 | **2,5** | 3,5 |
| Floresta | 5–10 | 6–8h | 4,1 | **6,2** | 8,6 |
| Cripta | 10–15 | 12–15h | 8,5 | **11,6** | 14,9 |
| Serra | 15–20 | 15–20h | 12,2 | **16,4** | 21,2 |
| Pântano | 20–25 | 20–25h | 15,0 | **20,4** | 27,1 |
| Torre | 25–30 | 22–28h | 17,8 | **22,9** | 29,7 |
| Ilhas | 30–35 | 28–35h | 23,7 | **29,5** | 38,1 |
| Vulcão | 35–40 | 35–45h | 31,7 | **39,0** | 51,1 |
| **Total 1→40** | | 140–180h | **114,6** (alvo 110–130) | **148,5** (meta ~150) | **194,1** (alvo 180–220) |

**Premissas por perfil:**

| Perfil | Overhead por kill | Tempo em combate | Horas/dia | Masmorra/h | WB/dia | TvT/dia |
|---|---:|---:|---:|---:|---:|---:|
| Muito eficiente | 4,5s | 92% | 5 | 0,5 | 2 | 2 |
| Ativo | 7s | 85% | 3 | 0,35 | 1 | 1 |
| Casual | 9,5s | 78% | 1,5 | 0,2 | 0,2 | 0,3 |

Cada clear de masmorra dura 15 minutos, e WB e TvT duram 10 minutos cada.

**Isto é estimativa, não garantia.** Para reajustar, mude `REGIONS.hours` ou as premissas, rode `--derive` e cole a tabela nova.

## 5. Fontes de XP

| Fonte | Regra (servidor) |
|---|---|
| Mob de campo | XP base de `mobStats` × **gap de level** × share de party × boost de evento (×1). Séquito temporário paga 50%. |
| Chefe de campo | Mesma regra (gap aplicado). Respawn de 60s inalterado. |
| Missão | Fração da `XP_TO_NEXT` do **nível adequado** do estágio: simples 6%, principal 12%, final de capítulo 22%. Os estágios "portal liberado" (6/10/14/18/22/26) passaram a pagar XP de capítulo pelo mesmo caminho idempotente. |
| Masmorra | O trash continua sem XP. **Conclusão (chefe):** 6% da `XP_TO_NEXT` do próprio nível × gap(chefe − jogador), nos **4 primeiros clears do dia**. |
| World Boss | 4% da `XP_TO_NEXT` do próprio nível, nas **2 primeiras participações do dia**. |
| TvT | Vitória 2%, empate 1,5%, derrota 1% da `XP_TO_NEXT`, nas **2 primeiras do dia**. |
| Bestiário | 0 (não existe recompensa hoje — hook futuro, ver §14). |

**Participação por fonte** (ciclo 1→40, perfil ativo; meta de design, não trava):

| Fonte | Real | Meta |
|---|---:|---:|
| Mobs | 68,0% | 50% |
| Masmorra | 13,6% | 12% |
| World Boss | 7,7% | ≈6% (bosses + WB) |
| Missões | 5,5% | 20% |
| TvT (eventos) | 2,9% | 5% |
| Chefes de campo | 2,4% | (em bosses) |
| Bestiário | 0% | 4% |

⚠ **Para revisão:** missões ficam em 5,5% porque o jogo tem só 15 estágios. Chegar a 20% exigiria missões novas ou daily/weekly, o que ficou fora de escopo. Isso não foi compensado inflando a XP das quests, porque o prompt fixa as frações por missão. A diferença foi absorvida pelo combate.

## 6. XP por diferença de level (`mobLevel − playerLevel`)

| Diferença | Multiplicador |
|---|---:|
| −8 ou menos | 0% |
| −6 a −7 | 25% |
| −5 | 50% |
| −3 a −4 | 70% |
| −1 a −2 | 90% |
| 0 | 100% |
| +1 | 105% |
| +2 | 110% |
| +3 ou mais | 115% (máximo) |

Onde se aplica:
- abate de campo (inclusive chefes de campo);
- XP de conclusão de masmorra (gap entre chefe e jogador).

World Boss e TvT usam a regra própria (fração do próprio need, sem gap).

O cálculo usa o **nível persistido** no banco (nunca `p.lvl` nem nada vindo do cliente).

## 7. Drop de equipamento (`BALANCE.DROP_RATES`)

| Fonte | Rare | Epic | Legendary |
|---|---:|---:|---:|
| Mob comum (campo e trash de masmorra) | 0,30% | 0,03% | 0% |
| Elite | 3% | 0,30% | 0% |
| Chefe de masmorra | 12% | 2,5% | 0,30% |
| World Boss (roll **individual** por membro elegível) | 30% | 7% | 1% |

Regras:
- **Um único roll** mutuamente exclusivo (faixas acumuladas Legendary → Epic → Rare). O segundo roll só escolhe o tipo, então sai no máximo 1 item por roll.
- RNG injetável nos testes. O cliente nunca envia rarity, type ou lv.
- O 5% genérico de Legendary em boss deixou de existir, assim como o Legendary **garantido** para 1 membro aleatório do World Boss.
- ⚠ **Decisão conservadora (revisar):** "elite" não existe como mob. O **chefe de campo usa a tabela Elite**, porque o respawn de 60s tornaria Legendary farmável com a tabela de chefe de masmorra. Configurável em `FIELD_BOSS_DROP_TIER`.
- Itens antigos não são convertidos nem rerrolados.

Expectativa:

| Fonte | Rare | Epic | Legendary |
|---|---:|---:|---:|
| 1.000 kills de mob comum | 3 | 0,3 | 0 |
| 10.000 kills de mob comum | 30 | 3 | 0 |
| 100 chefes de masmorra | 12 | 2,5 | 0,3 |
| 100 World Boss (por jogador) | 30 | 7 | 1 |

## 8. Enchant

| Alvo | Moeda | Custo | Chance |
|---|---|---|---:|
| +1 | ouro | `itemLv × rarityMul × 1 × 10` | 100% |
| +2 | ouro | `itemLv × rarityMul × 2 × 10` | 100% |
| +3 | ouro | `itemLv × rarityMul × 3 × 10` | 100% |
| +4 | gema | 1 | 80% |
| +5 | gema | 2 | 70% |
| +6 | gema | 3 | 60% |
| +7 | gema | 4 | 50% |
| +8 | gema | 6 | 35% |
| +9 | gema | 8 | 25% |
| +10 | gema | 12 | 15% |

- `rarityMul`: Basic 1,0 · Rare 1,5 · Epic 2,5 · Legendary 4,0.
- O custo em ouro é arredondado a múltiplos de 10, com mínimo de 10.
- **Falha em +4..+10:** consome as gemas. O item **não quebra, não some, não perde enchant** (exemplo: Epic +7 tenta +8, paga 6 gemas, falha e continua Epic +7).
- Sem saldo: rejeitado sem tocar em nada.
- Protegido contra clique duplo por `expectedEnchant`. O RNG é `crypto.randomInt`, sempre no servidor.

Custo em ouro (+1 / +2 / +3 / total +0→+3):

| Item | +1 | +2 | +3 | Total +0→+3 |
|---|---:|---:|---:|---:|
| Basic Lv5 | 50 | 100 | 150 | 300 |
| Rare Lv20 | 300 | 600 | 900 | 1.800 |
| Epic Lv36 | 900 | 1.800 | 2.700 | 5.400 |
| Legendary Lv36 | 1.440 | 2.880 | 4.320 | 8.640 |

Exemplo Basic Lv5 (lv 5 é a fórmula pura; os itens reais existem nos níveis 1/4/8…).

**+3→+10:** esperança de 19,9 tentativas e **146 gemas**.

| Percentil (Monte Carlo 20k) | Gemas |
|---|---:|
| p10 | 66 |
| p25 | 90 |
| Mediana | 128 |
| p75 | 183 |
| p90 | 251 |

Um projeto de longo prazo: cerca de 3,7 semanas de um jogador ativo por peça, e cerca de 26 semanas para as 7 peças encantáveis.

**Poder acumulado** (sobre a propriedade principal: arma = ATK; armadura/capa = DEF+HP; bota = DEF, SPD nunca muda):

| Enchant | +1 | +2 | +3 | +4 | +5 | +6 | +7 | +8 | +9 | +10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Bônus | 2% | 4% | 6% | 8,5% | 11% | 13,5% | 16,5% | 19,5% | 22,5% | 27,5% |

Aplicado uma única vez, em `GEAR_DATA.statsFor`, sempre sobre a base × raridade. O cliente só soma os stats já calculados, então não há dupla aplicação.

**Comparação de ATK na arma Lv36:**

| Item | ATK |
|---|---:|
| Epic +8 | 54 |
| Legendary +3 | 54 |
| Legendary +0 | 51 |
| Epic +10 | 58 |

Epic +8 empata com Legendary +3: a escolha deixa de ser óbvia.

**Compatibilidade:**
- O enchant existente é mantido.
- Os stats são recalculados pela tabela nova na próxima leitura. Exemplo: arma +5 era +15% e agora é +11%; arma +10 era +30% e agora é +27,5%.
- As regras novas valem na próxima tentativa, sem cobrança retroativa.

## 9. Ouro

- Nenhuma fonte de ouro foi alterada: mobs, missões, baús, World Boss 360, TvT 120/90/60 e venda.
- Novo sink principal: enchant +1..+3 (ver tabela acima). Os sinks existentes continuam: loja, poções, portais, taxa de mercado de 5%, reset de skill e recompra.

Ouro/h de campo (perfil ativo) versus custos:

| Região | Ouro/h | Arma basic da faixa | +1..+3 de um Rare da faixa | Horas p/ arma |
|---|---:|---:|---:|---:|
| Vila | 1.334 | 180 | 360 | 0,1 |
| Floresta | 2.029 | 450 | 720 | 0,2 |
| Cripta | 2.955 | 900 | 1.080 | 0,3 |
| Serra | 3.373 | 1.500 | 1.440 | 0,4 |
| Pântano | 4.145 | 3.200 | 2.160 | 0,8 |
| Torre | 3.093 | 4.400 | 2.520 | 1,4 |
| Ilhas | 3.721 | 5.800 | 2.880 | 1,6 |
| Vulcão | 3.499 | 7.400 | 3.240 | 2,1 |

Com a curva nova, o jogador passa **muito mais horas** em cada região. Então o ouro acumulado por nível cresce (por exemplo, cerca de 6,2h na Floresta dão cerca de 12k de ouro).

⚠ **Para revisão:** o ouro de mob não foi reduzido, porque o prompt não definia números. Pode ser preciso um novo sink ou um ajuste após telemetria real. O simulador já imprime a comparação para essa decisão.

## 10. Gemas — moeda de progressão

| Fonte | Antes | Agora |
|---|---|---|
| Mob comum | 7–16% por kill | **0** |
| Trash de masmorra | 8% | **0** |
| Chefe de campo | 2–7 fixas **por kill** (respawn 60s) | 1 gema no **1º abate do dia de cada tipo de chefe**, só se não for trivial (gap ≥ −5) |
| Chefe de masmorra | 6 fixas, sem limite | 2 gemas no **1º clear do dia** |
| World Boss | 18 por evento (até 108/dia) | 5 gemas, só nas **3 primeiras participações da semana** |
| TvT | 6 / 3 / 4 | 1 / 1 / 1, só nas **4 primeiras da semana** |
| Missões | 28 no total | Inalterado (onboarding, uma vez) |

- O estado dos limites fica no save (`save.rwd`), travado no PUT genérico via `ECONOMY_LOCK_FIELDS`.
- Dia e semana ISO usam o fuso **America/Sao_Paulo** (mesmo do calendário de eventos).
- Não há cap global invisível: cada fonte tem seu próprio limite de atividade.

Estimativa semanal (não é garantia):

| Perfil | Masmorra | Chefe de campo | World Boss | TvT | **Total** | Meta |
|---|---:|---:|---:|---:|---:|---|
| Casual | 4,2 | 4,9 | 7 | 2,1 | **18** | 15–25 |
| Ativo | 14 | 7 | 15 | 4 | **40** | 25–40 |
| Endgame | 14 | 14 | 15 | 4 | **47** | 40–60 |

## 11. Party XP (campo)

| Tamanho | Por membro | Total |
|---|---:|---:|
| Solo | 100% | 100% |
| 2 | 65% | 130% |
| 3 | 48% | 144% |
| 4 | 40% | 160% |

Um membro só entra na divisão se estiver:
- na mesma party;
- com a conexão **autoritativa** viva do personagem;
- no **mesmo mapa**;
- **vivo**;
- a no máximo **900px** do mob.

Quem não for elegível não recebe nem dilui a XP de ninguém. Quem está parado na Vila não ganha XP da Floresta.

O gap de level é aplicado individualmente. Loot, quest e drop ficam com quem deu o golpe final (comportamento preservado). A IA nunca participa.

## 12. Penalidade de morte

- **PvE** (dano de mob via `hitTarget`, campo e masmorra): perde **0,25% da XP_TO_NEXT** do nível atual.
  - Limitado à XP atual: nunca fica negativa e nunca perde level.
  - Nunca perde item, ouro ou gema.
  - Exemplo: Lv20 perde 590 XP por morte.
- **Sem perda:** PvP de campo, TvT, Arena, Guild Wars futura, eventos PvP e duelos. Esses caminhos nunca chamam `applyDeathPenalty`, que também rejeita qualquer causa diferente de `'pve'`.
- ⚠ **Decisão conservadora (revisar):** morte **no World Boss** não custa XP (`DEATH_PENALTY.WORLD_BOSS=false`). É um raid de evento com respawn em 10s dentro da arena.

## 13. Compatibilidade com personagens existentes

- **Level:** mantido de 1 a 40. Level acima de 40 vira **40 com XP 0**, o único rebaixamento, na leitura (GET) e na próxima gravação.
- **XP:** normalizada para `[0, need−1]` do nível atual. XP antiga da curva `30×L` **nunca** gera level-up automático.
- **Sem alteração:** bag, eq, quest, gold, gem, gunlock, baús, wbRewards/tvtRewards, contadores, dungeon e guild.
- **Enchant:** mantido; os stats são recalculados pela tabela oficial. Itens não são convertidos nem rerrolados.
- **Estado novo:** `save.rwd` nasce zerado.

## 14. Extensões futuras (hooks, sem UI falsa)

- **Eventos:** `BALANCE.EVENT_BOOSTS` e `eventMultiplier(kind, now)`.
  - Tipos: xp, reputation, loot, guildPoints e material.
  - Boosts são janelas temporárias, com teto de ×3.
  - Nesta fase só `xp` (abate de campo) é consumido. A base continua x1.
- **Daily/Weekly:** já existem as frações de XP de missão `QUEST_XP_RATIO.daily` (2%) e `QUEST_XP_RATIO.weekly` (8%). O contrato de estado diário/semanal é o mesmo de `save.rwd` (`rolloverRewardState`). Daily nunca pode ser obrigatória para ganhar level.
- **Bestiário:** hoje não dá recompensa. Um hook futuro pode pagar XP ou material por marco de coleção, usando o mesmo padrão idempotente (`rwd`).
- **Dificuldade de masmorra (Normal / Hard / Heroic / Mythic):**
  - `DUNGEON_CFG` + `applyDungeonClearReward(save, lvl, {bossLvl})` já recebe o nível do chefe.
  - Uma dificuldade futura só precisa escalar `bossLvl`, HP e tier de drop por instância. Por exemplo, Mythic = Lv35–40 com tabela `dungeonBoss`, ou uma tabela nova em `DROP_RATES`.
  - Nada na 5.17 amarra a masmorra a um único nível.
- **Talentos e reputação:** progressão paralela pós-Lv40, fora desta fase. O cap 40 é o início do endgame.
- **Guild Wars:** **FASE 5.18**.

## 15. QA das 4 classes (XP/h de combate, perfil ativo)

| Lv | Guerreiro | Druida | Mago | Arqueiro | Max/min |
|---:|---:|---:|---:|---:|---:|
| 5 | 15.415 | 14.538 | 15.087 | 15.269 | 1,06× |
| 10 | 27.374 | 24.571 | 26.370 | 26.882 | 1,11× |
| 20 | 46.608 | 42.466 | 44.985 | 45.830 | 1,10× |
| 30 | 60.936 | 49.167 | 55.924 | 58.424 | 1,24× |
| 39 | 87.045 | 66.668 | 78.211 | 82.817 | 1,31× |

Tempo total 1→40 (ativo): guerreiro 141,9h · arqueiro 145,3h · mago 149,3h · druida 161,2h.

Nenhuma classe tem XP/h absurdamente superior. O druida é o mais lento (~14% a mais de tempo), por ter menor dano base e skills de suporte. **Nada foi rebalanceado nas classes** (documentado para revisão).

## 16. Observações de tuning e riscos conhecidos

- **`pendingSkill` reutilizável** (achado da auditoria, pré-existente, fora do escopo): um cliente adulterado consegue reaplicar o dano pendente de uma skill a cada 80ms enquanto ela não expira. O limite é 16 pacotes por segundo. Isso infla o DPS e, com ele, a XP/h de quem trapaceia.
- **`p.lvl` da conexão viva:** antes ficava congelado até reconectar. Agora é sincronizado após todo ganho de XP server-side. Efeito colateral: o dano base passa a acompanhar o level sem reconectar.
- **Missões abaixo da meta de 20%** (ver §5).
- **Ouro sem redução** (ver §9).
- **World Boss:** a gema é semanal e a XP é diária. O ouro de 360 continua a cada participação.
- **Premissas do simulador:** DPS com gear Basic, alvo único, sem exploit de skill e sem party. Com party de 4, o total de XP é 160% mais rápido por grupo.
