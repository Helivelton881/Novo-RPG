// Fase 5.17 — Progressão Hardcore & Economia x1.
//
// FONTE UNICA de balanceamento, compartilhada entre server.js (require,
// CommonJS) e index.html (<script src>, expoe window.BALANCE_DATA) -- mesmo
// padrao de game-data/gear-data.js. O SERVIDOR e sempre a autoridade: o
// cliente so le estes numeros pra EXIBIR (barra de XP, custo/chance do
// Ferreiro, recompensa de missao offline). Nenhum valor vindo do cliente e
// aceito pra decidir XP/level/ouro/gema/raridade/enchant.
//
// Toda constante economica da fase fica AQUI -- nunca espalhar numero
// magico em server.js/index.html. Ver docs/FASE-5.17-PROGRESSAO-ECONOMIA.md
// pra a filosofia, a tabela completa e as premissas do simulador
// (node tools/balance-sim.js).
'use strict';

// ===== Level cap =====
// Lv40 e o maximo ABSOLUTO desta versao. Nenhum sistema gera Lv41; XP
// recebida no cap e descartada (nunca acumula XP "escondida").
const LEVEL_CAP = 40;

// ===== Curva de XP =====
// XP_TO_NEXT[L] = XP necessaria pra passar do nivel L pro L+1 (L=1..39).
// Derivada por `node tools/balance-sim.js --derive` a partir de mobStats()
// real, DPS medio das 4 classes e das horas-alvo por regiao (REGIONS
// abaixo), depois arredondada pra 3 algarismos significativos. Para
// reajustar: mude as premissas do simulador/horas-alvo, rode --derive e
// cole a tabela nova aqui. XP_TO_NEXT[40] = 0 (cap).
const XP_TO_NEXT = [
  0, // indice 0 nao usado
  /* 1-10  */ 2360, 4330, 7040, 7330, 14100, 19700, 28300, 36800, 47900, 61900,
  /* 11-20 */ 79100, 100000, 111000, 124000, 137000, 150000, 165000, 186000, 209000, 236000,
  /* 21-30 */ 266000, 301000, 328000, 354000, 380000, 407000, 433000, 454000, 477000, 506000,
  /* 31-39 */ 536000, 568000, 621000, 682000, 747000, 819000, 899000, 996000, 1090000,
  /* 40 cap */ 0,
];
function clampLevel(lvl) {
  const n = Math.round(Number(lvl));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(LEVEL_CAP, n);
}
function xpToNext(lvl) {
  const l = clampLevel(lvl);
  return l >= LEVEL_CAP ? 0 : XP_TO_NEXT[l];
}
// XP total acumulada pra CHEGAR ao nivel L (a partir do Lv1 com 0 XP).
function cumulativeXp(lvl) {
  const l = clampLevel(lvl);
  let sum = 0;
  for (let i = 1; i < l; i++) sum += XP_TO_NEXT[i];
  return sum;
}
// Normaliza (lvl, xp) persistidos pra uma faixa VALIDA da curva atual --
// usado em toda leitura de save. Garante as regras de compatibilidade:
// - nunca diminui o nivel (exceto >40, que vira 40 -- unico caso documentado);
// - XP antiga (curva 30xL) nunca provoca level-up automatico: e so limitada
//   a [0, need-1] do nivel atual;
// - no cap, XP e sempre 0.
function normalizeProgress(lvl, xp) {
  const l = clampLevel(lvl);
  if (l >= LEVEL_CAP) return { lvl: LEVEL_CAP, xp: 0 };
  const need = XP_TO_NEXT[l];
  const x = Math.max(0, Math.min(need - 1, Math.floor(Number(xp) || 0)));
  return { lvl: l, xp: x };
}
// Unica funcao de ganho de XP (servidor). `gain` ja deve vir com qualquer
// multiplicador aplicado (gap/party/evento). Nunca ultrapassa o cap; no cap
// a XP e descartada.
function applyXp(lvl, xp, gain) {
  let { lvl: l, xp: x } = normalizeProgress(lvl, xp);
  if (l >= LEVEL_CAP) return { lvl: LEVEL_CAP, xp: 0, gained: 0, levelsGained: 0 };
  const start = l;
  let g = Math.max(0, Math.floor(Number(gain) || 0));
  const gained = g;
  x += g;
  while (l < LEVEL_CAP && x >= XP_TO_NEXT[l]) { x -= XP_TO_NEXT[l]; l += 1; }
  if (l >= LEVEL_CAP) x = 0;
  return { lvl: l, xp: x, gained, levelsGained: l - start };
}

