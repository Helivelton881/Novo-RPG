'use strict';
// Testes unitarios (sem HTTP, sem Supabase) das funcoes de item/posse da
// Fase 5.1, exportadas por server.js so pra isso (module.exports no fim do
// arquivo, atras de `require.main===module` -- nao muda como `node server.js`
// roda). Os 3 setInterval de escopo de modulo em server.js (tick de IA, ping
// de WS, respawn) usam .unref() justamente pra isto: o processo consegue
// sair sozinho depois dos testes em vez de ficar pendurado por causa deles.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server.js');

const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('createGear gera uid valido e unico a cada chamada', () => {
  const a = S.createGear('sword', 20, 'basic');
  const b = S.createGear('sword', 20, 'basic');
  assert.ok(UID_RE.test(a.uid));
  assert.ok(UID_RE.test(b.uid));
  assert.notEqual(a.uid, b.uid);
});

test('createGear: enchant sempre 0, req = lv pra arma', () => {
  const it = S.createGear('sword', 24, 'basic');
  assert.equal(it.enchant, 0);
  assert.equal(it.req, 24);
  assert.equal(it.lv, 24);
});

test('createGear com tipo/nivel invalido retorna null', () => {
  assert.equal(S.createGear('sword', 17, 'basic'), null); // 17 nao e uma das 11 faixas
  assert.equal(S.createGear('inexistente', 20, 'basic'), null);
});

test('sanitizeItem: item canonico com uid valido preserva o uid', () => {
  const uid = '11111111-2222-3333-4444-555555555555';
  const it = S.sanitizeItem({ uid, type: 'sword', lv: 20, rarity: 'rare', enchant: 3 });
  assert.equal(it.uid, uid);
  assert.equal(it.enchant, 3);
});

test('sanitizeItem: uid ausente ou invalido gera um novo uid', () => {
  const it1 = S.sanitizeItem({ type: 'sword', lv: 20, rarity: 'basic' });
  assert.ok(UID_RE.test(it1.uid));
  const it2 = S.sanitizeItem({ uid: 'nao-e-um-uid', type: 'sword', lv: 20, rarity: 'basic' });
  assert.ok(UID_RE.test(it2.uid));
});

test('sanitizeItem: stats/nome SEMPRE recalculados no servidor -- forjar atk/n no payload nao tem efeito', () => {
  const it = S.sanitizeItem({ type: 'sword', lv: 8, rarity: 'basic', atk: 999999, n: 'Espada Hackeada', def: 999 });
  assert.equal(it.atk, 9); // valor real da faixa lv8 basic
  assert.equal(it.n, 'Lâmina Sombria');
  assert.equal(it.def, 0); // sword nao tem def
});

test('sanitizeItem: rarity fora do dominio, sem tier legado valido como fallback, e rejeitada (null)', () => {
  assert.equal(S.sanitizeItem({ type: 'sword', lv: 40, rarity: 'mythic', tier: 99 }), null);
});
test('sanitizeItem: enchant fora de 0-10 e travado no limite', () => {
  assert.equal(S.sanitizeItem({ type: 'sword', lv: 20, rarity: 'basic', enchant: 999 }).enchant, 10);
  assert.equal(S.sanitizeItem({ type: 'sword', lv: 20, rarity: 'basic', enchant: -5 }).enchant, 0);
});

test('sanitizeItem: item de classe/tipo inexistente e rejeitado (null)', () => {
  assert.equal(S.sanitizeItem({ type: 'canhao_laser', lv: 20, rarity: 'basic' }), null);
});

test('sanitizeItem: formato legado {type,tier} migra pro modelo novo preservando stats exatos', () => {
  const it = S.sanitizeItem({ type: 'sword', tier: 3 }); // tier3 antigo = lv8
  assert.equal(it.lv, 8);
  assert.equal(it.rarity, 'basic');
  assert.equal(it.atk, 9); // mesmo valor que o antigo tier3 sempre teve
  assert.ok(UID_RE.test(it.uid)); // ganhou uid novo na migracao
});

test('sanitizeItem: tier legado invalido (fora de 1-5) e rejeitado', () => {
  assert.equal(S.sanitizeItem({ type: 'sword', tier: 9 }), null);
  assert.equal(S.sanitizeItem({ type: 'sword', tier: 0 }), null);
});

test('sanitizeSave: bag/eq com uid duplicado -- so a primeira ocorrencia sobrevive', () => {
  const it = S.createGear('sword', 8, 'basic');
  const save = S.sanitizeSave({ bag: [it, it, it], eq: {} }, 10);
  assert.equal(save.bag.length, 1);
  assert.equal(save.bag[0].uid, it.uid);
});

test('sanitizeSave: mesmo uid na mochila E equipado -- a copia da mochila vence, o slot equipado e descartado', () => {
  const it = S.createGear('sword', 8, 'basic');
  const save = S.sanitizeSave({ bag: [it], eq: { sword: it } }, 10);
  assert.equal(save.bag.length, 1);
  assert.equal(save.eq.sword, null);
});

