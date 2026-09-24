'use strict';
// Fase 5.4: Ferreiro + enchant via HTTP real (handleShop action
// 'enchant_item'). A logica de chance/quebra em si (RNG injetado,
// deterministica) ja esta 100% coberta em test/enchant.test.js, sem
// Supabase -- aqui cobrimos a FIACAO real: endpoint, mutex/withCharLock,
// posse por uid, protecao contra PUT bruto, sell_common, buyback. So os
// alvos SEMPRE seguros (+1/+2/+3, 100% de chance) sao testados via rede de
// verdade, porque o RNG de producao (secureRandom) nao e injetavel pelo
// cliente por design (nunca deixar o cliente controlar o roll). Itens
// Rare/Epic/Legendary e ja-encantados usados aqui sao semeados direto no
// Supabase de TESTE via adminPatchCharacter (mesmo padrao de
// test/rarity-shop.test.js) -- so pra SETUP, nunca pra bypassar o fluxo
// real de enchant_item, que sempre roda por handleShop. Precisa de
// Supabase (projeto de TESTE, nunca o oficial).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, adminPatchCharacter } = require('./helpers');
const S = require('../server.js');

const PORT = 8113;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'qa_' + Math.random().toString(36).slice(2, 10);
async function newChar(gold, cls = 'guerreiro') {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Ferreiro-QA', cls }, token);
  const id = created.json.character.id;
  const save = { ...created.json.character.save, gold };
  await adminPatchCharacter(id, { save });
  return { token, id, save };
}
async function seedBag(ch, items) {
  await adminPatchCharacter(ch.id, { save: { ...ch.save, bag: items } });
}
async function enchant(ch, uid, expectedEnchant) {
  return httpJson(srv, 'POST', '/api/characters/' + ch.id + '/shop', { action: 'enchant_item', uid, expectedEnchant }, ch.token);
}
async function getSave(ch) {
  const r = await httpJson(srv, 'GET', '/api/characters', null, ch.token);
  return r.json.characters.find(c => c.id === ch.id).save;
}

test('enchant +1 via endpoint real: sempre sucesso (safe enchant), custo debitado, mesmo uid', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(100000);
  const sword = S.createGear('sword', 40, 'legendary');
  await seedBag(ch, [sword]);
  const expectedCost = S.GEAR_DATA.enchantCost('sword', 40, 1);
  const r = await enchant(ch, sword.uid, 0);
  assert.equal(r.status, 200);
  assert.equal(r.json.enchant.success, true);
  assert.equal(r.json.enchant.newEnchant, 1);
  assert.equal(r.json.enchant.uid, sword.uid);
  assert.equal(r.json.character.save.bag[0].uid, sword.uid, 'uid deveria permanecer identico');
  assert.equal(r.json.character.save.bag[0].enchant, 1);
  assert.equal(r.json.character.save.gold, 100000 - expectedCost);
});

test('enchant sequencial +1 -> +2 -> +3 via endpoint real: sempre sucesso, nunca quebra', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(100000);
  const armor = S.createGear('armor', 20, 'basic');
  await seedBag(ch, [armor]);
  let uid = armor.uid, exp = 0;
  for (let target = 1; target <= 3; target++) {
    const r = await enchant(ch, uid, exp);
    assert.equal(r.status, 200, `target +${target}`);
    assert.equal(r.json.enchant.success, true);
    assert.equal(r.json.enchant.newEnchant, target);
    exp = target;
  }
  const save = await getSave(ch);
  assert.equal(save.bag[0].enchant, 3);
  assert.equal(save.bag[0].uid, uid);
});

test('enchant: item equipado tambem pode ser encantado (permanece no mesmo slot)', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(100000);
  const cape = S.createGear('cape', 8, 'rare');
  await adminPatchCharacter(ch.id, { save: { ...ch.save, bag: [], eq: { ...ch.save.eq, cape } } });
  const r = await enchant(ch, cape.uid, 0);
  assert.equal(r.status, 200);
  assert.equal(r.json.character.save.eq.cape.uid, cape.uid);
  assert.equal(r.json.character.save.eq.cape.enchant, 1);
});

test('enchant: item nao elegivel (shield/helmet/jewel) e rejeitado sem cobrar', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(100000);
  for (const type of ['shield', 'helmet', 'jewel']) {
    const it = S.createGear(type, 20, 'basic');
    await seedBag(ch, [it]);
    const r = await enchant(ch, it.uid, 0);
    assert.equal(r.status, 400);
    const save = await getSave(ch);
    assert.equal(save.gold, 100000, `${type} nao deveria ter cobrado nada`);
  }
});

test('enchant: uid inexistente e uid de outro personagem sao rejeitados', { skip: !hasSupabase() }, async () => {
  const a = await newChar(100000), b = await newChar(100000);
  const swordB = S.createGear('sword', 12, 'basic');
  await seedBag(b, [swordB]);
  const forged = await enchant(a, '11111111-1111-1111-1111-111111111111', 0);
  assert.equal(forged.status, 400);
  const stolen = await enchant(a, swordB.uid, 0); // uid real, mas pertence a conta B
  assert.equal(stolen.status, 400);
  const stillThere = await getSave(b);
  assert.equal(stillThere.bag[0].uid, swordB.uid, 'personagem B nao deveria ter sido afetado');
});

test('enchant: ouro insuficiente rejeita sem alterar enchant/gold', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(1);
  const sword = S.createGear('sword', 40, 'legendary'); // +1 custa bem mais que 1 ouro
  await seedBag(ch, [sword]);
  const r = await enchant(ch, sword.uid, 0);
  assert.equal(r.status, 400);
  const save = await getSave(ch);
  assert.equal(save.gold, 1);
  assert.equal(save.bag[0].enchant, 0);
});