// ===== Regioes (faixas de balanceamento, NUNCA paredes rigidas) =====
// hours = [jogador ativo normal min, max] pra atravessar a regiao. `from`/
// `to` = nivel de entrada/saida. Usado pelo simulador (--derive usa o
// ponto medio) e pela documentacao.
const REGIONS = [
  { id: 'vila', name: 'Vila', from: 1, to: 5, hours: [2, 3] },
  { id: 'floresta', name: 'Floresta', from: 5, to: 10, hours: [6, 8] },
  { id: 'cripta', name: 'Cripta', from: 10, to: 15, hours: [12, 15] },
  { id: 'serra', name: 'Serra', from: 15, to: 20, hours: [15, 20] },
  { id: 'pantano', name: 'Pântano', from: 20, to: 25, hours: [20, 25] },
  { id: 'torre', name: 'Torre', from: 25, to: 30, hours: [22, 28] },
  { id: 'ilhas', name: 'Ilhas', from: 30, to: 35, hours: [28, 35] },
  { id: 'vulcao', name: 'Vulcão', from: 35, to: 40, hours: [35, 45] },
];
function regionForLevel(lvl) {
  const l = clampLevel(lvl);
  for (const r of REGIONS) if (l >= r.from && l < r.to) return r;
  return REGIONS[REGIONS.length - 1];
}

// ===== XP por diferenca de nivel (mobLevel - playerLevel) =====
// Abaixo: 0 → 100%, -1/-2 → 90%, -3/-4 → 70%, -5 → 50%, -6/-7 → 25%,
// -8 ou menos → 0%. Acima: +1 → 105%, +2 → 110%, +3 ou mais → 115% (MAX).
const XP_GAP_BELOW = { 0: 1.00, 1: 0.90, 2: 0.90, 3: 0.70, 4: 0.70, 5: 0.50, 6: 0.25, 7: 0.25 };
const XP_GAP_ABOVE = { 1: 1.05, 2: 1.10 };
const XP_GAP_MAX = 1.15;
function xpGapMultiplier(diff) {
  const d = Math.round(Number(diff) || 0);
  if (d >= 3) return XP_GAP_MAX;
  if (d > 0) return XP_GAP_ABOVE[d];
  const below = -d;
  return below >= 8 ? 0 : XP_GAP_BELOW[below];
}

// ===== XP de missao =====
// Recompensa como fracao da XP_TO_NEXT do nivel ADEQUADO daquele estagio
// (`lvl`), nunca do nivel real do jogador -- quest feita atrasada nao vira
// atalho, quest feita cedo nao da varios levels. Tipos:
// simple ~5-8%, main ~10-15%, chapter (final de capitulo) ~20-25%,
// daily pequena, weekly moderada (daily/weekly: hooks pra sistemas futuros,
// nenhum estagio usa hoje).
const QUEST_XP_RATIO = { none: 0, simple: 0.06, main: 0.12, chapter: 0.22, daily: 0.02, weekly: 0.08 };
// Estagio (valor de save.quest que a recompensa consome) -> tipo + nivel
// adequado. Os estagios 6/10/14/18/22/26 sao o "portal liberado" logo apos
// derrotar o chefe regional = final de capitulo.
const QUEST_STAGE_XP = {
  0: { kind: 'none', lvl: 1 },
  2: { kind: 'simple', lvl: 2 },
  4: { kind: 'main', lvl: 6 },
  6: { kind: 'chapter', lvl: 9 },
  8: { kind: 'main', lvl: 11 },
  10: { kind: 'chapter', lvl: 14 },
  12: { kind: 'main', lvl: 16 },
  14: { kind: 'chapter', lvl: 19 },
  16: { kind: 'main', lvl: 21 },
  18: { kind: 'chapter', lvl: 24 },
  20: { kind: 'main', lvl: 26 },
  22: { kind: 'chapter', lvl: 29 },
  24: { kind: 'main', lvl: 31 },
  26: { kind: 'chapter', lvl: 34 },
  28: { kind: 'main', lvl: 36 },
};
function questXpFor(stage) {
  const s = QUEST_STAGE_XP[stage];
  if (!s) return 0;
  return Math.round((QUEST_XP_RATIO[s.kind] || 0) * xpToNext(s.lvl));
}

