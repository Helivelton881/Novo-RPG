'use strict';
// Fase 5.17.2 -- Mercador de Reliquias. Testes puros (sem HTTP/Supabase)
// contra game-data/relic-shop.js, balance-data.js e o nucleo de compra
// exportado por server.js. Relogio sempre injetado.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../game-data/balance-data.js');
const R = require('../game-data/relic-shop.js');
const S = require('../server.js');

const CLASSES = Object.keys(S.DROP_TYPES_BY_CLASS);
const NOW = Date.UTC(2026, 8, 24, 15, 0, 0);            // qua 24/09/2026 12h BRT
const SAME_WEEK_LATER = Date.UTC(2026, 8, 28, 2, 59, 0); // dom 27/09 23:59 BRT
const NEXT_WEEK = Date.UTC(2026, 8, 28, 3, 0, 0);        // seg 28/09 00:00 BRT
const NPC = B.RELIC_SHOP.NPC;
const AT_NPC = { map: 'vila', x: NPC.x + 20, y: NPC.y + 10 };
const WEEK = R.relicWeekInfo(NOW).weekId;

function saveFor(cls, lvl, extra) { return S.sanitizeSave({ cls, gem: 1000, gold: 0, bag: [], ...extra }, lvl); }
function stock(cls, lvl, now = NOW) { return S.relicShopView(saveFor(cls, lvl), lvl, now).offers; }

// ===================== SEMANA =====================
test('SEMANA: reset segunda 00:00 BRT (03:00 UTC); weekId/startAt/nextResetAt estaveis', () => {
  const a = R.relicWeekInfo(NOW), b = R.relicWeekInfo(SAME_WEEK_LATER), c = R.relicWeekInfo(NEXT_WEEK);
  assert.equal(a.weekId, '2026-W39');
  assert.equal(b.weekId, a.weekId, 'domingo 23:59 BRT ainda e a mesma semana');
  assert.equal(c.weekId, '2026-W40', 'segunda 00:00 BRT vira');
  assert.equal(a.startAt, Date.UTC(2026, 8, 21, 3, 0, 0));
  assert.equal(a.nextResetAt, NEXT_WEEK);
  assert.equal(c.startAt, NEXT_WEEK);
  assert.equal(new Date(a.nextResetAt).getUTCDay(), 1);
  assert.equal(new Date(a.nextResetAt).getUTCHours(), 3);
});

test('SEMANA: virada de ano ISO correta', () => {
  assert.equal(R.relicWeekInfo(Date.UTC(2027, 0, 1, 12)).weekId, '2026-W53');
  assert.equal(R.relicWeekInfo(Date.UTC(2027, 0, 4, 12)).weekId, '2027-W01');
});

// ===================== ESTOQUE =====================
test('ESTOQUE: exatamente 6 ofertas -- 4 Rare (slots 0-3) + 2 Epic (4-5), nunca Basic/Legendary', () => {
  for (const cls of CLASSES) for (const lvl of [1, 4, 7, 12, 23, 29, 36, 40]) {
    const s = stock(cls, lvl);
    assert.equal(s.length, 6, `${cls} Lv${lvl}`);
    assert.deepEqual(s.map(o => o.rarity), ['rare', 'rare', 'rare', 'rare', 'epic', 'epic']);
    for (const o of s) { assert.notEqual(o.rarity, 'legendary'); assert.notEqual(o.rarity, 'basic'); }
  }
});

test('ESTOQUE: deterministico -- mesma semana/classe/nivel = mesmo estoque (relogar/restart/reconnect)', () => {
  for (const cls of CLASSES) {
    const a = stock(cls, 30, NOW), b = stock(cls, 30, SAME_WEEK_LATER);
    delete require.cache[require.resolve('../game-data/relic-shop.js')];
    const R2 = require('../game-data/relic-shop.js'); // "restart": modulo recarregado do zero
    const c = R2.relicStock({ weekId: WEEK, cls, lvl: 30, types: S.DROP_TYPES_BY_CLASS[cls] });
    const key = x => x.map(o => [o.offerId, o.type, o.lv, o.rarity, o.priceGem].join('|'));
    assert.deepEqual(key(a), key(b));
    assert.deepEqual(key(a), key(c));
  }
});

test('ESTOQUE: semana seguinte gira (pelo menos uma oferta muda para alguma classe)', () => {
  let changed = 0;
  for (const cls of CLASSES) {
    const a = stock(cls, 36, NOW).map(o => o.type + o.lv), b = stock(cls, 36, NEXT_WEEK).map(o => o.type + o.lv);
    if (a.join() !== b.join()) changed++;
    assert.notEqual(stock(cls, 36, NOW)[0].offerId, stock(cls, 36, NEXT_WEEK)[0].offerId, 'offerId carrega o weekId');
  }
  assert.ok(changed >= 1);
});