test('enchant: item +10 rejeitado (MAX_ENCHANT), gold nao muda', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(100000);
  const maxed = S.applyEnchant(S.createGear('boots', 1, 'basic'), 10);
  await seedBag(ch, [maxed]);
  const r = await enchant(ch, maxed.uid, 10);
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'MAX_ENCHANT');
  const save = await getSave(ch);
  assert.equal(save.gold, 100000);
  assert.equal(save.bag[0].enchant, 10);
});

test('enchant: expectedEnchant desatualizado (STALE_ENCHANT_STATE) e rejeitado sem cobrar', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(100000);
  const sword = S.createGear('sword', 20, 'basic');
  await seedBag(ch, [sword]);
  const first = await enchant(ch, sword.uid, 0);
  assert.equal(first.json.enchant.success, true); // agora enchant=1 de verdade
  const goldAfterFirst = first.json.character.save.gold;
  // repete a MESMA request (expectedEnchant=0, que ja nao bate mais)
  const second = await enchant(ch, sword.uid, 0);
  assert.equal(second.status, 400);
  assert.equal(second.json.error, 'STALE_ENCHANT_STATE');
  const save = await getSave(ch);
  assert.equal(save.gold, goldAfterFirst, 'segunda tentativa nao deveria ter cobrado nada');
  assert.equal(save.bag[0].enchant, 1, 'nao deveria ter avancado pra +2 por causa da request duplicada');
});

test('enchant: duas requests concorrentes com o mesmo expectedEnchant -- so uma executa (mutex + expectedEnchant)', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(100000);
  const sword = S.createGear('sword', 20, 'basic');
  await seedBag(ch, [sword]);
  const [a, b] = await Promise.all([enchant(ch, sword.uid, 0), enchant(ch, sword.uid, 0)]);
  const oks = [a, b].filter(r => r.status === 200 && r.json.enchant && r.json.enchant.success).length;
  assert.equal(oks, 1, 'exatamente uma das duas tentativas concorrentes deveria ter executado');
  const save = await getSave(ch);
  assert.equal(save.bag[0].enchant, 1, 'nao pode ter avancado +0->+1->+2 por causa do duplo clique');
});

test('tampering: PUT generico nao consegue forjar enchant (item real fica 0 -> PUT manda 10 -> continua 0)', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(1000);
  const sword = S.createGear('sword', 40, 'legendary'); // enchant real 0
  await seedBag(ch, [sword]);
  const tampered = { ...sword, enchant: 10 };
  const put = await httpJson(srv, 'PUT', '/api/characters/' + ch.id, { lvl: 1, save: { ...ch.save, gold: 1000, bag: [tampered] } }, ch.token);
  assert.equal(put.status, 200);
  assert.equal(put.json.character.save.bag[0].enchant, 0, 'enchant forjado via PUT bruto nunca deveria persistir');
  assert.equal(put.json.character.save.bag[0].uid, sword.uid);
  const reloaded = await getSave(ch);
  assert.equal(reloaded.bag[0].enchant, 0, 'apos reload continua 0');
});

test('buyback preserva enchant: Epic +7 vendido e recomprado continua Epic +7, mesmo uid/lv', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(0);
  const epic7 = S.applyEnchant(S.createGear('armor', 24, 'epic'), 7);
  await seedBag(ch, [epic7]);
  const sold = await httpJson(srv, 'POST', '/api/characters/' + ch.id + '/shop', { action: 'sell_item', uid: epic7.uid }, ch.token);
  assert.equal(sold.status, 200);
  await adminPatchCharacter(ch.id, { save: { ...sold.json.character.save, gold: 999999 } });
  const buyback = await httpJson(srv, 'POST', '/api/characters/' + ch.id + '/shop', { action: 'buyback', index: 0 }, ch.token);
  assert.equal(buyback.status, 200);
  const back = buyback.json.character.save.bag.find(it => it.uid === epic7.uid);
  assert.ok(back, 'buyback deveria devolver o MESMO uid');
  assert.equal(back.rarity, 'epic');
  assert.equal(back.lv, 24);
  assert.equal(back.enchant, 7, 'enchant nao deveria ter sido resetado pelo buyback');
});

test('sell_common: Basic+0 vende normalmente; Basic+1, Rare+0, Epic+0 e Legendary+0 NUNCA sao vendidos automaticamente', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(0);
  const basic0 = S.createGear('boots', 1, 'basic');
  const basic1 = S.applyEnchant(S.createGear('boots', 1, 'basic'), 1);
  const rare0 = S.createGear('boots', 1, 'rare');
  const epic0 = S.createGear('boots', 1, 'epic');
  const legendary0 = S.createGear('boots', 1, 'legendary');
  await seedBag(ch, [basic0, basic1, rare0, epic0, legendary0]);
  const r = await httpJson(srv, 'POST', '/api/characters/' + ch.id + '/shop', { action: 'sell_common' }, ch.token);
  assert.equal(r.status, 200);
  const remaining = r.json.character.save.bag.map(it => it.uid);
  assert.ok(!remaining.includes(basic0.uid), 'Basic +0 deveria ter sido vendido');
  assert.ok(remaining.includes(basic1.uid), 'Basic +1 NUNCA pode ser vendido automaticamente (encantado)');
  assert.ok(remaining.includes(rare0.uid), 'Rare +0 nao e "comum"');
  assert.ok(remaining.includes(epic0.uid), 'Epic +0 nao e "comum"');
  assert.ok(remaining.includes(legendary0.uid), 'Legendary +0 nao e "comum"');
  assert.equal(r.json.character.save.gold, S.GEAR_DATA.sellPriceForItem(basic0));
});
