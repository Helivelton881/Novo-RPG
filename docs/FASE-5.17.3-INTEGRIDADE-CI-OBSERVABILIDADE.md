# FASE 5.17.3 — Integridade, CI & Observabilidade

Fase de estabilidade e hardening. **Nenhuma mecânica nova**, e nada muda em gameplay nem em balanceamento. Ficam iguais: curva de XP, drops, gemas, ouro, enchant, Mercador de Relíquias, quests, portais, Dungeon, World Boss, TvT, Mercado, Bestiário, Guild, combate, pathfinding, sprites e animações.

> **LIVING WORLD FORA DO ESCOPO E NÃO MODIFICADO.** Nenhuma linha de código de IA/Living World foi alterada. Nenhuma migration nova toca `living_world_settings`. Nenhum valor de produção (`field_spawn_enabled`, `dungeon_fill_enabled`, `tvt_fill_enabled`, `field_world_cap`, `per_map_cap`) foi lido para alteração, resetado ou migrado. As duas migrations originais do Living World só tiveram o **nome do arquivo** alinhado à versão já aplicada em produção (conteúdo byte a byte idêntico, 0 linhas alteradas). Um teste que lia o caminho antigo teve só o caminho atualizado.

## 1. Problemas encontrados (auditoria de 2026-09-27)

| # | Problema | Evidência |
|---|---|---|
| 1 | Personagem legado acima do cap | produção: 1 personagem com `lvl=41`, `save.xp=193` |
| 2 | Ranking podia expor level > 40 | 1 linha `character_rank_stats.level=41`; `fetchRankRows` repassava o valor cru |
| 3 | Personagem sem linha de ranking | 15 personagens / 14 linhas; `POST /api/characters` não criava a linha |
| 4 | CI verde falso | 195 SKIPPED por `SUPABASE_URL`/`SUPABASE_SECRET_KEY` vazios |
| 5 | Supabase CI vazio | `crtyqlwrsvesbtqglipp`: 0 tabelas, 0 migrations |
| 6 | Histórico de migrations "desalinhado" | 5 versões no repo diferentes das registradas em produção |
| 7 | Render sem health check | `healthCheckPath` vazio |
| 8 | ~1.300 avisos/dia do PostgREST | "Warp server error: Thread killed by timeout manager" |
| 9 | Advisor: FK sem índice | `public.friends` → `friends_friend_id_fkey` |

## 2. Causa raiz e correção

### 2.1 Level cap 40 (A1–A3)
- **Causa:** o personagem foi gravado antes da Fase 5.17, quando o cap era 99. Depois disso, o código passou a fazer clamp em todos os caminhos de escrita (`clampLevel`/`applyXp`), mas nada normalizava o dado já persistido e o banco não tinha constraint.
- **Regra oficial verificada no código:** `BALANCE.normalizeProgress` define level em 1..40 e, **no cap, XP = 0** (XP excedente é descartada).
- **Migration `20260927010241_enforce_level_cap_and_rank_stats_integrity`** (idempotente):
  - `characters.lvl` → faixa 1..40;
  - `save.lvl` = coluna `lvl`;
  - no cap, `save.xp` = 0;
  - `character_rank_stats.level`/`xp` no mesmo estado normalizado;
  - constraints `characters_lvl_range` (1..40), `character_rank_stats_level_range` (1..40) e `character_rank_stats_xp_nonnegative`.
- **Código:**
  - os três PATCH que gravavam só `{save}` (loja, baú, penalidade de morte) passam a gravar `{lvl, save}`, com o mesmo valor normalizado, para que coluna e JSON nunca divirjam;
  - todos os demais caminhos de escrita já usavam `clampLevel`/`applyXp` (auditado: criação, XP de mob, party, quest, Dungeon, World Boss, TvT, PUT, autosave `patchCharacterFields`, WS join);
  - não existe endpoint admin que altere level.

