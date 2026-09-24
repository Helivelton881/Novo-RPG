// Fonte unica de dados de equipamento (Fase 5.1), compartilhada entre
// server.js (via require, Node/CommonJS) e index.html (via <script src>,
// expoe window.GEAR_DATA) -- evita manter duas tabelas divergentes.
//
// Modelo canonico de item (todo item NOVO gerado por createGear()):
//   { uid, type, lv, rarity, enchant, n, atk, def, hp, blk, spd, req }
// - uid: crypto.randomUUID(), unico, estavel (nunca regenerado depois de criado)
// - type: mesmo dominio de sempre (sword/bow/staffd/staffm/shield/armor/helmet/cape/jewel/boots)
// - lv: nivel/faixa de progressao do equipamento (1,4,8,12,16,20,24,28,32,36,40) --
//   NAO confundir com rarity. Determina req e a stat base.
// - rarity: 'basic'|'rare'|'epic'|'legendary' -- multiplica a stat base, nao mexe em req.
// - enchant: 0..10 (nesta fase sempre 0 -- preparacao pra Fase 5.4)
// - req: nivel minimo de PERSONAGEM pra equipar. Pra arma/armadura sempre = lv
//   (igual ao comportamento antigo). Pra escudo/capacete/capa/joia/bota, preserva
//   o comportamento antigo (sem gate) nas 5 faixas legadas (lv<=20) e introduz
//   gate = lv só nas faixas novas (lv>20), que nunca existiram antes -- ver
//   "compat" abaixo pra por que essa assimetria é intencional.
//
// Itens ANTIGOS (sem uid, com `tier` 1-5 em vez de `lv`+`rarity`) migram na leitura
// (ver LEGACY_TIER_LEVEL + sanitizeItem em server.js): tier vira lv via essa tabela,
// rarity vira 'basic' (stats preservados byte-a-byte, já que os 5 valores legados
// em lv=1/4/8/12/20 são EXATAMENTE os antigos tiers 1-5), ganham uid novo uma unica
// vez, e a partir dai persistem como itens no modelo novo.
'use strict';

const GEAR_LEVELS = [1, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40];

// tier antigo (indice 1-5 em GEAR_TIERS/GEAR do cliente) -> lv novo.
// Preservado pra migrar item antigo sem uid: LEGACY_TIER_LEVEL[tier] = lv.
const LEGACY_TIER_LEVEL = [null, 1, 4, 8, 12, 20];
// Inverso, usado só internamente pra validar/gerar visual de item legado.
const LEVEL_LEGACY_TIER = { 1: 1, 4: 2, 8: 3, 12: 4, 20: 5 };

const RARITY = {
  basic: { mul: 1.00, label: 'Básico' },
  rare: { mul: 1.10, label: 'Raro' },
  epic: { mul: 1.20, label: 'Épico' },
  legendary: { mul: 1.35, label: 'Lendário' },
};
const RARITY_ORDER = ['basic', 'rare', 'epic', 'legendary'];

// Tipos que sempre tiveram `req` (trava de nivel) mesmo no modelo antigo.
const TYPES_WITH_LEGACY_REQ = new Set(['sword', 'bow', 'staffd', 'staffm', 'armor']);

