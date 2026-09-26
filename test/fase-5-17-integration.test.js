'use strict';
// Fase 5.17 -- integracao HTTP real (endpoint + withCharLock + Supabase de
// TESTE). Sem SUPABASE_URL/SUPABASE_SECRET_KEY estes testes sao SKIPPED
// (nunca PASS) -- a logica pura correspondente esta coberta em
// test/fase-5-17-progression.test.js e test/enchant.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, adminPatchCharacter } = require('./helpers');
const S = require('../server.js');
const B = require('../game-data/balance-data.js');

const PORT = 8217;
let srv;
before(async () => { if (hasSupabase()) srv = await startServer(PORT); });
after(() => { if (srv) stopServer(srv); });

const rnd = () => 'qa_' + Math.random().toString(36).slice(2, 10);
async function newChar(patch = {}, lvl) {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'QA-517', cls: 'guerreiro' }, token);
  const id = created.json.character.id;
  const save = { ...created.json.character.save, ...patch };
  await adminPatchCharacter(id, lvl ? { lvl, save } : { save });
  return { token, id, save };
}
async function getChar(ch) {
  const r = await httpJson(srv, 'GET', '/api/characters', null, ch.token);
  return r.json.characters.find(c => c.id === ch.id);
}
const enchant = (ch, body) => httpJson(srv, 'POST', '/api/characters/' + ch.id + '/shop', { action: 'enchant_item', ...body }, ch.token);
const skip = !hasSupabase();

test('ANTI-CHEAT PUT: lvl 40/99, xp/gold/gem gigantes, rwd e enchant forjados sao ignorados', { skip }, async () => {
  const sword = S.createGear('sword', 20, 'basic');
  const ch = await newChar({ gold: 100, gem: 3, bag: [sword] }, 12);
  for (const lvl of [40, 99]) {
    const forged = { ...ch.save, lvl, xp: 9e9, gold: 9e9, gem: 9e9, rwd: { d: '2099-01-01', dx: 0, dg: 0 }, bag: [{ ...sword, enchant: 10, rarity: 'legendary' }] };
    const r = await httpJson(srv, 'PUT', '/api/characters/' + ch.id, { lvl, save: forged }, ch.token);
    assert.equal(r.status, 200);
    const c = await getChar(ch);
    assert.equal(c.lvl, 12); assert.equal(c.save.gold, 100); assert.equal(c.save.gem, 3);
    assert.ok(c.save.xp < B.xpToNext(12));
    assert.equal(c.save.bag[0].enchant, 0); assert.equal(c.save.bag[0].rarity, 'basic');
    assert.notEqual(c.save.rwd.d, '2099-01-01');
  }
});

test('ENCHANT HTTP: +4 sem gema rejeita sem tocar no item; com gema cobra exatamente 1 gema e nunca destroi', { skip }, async () => {
  const sword = S.applyEnchant(S.createGear('sword', 40, 'legendary'), 3);
  const ch = await newChar({ gold: 100000, gem: 0, bag: [sword] });
  const no = await enchant(ch, { uid: sword.uid, expectedEnchant: 3 });
  assert.equal(no.status, 400);
  let c = await getChar(ch);
  assert.equal(c.save.bag[0].enchant, 3); assert.equal(c.save.gold, 100000);

  await adminPatchCharacter(ch.id, { save: { ...c.save, gem: 5 } });
  // corpo forjado: success/cost/chance/rarity sao ignorados pelo servidor
  const r = await enchant(ch, { uid: sword.uid, expectedEnchant: 3, success: true, cost: 0, chance: 1, rarity: 'legendary', newEnchant: 10 });
  assert.equal(r.status, 200);
  assert.equal(r.json.enchant.currency, 'gem');
  c = await getChar(ch);
  assert.equal(c.save.gem, 4, 'exatamente 1 gema consumida (+4)');
  assert.equal(c.save.gold, 100000, '+4 nunca cobra ouro');
  assert.equal(c.save.bag.length, 1, 'item nunca desaparece');
  assert.equal(c.save.bag[0].uid, sword.uid);
  assert.ok([3, 4].includes(c.save.bag[0].enchant), 'nunca reduz, nunca pula pra +10');
});

test('ENCHANT HTTP: +1 cobra o ouro oficial (itemLv x rarityMul x alvo x 10) e persiste apos reload', { skip }, async () => {
  const armor = S.createGear('armor', 20, 'rare');
  const ch = await newChar({ gold: 5000, bag: [armor] });
  const r = await enchant(ch, { uid: armor.uid, expectedEnchant: 0 });
  assert.equal(r.status, 200);
  const c = await getChar(ch); // "reload": leitura fresca do banco
  assert.equal(c.save.gold, 5000 - B.enchantCostFor(20, 'rare', 1).amount);
  assert.equal(c.save.bag[0].enchant, 1);
});

test('QUEST HTTP: XP da missao e concedida uma unica vez (sem duplicar apos reload)', { skip }, async () => {
  const ch = await newChar({ quest: 2, xp: 0 });
  const first = await httpJson(srv, 'POST', '/api/characters/' + ch.id + '/quest', { from: 2 }, ch.token);
  assert.equal(first.status, 200);
  const second = await httpJson(srv, 'POST', '/api/characters/' + ch.id + '/quest', { from: 2 }, ch.token);
  assert.equal(second.status, 400);
  const c = await getChar(ch);
  assert.equal(c.save.quest, 3);
  assert.equal(B.cumulativeXp(c.lvl) + c.save.xp, B.questXpFor(2), 'XP total = exatamente 1 recompensa');
});

test('MIGRACAO HTTP: personagem Lv55 no banco vira Lv40/XP0 na proxima gravacao; equipamento intacto', { skip }, async () => {
  const sword = S.createGear('sword', 40, 'epic');
  const ch = await newChar({ gold: 777, gem: 9, eq: { sword }, xp: 123456 }, 55);
  const r = await httpJson(srv, 'PUT', '/api/characters/' + ch.id, { lvl: 55, save: ch.save }, ch.token);
  assert.equal(r.status, 200);
  const c = await getChar(ch);
  assert.equal(c.lvl, 40); assert.equal(c.save.xp, 0);
  assert.equal(c.save.gold, 777); assert.equal(c.save.gem, 9);
  assert.equal(c.save.eq.sword.uid, sword.uid);
});