### 2.2 Ranking (B, B1–B3)
- **Código:** `fetchRankRows` normaliza level/XP antes de montar a resposta, então nenhum tipo de ranking devolve level > 40. `syncRankLevelXp` normaliza antes da RPC.
- **Banco:** `rank_stats_set_level_xp` faz clamp e XP 0 no cap (defesa em profundidade). Os grants foram mantidos, e o `revoke` de public/anon/authenticated foi reaplicado.
- **Nascimento do rank:** o trigger `AFTER INSERT` `trg_characters_create_rank_stats` insere a linha **na mesma transação** do INSERT (`ON CONFLICT DO NOTHING`). O POST ainda faz um upsert idempotente, só como rede de segurança para um banco sem a migration.
- **Backfill:** cria as linhas ausentes com level/XP reais normalizados. PvP, TvT, World Boss e Bestiário ficam no default, sem valores inventados.

### 2.3 Histórico de migrations (C)
Comparei o conteúdo, não o nome.
- Usei `md5` do SQL de `supabase_migrations.schema_migrations.statements` (produção) contra os arquivos do repo, com comentários removidos e espaços colapsados.
- **Resultado:** as **16/16** migrations são SQL idêntico, incluindo as 5 com versão divergente. A diferença era só de comentários e formatação.
- **Ação:** renomeei os 5 arquivos para as versões aplicadas em produção. Produção não foi tocada e nenhuma migration aplicada foi editada.

| Nome no repo antes | Versão alinhada à produção |
|---|---|
| `20260925000000_add_admin_rbac_and_moderation` | `20260925034224` |
| `20260925000100_add_admin_tables_fk_covering_indexes` | `20260925034318` |
| `20260925010000_add_portal_news` | `20260925080811` |
| `20260925020000_add_living_world_settings` | `20260925104225` |
| `20260925021000_add_living_world_settings_updated_by_index` | `20260925104256` |

### 2.4 Supabase CI (D1)
- Apliquei as 18 migrations oficiais (as 16 de produção mais as 2 novas), **na ordem oficial**, ao projeto `Novo-RPG CI` (`crtyqlwrsvesbtqglipp`).
- Registrei cada uma em `supabase_migrations.schema_migrations` com **a mesma versão e o mesmo nome do repo**. Não usei `apply_migration`, porque ele registraria o timestamp do momento e recriaria a divergência.
- **Banco limpo:** a cadeia inteira aplica do zero sem erro.
- **Estrutura:** as tabelas e funções do CI são iguais às de produção, mais `character_rank_stats_on_character_insert` e `idx_friends_friend_id` desta fase.
- **Dados:** nenhum dado de produção foi copiado. O CI está com 0 usuários.
- **Validação da migration no CI com o cenário legado real** (Lv41/xp193 com rank 41, e um personagem sem rank):
  - resultado 0 fora do cap, 0 divergências, 0 sem rank, 0 duplicados;
  - Lv41 virou 40/0 e o ouro foi preservado;
  - o personagem sem rank recebeu level/XP reais;
  - o gatilho cria a linha level 1/XP 0;
  - a RPC `(99, 5000)` grava 40/0;
  - as constraints recusam 41;
  - o DELETE faz cascade;
  - reexecutar o backfill altera 0 linhas.

  A fixture foi removida em seguida.

### 2.5 CI sem falso-verde (D2–D5, I)
- **`.github/workflows/test.yml`:**
  - job **unit**: `npm ci`, `node -c server.js`, `git diff --check` e `npm run test:unit`. Os testes de Supabase aparecem como SKIPPED, e o resumo avisa que eles **não** são PASS;
  - job **integration** (`needs: unit`, concorrência serializada no banco de CI): `npm run test:integration` com os secrets `CI_SUPABASE_URL` e `CI_SUPABASE_SECRET_KEY`.
- **`tools/run-tests.js integration` falha se:**
  - os secrets estiverem ausentes;
  - a URL for de produção;
  - a URL não for do projeto `crtyqlwrsvesbtqglipp`;
  - **qualquer** teste terminar SKIPPED.