test('CLASSE: todo tipo ofertado e compativel com a classe real (fonte: DROP_TYPES_BY_CLASS)', () => {
  assert.deepEqual(CLASSES.sort(), ['arqueiro', 'druida', 'guerreiro', 'mago']);
  for (const cls of CLASSES) for (let w = 1; w <= 20; w++) {
    const weekId = '2027-W' + String(w).padStart(2, '0');
    for (const o of R.relicStock({ weekId, cls, lvl: 40, types: S.DROP_TYPES_BY_CLASS[cls] })) {
      assert.ok(S.DROP_TYPES_BY_CLASS[cls].includes(o.type), `${cls} recebeu ${o.type}`);
      assert.ok(S.CLASS_ITEM_TYPES[cls].includes(o.type), `${cls} pode equipar ${o.type}`);
    }
  }
});

test('NIVEL: nunca acima do personagem; pool = dois maiores tiers elegiveis', () => {
  const expectPool = { 1: [1], 3: [1], 4: [4, 1], 7: [4, 1], 12: [12, 8], 23: [20, 16], 29: [28, 24], 36: [36, 32], 37: [36, 32], 40: [40, 36] };
  for (const [lvl, pool] of Object.entries(expectPool)) assert.deepEqual(R.relicTierPool(Number(lvl)), pool, `Lv${lvl}`);
  for (const cls of CLASSES) for (let lvl = 1; lvl <= 40; lvl++) for (const o of stock(cls, lvl)) {
    assert.ok(o.lv <= lvl, `${cls} Lv${lvl} recebeu gear Lv${o.lv}`);
    assert.ok(R.relicTierPool(lvl).includes(o.lv));
    assert.ok(o.itemPreview.req <= lvl, 'req nunca acima do nivel');
  }
});

test('NIVEL: tier maximo predomina (~70%) e o anterior aparece', () => {
  let top = 0, prev = 0;
  for (const cls of CLASSES) for (let w = 1; w <= 52; w++) for (const o of R.relicStock({ weekId: '2027-W' + String(w).padStart(2, '0'), cls, lvl: 36, types: S.DROP_TYPES_BY_CLASS[cls] })) { if (o.lv === 36) top++; else if (o.lv === 32) prev++; else assert.fail('tier fora do pool'); }
  const share = top / (top + prev);
  assert.ok(share > 0.6 && share < 0.8, `share ${share}`);
  assert.ok(prev > 0);
});

test('DEDUP: nunca repete type+lv+rarity na mesma semana quando o pool permite (Lv8+)', () => {
  for (const cls of CLASSES) for (let w = 1; w <= 52; w++) for (const lvl of [8, 20, 40]) {
    const s = R.relicStock({ weekId: '2027-W' + String(w).padStart(2, '0'), cls, lvl, types: S.DROP_TYPES_BY_CLASS[cls] });
    const keys = s.map(o => o.type + ':' + o.lv + ':' + o.rarity);
    assert.equal(new Set(keys).size, keys.length, `${cls} Lv${lvl} W${w}: ${keys}`);
  }
});

// ===================== PRECO =====================
test('PRECO: tabela oficial exata Rare/Epic em todos os 11 tiers', () => {
  const rare = [2, 3, 4, 5, 7, 9, 12, 15, 19, 24, 30], epic = [8, 10, 12, 15, 18, 22, 28, 34, 42, 52, 65];
  const tiers = [1, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40];
  assert.deepEqual(tiers, S.GEAR_DATA.GEAR_LEVELS);
  tiers.forEach((lv, i) => {
    assert.equal(B.relicPrice(lv, 'rare'), rare[i], `Rare Lv${lv}`);
    assert.equal(B.relicPrice(lv, 'epic'), epic[i], `Epic Lv${lv}`);
    assert.equal(B.relicPrice(lv, 'legendary'), null);
    assert.equal(B.relicPrice(lv, 'basic'), null);
  });
  for (const o of stock('mago', 40)) assert.equal(o.priceGem, B.relicPrice(o.lv, o.rarity));
});

test('ECONOMIA 5.17 INTACTA: fontes de gema/drop/enchant nao mudaram', () => {
  assert.deepEqual(B.DROP_RATES.dungeonBoss, { rare: 0.12, epic: 0.025, legendary: 0.003 });
  assert.equal(B.DUNGEON.BOSS_GEMS, 2);
  assert.equal(B.WORLD_BOSS.GEMS, 5);
  assert.deepEqual(B.TVT.GEMS, { win: 1, draw: 1, loss: 1 });
  assert.equal(B.FIELD_BOSS.DAILY_GEMS, 1);
  assert.equal(B.ENCHANT_GEM_COST[10], 12);
});

