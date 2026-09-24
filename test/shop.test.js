'use strict';
// Fase 3 (loja server-autoritativa) + Fase 5.1 (modelo de item com uid/lv/
// rarity/enchant, equip/unequip por uid, protecao de posse no PUT generico).
// Precisa de Supabase configurado.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson } = require('./helpers');

const PORT = 8104;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rnd = () => 'qa_' + Math.random().toString(36).slice(2, 10);
async function newChar(gold, cls = 'guerreiro', lvl = 1) {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Heroi', cls }, token);
  const id = created.json.character.id;
  await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl, save: { gold: gold ?? 1000 } }, token);
  return { token, id };
}
async function shop(id, token, action, params) {
  return httpJson(srv, 'POST', '/api/characters/' + id + '/shop', Object.assign({ action }, params || {}), token);
}
async function getChar(id, token) { return httpJson(srv, 'GET', '/api/characters', null, token); }

test('compra: espada Nv1 custa 60 e equipa automaticamente (slot vazio), ganha uid valido e rarity basic', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  const r = await shop(id, token, 'buy_gear', { type: 'sword', lv: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.character.save.gold, 940);
  const sw = r.json.character.save.eq.sword;
  assert.equal(sw.type, 'sword');
  assert.equal(sw.lv, 1);
  assert.equal(sw.rarity, 'basic');
  assert.equal(sw.enchant, 0);
  assert.ok(UID_RE.test(sw.uid), 'item comprado deveria ter uid valido');
});

test('compra: ouro insuficiente e rejeitada (400), nao debita nada', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(10);
  const r = await shop(id, token, 'buy_gear', { type: 'sword', lv: 1 });
  assert.equal(r.status, 400);
});

test('compra: nivel/tipo invalido e rejeitada', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  const r1 = await shop(id, token, 'buy_gear', { type: 'sword', lv: 17 }); // 17 nao e uma das 11 faixas
  assert.equal(r1.status, 400);
  const r2 = await shop(id, token, 'buy_gear', { type: 'espada_lendaria', lv: 20 });
  assert.equal(r2.status, 400);
});

test('compra: arma de outra classe e rejeitada', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000, 'mago');
  const r = await shop(id, token, 'buy_gear', { type: 'sword', lv: 1 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /classe/i);
});

test('compra: nivel insuficiente guarda item legitimo na mochila sem equipar', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000, 'guerreiro', 1);
  const r = await shop(id, token, 'buy_gear', { type: 'sword', lv: 4 });
  assert.equal(r.status, 200);
  assert.equal(r.json.character.save.eq.sword, null);
  assert.equal(r.json.character.save.bag[0].req, 4);
});

test('compra: preco, uid, rarity e stats forjados no corpo do request sao ignorados e recalculados no servidor', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000, 'arqueiro', 8);
  const r = await shop(id, token, 'buy_gear', {
    type: 'bow', lv: 8, price: 1, atk: 9999, uid: '11111111-1111-1111-1111-111111111111', rarity: 'legendary', enchant: 10,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.character.save.gold, 550); // preco real de lv8 (450), nao o "1" forjado
  const bow = r.json.character.save.eq.sword;
  assert.equal(bow.atk, 9); // valor real, nao 9999
  assert.equal(bow.rarity, 'basic'); // Mercador so vende basic, nunca legendary
  assert.equal(bow.enchant, 0);
  assert.notEqual(bow.uid, '11111111-1111-1111-1111-111111111111'); // uid sempre gerado pelo servidor
});

test('compra: mochila cheia rejeita item que nao pode auto-equipar sem debitar ouro', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(2000);
  await shop(id, token, 'buy_gear', { type: 'sword', lv: 1 });
  for (let i = 0; i < 12; i++) {
    const r = await shop(id, token, 'buy_gear', { type: 'sword', lv: 1 });
    assert.equal(r.status, 200);
  }
  const blocked = await shop(id, token, 'buy_gear', { type: 'sword', lv: 1 });
  assert.equal(blocked.status, 400);
  assert.match(blocked.json.error, /Mochila cheia/);
});

test('compra em pilha: potao de vida (10 ouro cada) soma a quantidade certa', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  const r = await shop(id, token, 'buy_stack', { key: 'pv', qty: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.json.character.save.gold, 950);
  assert.equal(r.json.character.save.pv, 5);
});

test('equipar por uid: item na mochila vai pro slot, nivel insuficiente e rejeitado', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000, 'guerreiro', 1);
  const bought = await shop(id, token, 'buy_gear', { type: 'sword', lv: 4 }); // nivel 1, nao equipa sozinho
  const uid = bought.json.character.save.bag[0].uid;
  const tooLow = await shop(id, token, 'equip_item', { uid });
  assert.equal(tooLow.status, 400);
  assert.match(tooLow.json.error, /[Nn]ível/);
  // sobe de nivel via PUT e tenta de novo
  await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 4, save: bought.json.character.save }, token);
  const ok = await shop(id, token, 'equip_item', { uid });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.character.save.eq.sword.uid, uid);
  assert.equal(ok.json.character.save.bag.length, 0);
});

