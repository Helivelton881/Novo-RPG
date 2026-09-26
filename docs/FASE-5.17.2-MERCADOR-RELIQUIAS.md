# FASE 5.17.2 — Mercador de Relíquias

Novo **gem sink**. Nenhuma fonte de gema, drop rate, enchant, XP ou ouro foi alterada.
Depois desta fase, a gema tem dois destinos principais:
1. comprar equipamento Raro ou Épico;
2. encantar de +4 a +10.

## NPC e localização

- **Nome:** Mercador de Relíquias (`id: relicario`). A janela mostra "💎 Mercador de Relíquias — Equipamentos Raros e Épicos".
- **Posição na Vila Inicial:** x=950, y=619, à esquerda do Mercador comum, na frente da casa da área de comércio.
- **Fonte única da posição:** `BALANCE.RELIC_SHOP.NPC`. O cliente desenha nela e o servidor valida a proximidade da compra contra ela.
- **Interação:** mesmo padrão dos outros NPCs. Por proximidade (62px) aparece o botão **"Ver relíquias"**, que abre a janela; nada abre sozinho. A janela fecha a mais de 200px do NPC, como a do Mercador e a do Ferreiro.
- **Arte:** **ASSET ESPECÍFICO DO MERCADOR DE RELÍQUIAS PENDENTE.** Reaproveita o sprite do `mercador` via `spriteKey`; nenhum PNG foi criado ou alterado.

## Estoque semanal

- **Composição:** 6 ofertas por semana e por personagem. Slots 0–3 são **Raros** e slots 4–5 são **Épicos**. Nunca Básico, nunca Lendário.
- **Determinístico** (`game-data/relic-shop.js`):
  - seed = hash FNV-1a de `relic-shop:<weekId>:<classe>:<slot>`, passada a um PRNG mulberry32;
  - sem `Math.random` e sem estado em memória;
  - o estoque é o mesmo ao relogar, recarregar, reconectar ou reiniciar o Render.
- **Nenhuma tabela nova:** o estoque é reconstruído a cada consulta, e só as compras do personagem são persistidas.
- **Reset:** segunda-feira 00:00 BRT (= segunda 03:00 UTC; o Brasil não tem horário de verão desde 2019).
  - `relicWeekInfo(now)` devolve `weekId` ISO (`2026-W39`), `startAt` e `nextResetAt`.
  - A janela mostra "Próxima renovação: 1d 5h".
- **Classe:** os tipos vêm de `DROP_TYPES_BY_CLASS` do servidor (arma da classe, armadura, capa e bota). Não existe uma segunda tabela de classes. As classes reais são `guerreiro`, `druida`, `mago` e `arqueiro`.
- **Nível:**
  - a faixa é o maior `GEAR_LEVEL` ≤ level do personagem, e o estoque usa os **dois maiores tiers elegíveis**, com pesos 70% / 30% (medido em 52 semanas: ≈67% no tier máximo);
  - Lv1–3 usa só o tier 1;
  - nunca oferece equipamento acima do level (`req` ≤ level).
- **Deduplicação:** nunca repete type+lv+rarity na mesma semana quando o pool permite (a partir do Lv8, testado em 52 semanas × 4 classes). Com pool pequeno (Lv1–3), a repetição é aceita após 12 tentativas.
- **Level-up no meio da semana:** ao cruzar um tier, as ofertas passam a refletir o tier novo, mas **os slots já comprados continuam COMPRADOS**. A compra é travada por slot, então subir de tier não abre 6 compras novas.

## Preços oficiais (`BALANCE.RELIC_MERCHANT_PRICES`)

| Tier | 1 | 4 | 8 | 12 | 16 | 20 | 24 | 28 | 32 | 36 | 40 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Raro | 2 | 3 | 4 | 5 | 7 | 9 | 12 | 15 | 19 | 24 | 30 |
| Épico | 8 | 10 | 12 | 15 | 18 | 22 | 28 | 34 | 42 | 52 | 65 |

Todo item comprado nasce **+0**.

## Compra (server-authoritative)

- **O cliente** envia `{action:'relic_buy', offerId, expected:{type,lv,rarity}}`. O `expected` só serve para **recusar** (`OFFER_CHANGED`) se a oferta tiver mudado; nunca é usado como fonte de verdade.
- **O servidor** (`attemptRelicPurchase`, dentro de `withCharLock`) segue esta ordem:
  1. carrega e sanitiza o save;
  2. exige sessão de jogo viva, mapa `vila` e distância de até 200px do NPC;
  3. faz o parse do `offerId` (`relic:<weekId>:<classe>:<slot>`);
  4. confere semana atual e classe;
  5. reconstrói a oferta;
  6. confere Raro/Épico (defesa em profundidade), level e tipo compatível;
  7. confere se já foi comprada;
  8. confere saldo e espaço na mochila (limite de 12, o mesmo das outras compras);
  9. cria o item canônico com `createGear` (uid, stats, req);
  10. desconta as gemas;
  11. põe o item na mochila;
  12. marca o slot;
  13. faz um único PATCH.
- **Nada é cobrado antes de todas as validações.**
- **Consulta** (`relic_state`): só leitura, não grava nada. Devolve `weekId`, `nextResetAt`, saldo e as 6 ofertas (`offerId`, `type`, `lv`, `rarity`, `priceGem`, `purchased` e `itemPreview` com stats de `GEAR_DATA.statsFor`).
- **Log** estruturado a cada compra: `relic_purchase` com `userId`, `charId`, `offerId`, `itemType`, `lv`, `rarity`, `gemCost` e `weekId`, sem secrets.

## Persistência e segurança

