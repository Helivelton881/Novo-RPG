# FASE 5.17.1 — Hotfix Vulcão Ardente: Sprites & Animações

Hotfix visual/técnico. **Nenhuma** mudança de gameplay: hitbox, dano, XP, loot, IA, respawn, quest e `balance-data.js` estão intocados. A próxima grande fase continua sendo a **FASE 5.18 — Guild Wars**.

## Problema original

Os monstros do Vulcão Ardente:
- andavam de costas;
- atacavam com a pose de caminhada ou parados (o Elemental aparecia parado no próprio golpe);
- ficavam olhando para o lado errado durante o ataque no modo online;
- às vezes trocavam de lado sem motivo;
- sumiam instantaneamente ao morrer.

## Causa raiz

1. **Flip invertido.** Os PNGs `salamander`, `elemental`, `skel_ash` e `lorde` foram desenhados **olhando para a ESQUERDA**. O draw espelhava quando `face === -1` (andando para a esquerda), como se o sprite nativo olhasse para a direita, então o monstro andava de costas nos dois sentidos. O lobo da Serra, que também é nativo para a esquerda, sempre espelhou com `face === 1`: a convenção do Vulcão estava invertida.
2. **Walk sobrescrevia o ataque.** O draw testava `s.moving` **antes** do estado de ataque. Como o servidor reporta `moving=true` em micro-deslocamentos durante `wind`/`breath`, o ataque aparecia como caminhada.
3. **Estado de ataque incompleto.** O golpe do Elemental (`slam`) e o `meteor` do Senhor das Chamas não eram reconhecidos como ataque e caíam no frame parado.
4. **`face` no servidor (online).** `tickMobAI` só mudava `face` quando `Δx > 0.01`. Isso tinha dois efeitos:
   - durante `wind`/`breath`/`slam` (monstro parado) o lado ficava **congelado** no último passo, e o monstro atacava de costas para o alvo;
   - empurrões de colisão de sub-pixel faziam o sprite piscar de lado.
5. **Morte sem animação.** O mob sumia no mesmo frame, porque o asset não tem frames de morte.

## Monstros auditados (código real)

| Tipo | Nome no jogo | Sprite | Frame (px) | Frames | Orientação nativa | Idle | Walk | Attack | Hit | Death | Direções | Flip | Problema |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `sala` | Salamandra | `salamander` | 76×64 | 3 | esquerda | f0 | 1-0-2-0 @7fps | f2 (`wind`, `breath`) | overlay branco (sem frame) | fade (sem frame) | só L/R | espelha olhando p/ direita | flip invertido; walk sobre ataque |
| `elem` | Elemental de Magma | `elemental` | 62×78 | 3 | esquerda | f0 | 1-0-2-0 @5fps | f2 (`wind`, `slam`) | overlay | fade | só L/R | idem | flip invertido; `slam` sem pose |
| `calc` | Esqueleto Calcinado | `skel_ash` | 54×66 | 3 | esquerda | f0 | 1-0-2-0 @7fps | f2 (`wind`, combo) | overlay | fade | só L/R | idem | flip invertido |
| `cinza` | Morcego de Cinzas | `bat_ash` | 55×34 | 3 | frontal | asa 0-1-2 @12fps | idem | asa @18fps (`wind`, `swoop`) | overlay | fade | frontal | **nunca** espelha | já estava ok; só migrou para a config |
| `lorde` | Senhor das Chamas (boss) | `lorde` | 102×118 | 3 | esquerda | f0 | 1-0-2-0 @6fps | f2 (`wind`, `wind2`, `meteor`) | overlay | fade | só L/R | idem | flip invertido; `meteor` sem pose |

O `ancient_titan` (World Boss) reusa o sprite e o draw do Senhor das Chamas, então também recebe o flip correto.

## Sprite sheets (auditados nos PNGs reais embutidos em `SPR`, `index.html`)

Todos são **uma única linha de 3 frames**:

| Sprite | Resolução total | Frame (px) | Colunas × linhas |
|---|---|---|---|
| `salamander` | 228×64 | 76×64 | 3×1 |
| `elemental` | 186×78 | 62×78 | 3×1 |
| `skel_ash` | 162×66 | 54×66 | 3×1 |
| `bat_ash` | 165×34 | 55×34 | 3×1 |
| `lorde` | 306×118 | 102×118 | 3×1 |

- Frame 0 é a pose parada; frames 1 e 2 são os passos. O frame 2 é a pose mais "avançada".
- **Não existem:** linhas por direção (cima/baixo), frames dedicados de ataque, hit ou morte.
- Não há assets alternativos no projeto para esses monstros.
- Nenhum PNG foi alterado e nenhuma arte foi gerada.

## Assets faltantes e fallbacks adotados

| Faltante | Fallback |
|---|---|
| **Ataque** | Frame 2 segurado durante o estado de ataque, mais o tremor que já existia. O morcego bate as asas mais rápido. |
| **Hit** | Mantém a pose atual (walk ou idle) com o overlay branco de flash que já existia. Nenhum frame falso foi inventado. |
| **Morte** | O último frame some em `DEATH_FADE_S = 0,35s`. Só vale para mobs que foram vistos vivos, e nunca volta a andar. |
| **Cima/baixo** | Mantém o último lado horizontal. Nenhuma arte vertical existe. |