test('sanitizeSave: item equipado com req acima do nivel real e desequipado (nao perdido)', () => {
  const it = S.createGear('sword', 40, 'basic'); // req 40
  const save = S.sanitizeSave({ bag: [], eq: { sword: it } }, 10); // personagem nivel 10
  assert.equal(save.eq.sword, null);
  assert.equal(save.bag.length, 1);
  assert.equal(save.bag[0].uid, it.uid);
});

test('sanitizeSave: item legado sem uid recebe um uid estavel na migracao (nao regenera a cada chamada com o MESMO uid de entrada)', () => {
  const save1 = S.sanitizeSave({ bag: [{ type: 'sword', tier: 2 }], eq: {} }, 10);
  const migratedUid = save1.bag[0].uid;
  // Uma segunda chamada passando o item JA MIGRADO (com uid) de volta preserva o mesmo uid.
  const save2 = S.sanitizeSave({ bag: [save1.bag[0]], eq: {} }, 10);
  assert.equal(save2.bag[0].uid, migratedUid);
});

test('lockOwnedItems: item cujo uid nunca existiu no save persistido e descartado (nao fabrica item)', () => {
  const owned = { bag: [], eq: Object.fromEntries(S.EQ_SLOTS.map(s => [s, null])) };
  const forged = S.createGear('sword', 40, 'legendary'); // nunca foi comprado/dropado
  const candidate = { bag: [forged], eq: Object.fromEntries(S.EQ_SLOTS.map(s => [s, null])) };
  const locked = S.lockOwnedItems(candidate, owned);
  assert.equal(locked.bag.length, 0);
});

test('lockOwnedItems: item realmente possuido sobrevive e usa sempre a copia canonica do servidor (ignora stats forjados no candidato)', () => {
  const real = S.createGear('sword', 8, 'basic');
  const owned = { bag: [real], eq: Object.fromEntries(S.EQ_SLOTS.map(s => [s, null])) };
  const tampered = { ...real, atk: 999999, rarity: 'legendary' };
  const candidate = { bag: [tampered], eq: Object.fromEntries(S.EQ_SLOTS.map(s => [s, null])) };
  const locked = S.lockOwnedItems(candidate, owned);
  assert.equal(locked.bag.length, 1);
  assert.equal(locked.bag[0].atk, real.atk); // nao o valor forjado
  assert.equal(locked.bag[0].rarity, 'basic');
});

test('lockOwnedItems: equipar/desequipar (mover uid ja possuido entre bag e eq) passa livremente', () => {
  const real = S.createGear('sword', 8, 'basic');
  const owned = { bag: [real], eq: Object.fromEntries(S.EQ_SLOTS.map(s => [s, null])) };
  const candidate = { bag: [], eq: { ...Object.fromEntries(S.EQ_SLOTS.map(s => [s, null])), sword: real } };
  const locked = S.lockOwnedItems(candidate, owned);
  assert.equal(locked.eq.sword.uid, real.uid);
  assert.equal(locked.bag.length, 0);
});

test('lockOwnedItems: item que o cliente "esqueceu" de mandar de volta nao e perdido (volta pra mochila)', () => {
  const real = S.createGear('boots', 4, 'basic');
  const owned = { bag: [real], eq: Object.fromEntries(S.EQ_SLOTS.map(s => [s, null])) };
  const candidate = { bag: [], eq: Object.fromEntries(S.EQ_SLOTS.map(s => [s, null])) }; // cliente mandou vazio
  const locked = S.lockOwnedItems(candidate, owned);
  assert.equal(locked.bag.length, 1);
  assert.equal(locked.bag[0].uid, real.uid);
});

test('lockOwnedItems: uid duplicado no payload do cliente (mesmo item possuido citado 2x) nao vira 2 copias', () => {
  const real = S.createGear('jewel', 12, 'basic');
  const owned = { bag: [real], eq: Object.fromEntries(S.EQ_SLOTS.map(s => [s, null])) };
  const candidate = { bag: [real, { ...real }], eq: Object.fromEntries(S.EQ_SLOTS.map(s => [s, null])) };
  const locked = S.lockOwnedItems(candidate, owned);
  assert.equal(locked.bag.length, 1);
});

test('typeSlot: armas de todas as classes mapeiam pro slot "sword"; demais tipos mapeiam pra si mesmos', () => {
  for (const w of ['sword', 'bow', 'staffd', 'staffm']) assert.equal(S.typeSlot(w), 'sword');
  for (const t of ['shield', 'armor', 'helmet', 'cape', 'jewel', 'boots']) assert.equal(S.typeSlot(t), t);
});

test('CLASS_ITEM_TYPES: cada classe so pode receber a propria arma (e escudo so pro guerreiro)', () => {
  assert.ok(S.CLASS_ITEM_TYPES.guerreiro.includes('shield'));
  assert.ok(!S.CLASS_ITEM_TYPES.mago.includes('shield'));
  assert.ok(S.CLASS_ITEM_TYPES.mago.includes('staffm'));
  assert.ok(!S.CLASS_ITEM_TYPES.mago.includes('sword'));
});