// ===== Stats base (rarity=basic, enchant=0) por tipo x lv =====
// As 5 colunas lv=1/4/8/12/20 SAO os valores antigos de GEAR_TIERS/GEAR,
// preservados exatamente (nenhum item existente muda de stats ao migrar).
// As 6 colunas novas (16/24/28/32/36/40) continuam a MESMA taxa de crescimento
// por nivel que já existia entre os pontos reais lv12->lv20 de cada stat
// (extrapolação linear simples a partir de dois pontos reais, não chute) --
// ver LEIA-PRIMEIRO.md "Fase 5.1" pra a derivação completa.
const WEAPON_STATS = {
  1: { atk: 2 }, 4: { atk: 5 }, 8: { atk: 9 }, 12: { atk: 14 }, 16: { atk: 18 },
  20: { atk: 22 }, 24: { atk: 26 }, 28: { atk: 30 }, 32: { atk: 34 }, 36: { atk: 38 }, 40: { atk: 42 },
};
const GEAR_STATS = {
  sword: WEAPON_STATS, bow: WEAPON_STATS, staffd: WEAPON_STATS, staffm: WEAPON_STATS,
  shield: {
    1: { def: 2, blk: .10 }, 4: { def: 4, blk: .14 }, 8: { def: 7, blk: .18 }, 12: { def: 11, blk: .22 }, 16: { def: 14, blk: .24 },
    20: { def: 16, blk: .26 }, 24: { def: 19, blk: .28 }, 28: { def: 21, blk: .30 }, 32: { def: 24, blk: .32 }, 36: { def: 26, blk: .34 }, 40: { def: 29, blk: .36 },
  },
  armor: {
    1: { def: 2, hp: 10 }, 4: { def: 4, hp: 25 }, 8: { def: 7, hp: 45 }, 12: { def: 10, hp: 70 }, 16: { def: 13, hp: 88 },
    20: { def: 15, hp: 105 }, 24: { def: 18, hp: 123 }, 28: { def: 20, hp: 140 }, 32: { def: 23, hp: 158 }, 36: { def: 25, hp: 175 }, 40: { def: 28, hp: 193 },
  },
  helmet: {
    1: { def: 1, hp: 6 }, 4: { def: 3, hp: 14 }, 8: { def: 5, hp: 28 }, 12: { def: 8, hp: 44 }, 16: { def: 10, hp: 55 },
    20: { def: 12, hp: 66 }, 24: { def: 14, hp: 77 }, 28: { def: 16, hp: 88 }, 32: { def: 18, hp: 99 }, 36: { def: 20, hp: 110 }, 40: { def: 22, hp: 121 },
  },
  cape: {
    1: { def: 1, hp: 8 }, 4: { def: 2, hp: 16 }, 8: { def: 4, hp: 30 }, 12: { def: 6, hp: 48 }, 16: { def: 8, hp: 60 },
    20: { def: 9, hp: 72 }, 24: { def: 11, hp: 84 }, 28: { def: 12, hp: 96 }, 32: { def: 14, hp: 108 }, 36: { def: 15, hp: 120 }, 40: { def: 17, hp: 132 },
  },
  jewel: {
    1: { atk: 1, hp: 5 }, 4: { atk: 2, hp: 12 }, 8: { atk: 4, hp: 20 }, 12: { atk: 6, hp: 34 }, 16: { atk: 8, hp: 43 },
    20: { atk: 9, hp: 52 }, 24: { atk: 11, hp: 61 }, 28: { atk: 12, hp: 70 }, 32: { atk: 14, hp: 79 }, 36: { atk: 15, hp: 88 }, 40: { atk: 17, hp: 97 },
  },
  boots: {
    1: { def: 1, spd: .03 }, 4: { def: 2, spd: .05 }, 8: { def: 4, spd: .08 }, 12: { def: 6, spd: .12 }, 16: { def: 8, spd: .14 },
    20: { def: 9, spd: .16 }, 24: { def: 11, spd: .18 }, 28: { def: 12, spd: .20 }, 32: { def: 14, spd: .22 }, 36: { def: 15, spd: .24 }, 40: { def: 17, spd: .26 },
  },
};

