'use strict';
// Fase 5.3: preco de venda por raridade, protecao do sell_common contra
// item raro, e buyback preservando rarity/lv/enchant/uid. Como comprar no
// Mercador so gera Basic (por design -- ver LEIA-PRIMEIRO.md "Fase 5.3"),
// os itens Rare/Epic/Legendary usados aqui sao semeados direto no Supabase
// de TESTE via adminPatchCharacter (mesmo padrao de setup usado em
// test/dungeon-integration.test.js) -- os testes em si exercitam os
// fluxos reais de venda/recompra (handleShop), sem bypass. Precisa de
// Supabase (projeto de TESTE, nunca o oficial).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, adminPatchCharacter } = require('./helpers');
const S = require('../server.js');

const PORT = 8112;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'qa_' + Math.random().toString(36).slice(2, 10);
async function newChar(gold, cls = 'guerreiro') {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Vendedor', cls }, token);
  const id = created.json.character.id;
  return { token, id, save: created.json.character.save };
}
// Seeda a mochila do personagem com itens reais (uid/stats vindos de
// createGear de verdade, nao inventados a mao) -- so o setup que nao tem
// mais rota legitima (compra sempre gera Basic).
async function seedBag(ch, items) {
  await adminPatchCharacter(ch.id, { save: { ...ch.save, bag: items } });
}
async function shop(id, token, action, params) {
  return httpJson(srv, 'POST', '/api/characters/' + id + '/shop', Object.assign({ action }, params || {}), token);
}

test('venda por raridade: Basic 1x, Rare 2x, Epic 4x, Legendary 8x sobre o preco base do nivel', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(0);
  const basic = S.createGear('armor', 20, 'basic');
  const rare = S.createGear('armor', 20, 'rare');
  const epic = S.createGear('armor', 20, 'epic');
  const legendary = S.createGear('armor', 20, 'legendary');
  await seedBag(ch, [basic, rare, epic, legendary]);
  const base = S.GEAR_DATA.sellPriceFor(20);

  const sBasic = await shop(ch.id, ch.token, 'sell_item', { uid: basic.uid });
  assert.equal(sBasic.json.character.save.gold, base);
  const sRare = await shop(ch.id, ch.token, 'sell_item', { uid: rare.uid });
  assert.equal(sRare.json.character.save.gold, base + base * 2);
  const sEpic = await shop(ch.id, ch.token, 'sell_item', { uid: epic.uid });
  assert.equal(sEpic.json.character.save.gold, base + base * 2 + base * 4);
  const sLeg = await shop(ch.id, ch.token, 'sell_item', { uid: legendary.uid });
  assert.equal(sLeg.json.character.save.gold, base + base * 2 + base * 4 + base * 8);
});

test('sell_common (venda em massa): Rare/Epic/Legendary Nv1 NAO sao vendidos como "comuns" -- so Basic', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(0);
  const basicLv1 = S.createGear('boots', 1, 'basic');
  const rareLv1 = S.createGear('boots', 1, 'rare');
  const epicLv1 = S.createGear('boots', 1, 'epic');
  const legendaryLv1 = S.createGear('boots', 1, 'legendary');
  const basicLv20 = S.createGear('boots', 20, 'basic'); // basic de nivel alto tambem deveria vender (rarity, nao nivel, decide)
  await seedBag(ch, [basicLv1, rareLv1, epicLv1, legendaryLv1, basicLv20]);

  const r = await shop(ch.id, ch.token, 'sell_common', {});
  assert.equal(r.status, 200);
  const remaining = r.json.character.save.bag.map(it => it.uid);
  assert.ok(!remaining.includes(basicLv1.uid), 'basic Nv1 deveria ter sido vendido');
  assert.ok(!remaining.includes(basicLv20.uid), 'basic Nv20 tambem deveria ter sido vendido (rarity decide, nao nivel)');
  assert.ok(remaining.includes(rareLv1.uid), 'Rare Nv1 NUNCA pode ser vendido como comum');
  assert.ok(remaining.includes(epicLv1.uid), 'Epic Nv1 NUNCA pode ser vendido como comum');
  assert.ok(remaining.includes(legendaryLv1.uid), 'Legendary Nv1 NUNCA pode ser vendido como comum');
  const expectedGold = S.GEAR_DATA.sellPriceForItem(basicLv1) + S.GEAR_DATA.sellPriceForItem(basicLv20);
  assert.equal(r.json.character.save.gold, expectedGold);
});

test('buyback preserva uid/rarity/lv/enchant de um item Epic vendido (nunca vira Basic)', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(0);
  const epic = S.createGear('cape', 16, 'epic');
  await seedBag(ch, [epic]);
  const sold = await shop(ch.id, ch.token, 'sell_item', { uid: epic.uid });
  assert.equal(sold.status, 200);
  const soldPrice = sold.json.character.save.gold;
  // da ouro suficiente pra recomprar (buyback = preco de venda * 1.5, ja arredondado no momento da venda)
  await adminPatchCharacter(ch.id, { save: { ...sold.json.character.save, gold: 999999 } });
  const buyback = await shop(ch.id, ch.token, 'buyback', { index: 0 });
  assert.equal(buyback.status, 200);
  const back = buyback.json.character.save.bag.find(it => it.uid === epic.uid);
  assert.ok(back, 'buyback deveria devolver o MESMO uid vendido');
  assert.equal(back.rarity, 'epic');
  assert.equal(back.lv, 16);
  assert.equal(back.enchant, 0);
});

test('tampering: PUT nao consegue promover um item Basic ja possuido pra Legendary (protecao generica de posse ja cobre rarity forjada)', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(1000);
  const bought = await shop(ch.id, ch.token, 'buy_gear', { type: 'sword', lv: 1 });
  const real = bought.json.character.save.eq.sword;
  assert.equal(real.rarity, 'basic');
  const tampered = { ...real, rarity: 'legendary' };
  const r = await httpJson(srv, 'PUT', '/api/characters/' + ch.id, { lvl: 1, save: { ...bought.json.character.save, eq: { sword: tampered } } }, ch.token);
  assert.equal(r.json.character.save.eq.sword.rarity, 'basic', 'rarity forjada via PUT bruto nunca deveria sobreviver');
  assert.equal(r.json.character.save.eq.sword.uid, real.uid);
});