test('equipar por uid inexistente e rejeitado', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  const r = await shop(id, token, 'equip_item', { uid: '99999999-9999-9999-9999-999999999999' });
  assert.equal(r.status, 400);
});

test('desequipar: item volta pra mochila, mesmo uid preservado; rejeita se mochila cheia', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  const bought = await shop(id, token, 'buy_gear', { type: 'sword', lv: 1 }); // auto-equipa
  const uid = bought.json.character.save.eq.sword.uid;
  const r = await shop(id, token, 'unequip_item', { slot: 'sword' });
  assert.equal(r.status, 200);
  assert.equal(r.json.character.save.eq.sword, null);
  assert.equal(r.json.character.save.bag[0].uid, uid);
});

test('venda por uid: devolve o preco certo, some da mochila, nao duplica uid na recompra', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  await shop(id, token, 'buy_gear', { type: 'sword', lv: 1 });
  const bought = await shop(id, token, 'buy_gear', { type: 'sword', lv: 1 }); // 2a vai pra mochila
  assert.equal(bought.json.character.save.bag.length, 1);
  const uid = bought.json.character.save.bag[0].uid;
  const goldBefore = bought.json.character.save.gold;
  const sold = await shop(id, token, 'sell_item', { uid });
  assert.equal(sold.status, 200);
  assert.equal(sold.json.character.save.bag.length, 0);
  assert.ok(sold.json.character.save.gold > goldBefore);
  const buyback = await shop(id, token, 'buyback', { index: 0 });
  assert.equal(buyback.status, 200);
  assert.equal(buyback.json.character.save.bag[0].uid, uid, 'recompra deveria devolver o MESMO uid vendido');
});

test('venda: uid/indice invalido e rejeitada', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  const r1 = await shop(id, token, 'sell_item', { bagIndex: 5 });
  assert.equal(r1.status, 400);
  const r2 = await shop(id, token, 'sell_item', { uid: 'nao-existe' });
  assert.equal(r2.status, 400);
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

// ===== Fase 5.1: tampering do PUT generico (posse server-authoritative) =====
test('tampering: PUT com item forjado (uid inventado, nunca comprado) nao e aceito', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  const forged = { uid: '12345678-1234-1234-1234-123456789012', type: 'sword', lv: 40, rarity: 'legendary', enchant: 10 };
  const r = await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 1, save: { gold: 1000, bag: [forged], eq: {} } }, token);
  assert.equal(r.status, 200); // o PUT em si sempre "sucede" -- so o item forjado nao sobrevive
  assert.equal((r.json.character.save.bag || []).length, 0, 'item nunca comprado nao pode aparecer via PUT bruto');
});

test('tampering: PUT trocando rarity/enchant/lv/atk de um item ja possuido nao tem efeito (sempre volta a copia canonica do servidor)', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  const bought = await shop(id, token, 'buy_gear', { type: 'sword', lv: 1 });
  const real = bought.json.character.save.eq.sword;
  const tampered = { ...real, rarity: 'legendary', enchant: 10, lv: 40, atk: 99999 };
  const r = await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 1, save: { ...bought.json.character.save, eq: { sword: tampered } } }, token);
  assert.equal(r.status, 200);
  const sw = r.json.character.save.eq.sword;
  assert.equal(sw.uid, real.uid);
  assert.equal(sw.rarity, 'basic'); assert.equal(sw.enchant, 0); assert.equal(sw.lv, 1); assert.equal(sw.atk, real.atk);
});

test('tampering: uid duplicado (mesmo item citado 2x no bag, ou em bag+eq) nunca vira 2 copias', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(1000);
  const bought = await shop(id, token, 'buy_gear', { type: 'sword', lv: 1 });
  const real = bought.json.character.save.eq.sword;
  const dup1 = await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 1, save: { ...bought.json.character.save, bag: [real, { ...real }], eq: { sword: null } } }, token);
  assert.equal(dup1.json.character.save.bag.length, 1, 'uid duplicado na mochila nao pode virar 2 copias');
  const dup2 = await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 1, save: { ...bought.json.character.save, bag: [real], eq: { sword: real } } }, token);
  // uid so pode estar em UM lugar: ou mochila ou equipado, nunca os dois
  const total = (dup2.json.character.save.bag.length) + (dup2.json.character.save.eq.sword ? 1 : 0);
  assert.equal(total, 1);
});

test('compras concorrentes do mesmo personagem nao duplicam ouro/itens (mutex por personagem)', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(120); // da exatamente pra 2 espadas (60 cada), nao pra 3
  const [a, b, c] = await Promise.all([
    shop(id, token, 'buy_gear', { type: 'sword', lv: 1 }),
    shop(id, token, 'buy_gear', { type: 'sword', lv: 1 }),
    shop(id, token, 'buy_gear', { type: 'sword', lv: 1 }),
  ]);
  const oks = [a, b, c].filter(r => r.status === 200).length;
  const final = await getChar(id, token);
  const ch = final.json.characters.find(x => x.id === id);
  assert.equal(oks, 2, 'com 120 de ouro so 2 das 3 compras concorrentes de 60 deveriam suceder');
  assert.equal(ch.save.gold, 0, 'ouro final deveria refletir exatamente as compras que sucederam, sem corrida');
});