// ===== Masmorra =====
// Masmorra comum (trash) continua sem XP (comportamento historico). O
// CHEFE concede XP de conclusao a cada membro elegivel: ratio x need do
// proprio nivel x multiplicador de gap (chefe muito abaixo = pouco/zero).
// Limite diario de clears que pagam XP e de clears que pagam gema -- estado
// server-side no save (save.rwd), nunca um cap invisivel global.
const DUNGEON = {
  CLEAR_XP_RATIO: 0.06,
  XP_CLEARS_PER_DAY: 4,
  BOSS_GEMS: 2,
  GEM_CLEARS_PER_DAY: 1,
  TRASH_GEM_CHANCE: 0,
};
// ===== Chefe de campo =====
// Respawn de 60s -- nunca pode ser fonte repetivel de gema. So o 1o abate
// do DIA de cada tipo de chefe paga gema, e so se o chefe nao for trivial
// pro jogador (mobLevel - playerLevel >= MIN_GAP).
const FIELD_BOSS = { DAILY_GEMS: 1, MIN_GAP: -5 };
// ===== World Boss =====
const WORLD_BOSS = {
  XP_RATIO: 0.04,          // fracao da XP_TO_NEXT do nivel do jogador
  XP_EVENTS_PER_DAY: 2,    // participacoes/dia que pagam XP
  GOLD: 360,
  GEMS: 5,
  GEM_EVENTS_PER_WEEK: 3,  // participacoes/semana que pagam gema
};
// ===== Team vs Team (evento PvP) =====
const TVT = {
  XP_RATIO: { win: 0.02, draw: 0.015, loss: 0.01 },
  XP_EVENTS_PER_DAY: 2,
  GOLD: { win: 120, draw: 90, loss: 60 },
  GEMS: { win: 1, draw: 1, loss: 1 },
  GEM_EVENTS_PER_WEEK: 4,
};
// Mob comum de campo: gema = 0 (nao e fonte relevante de gema).
const COMMON_MOB_GEM_CHANCE = 0;

// ===== Drop de equipamento especial =====
// Probabilidades MUTUAMENTE EXCLUSIVAS: um unico roll r em [0,1):
// r < legendary → Legendary; r < legendary+epic → Epic;
// r < legendary+epic+rare → Rare; senao nada. No maximo 1 item por roll.
const DROP_RATES = {
  common:      { rare: 0.003, epic: 0.0003, legendary: 0 },
  elite:       { rare: 0.03,  epic: 0.003,  legendary: 0 },
  dungeonBoss: { rare: 0.12,  epic: 0.025,  legendary: 0.003 },
  worldBoss:   { rare: 0.30,  epic: 0.07,   legendary: 0.01 },
};
// Chefe de CAMPO usa a tabela de elite (decisao conservadora da 5.17: respawn
// de 60s faria Legendary farmavel) -- ver docs, marcado pra revisao.
const FIELD_BOSS_DROP_TIER = 'elite';
function rollDropRarity(tier, rng) {
  const t = DROP_RATES[tier];
  if (!t) return null;
  const r = (typeof rng === 'function' ? rng : Math.random)();
  if (r < t.legendary) return 'legendary';
  if (r < t.legendary + t.epic) return 'epic';
  if (r < t.legendary + t.epic + t.rare) return 'rare';
  return null;
}

// ===== Enchant =====
// +1..+3: OURO, 100%. +4..+10: GEMAS, chance abaixo. Falha em +4..+10
// consome as gemas e NAO quebra, NAO some, NAO reduz o item.
const ENCHANT_MAX = 10;
const ENCHANT_GOLD_MAX_TARGET = 3;
const ENCHANT_RARITY_GOLD_MUL = { basic: 1.0, rare: 1.5, epic: 2.5, legendary: 4.0 };
const ENCHANT_GEM_COST = { 4: 1, 5: 2, 6: 3, 7: 4, 8: 6, 9: 8, 10: 12 };
const ENCHANT_SUCCESS = { 1: 1.00, 2: 1.00, 3: 1.00, 4: 0.80, 5: 0.70, 6: 0.60, 7: 0.50, 8: 0.35, 9: 0.25, 10: 0.15 };
// Bonus ACUMULADO sobre a(s) propriedade(s) principal(is) do item (nunca
// composto por tentativa -- sempre base x rarity x (1+bonus)).
const ENCHANT_POWER = { 0: 0, 1: 0.02, 2: 0.04, 3: 0.06, 4: 0.085, 5: 0.11, 6: 0.135, 7: 0.165, 8: 0.195, 9: 0.225, 10: 0.275 };
// Arredondamento "amigavel" do custo em ouro: multiplo de 10, minimo 10.
function friendlyGold(v) { return Math.max(10, Math.round(v / 10) * 10); }
function enchantGoldCostRaw(itemLv, rarity, target) {
  return (Number(itemLv) || 0) * (ENCHANT_RARITY_GOLD_MUL[rarity] || ENCHANT_RARITY_GOLD_MUL.basic) * target * 10;
}
// Custo de UMA tentativa pra alcancar `target` → {currency:'gold'|'gem', amount} ou null.
function enchantCostFor(itemLv, rarity, target) {
  const t = Math.round(Number(target));
  if (!Number.isInteger(t) || t < 1 || t > ENCHANT_MAX) return null;
  if (t <= ENCHANT_GOLD_MAX_TARGET) {
    const lv = Number(itemLv);
    if (!Number.isFinite(lv) || lv < 1) return null;
    return { currency: 'gold', amount: friendlyGold(enchantGoldCostRaw(lv, rarity, t)) };
  }
  return { currency: 'gem', amount: ENCHANT_GEM_COST[t] };
}
function enchantChance(target) { return ENCHANT_SUCCESS[target] == null ? null : ENCHANT_SUCCESS[target]; }
function enchantPower(enchant) {
  const e = Math.max(0, Math.min(ENCHANT_MAX, Math.round(Number(enchant) || 0)));
  return ENCHANT_POWER[e];
}

