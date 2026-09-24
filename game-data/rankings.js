'use strict';
// Fase 5.10 -- Rankings: nucleo puro (tipos, paginacao, ordenacao,
// derivacao de K/D, cache TTL). Sem HTTP/WS/Supabase aqui.

const RANK_TYPES = Object.freeze(['level', 'pvp', 'tvt', 'world_boss', 'bestiary', 'guild']);
const RANK_PAGE_SIZE = 20;
const RANK_CACHE_MS = 45 * 1000; // dentro da janela de 30-60s pedida

function isValidRankType(type) { return RANK_TYPES.includes(type); }

function kdRatio(kills, deaths) {
  const k = Math.max(0, Number(kills) || 0), d = Math.max(0, Number(deaths) || 0);
  // Nunca armazenado -- sempre derivado no momento da resposta. Sem
  // mortes, o K/D e o proprio numero de kills (convencao usual).
  return d > 0 ? Math.round((k / d) * 100) / 100 : k;
}

// Pagina uma lista JA ORDENADA (a ordenacao real e feita no SQL, com nome
// como desempate estavel -- esta funcao so recorta a pagina certa e
// calcula os metadados). page e 1-indexado.
function paginate(rows, page, pageSize) {
  const size = pageSize || RANK_PAGE_SIZE;
  const p = Math.max(1, Math.round(Number(page) || 1));
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const clampedPage = Math.min(p, totalPages);
  const start = (clampedPage - 1) * size;
  return { items: rows.slice(start, start + size), page: clampedPage, pageSize: size, total, totalPages };
}

// Cache TTL simples em memoria, chaveado por "tipo:pagina". Nao atualiza
// em tempo real a cada hit -- so expira e deixa o proximo pedido
// recalcular. `now` injetavel pra teste determinístico.
function createRankCache() {
  const store = new Map();
  return {
    get(key, now = Date.now()) {
      const hit = store.get(key);
      if (!hit || now >= hit.expiresAt) return null;
      return hit.value;
    },
    set(key, value, now = Date.now(), ttlMs = RANK_CACHE_MS) {
      store.set(key, { value, expiresAt: now + ttlMs });
    },
    clear() { store.clear(); },
    size() { return store.size; },
  };
}

// Comparadores puros, um por tipo de ranking -- nome como desempate
// estavel em todos (nunca ordem "como o banco devolveu"). `row` e o
// formato ja normalizado que server.js monta (name, level, xp, pvpKills,
// pvpDeaths, tvtWins, tvtLosses, tvtKills, worldBossKills,
// worldBossParticipations, bestiaryDiscovered, totalLevel, memberCount).
function byNameStable(a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR'); }
const RANK_COMPARATORS = Object.freeze({
  level: (a, b) => (b.level - a.level) || (b.xp - a.xp) || byNameStable(a, b),
  pvp: (a, b) => (b.pvpKills - a.pvpKills) || (a.pvpDeaths - b.pvpDeaths) || byNameStable(a, b),
  tvt: (a, b) => (b.tvtWins - a.tvtWins) || (b.tvtKills - a.tvtKills) || (a.tvtLosses - b.tvtLosses) || byNameStable(a, b),
  world_boss: (a, b) => (b.worldBossKills - a.worldBossKills) || (b.worldBossParticipations - a.worldBossParticipations) || byNameStable(a, b),
  bestiary: (a, b) => (b.bestiaryDiscovered - a.bestiaryDiscovered) || byNameStable(a, b),
  guild: (a, b) => (b.totalLevel - a.totalLevel) || (b.memberCount - a.memberCount) || String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR'),
});
function sortForType(type, rows) {
  const cmp = RANK_COMPARATORS[type];
  return cmp ? [...rows].sort(cmp) : rows;
}

module.exports = { RANK_TYPES, RANK_PAGE_SIZE, RANK_CACHE_MS, isValidRankType, kdRatio, paginate, createRankCache, RANK_COMPARATORS, sortForType };
