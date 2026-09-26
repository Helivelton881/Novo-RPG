// Fase 5.17.2 — Mercador de Relíquias: estoque semanal DETERMINISTICO.
//
// Modulo puro (sem HTTP/WS/Supabase/Math.random). O estoque nunca e
// armazenado: e sempre RECONSTRUIDO a partir de dados server-side estaveis
// (weekId + classe + slot + faixa de nivel do personagem), entao e o mesmo
// apos relogar, recarregar, reconectar ou reiniciar o servidor. So as
// COMPRAS do personagem sao persistidas (save.relicShop, server.js).
//
// Precos/slots/pesos vem de game-data/balance-data.js (RELIC_MERCHANT_PRICES,
// RELIC_SHOP). Os tipos por classe vem de DROP_TYPES_BY_CLASS do servidor
// (passados como parametro -- nunca uma segunda tabela de classes aqui).
(function () {
'use strict';

const BALANCE = (typeof module !== 'undefined' && module.exports) ? require('./balance-data.js') : window.BALANCE_DATA;
const GEAR = (typeof module !== 'undefined' && module.exports) ? require('./gear-data.js') : window.GEAR_DATA;

const DAY_MS = 86400000, WEEK_MS = 7 * DAY_MS;

// Semana do Mercador: comeca segunda 00:00 BRT (= segunda 03:00 UTC).
// weekId no formato ISO 'YYYY-Www' calculado sobre o horario de Brasilia.
function relicWeekInfo(now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const offsetMs = BALANCE.RELIC_SHOP.RESET_UTC_OFFSET_HOURS * 3600000;
  const local = new Date(t + offsetMs); // "relogio de Brasilia" expresso em UTC
  const dow = local.getUTCDay() || 7; // 1=segunda ... 7=domingo
  const mondayLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - (dow - 1) * DAY_MS;
  const startAt = mondayLocal - offsetMs;
  const nextResetAt = startAt + WEEK_MS;
  // ISO week: a quinta-feira da semana decide o ano.
  const thursday = new Date(mondayLocal + 3 * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(isoYear, 0, 1)) / WEEK_MS) + 1;
  return { weekId: `${isoYear}-W${String(week).padStart(2, '0')}`, startAt, nextResetAt };
}

// Hash FNV-1a 32 bits + PRNG mulberry32: deterministico, sem estado global.
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function rngFrom(seedStr) {
  let a = hash32(seedStr);
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Faixas elegiveis: as DUAS maiores GEAR_LEVELS <= nivel do personagem
// (ou so uma, se o personagem ainda nao passou da segunda faixa).
function relicTierPool(playerLvl) {
  const lvl = BALANCE.clampLevel(playerLvl);
  const eligible = GEAR.GEAR_LEVELS.filter(l => l <= lvl);
  return eligible.slice(-2).reverse(); // [maior, anterior]
}

function slotRarity(slot) {
  const R = BALANCE.RELIC_SHOP;
  if (slot >= 0 && slot < R.RARE_SLOTS) return 'rare';
  if (slot >= R.RARE_SLOTS && slot < R.RARE_SLOTS + R.EPIC_SLOTS) return 'epic';
  return null;
}
function slotCount() { return BALANCE.RELIC_SHOP.RARE_SLOTS + BALANCE.RELIC_SHOP.EPIC_SLOTS; }
function offerIdFor(weekId, cls, slot) { return `relic:${weekId}:${cls}:${slot}`; }
function parseOfferId(offerId) {
  const m = /^relic:(\d{4}-W\d{2}):([a-z]{3,16}):(\d)$/.exec(String(offerId || ''));
  if (!m) return null;
  return { weekId: m[1], cls: m[2], slot: Number(m[3]) };
}

// Estoque completo da semana pra uma classe/nivel. `types` = tipos de item
// compativeis com a classe (DROP_TYPES_BY_CLASS[cls] do servidor).
// Deduplicacao: tenta nunca repetir type+lv+rarity na mesma semana; se o
// pool for pequeno demais (ex.: Lv1-3, uma unica faixa), aceita repeticao
// depois de MAX_TRIES tentativas (fallback documentado).
const MAX_TRIES = 12;
function relicStock({ weekId, cls, lvl, types }) {
  if (!weekId || !cls || !Array.isArray(types) || !types.length) return [];
  const tiers = relicTierPool(lvl);
  if (!tiers.length) return [];
  const seen = new Set(), out = [];
  for (let slot = 0; slot < slotCount(); slot++) {
    const rarity = slotRarity(slot);
    const rng = rngFrom(`relic-shop:${weekId}:${cls}:${slot}`);
    let pick = null;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const lv = tiers.length > 1 && rng() >= BALANCE.RELIC_SHOP.TOP_TIER_WEIGHT ? tiers[1] : tiers[0];
      const type = types[Math.min(types.length - 1, Math.floor(rng() * types.length))];
      const cand = { type, lv };
      if (!pick) pick = cand;
      if (!seen.has(`${type}:${lv}:${rarity}`)) { pick = cand; break; }
    }
    seen.add(`${pick.type}:${pick.lv}:${rarity}`);
    out.push({
      offerId: offerIdFor(weekId, cls, slot), slot, type: pick.type, lv: pick.lv, rarity,
      priceGem: BALANCE.relicPrice(pick.lv, rarity),
    });
  }
  return out;
}

const DATA = { relicWeekInfo, hash32, rngFrom, relicTierPool, slotRarity, slotCount, offerIdFor, parseOfferId, relicStock, MAX_TRIES };
if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
else if (typeof window !== 'undefined') window.RELIC_SHOP = DATA;
})();