// ===================== COMPRA =====================
function buy(save, lvl, slot, opts = {}) {
  const view = S.relicShopView(save, lvl, opts.now || NOW);
  const offer = view.offers[slot];
  return { offer, out: S.attemptRelicPurchase(save, lvl, opts.offerId || offer.offerId, ('ctx' in opts ? opts.ctx : AT_NPC), opts.expected, opts.now || NOW) };
}

test('COMPRA Rare e Epic: cobra gema exata, item canonico +0 na mochila, slot marcado', () => {
  const save = saveFor('arqueiro', 36);
  for (const slot of [0, 4]) {
    const before = save.gem;
    const { offer, out } = buy(save, 36, slot);
    assert.ok(out.result, JSON.stringify(out));
    const it = out.result.item;
    assert.equal(before - save.gem, offer.priceGem);
    assert.equal(it.enchant, 0);
    assert.equal(it.rarity, offer.rarity);
    assert.equal(it.lv, offer.lv);
    assert.equal(it.type, offer.type);
    assert.match(it.uid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const st = S.GEAR_DATA.statsFor(it.type, it.lv, it.rarity, 0);
    assert.equal(it.req, st.req);
    if (st.atk) assert.equal(it.atk, st.atk);
    assert.ok(save.bag.some(b => b.uid === it.uid));
  }
  assert.deepEqual(save.relicShop, { w: WEEK, b: [0, 4] });
});

test('COMPRA: estado sobrevive a sanitizeSave (reload/relogin) e a oferta aparece COMPRADA', () => {
  const save = saveFor('druida', 20);
  const { offer } = buy(save, 20, 2);
  const reloaded = S.sanitizeSave(JSON.parse(JSON.stringify(save)), 20);
  assert.deepEqual(reloaded.relicShop, { w: WEEK, b: [2] });
  const view = S.relicShopView(reloaded, 20, NOW);
  assert.equal(view.offers[2].purchased, true);
  assert.equal(view.offers[1].purchased, false);
  const again = S.attemptRelicPurchase(reloaded, 20, offer.offerId, AT_NPC, null, NOW);
  assert.equal(again.error, 'ALREADY_PURCHASED');
});

test('COMPRA: semana nova = reset logico (compras antigas nao bloqueiam; sem historico acumulado)', () => {
  const save = saveFor('mago', 40);
  buy(save, 40, 0); buy(save, 40, 1);
  const view = S.relicShopView(save, 40, NEXT_WEEK);
  assert.ok(view.offers.every(o => !o.purchased));
  const { out } = buy(save, 40, 0, { now: NEXT_WEEK });
  assert.ok(out.result);
  assert.deepEqual(save.relicShop, { w: '2026-W40', b: [0] });
});

test('UMA POR OFERTA: 2a compra da mesma oferta (duplo clique/retry/2 abas) nao cobra nem duplica', () => {
  const save = saveFor('guerreiro', 28);
  const { offer } = buy(save, 28, 3);
  const gemAfter = save.gem, bagAfter = save.bag.length;
  for (let i = 0; i < 3; i++) assert.equal(S.attemptRelicPurchase(save, 28, offer.offerId, AT_NPC, null, NOW).error, 'ALREADY_PURCHASED');
  assert.equal(save.gem, gemAfter);
  assert.equal(save.bag.length, bagAfter);
});

test('MOCHILA CHEIA: rejeita, nao cobra, nao marca', () => {
  const full = Array.from({ length: S.SHOP_BAG_MAX }, () => S.createGear('boots', 1, 'basic'));
  const save = saveFor('guerreiro', 40, { bag: full });
  const { out } = buy(save, 40, 0);
  assert.equal(out.error, 'Mochila cheia');
  assert.equal(save.gem, 1000);
  assert.equal(save.bag.length, S.SHOP_BAG_MAX);
  assert.deepEqual(save.relicShop, { w: '', b: [] });
});

test('GEMAS INSUFICIENTES: rejeita sem alterar bag/gem/estado', () => {
  const save = saveFor('guerreiro', 40, { gem: 5 });
  const { out } = buy(save, 40, 5);
  assert.equal(out.error, 'Gemas insuficientes');
  assert.equal(save.gem, 5);
  assert.equal(save.bag.length, 0);
  assert.deepEqual(save.relicShop.b, []);
});

test('MAPA/PROXIMIDADE: fora da Vila ou longe do NPC nao compra', () => {
  for (const ctx of [{ map: 'floresta', x: NPC.x, y: NPC.y }, { map: 'floresta_d#abcd1234', x: NPC.x, y: NPC.y }, { map: 'tvt#abc123', x: NPC.x, y: NPC.y }, { map: 'vila', x: NPC.x + 400, y: NPC.y }, null]) {
    const save = saveFor('guerreiro', 40);
    const { out } = buy(save, 40, 0, { ctx });
    assert.ok(out.error, JSON.stringify(ctx));
    assert.equal(save.gem, 1000);
  }
});

// ===================== SEGURANCA =====================
test('SEGURANCA: offerId forjado/inexistente/semana antiga/futura/outra classe e rejeitado', () => {
  const save = saveFor('guerreiro', 40);
  const bad = ['', 'x', 'relic:2026-W39:guerreiro:9', 'relic:2026-W38:guerreiro:0', 'relic:2026-W41:guerreiro:0', 'relic:2026-W39:mago:0', 'relic:2026-W39:guerreiro:-1', 'relic:2026-W39:admin:0', { rarity: 'legendary' }];
  for (const id of bad) {
    const out = S.attemptRelicPurchase(save, 40, id, AT_NPC, null, NOW);
    assert.ok(out.error, String(id));
  }
  assert.equal(save.gem, 1000);
  assert.equal(save.bag.length, 0);
});

test('SEGURANCA: `expected` do cliente so pode REJEITAR (OFFER_CHANGED) -- nunca muda raridade/nivel/preco', () => {
  const save = saveFor('guerreiro', 40);
  const view = S.relicShopView(save, 40, NOW), offer = view.offers[0];
  const forged = S.attemptRelicPurchase(save, 40, offer.offerId, AT_NPC, { type: offer.type, lv: 40, rarity: 'legendary', price: 0 }, NOW);
  assert.equal(forged.error, 'OFFER_CHANGED');
  assert.equal(save.gem, 1000);
  const ok = S.attemptRelicPurchase(save, 40, offer.offerId, AT_NPC, { type: offer.type, lv: offer.lv, rarity: offer.rarity, price: 1, stats: { atk: 9999 } }, NOW);
  assert.equal(ok.result.item.rarity, 'rare');
  assert.equal(1000 - save.gem, offer.priceGem, 'preco sempre o oficial');
  assert.notEqual(ok.result.item.atk, 9999);
});

test('SEGURANCA: PUT generico nunca reseta/forja relicShop, gem ou bag (ECONOMY_LOCK_FIELDS)', () => {
  assert.ok(S.ECONOMY_LOCK_FIELDS.includes('relicShop'));
  assert.ok(S.ECONOMY_LOCK_FIELDS.includes('gem'));
  const forged = S.sanitizeRelicShopState({ w: 'hack', b: [0, 0, 9, -1, 'x', 5] });
  assert.deepEqual(forged, { w: '', b: [0, 5] });
});

test('SEGURANCA: nenhuma combinacao de classe/nivel/semana gera Legendary ou Basic', () => {
  for (const cls of CLASSES) for (let w = 1; w <= 53; w++) for (const lvl of [1, 10, 20, 30, 40]) for (const o of R.relicStock({ weekId: '2026-W' + String(w).padStart(2, '0'), cls, lvl, types: S.DROP_TYPES_BY_CLASS[cls] })) assert.ok(['rare', 'epic'].includes(o.rarity));
});

test('LEVEL-UP no meio da semana: slot comprado continua COMPRADO (nunca abre 6 compras novas por tier)', () => {
  const save = saveFor('guerreiro', 19);
  buy(save, 19, 0);
  const view = S.relicShopView(save, 20, NOW);
  assert.equal(view.offers[0].purchased, true);
});

// ===================== CLIENTE (estatico) =====================
test('CLIENTE: NPC na Vila na posicao central, interacao pelo padrao existente, compra so manda offerId', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id:'relicario',nome:'Mercador de Relíquias',x:BALANCE_DATA\.RELIC_SHOP\.NPC\.x,y:BALANCE_DATA\.RELIC_SHOP\.NPC\.y/);
  assert.match(html, /if\(npc\.id==='relicario'\)\{openRelic\(\);return\}/);
  assert.match(html, /relicRequest\('relic_buy',\{offerId:o\.offerId,expected:\{type:o\.type,lv:o\.lv,rarity:o\.rarity\}\}\)/);
  assert.ok(!/relic_buy'[^)]*price/.test(html), 'cliente nunca manda preco');
  assert.match(html, /<div id="relic" class="rw"/);
});
