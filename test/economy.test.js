'use strict';
// Fase 5.2: PUT generico nao pode mais ser carteira. Cobre especificamente
// ECONOMY_LOCK_FIELDS (gold/gem/pv/pa/ap/key/scr/gunlock/chest*) e o
// "primeiro PUT" de personagem novo (startingSave ja nasce completo, sem
// excecao de import local->nuvem pra economia). Precisa de Supabase.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson } = require('./helpers');

const PORT = 8109;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'qa_' + Math.random().toString(36).slice(2, 10);
async function newAccount() {
  const username = rnd(), password = 'SenhaForte123';
  const r = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  return { username, token: r.json.token };
}
async function newChar(cls = 'guerreiro') {
  const acc = await newAccount();
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Heroi', cls }, acc.token);
  return { token: acc.token, id: created.json.character.id, initialSave: created.json.character.save };
}
async function getSave(id, token) {
  const r = await httpJson(srv, 'GET', '/api/characters', null, token);
  return r.json.characters.find(c => c.id === id).save;
}

test('primeira gravacao: personagem novo ja nasce com save inicial completo do servidor (nao {})', { skip: !hasSupabase() }, async () => {
  const { initialSave } = await newChar();
  assert.equal(initialSave.gold, 10);
  assert.equal(initialSave.pv, 3);
  assert.equal(initialSave.pa, 2);
  assert.equal(initialSave.gem, 0);
  assert.ok(initialSave.eq.sword, 'personagem novo deveria nascer com arma inicial equipada');
  assert.deepEqual(initialSave.gunlock, {});
});

test('primeiro PUT: tentar forjar ouro/gema/pv/portais/item lendario no primeiro PUT online e ignorado', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar();
  const forgedItem = { uid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type: 'sword', lv: 40, rarity: 'legendary', enchant: 10 };
  const put = await httpJson(srv, 'PUT', '/api/characters/' + id, {
    lvl: 40,
    save: {
      gold: 500000, gem: 5000, pv: 999, pa: 999, ap: 999, key: 999, scr: 999,
      gunlock: { floresta: true, cripta: true, serra: true, pantano: true, torre: true, ilhas: true, vulcao: true },
      chest: true, chest2: true, chest3: true, chest4: true, chest5: true, chest6: true, chest7: true,
      bag: [forgedItem], eq: { sword: forgedItem },
    },
  }, token);
  assert.equal(put.status, 200);
  const save = put.json.character.save;
  assert.equal(save.gold, 10, 'ouro forjado no primeiro PUT nao deveria persistir');
  assert.equal(save.gem, 0);
  assert.equal(save.pv, 3);
  assert.equal(save.pa, 2);
  assert.equal(save.ap || 0, 0);
  assert.equal(save.key || 0, 0);
  assert.equal(save.scr || 0, 0);
  assert.deepEqual(save.gunlock, {});
  for (const f of ['chest', 'chest2', 'chest3', 'chest4', 'chest5', 'chest6', 'chest7']) assert.ok(!save[f]);
  assert.equal((save.bag || []).length, 0, 'item forjado nao pode entrar na mochila via primeiro PUT');
  assert.notEqual(save.eq.sword && save.eq.sword.rarity, 'legendary');
  assert.equal(put.json.character.lvl, 1, 'nivel forjado no primeiro PUT nao deveria persistir');
});

test('PUT em personagem existente: gold=500000 gem=5000 pv=999 key=999 scr=999 todo gunlock/chest true nao persiste', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar();
  const put = await httpJson(srv, 'PUT', '/api/characters/' + id, {
    lvl: 1,
    save: {
      gold: 500000, gem: 5000, pv: 999, pa: 999, ap: 999, key: 999, scr: 999,
      gunlock: { floresta: true, cripta: true, serra: true, pantano: true, torre: true, ilhas: true, vulcao: true },
      chest: true, chest2: true, chest3: true, chest4: true, chest5: true, chest6: true, chest7: true,
    },
  }, token);
  assert.equal(put.status, 200);
  const save = put.json.character.save;
  assert.equal(save.gold, 10);
  assert.equal(save.gem, 0);
  assert.equal(save.pv, 3);
  assert.equal(save.pa, 2);
  assert.deepEqual(save.gunlock, {});
  for (const f of ['chest', 'chest2', 'chest3', 'chest4', 'chest5', 'chest6', 'chest7']) assert.ok(!save[f]);
});

test('PUT: campos economicos ficam travados no valor real do servidor mesmo apos uma mutacao legitima (nao reabre a brecha)', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar();
  // muda o gold real via um PUT que NAO deveria ter efeito -- confirma no GET
  const before = await getSave(id, token);
  assert.equal(before.gold, 10);
  await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 1, save: { ...before, gold: 999999, key: 50 } }, token);
  const after = await getSave(id, token);
  assert.equal(after.gold, 10, 'ouro ainda deveria ser o real do servidor apos tentativa de forja');
  assert.equal(after.key || 0, 0);
});

test('use_item: chave (key) so decrementa via acao server-side, nunca fica negativa nem usa item inexistente', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar();
  const noKey = await httpJson(srv, 'POST', '/api/characters/' + id + '/shop', { action: 'use_item', key: 'pv' }, token);
  assert.equal(noKey.status, 400, 'usar pv sem ter nenhum deveria ser rejeitado');
  const invalid = await httpJson(srv, 'POST', '/api/characters/' + id + '/shop', { action: 'use_item', key: 'gold' }, token);
  assert.equal(invalid.status, 400, 'gold nao e um consumivel usavel via use_item');
});