- **Estado:** `save.relicShop = { w: weekId, b: [slots] }`. É compacto (no máximo 6 números) e sanitizado. Uma semana diferente da atual equivale a reset lógico, sem histórico.
- **Trava:** `relicShop` entrou em `ECONOMY_LOCK_FIELDS`, então o PUT genérico nunca reseta compras nem restaura gemas ou mochila. O autosave da 5.16.7 só grava map/x/y/hp e relê o save fresco do banco, logo não reverte compras.
- **Duplo clique, duas abas, retry ou dois WebSockets:** `withCharLock` serializa as requisições. A segunda lê o slot já marcado e recebe `ALREADY_PURCHASED`, sem cobrar e sem gerar item.
- **Recusado:**
  - `offerId` forjado, inexistente, de outra classe, de semana antiga ou futura;
  - `price`, `rarity`, `lv` ou `stats` enviados pelo cliente (são ignorados);
  - compra fora da Vila (Floresta, masmorra, TvT, World Boss) ou longe do NPC.
- **Mercado, venda e trade:** sem bind. Os itens seguem as mesmas regras de qualquer item equivalente, e o `sellPrice` não foi alterado.

## Simulador (`node tools/balance-sim.js` → RELIC MERCHANT)

- **Semanas de gema por item** (casual 18 / ativo 40 / endgame 47): Épico Lv40 = 3,6 / 1,6 / 1,4. As 6 ofertas Lv40 somam 250 gemas, cerca de 6,3 semanas de um jogador ativo.
- **Comprar vs encantar:** um Épico Lv40 (65 gemas) custa ≈44% do custo médio de levar um item de +3 a +10 (146 gemas).
- **ATK de arma Lv40:**

  | Item | ATK |
  |---|---|
  | Raro +0 | 46 |
  | Épico +0 | 50 |
  | Raro +7 | 54 |
  | Épico +7 | 59 |
  | Lendário +0 (só drop) | 57 |

  Comprar ou encantar é uma escolha real.

- ⚠ **Arbitragem para revisão antes do merge:** comprar e revender ao Mercador comum rende **2,3× a 3,6×** mais ouro do que vender a gema diretamente.
  - A gema vende a 25 de ouro; um Raro Lv40 custa 30 gemas (750 de ouro) e revende por 2.670.
  - O teto é de 6 ofertas por personagem por semana: cerca de 21 mil de ouro por 250 gemas, o equivalente a ~6h de farm no Vulcão.
  - Não é infinito, e a gema continua mais valiosa para enchant. Mesmo assim, é uma conversão gema → ouro melhor que a venda direta.
  - Nada foi alterado. Opções para decidir: reduzir o `sellPrice` desses itens, marcar a origem, ou manter.

## Testes

- `test/fase-5-17-2-relic-merchant.test.js` (puro, 24 testes):
  - semana e reset;
  - 6 ofertas / 4 Raros / 2 Épicos / 0 Lendário / 0 Básico;
  - determinismo, incluindo "restart" com o módulo recarregado;
  - rotação semanal;
  - classe (4 classes reais);
  - nível (Lv1/3/4/7/12/23/29/36/37/40 e todos de 1 a 40);
  - distribuição 70/30 e deduplicação;
  - preços exatos nos 11 tiers;
  - economia 5.17 intacta;
  - compra de Raro e Épico (gema, +0, stats, uid, req);
  - persistência após `sanitizeSave` (reload e login);
  - reset semanal;
  - uma compra por oferta (duplo clique e retry);
  - mochila cheia, gemas insuficientes, mapa e proximidade;
  - `offerId` forjado, `expected` forjado, `ECONOMY_LOCK_FIELDS`;
  - Lendário impossível;
  - level-up no meio da semana;
  - checagens estáticas do cliente.
- `test/fase-5-17-2-relic-integration.test.js` (HTTP real, Supabase): SKIPPED sem credencial.
- Resultado local de `npm test`: 0 falhas; os testes que dependem de Supabase aparecem como **SKIPPED**.

## QA visual (local)

- **Ambiente:** servidor local, modo dev offline (`__G.dev`), **sem conta**, porque o login exige Supabase.
- **Verificado:**
  - o NPC aparece na Vila, à esquerda do Mercador comum, sem sobrepor bloqueios;
  - a proximidade faz dele o NPC mais próximo, e a interação abre a janela;
  - sem conta, a janela mostra "Entre com uma conta online para negociar relíquias";
  - com a view injetada na página (o mesmo `relicStock` e `statsFor` do servidor, carregados só na memória da página):
    - saldo de gemas, 6 ofertas com as cores reais (Raro azul, Épico roxo), level, stats e preço;
    - COMPRADO esmaecido;
    - "Gemas insuficientes" e "Mochila cheia" desabilitam a compra;
    - a confirmação "Comprar X por N gemas?" aparece com Cancelar e Comprar;
    - a tentativa de compra sem conta falha sem mexer em gema nem mochila.
  - Console e servidor sem erros.
- **Bugs encontrados e corrigidos no QA:**
  - o ícone de gema dentro da linha saía gigante;
  - o botão "Falar com Mercador" era ambíguo e virou "Ver relíquias".
- **Não coberto no navegador:** compra real com conta (Supabase), reload e logout/login com conta. A lógica equivalente está coberta nos testes puros e no teste de integração (SKIPPED sem credencial).

## Limitações

- Asset do NPC pendente (usa o sprite do Mercador).
- A proximidade depende da sessão de jogo viva. Sem WebSocket ativo, a compra é recusada ("Personagem precisa estar online"), mesmo padrão de `use_item`.
- O fuso UTC−3 é fixo. Se o horário de verão voltar a existir, é preciso ajustar `RESET_UTC_OFFSET_HOURS`.
- Arbitragem de revenda documentada acima, para decisão.