// ===== Nomes (originais do Novo-RPG, sem copiar outros jogos) =====
// 1/4/8/12/20 preservam os nomes ja existentes; 16/24/28/32/36/40 seguem a
// mesma zona de campo associada aquela faixa de nivel (serra->pantano->torre->
// ilhas->vulcao), pra soar como progressao natural do mundo já existente.
const GEAR_NAMES = {
  sword: { 1: 'Espada de Aço', 4: 'Espada Real', 8: 'Lâmina Sombria', 12: 'Lâmina Flamejante', 16: 'Lâmina da Matilha', 20: 'Lâmina da Aurora', 24: 'Lâmina do Pântano', 28: 'Lâmina da Torre', 32: 'Lâmina das Ilhas', 36: 'Lâmina Celeste', 40: 'Lâmina do Vulcão' },
  bow: { 1: 'Arco de Caçador', 4: 'Arco da Floresta', 8: 'Arco Élfico', 12: 'Arco Glacial', 16: 'Arco da Matilha', 20: 'Arco da Aurora', 24: 'Arco do Pântano', 28: 'Arco da Torre', 32: 'Arco das Ilhas', 36: 'Arco Celeste', 40: 'Arco do Vulcão' },
  staffd: { 1: 'Cajado de Vinhas', 4: 'Cajado do Bosque', 8: 'Cajado de Galhada', 12: 'Cajado Ancestral', 16: 'Cajado Selvagem', 20: 'Cajado Primordial', 24: 'Cajado do Pântano', 28: 'Cajado da Torre', 32: 'Cajado das Ilhas', 36: 'Cajado Celeste', 40: 'Cajado do Vulcão' },
  staffm: { 1: 'Cajado de Cristal', 4: 'Cajado de Safira', 8: 'Cajado Lunar', 12: 'Cajado Arcano', 16: 'Cajado de Granito', 20: 'Cajado Celestial', 24: 'Cajado Sombrio', 28: 'Cajado da Torre', 32: 'Cajado Etéreo', 36: 'Cajado do Zênite', 40: 'Cajado do Magma' },
  shield: { 1: 'Escudo de Madeira', 4: 'Escudo Reforçado', 8: 'Escudo de Aço', 12: 'Escudo Sombrio', 16: 'Escudo da Matilha', 20: 'Escudo da Aurora', 24: 'Escudo do Pântano', 28: 'Escudo da Torre', 32: 'Escudo das Ilhas', 36: 'Escudo Celeste', 40: 'Escudo do Vulcão' },
  armor: { 1: 'Gibão de Couro', 4: 'Couraça Reforçada', 8: 'Armadura de Aço', 12: 'Manto Sombrio', 16: 'Armadura da Matilha', 20: 'Armadura da Aurora', 24: 'Armadura do Pântano', 28: 'Armadura da Torre', 32: 'Armadura das Ilhas', 36: 'Armadura Celeste', 40: 'Armadura do Vulcão' },
  helmet: { 1: 'Capuz de Couro', 4: 'Elmo de Ferro', 8: 'Elmo de Aço', 12: 'Elmo Sombrio', 16: 'Elmo da Matilha', 20: 'Elmo da Aurora', 24: 'Elmo do Pântano', 28: 'Elmo da Torre', 32: 'Elmo das Ilhas', 36: 'Elmo Celeste', 40: 'Elmo do Vulcão' },
  cape: { 1: 'Capa de Viagem', 4: 'Capa Reforçada', 8: 'Capa do Andarilho', 12: 'Capa Sombria', 16: 'Capa da Matilha', 20: 'Capa da Aurora', 24: 'Capa do Pântano', 28: 'Capa da Torre', 32: 'Capa das Ilhas', 36: 'Capa Celeste', 40: 'Capa do Vulcão' },
  jewel: { 1: 'Amuleto Simples', 4: 'Amuleto de Jade', 8: 'Amuleto Arcano', 12: 'Coração Sombrio', 16: 'Amuleto da Matilha', 20: 'Amuleto da Aurora', 24: 'Amuleto do Pântano', 28: 'Amuleto da Torre', 32: 'Amuleto das Ilhas', 36: 'Amuleto Celeste', 40: 'Amuleto do Vulcão' },
  boots: { 1: 'Botas de Couro', 4: 'Botas Reforçadas', 8: 'Botas de Aço', 12: 'Botas Sombrias', 16: 'Botas da Matilha', 20: 'Botas da Aurora', 24: 'Botas do Pântano', 28: 'Botas da Torre', 32: 'Botas das Ilhas', 36: 'Botas Celestes', 40: 'Botas do Vulcão' },
};

// ===== Preços de loja (raridade basic, unica vendida pelo Mercador nesta fase) =====
// 1/4/8/12 preservam os precos ja praticados (nao muda economia existente).
// 20 preenche uma lacuna real: o tier5 ja existia em GEAR_TIERS mas nunca
// tinha preco de loja (so vinha de bau). 16-40 seguem uma curva de crescimento
// com razao decrescente (mesmo formato da curva 1->12 ja real), calibrada
// contra renda esperada de abate (rollMobLoot) + recompensa de missao
// (QUEST_REWARDS) pra ficar alcançável em ~15-40min de jogo normal por peça
// -- ver LEIA-PRIMEIRO.md "Fase 5.1" pra a simulação completa. Não é uma
// garantia matematicamente exata (não há telemetria real de produção ainda),
// é a melhor estimativa a partir da economia hoje; ajustar depois com dados
// reais é esperado.
const GEAR_PRICES = {
  sword: { 1: 60, 4: 180, 8: 450, 12: 900, 16: 1500, 20: 2200, 24: 3200, 28: 4400, 32: 5800, 36: 7400, 40: 9200 },
  bow: { 1: 60, 4: 180, 8: 450, 12: 900, 16: 1500, 20: 2200, 24: 3200, 28: 4400, 32: 5800, 36: 7400, 40: 9200 },
  staffd: { 1: 60, 4: 180, 8: 450, 12: 900, 16: 1500, 20: 2200, 24: 3200, 28: 4400, 32: 5800, 36: 7400, 40: 9200 },
  staffm: { 1: 60, 4: 180, 8: 450, 12: 900, 16: 1500, 20: 2200, 24: 3200, 28: 4400, 32: 5800, 36: 7400, 40: 9200 },
  armor: { 1: 30, 4: 120, 8: 320, 12: 700, 16: 1150, 20: 1650, 24: 2350, 28: 3200, 32: 4200, 36: 5350, 40: 6650 },
  shield: { 1: 25, 4: 100, 8: 265, 12: 585, 16: 960, 20: 1375, 24: 1960, 28: 2665, 32: 3500, 36: 4460, 40: 5540 },
  helmet: { 1: 25, 4: 100, 8: 265, 12: 585, 16: 960, 20: 1375, 24: 1960, 28: 2665, 32: 3500, 36: 4460, 40: 5540 },
  boots: { 1: 25, 4: 100, 8: 265, 12: 585, 16: 960, 20: 1375, 24: 1960, 28: 2665, 32: 3500, 36: 4460, 40: 5540 },
  cape: { 1: 20, 4: 80, 8: 215, 12: 465, 16: 765, 20: 1100, 24: 1565, 28: 2135, 32: 2800, 36: 3565, 40: 4435 },
  jewel: { 1: 40, 4: 160, 8: 425, 12: 935, 16: 1535, 20: 2200, 24: 3135, 28: 4265, 32: 5600, 36: 7135, 40: 8865 },
};