- **`test/helpers.js`:** `hasSupabase()` recusa a ref de produção sempre (inclusive localmente) e falha se `REQUIRE_SUPABASE=1` estiver sem credencial.
- **Actions:** `actions/checkout@v7` (7.0.1) e `actions/setup-node@v7` (7.0.0), as versões oficiais mais recentes consultadas na API de releases do GitHub. Node **22**, porque o Node 20 saiu de suporte em abr/2026.
- **Isolamento:** os testes criam usuários com nomes únicos por execução (`GITHUB_RUN_ID` + aleatório) e não dependem de estado anterior.
- **`SUPABASE_TEST_SAFE=1`:** fica ligado só no job de integração, porque o banco de CI é descartável. Isso libera os 3 testes de concorrência real do Mercado.

**⛔ BLOCKED: GITHUB SECRET PERMISSION.** Esta sessão não tem `gh` nem token do GitHub, e o MCP do Supabase só expõe chaves *publicáveis*: a secret key do projeto CI não é acessível daqui. Não criei nenhum secret. Configure no GitHub (Settings → Secrets and variables → Actions):

| Nome | Valor |
|---|---|
| `CI_SUPABASE_URL` | `https://crtyqlwrsvesbtqglipp.supabase.co` |
| `CI_SUPABASE_SECRET_KEY` | secret key (`sb_secret_…`) **do projeto Novo-RPG CI**. **Nunca** a de produção. |

Enquanto esses secrets não existirem, o job de integração **falha**, de propósito. Os antigos `SUPABASE_URL`/`SUPABASE_SECRET_KEY` do repositório deixam de ser usados.

### 2.6 Health check (E)
- `GET /health` (e `HEAD`) responde `200 {"ok":true,"service":"novo-rpg","commit":<RENDER_GIT_COMMIT[0..12]>,"uptimeSeconds":N}`.
- **Liveness pura:** sem I/O e sem Supabase, e não expõe nenhum segredo, usuário, ID ou stack. Qualquer outro método recebe 405.
- **Readiness (`/ready`) não foi criada:** a checagem de Supabase exigiria uma query periódica, o que é desnecessário para o Render e aumenta a carga.
- **Render (E2):** o serviço tem `autoDeploy: yes` na `main` e `healthCheckPath` vazio. **Configurar `healthCheckPath=/health` só DEPOIS do deploy autorizado deste código**: se for configurado antes, o Render marcaria as instâncias atuais (que ainda não têm `/health`) como não saudáveis.

### 2.7 Avisos do PostgREST (F)
- **Volume:** ~1.410 avisos em 24h, cerca de 60–80 por hora de forma constante, independente do tráfego.
- **Correlação:** os avisos surgem **~150ms depois** das duas requisições do sweep de 60s do servidor, `PATCH guild_invites` (expirar convites) e `POST rpc/market_expire_listings`. Às vezes aparecem +30s depois. Exemplo: requisições em `00:37:13.96` retornaram 204/200 em 170–427ms, e o aviso veio em `00:37:14.12`.
- **Status HTTP (`edge_logs`, 24h):** **zero** 4xx e 5xx. Só houve 200, 201, 204 e 1 resposta 300 isolada num GET de `admin_roles`. A latência média ficou em ~180–300ms.
- **Banco:** `postgres_logs` sem nenhum ERROR, FATAL ou PANIC.
- **Código:** existe um único `setInterval` de 60s, em nível de módulo (não é recriado em reconnect), e cada chamada leva menos de 0,5s. Não há sobreposição, N+1 nem timer duplicado.
- **Classificação: C — AVISO INTERNO DO POSTGREST SEM IMPACTO OBSERVADO.** O padrão é compatível com o Warp (servidor HTTP do PostgREST) encerrando por timeout a thread de conexões keep-alive ociosas depois das requisições periódicas. **Nenhuma lógica foi alterada** só para silenciar o aviso.