## Mudanças

- **Novo `game-data/monster-animation.js`:** fonte única, em IIFE, compartilhada por cliente e servidor. Contém:
  - `MONSTER_ANIMATIONS` por tipo: sheet, frame, frames, orientação nativa, idle, walk e attack com os estados;
  - helpers puros:
    - `visualState`, com prioridade **death > attack > hit > walk > idle**;
    - `frameFor`, que usa o timer próprio da entidade (`s.anim`, acumulado por `dt`, nunca `Date.now()`);
    - `shouldMirror`;
    - `faceFromDx`, com histerese de 0,5px;
    - `resolveFace`, que olha para o alvo durante o ataque;
    - `deathAlpha`.
- **`index.html`:**
  - `drawSala`/`drawElem`/`drawCalc`/`drawLorde`/`drawCinza` usam a config. O espelhamento acontece num único ponto (`vulcMirror`), sempre dentro de `ctx.save()/restore()`, sem double flip.
  - O fade de morte entra na lista de desenho ordenada por Y já existente.
  - `mobDims` (hitbox/seleção) não mudou.
- **`server.js`:** em `tickMobAI`, **só o campo visual `face`** dos tipos do Vulcão passa por `volcanoMobFace`. Em ataque, olha para o alvo travado (`mob.tgt`); fora dele, segue o movimento com histerese. Nenhuma regra de gameplay lê `mob.face`. Os demais mapas continuam como antes.

## Sincronização com o evento real

A animação de ataque é disparada **exclusivamente** pelo estado de IA:
- **online:** o servidor decide `wind`/`breath`/`slam`/`wind2`/`meteor`/`swoop` e transmite em `mob_positions`;
- **offline:** o mesmo estado vem de `updX`.

Não existe timer independente. O cliente não decide acerto, dano nem cooldown.

## Testes

`test/fase-5-17-1-vulcao-animation.test.js` (puro):
- a config bate com os PNGs reais (tamanho de frame, 1 linha × 3 frames, frames referenciados existentes);
- flip correto por orientação nativa, e o morcego nunca espelha;
- espelhamento único dentro de `save`/`restore`;
- `face` por movimento com histerese e olhando para o alvo no ataque (incluindo `volcanoMobFace` do servidor);
- prioridade de estados;
- ataque não é sobrescrito por walk;
- `slam` mostra ataque;
- morte não volta a walk e o fade termina;
- ciclo de walk em ordem pelo timer da entidade;
- regressão de `mobStats` (HP/XP/dano) e da hitbox.

`test/fase-5-17-progression.test.js` já carrega todos os scripts de `game-data` no mesmo escopo global, como o navegador faz, e cobre também o módulo novo.

`npm test`: 756 testes · **564 pass · 0 fail · 192 SKIPPED** (os skipped dependem de Supabase e não há credencial local).

## QA no navegador (servidor local)

O login exige Supabase e não há credencial local. Por isso o QA usou o **modo de desenvolvimento local** (`__G.dev`), com o WebSocket conectado como **visitante** ao servidor local. A IA dos mobs do Vulcão rodou **no servidor**, ou seja, o caminho online real, com o `face` novo.

O painel do navegador estava oculto, o que pausa o `requestAnimationFrame`. O loop foi avançado chamando `update(dt)`/`draw()`, que são os mesmos passos de `frame()`.

Métricas por monstro, com o jogador circulando e atacando:

| Monstro | Amostras andando de costas | Ataque olhando p/ alvo | Ataque exibido mesmo com `moving` | Walk alterna frames |
|---|---:|---:|---|---|
| Salamandra | 0 | 83/86 | sim (9 amostras) | 1-0-2-0 |
| Elemental | 0 | **147/147** (`slam` agora em pose de ataque) | sim (23) | sim |
| Esqueleto Calcinado | 0 | 90/90 (e 61/61 numa 2ª rodada) | sim (20) | sim |
| Morcego de Cinzas | 0 (frontal) | n/a | asa 0-1-2 mais rápida | sim |
| Senhor das Chamas | 0 | 127/136 | `wind`/`wind2`/`meteor` | sim |

- As poucas amostras divergentes (Salamandra 3, Senhor das Chamas 9) acontecem quando o jogador cruza a linha central do mob, dentro do intervalo de 150ms entre ticks do servidor e da interpolação.
- **Morte → fade → respawn** (modo offline, abate local): alpha 1 → 0,9 → … → 0 em ~0,35s, **nenhum** frame de walk durante a morte, e ciclo normal após o respawn.
- **Captura:** a salamandra à esquerda do jogador aparece virada para a direita, na direção dele.
- Console sem erros, servidor sem erros.

**Não coberto:** jogador com conta real (não há Supabase local) e produção.

## Limitações restantes

- Os assets não têm frames de ataque, hit, morte nem direções verticais; os fallbacks estão documentados acima. Arte dedicada fica como pendência de asset, sem PNG novo nesta fase.
- O `face` online depende do tick de 150ms do servidor. Em cruzamentos muito rápidos pode haver até um tick de atraso.
- A correção do `face` no servidor está restrita ao Vulcão. Outras regiões usam a regra antiga (`Δx > 0,01`), que tem o mesmo congelamento de lado durante ataques. Fica como candidata a hotfix futuro, fora do escopo.
