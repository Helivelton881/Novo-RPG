'use strict';
// Fase 5.17.2 -- Mercador de Reliquias via HTTP real (handleShop +
// withCharLock + Supabase de TESTE). Sem SUPABASE_URL/SUPABASE_SECRET_KEY
// estes testes ficam SKIPPED (nunca PASS). A logica de compra em si (Vila,
// proximidade, 1x por oferta, bag/gema, forja) esta coberta sem Supabase em
// test/fase-5-17-2-relic-merchant.test.js via attemptRelicPurchase.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, adminPatchCharacter } = require('./helpers');

const PORT = 8219;
let srv;
const skip = !hasSupabase();
before(async () => { if (!skip) srv = await startServer(PORT); });
after(() => { if (srv) stopServer(srv); });

const rnd = () => 'qa_' + Math.random().toString(36).slice(2, 10);
async function newChar(patch = {}, lvl = 36) {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Relic-QA', cls: 'guerreiro' }, token);
  const id = created.json.character.id;
  const save = { ...created.json.character.save, ...patch };
  await adminPatchCharacter(id, { lvl, save });
  return { token, id, save };
}
const shop = (ch, body) => httpJson(srv, 'POST', '/api/characters/' + ch.id + '/shop', body, ch.token);
async function getSave(ch) { const r = await httpJson(srv, 'GET', '/api/characters', null, ch.token); return r.json.characters.find(c => c.id === ch.id).save; }

test('relic_state: 6 ofertas (4 Rare + 2 Epic), weekId/nextResetAt, e NUNCA grava nada', { skip }, async () => {
  const ch = await newChar({ gem: 77 });
  const r = await shop(ch, { action: 'relic_state' });
  assert.equal(r.status, 200);
  assert.equal(r.json.relic.offers.length, 6);
  assert.deepEqual(r.json.relic.offers.map(o => o.rarity), ['rare', 'rare', 'rare', 'rare', 'epic', 'epic']);
  assert.match(r.json.relic.weekId, /^\d{4}-W\d{2}$/);
  assert.ok(r.json.relic.nextResetAt > Date.now());
  const again = await shop(ch, { action: 'relic_state' });
  assert.deepEqual(again.json.relic.offers.map(o => o.offerId + o.type + o.lv), r.json.relic.offers.map(o => o.offerId + o.type + o.lv), 'estoque estavel entre requisicoes');
  assert.equal((await getSave(ch)).gem, 77);
});

test('relic_buy sem sessao de jogo viva na Vila: rejeitado, nada cobrado', { skip }, async () => {
  const ch = await newChar({ gem: 500 });
  const state = await shop(ch, { action: 'relic_state' });
  const r = await shop(ch, { action: 'relic_buy', offerId: state.json.relic.offers[0].offerId, price: 0, rarity: 'legendary' });
  assert.equal(r.status, 400);
  const save = await getSave(ch);
  assert.equal(save.gem, 500);
  assert.equal(save.bag.length, 0);
});

test('PUT generico nao reseta relicShop nem restaura gemas (ECONOMY_LOCK_FIELDS)', { skip }, async () => {
  const ch = await newChar({ gem: 10, relicShop: { w: '2026-W39', b: [0, 4] } });
  const r = await httpJson(srv, 'PUT', '/api/characters/' + ch.id, { lvl: 36, save: { ...ch.save, gem: 9999, relicShop: { w: '', b: [] } } }, ch.token);
  assert.equal(r.status, 200);
  const save = await getSave(ch);
  assert.equal(save.gem, 10);
  assert.deepEqual(save.relicShop, { w: '2026-W39', b: [0, 4] });
});