### 2.8 Índice `friends(friend_id)` (G)
- O advisor confirmou que o índice ainda estava ausente.
- A migration `20260927010254_add_friends_friend_id_index` cria `idx_friends_friend_id`.
- Os 25 índices marcados como "unused" **não** foram removidos: o banco é pequeno e muitos sistemas ainda têm pouco uso.

### 2.9 RLS (H)
**INTENTIONAL SERVER-ONLY RLS MODEL.** O RLS está ativo e sem policies, e todo acesso passa por `server.js` com a secret/service-role key. O cliente não acessa o banco diretamente. O advisor "RLS enabled no policy" é **esperado**. Nenhuma policy foi criada e nenhum GRANT a anon ou authenticated foi feito.

## 3. Produção — estado e próximos passos (NÃO aplicado sem autorização)

**Preview (só leitura, em 2026-09-27):**

| Métrica | Valor |
|---|---|
| `chars_out_of_range` | 1 (41/193) |
| `rank_out_of_range` | 1 |
| `missing_rank` | 1 |
| `chars_cap_with_xp` | 0 |
| `save_lvl_mismatch` | 0 |
| `rank_cap_with_xp` | 0 |
| `nonnumeric_save_xp` | 0 |

Ordem recomendada, depois da autorização:
1. Aplicar as 2 migrations novas na produção. Isso é compatível com o código atual, que já faz clamp em 40.
2. Rodar o SELECT de validação que está no fim da migration. O esperado é 0 em todas as colunas.
3. Fazer o merge. O Render publica sozinho (autoDeploy).
4. Com `GET https://novo-rpg.onrender.com/health` respondendo 200, configurar `healthCheckPath=/health` no serviço `srv-daovaiugekts73f74t30`.

## 4. Testes

- **`test/fase-5-17-3-integrity.test.js`** — unit, 16 testes, sem banco:
  - cap: 39→40, 40 continua 40 com XP 0, 41/193 vira 40/0, 99 forjado, consistência de `save.lvl`, ausência de PATCH só-save;
  - migrations: versões iguais às de produção, conteúdo da migration de integridade, índice, nenhuma remoção de índice, Living World não tocado;
  - travas de CI: recusa de produção, falha sem secrets, workflow correto;
  - com um **PostgREST falso** local: `/api/rankings` normaliza 41 → 40/0 em todos os tipos, sem duplicatas; `/health` responde 200, rápido, sem segredos, sem tocar no banco, e recusa POST com 405.
- **`test/fase-5-17-3-rank-integration.test.js`** — integração, 8 testes, Supabase CI:
  - rank no nascimento;
  - RPC com clamp;
  - constraints;
  - PUT forjado;
  - ranking ≤ 40 sem duplicatas;
  - cascade no DELETE;
  - upserts concorrentes sem duplicação;
  - autosave mais cap.
- **Resultado local** de `npm run test:unit`: **604 PASS / 0 FAIL / 203 SKIPPED**. Os 203 skipped são os testes que dependem de Supabase e só contam no job de integração.
- **Integração:** não executada nesta sessão, por falta da secret key do CI (ver 2.5).

## 5. Limitações e riscos

- Os ~200 testes de integração **nunca rodaram de verdade antes**. Quando os secrets forem configurados, é provável que alguns falhem por estarem desatualizados em relação às fases 5.2 a 5.17. Um exemplo é `progression.test.js`, que ainda espera o "primeiro PUT confiável", comportamento removido na 5.2. Isso é esperado e desejável: são falhas reais que antes eram escondidas pelo SKIP.
- A nova migration **ainda não foi aplicada em produção**.
- O `healthCheckPath` do Render ainda não foi configurado (depende do deploy).

## 6. Deliberadamente não alterado
- Living World (código, tabela, valores, migrations e painel);
- economia e balanceamento das fases 5.17, 5.17.1 e 5.17.2;
- índices "unused";
- modelo de RLS;
- lógica dos sweeps periódicos.