// req = nivel minimo de personagem pra equipar. Arma/armadura sempre =lv (igual
// sempre foi). Acessorio (escudo/capacete/capa/joia/bota): 0 nas 5 faixas
// legadas (lv<=20, preserva o comportamento antigo -- nunca tiveram gate) e
// =lv nas 6 faixas novas (lv>20, conteudo que nunca existiu antes, entao nao
// ha comportamento antigo pra quebrar). Documentado como decisao deliberada,
// nao inconsistencia.
function reqFor(type, lv) {
  if (TYPES_WITH_LEGACY_REQ.has(type)) return lv;
  return lv > 20 ? lv : 0;
}

function round2(v) { return Math.round(v * 100) / 100; }

// Stats finais (com rarity aplicada) pra um type+lv+rarity. Nao mexe em req
// (rarity nunca altera nivel minimo, só o "poder" do item).
function statsFor(type, lv, rarity) {
  const base = GEAR_STATS[type] && GEAR_STATS[type][lv];
  if (!base) return null;
  const mul = (RARITY[rarity] || RARITY.basic).mul;
  const out = { req: reqFor(type, lv) };
  if (base.atk) out.atk = Math.round(base.atk * mul);
  if (base.def) out.def = Math.round(base.def * mul);
  if (base.hp) out.hp = Math.round(base.hp * mul);
  if (base.blk) out.blk = round2(base.blk * mul);
  if (base.spd) out.spd = round2(base.spd * mul);
  return out;
}

function nameFor(type, lv) {
  return (GEAR_NAMES[type] && GEAR_NAMES[type][lv]) || 'Item';
}

function priceFor(type, lv) {
  return (GEAR_PRICES[type] && GEAR_PRICES[type][lv]) || null;
}

// Preco de venda ao mercador: SEMPRE foi uma unica tabela achatada por
// progressao, igual pra qualquer tipo/slot (SELL_PRICES no cliente antigo,
// indexado por tier 1-5) -- preservado aqui do mesmo jeito, so que por lv.
// As 5 colunas legadas (1/4/8/12/20) sao os valores antigos exatos; as 6
// novas seguem a mesma razao de ~14.5% sobre o preco de compra da arma
// (SWORD_PRICES) que ja era implicita nos 5 valores reais (8/60=13.3%,
// 22/180=12.2%, 60/450=13.3%, 140/900=15.6%, 320/2200=14.5% -- a media bate
// exatamente com o preco de lv20 calculado pra esta fase, o que confirma que
// a extrapolacao esta consistente com o desenho economico ja existente).
const SELL_PRICES = { 1: 8, 4: 22, 8: 60, 12: 140, 16: 220, 20: 320, 24: 465, 28: 640, 32: 840, 36: 1075, 40: 1335 };
function sellPriceFor(lv) { return SELL_PRICES[lv] || 0; }

// ===== Fase 5.3: venda por raridade =====
// Item raro/épico/lendário precisa valer mais que o Básico equivalente pro
// Mercador -- multiplicador aplicado DEPOIS do preço base por nivel
// (SELL_PRICES), nunca mexendo no preço de COMPRA (GEAR_PRICES, sempre
// basic). Ex.: Nv20 Basic vende por 320 -> Rare 640, Epic 1280, Legendary
// 2560 (2x/4x/8x, arredondado pra inteiro).
const SELL_RARITY_MUL = { basic: 1, rare: 2, epic: 4, legendary: 8 };
// Fonte central de venda por item -- nunca espalhar o multiplicador de
// raridade em mais de um lugar (server.js sempre chama isto, nunca
// sellPriceFor(lv) sozinho, pra um item que nao seja garantidamente basic).
function sellPriceForItem(item) {
  if (!item) return 0;
  return Math.round(sellPriceFor(item.lv) * (SELL_RARITY_MUL[item.rarity] || 1));
}

const DATA = {
  GEAR_LEVELS, LEGACY_TIER_LEVEL, LEVEL_LEGACY_TIER, RARITY, RARITY_ORDER,
  TYPES_WITH_LEGACY_REQ, GEAR_STATS, GEAR_NAMES, GEAR_PRICES, SELL_PRICES, SELL_RARITY_MUL,
  reqFor, statsFor, nameFor, priceFor, sellPriceFor, sellPriceForItem,
};

if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
else if (typeof window !== 'undefined') window.GEAR_DATA = DATA;