// ===== Party XP =====
// Fracao da XP-base do mob que CADA membro elegivel recebe (antes do gap
// individual). Total: 100% / 130% / 144% / 160%.
const PARTY_XP_SHARE = { 1: 1.00, 2: 0.65, 3: 0.48, 4: 0.40 };
const PARTY_XP_RANGE = 900; // px do mob -- fora disso nao recebe (anti-leech)
function partyXpShare(n) { return PARTY_XP_SHARE[Math.max(1, Math.min(4, Math.round(Number(n) || 1)))]; }

// ===== Penalidade de morte =====
// Morte PvE: perde 0,25% da XP NECESSARIA do nivel atual, limitada a XP
// atual (nunca negativa, nunca perde nivel/item/ouro/gema). PvP/TvT/Arena/
// Guild Wars/eventos PvP: zero. World Boss: zero (decisao conservadora,
// marcada pra revisao -- ver docs).
const DEATH_PENALTY = { PVE_XP_RATIO: 0.0025, WORLD_BOSS: false };
function deathXpLoss(lvl, xp, cause) {
  if (cause !== 'pve') return 0;
  const { lvl: l, xp: x } = normalizeProgress(lvl, xp);
  if (l >= LEVEL_CAP) return 0;
  return Math.min(x, Math.floor(XP_TO_NEXT[l] * DEATH_PENALTY.PVE_XP_RATIO));
}

// ===== Eventos temporarios (hook) =====
// A economia BASE e x1. Boosts sao sempre multiplicadores temporarios com
// janela explicita, nunca alteracao permanente dos valores acima. Lista
// vazia = nenhum boost ativo. Formato: {kind:'xp'|'reputation'|'loot'|
// 'guildPoints'|'material', mult, startsAt, endsAt} (epoch ms).
// Nesta fase so 'xp' e consumido (XP de abate de campo); os demais sao
// contratos pra sistemas futuros.
const EVENT_BOOST_KINDS = ['xp', 'reputation', 'loot', 'guildPoints', 'material'];
const EVENT_BOOSTS = [];
const EVENT_BOOST_MAX = 3;
function eventMultiplier(kind, now, boosts) {
  const list = Array.isArray(boosts) ? boosts : EVENT_BOOSTS;
  let m = 1;
  for (const b of list) {
    if (!b || b.kind !== kind) continue;
    if (!(now >= b.startsAt && now < b.endsAt)) continue;
    const v = Number(b.mult);
    if (Number.isFinite(v) && v > m) m = v;
  }
  return Math.min(EVENT_BOOST_MAX, m);
}

const DATA = {
  LEVEL_CAP, XP_TO_NEXT, clampLevel, xpToNext, cumulativeXp, normalizeProgress, applyXp,
  REGIONS, regionForLevel,
  XP_GAP_BELOW, XP_GAP_ABOVE, XP_GAP_MAX, xpGapMultiplier,
  QUEST_XP_RATIO, QUEST_STAGE_XP, questXpFor,
  DUNGEON, FIELD_BOSS, WORLD_BOSS, TVT, COMMON_MOB_GEM_CHANCE,
  DROP_RATES, FIELD_BOSS_DROP_TIER, rollDropRarity,
  ENCHANT_MAX, ENCHANT_GOLD_MAX_TARGET, ENCHANT_RARITY_GOLD_MUL, ENCHANT_GEM_COST, ENCHANT_SUCCESS, ENCHANT_POWER,
  friendlyGold, enchantGoldCostRaw, enchantCostFor, enchantChance, enchantPower,
  PARTY_XP_SHARE, PARTY_XP_RANGE, partyXpShare,
  DEATH_PENALTY, deathXpLoss,
  EVENT_BOOST_KINDS, EVENT_BOOSTS, EVENT_BOOST_MAX, eventMultiplier,
};

if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
else if (typeof window !== 'undefined') window.BALANCE_DATA = DATA;
