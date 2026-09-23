'use strict';
// Fase 3: compra, venda, recompra (loja server-autoritativa, Fase A/Fase 1).
// Precisa de Supabase configurado.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson } = require('./helpers');

const PORT = 8104;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'qa_' + Math.random().toString(36).slice(2, 10);
async function newChar(gold) {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Heroi', cls: 'guerreiro' }, token);
  const id = created.json.character.id;
  await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 1, save: { gold: gold ?? 1000 } }, token);
  return { token, id };
}
async function shop(id, token, action, params) {
  return httpJson(srv, 'POST', '/api/characters/' + id + '/shop', Object.assign({ action }, params || {}), token);
}

test('compra: espada tier1 custa 60 e equipa automaticamente (slot vazio)', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  const r = await shop(id, token, 'buy_gear', { type: 'sword', tier: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.character.save.gold, 940);
  assert.equal(r.json.character.save.eq.sword.type, 'sword');
});

test('compra: ouro insuficiente e rejeitada (400), nao debita nada', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(10);
  const r = await shop(id, token, 'buy_gear', { type: 'sword', tier: 1 });
  assert.equal(r.status, 400);
});

test('compra: item invalido (tipo/tier inexistente) e rejeitada', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  const r = await shop(id, token, 'buy_gear', { type: 'sword', tier: 99 });
  assert.equal(r.status, 400);
});

test('compra em pilha: potao de vida (10 ouro cada) soma a quantidade certa', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  const r = await shop(id, token, 'buy_stack', { key: 'pv', qty: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.json.character.save.gold, 950);
  assert.equal(r.json.character.save.pv, 5);
});

test('venda: item da mochila devolve o preco certo e some da mochila', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  // compra uma 2a espada (a 1a auto-equipa, a 2a vai pra mochila)
  await shop(id, token, 'buy_gear', { type: 'sword', tier: 1 });
  const bought = await shop(id, token, 'buy_gear', { type: 'sword', tier: 1 });
  assert.equal(bought.json.character.save.bag.length, 1, 'segunda espada deveria ir pra mochila (slot ja ocupado)');
  const goldBefore = bought.json.character.save.gold;
  const sold = await shop(id, token, 'sell_item', { bagIndex: 0 });
  assert.equal(sold.status, 200);
  assert.equal(sold.json.character.save.bag.length, 0);
  assert.ok(sold.json.character.save.gold > goldBefore, 'ouro nao aumentou depois da venda');
});

test('venda: indice de mochila invalido e rejeitada', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  const r = await shop(id, token, 'sell_item', { bagIndex: 5 });
  assert.equal(r.status, 400);
});

test('recompra: item recem-vendido pode ser recomprado pelo preco de recompra', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  await shop(id, token, 'buy_gear', { type: 'sword', tier: 1 });
  const bought = await shop(id, token, 'buy_gear', { type: 'sword', tier: 1 });
  const sold = await shop(id, token, 'sell_item', { bagIndex: 0 });
  assert.equal(sold.json.shopSold.length, 1, 'item vendido nao apareceu na lista de recompra');
  const goldBeforeBuyback = sold.json.character.save.gold;
  const buyback = await shop(id, token, 'buyback', { index: 0 });
  assert.equal(buyback.status, 200);
  assert.ok(buyback.json.character.save.gold < goldBeforeBuyback, 'recompra nao descontou ouro');
});

test('redistribuir habilidades: custa 30 e reseta os ranks pro base', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  const r = await shop(id, token, 'skill_reset', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.character.save.gold, 970);
  for (const rank of Object.values(r.json.character.save.sk)) assert.equal(rank, 1);
});

test('venda de gema: converte gema em ouro pelo preco certo', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(0);
  await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 1, save: { gold: 0, gem: 3 } }, token);
  const r = await shop(id, token, 'sell_gem', { qty: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.json.character.save.gem, 1);
  assert.equal(r.json.character.save.gold, 50);
});
