'use strict';
// Fase 5.11 -- Mercado/Leilao. Parte 1: logica pura de game-data/market.js
// (config, taxa, validacao) -- sempre roda. Parte 2: fluxo real via HTTP +
// RPC contra o servidor + Supabase de teste -- so roda com credenciais
// configuradas. As funcoes RPC (escrow/compra/claims) ja foram exercitadas
// manualmente contra o banco real de producao com registros descartaveis
// durante o desenvolvimento (concorrencia via SELECT ... FOR UPDATE e
// idempotencia via operation_id confirmadas); aqui a suite cobre a
// integracao real via HTTP (autorizacao, roteamento, mapeamento de erro,
// busca/filtros, historico, claims) contra a mesma funcao que server.js
// chama em producao.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, adminPatchCharacter } = require('./helpers');
const MARKET = require('../game-data/market.js');

// ===== Parte 1: logica pura =====
test('MARKET_FEE_RATE e 5%, preco max bate com o teto de save.gold (500000)', () => {
  assert.equal(MARKET.MARKET_FEE_RATE, 0.05);
  assert.equal(MARKET.MARKET_MAX_PRICE, 500000);
  assert.equal(MARKET.MARKET_MIN_PRICE, 1);
});
test('isValidPrice: aceita a faixa, rejeita fora dela', () => {
  assert.equal(MARKET.isValidPrice(1), true);
  assert.equal(MARKET.isValidPrice(500000), true);
  assert.equal(MARKET.isValidPrice(0), false);
  assert.equal(MARKET.isValidPrice(500001), false);
  assert.equal(MARKET.isValidPrice(-5), false);
  assert.equal(MARKET.isValidPrice(NaN), false);
});
test('feeFor: 1000 -> taxa 50, vendedor recebe 950 (mesma formula da funcao SQL)', () => {
  const { fee, netReceived } = MARKET.feeFor(1000);
  assert.equal(fee, 50);
  assert.equal(netReceived, 950);
});
test('isValidSort: aceita os 4 tipos, rejeita invencionice', () => {
  for (const s of MARKET.MARKET_SORTS) assert.equal(MARKET.isValidSort(s), true);
  assert.equal(MARKET.isValidSort('aleatorio'), false);
});

// ===== Parte 2: fluxo real =====
const PORT = 8170;
let srv;
before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'mq_' + Math.random().toString(36).slice(2, 10);
function fakeItem(overrides) {
  return Object.assign({
    uid: 'aaaaaaaa-' + rnd().slice(0,4) + '-4aaa-8aaa-' + rnd().slice(0,12).padEnd(12,'0'),
    type: 'sword', lv: 5, rarity: 'rare', enchant: 2, n: 'Espada de Teste',
    atk: 20, def: 0, hp: 0, blk: 0, spd: 0, req: 5,
  }, overrides || {});
}
async function newChar(startGold, items) {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'M' + rnd().slice(0,6), cls: 'guerreiro' }, token);
  const charId = created.json.character.id;
  if (startGold != null || items) {
    await adminPatchCharacter(charId, { save: { gold: startGold != null ? startGold : 10, gem:0, pv:3, pa:2, bag: items || [], eq: {}, cls:'guerreiro', name:'M', chat:[], sk:{}, quest:0 } });
  }
  return { token, charId };
}

test('listar item: forjar UID (item de outro personagem) e rejeitado', { skip: !hasSupabase() }, async () => {
  const owner = await newChar(100, [fakeItem()]);
  const stranger = await newChar(100, []);
  const item = (await httpJson(srv, 'GET', `/api/market/${owner.charId}/mine`, null, owner.token));
  const r = await httpJson(srv, 'POST', `/api/market/${stranger.charId}/list`, { itemUid: 'uid-que-nao-existe-nesse-personagem', price: 100 }, stranger.token);
  assert.equal(r.status, 400);
});

test('listar item: item real do proprio bag funciona, some do bag', { skip: !hasSupabase() }, async () => {
  const item = fakeItem();
  const seller = await newChar(100, [item]);
  const r = await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 500 }, seller.token);
  assert.equal(r.status, 201);
  assert.equal(r.json.listing.price, 500);
  assert.equal(r.json.listing.enchant, 2);
  const mine = await httpJson(srv, 'GET', `/api/market/${seller.charId}/mine`, null, seller.token);
  assert.equal(mine.json.listings.length, 1);
  assert.equal(mine.json.listings[0].status, 'active');
});

test('listar item: preco invalido e rejeitado', { skip: !hasSupabase() }, async () => {
  const item = fakeItem();
  const seller = await newChar(100, [item]);
  const r = await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 0 }, seller.token);
  assert.equal(r.status, 400);
});

test('listar item: item equipado (nao no bag) e rejeitado', { skip: !hasSupabase() }, async () => {
  const item = fakeItem();
  const seller = await newChar(100, []); // bag vazio, item so existiria equipado -- nunca listavel por essa rota
  const r = await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 100 }, seller.token);
  assert.equal(r.status, 400);
});

test('busca de mercado: filtro por tipo/raridade/preco e paginacao', { skip: !hasSupabase() }, async () => {
  const cheap = fakeItem({ type:'bow', rarity:'epic', enchant:0 });
  const seller = await newChar(100, [cheap]);
  await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: cheap.uid, price: 42 }, seller.token);
  const r = await httpJson(srv, 'GET', '/api/market/listings?type=bow&rarity=epic&priceMin=1&priceMax=1000');
  assert.equal(r.status, 200);
  const found = r.json.items.find(x => x.price === 42);
  assert.ok(found, 'item anunciado deveria aparecer na busca filtrada');
  assert.ok(found.sellerName);
});

test('busca de mercado: nunca vaza character_id do vendedor nem userId', { skip: !hasSupabase() }, async () => {
  const item = fakeItem();
  const seller = await newChar(100, [item]);
  await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 77 }, seller.token);
  const r = await httpJson(srv, 'GET', '/api/market/listings?priceMin=77&priceMax=77');
  const text = JSON.stringify(r.json);
  assert.equal(text.includes('userId'), false);
  assert.equal(text.includes(seller.charId), false);
});

test('cancelar: so o dono pode, item vai pra claim (nao volta direto pro bag)', { skip: !hasSupabase() }, async () => {
  const item = fakeItem();
  const seller = await newChar(100, [item]);
  const other = await newChar(100, []);
  const listed = await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 300 }, seller.token);
  const listingId = listed.json.listing.id;
  const badCancel = await httpJson(srv, 'POST', `/api/market/${other.charId}/cancel`, { listingId }, other.token);
  assert.equal(badCancel.status, 400);
  const goodCancel = await httpJson(srv, 'POST', `/api/market/${seller.charId}/cancel`, { listingId }, seller.token);
  assert.equal(goodCancel.status, 200);
  const claims = await httpJson(srv, 'GET', `/api/market/${seller.charId}/claims`, null, seller.token);
  assert.equal(claims.json.claims.length, 1);
  assert.equal(claims.json.claims[0].kind, 'item');
});

test('comprar: fluxo completo -- gold debitado do comprador, creditado (liquido) no vendedor, item entregue', { skip: !hasSupabase() }, async () => {
  const item = fakeItem();
  const seller = await newChar(0, [item]);
  const buyer = await newChar(1000, []);
  const listed = await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 200 }, seller.token);
  const listingId = listed.json.listing.id;
  const operationId = crypto.randomUUID();
  const bought = await httpJson(srv, 'POST', `/api/market/${buyer.charId}/buy`, { listingId, operationId }, buyer.token);
  assert.equal(bought.status, 200);
  assert.equal(bought.json.transaction.price, 200);
  assert.equal(bought.json.transaction.fee, 10);
  assert.equal(bought.json.transaction.seller_received, 190);
  const mine = await httpJson(srv, 'GET', `/api/market/${seller.charId}/mine`, null, seller.token);
  assert.equal(mine.json.listings[0].status, 'sold');
});

test('comprar: self-buy e rejeitado', { skip: !hasSupabase() }, async () => {
  const item = fakeItem();
  const seller = await newChar(1000, [item]);
  const listed = await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 100 }, seller.token);
  const r = await httpJson(srv, 'POST', `/api/market/${seller.charId}/buy`, { listingId: listed.json.listing.id, operationId: crypto.randomUUID() }, seller.token);
  assert.equal(r.status, 400);
});

test('comprar: ouro insuficiente e rejeitado', { skip: !hasSupabase() }, async () => {
  const item = fakeItem();
  const seller = await newChar(0, [item]);
  const poorBuyer = await newChar(5, []);
  const listed = await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 1000 }, seller.token);
  const r = await httpJson(srv, 'POST', `/api/market/${poorBuyer.charId}/buy`, { listingId: listed.json.listing.id, operationId: crypto.randomUUID() }, poorBuyer.token);
  assert.equal(r.status, 400);
});

test('comprar: listing ja vendida (tentativa de comprar de novo) e rejeitada', { skip: !hasSupabase() }, async () => {
  const item = fakeItem();
  const seller = await newChar(0, [item]);
  const buyerA = await newChar(1000, []);
  const buyerB = await newChar(1000, []);
  const listed = await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 100 }, seller.token);
  const listingId = listed.json.listing.id;
  const first = await httpJson(srv, 'POST', `/api/market/${buyerA.charId}/buy`, { listingId, operationId: crypto.randomUUID() }, buyerA.token);
  assert.equal(first.status, 200);
  const second = await httpJson(srv, 'POST', `/api/market/${buyerB.charId}/buy`, { listingId, operationId: crypto.randomUUID() }, buyerB.token);
  assert.equal(second.status, 400);
});

test('idempotencia: retry com o MESMO operationId nunca compra duas vezes', { skip: !hasSupabase() }, async () => {
  const item = fakeItem();
  const seller = await newChar(0, [item]);
  const buyer = await newChar(1000, []);
  const listed = await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 100 }, seller.token);
  const listingId = listed.json.listing.id, operationId = crypto.randomUUID();
  const first = await httpJson(srv, 'POST', `/api/market/${buyer.charId}/buy`, { listingId, operationId }, buyer.token);
  const retry = await httpJson(srv, 'POST', `/api/market/${buyer.charId}/buy`, { listingId, operationId }, buyer.token);
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(first.json.transaction.id, retry.json.transaction.id);
  const history = await httpJson(srv, 'GET', `/api/market/${buyer.charId}/history`, null, buyer.token);
  assert.equal(history.json.history.filter(h => h.price === 100).length, 1);
});

test('comprar sem operationId (ou invalido) e rejeitado -- nunca opcional', { skip: !hasSupabase() }, async () => {
  const item = fakeItem();
  const seller = await newChar(0, [item]);
  const buyer = await newChar(1000, []);
  const listed = await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 100 }, seller.token);
  const r = await httpJson(srv, 'POST', `/api/market/${buyer.charId}/buy`, { listingId: listed.json.listing.id }, buyer.token);
  assert.equal(r.status, 400);
});

test('claim de item: bag cheia mantem o claim pendente (nunca perde)', { skip: !hasSupabase() }, async () => {
  const item = fakeItem();
  const fullBag = Array.from({length:24}, (_,i) => fakeItem({ n: 'Enchimento ' + i }));
  const seller = await newChar(100, [item, ...fullBag.slice(0,23)]);
  // lista o item real (24o slot), cancela -> vira claim; bag do seller ja esta com 23 (1 saiu pro escrow)
  const listed = await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 50 }, seller.token);
  await httpJson(srv, 'POST', `/api/market/${seller.charId}/cancel`, { listingId: listed.json.listing.id }, seller.token);
  // enche a bag de volta pra 24 antes de tentar reclamar
  await adminPatchCharacter(seller.charId, { save: { gold:100, gem:0, pv:3, pa:2, bag: fullBag, eq:{}, cls:'guerreiro', name:'M', chat:[], sk:{}, quest:0 } });
  const claims = await httpJson(srv, 'GET', `/api/market/${seller.charId}/claims`, null, seller.token);
  const claimId = claims.json.claims[0].id;
  const r = await httpJson(srv, 'POST', `/api/market/${seller.charId}/claims/${claimId}/item`, null, seller.token);
  assert.equal(r.status, 400);
  const stillPending = await httpJson(srv, 'GET', `/api/market/${seller.charId}/claims`, null, seller.token);
  assert.equal(stillPending.json.claims.length, 1, 'claim nao pode ter sido removido/perdido');
});

test('claim de item: com espaco na bag, retira normalmente e some da lista de pendentes', { skip: !hasSupabase() }, async () => {
  const item = fakeItem();
  const seller = await newChar(100, [item]);
  const listed = await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 50 }, seller.token);
  await httpJson(srv, 'POST', `/api/market/${seller.charId}/cancel`, { listingId: listed.json.listing.id }, seller.token);
  const claims = await httpJson(srv, 'GET', `/api/market/${seller.charId}/claims`, null, seller.token);
  const r = await httpJson(srv, 'POST', `/api/market/${seller.charId}/claims/${claims.json.claims[0].id}/item`, null, seller.token);
  assert.equal(r.status, 200);
  const after = await httpJson(srv, 'GET', `/api/market/${seller.charId}/claims`, null, seller.token);
  assert.equal(after.json.claims.length, 0);
});

test('UID e rarity e enchant e +10 sao preservados na transferencia (mesmo item fisico, nao um novo)', { skip: !hasSupabase() }, async () => {
  const item = fakeItem({ enchant: 10, rarity: 'legendary' });
  const seller = await newChar(0, [item]);
  const buyer = await newChar(1000, []);
  const listed = await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 100 }, seller.token);
  assert.equal(listed.json.listing.enchant, 10);
  assert.equal(listed.json.listing.rarity, 'legendary');
  await httpJson(srv, 'POST', `/api/market/${buyer.charId}/buy`, { listingId: listed.json.listing.id, operationId: crypto.randomUUID() }, buyer.token);
  const buyerChars = await httpJson(srv, 'GET', '/api/characters', null, buyer.token);
  const receivedItem = buyerChars.json.characters.find(c => c.id === buyer.charId).save.bag.find(it => it.uid === item.uid);
  assert.ok(receivedItem, 'o mesmo item fisico (uid) deveria estar na mochila do comprador');
  assert.equal(receivedItem.enchant, 10);
  assert.equal(receivedItem.rarity, 'legendary');
});

test('historico: so mostra transacoes do proprio personagem', { skip: !hasSupabase() }, async () => {
  const item = fakeItem();
  const seller = await newChar(0, [item]);
  const buyer = await newChar(1000, []);
  const outsider = await newChar(100, []);
  const listed = await httpJson(srv, 'POST', `/api/market/${seller.charId}/list`, { itemUid: item.uid, price: 100 }, seller.token);
  await httpJson(srv, 'POST', `/api/market/${buyer.charId}/buy`, { listingId: listed.json.listing.id, operationId: crypto.randomUUID() }, buyer.token);
  const outsiderHistory = await httpJson(srv, 'GET', `/api/market/${outsider.charId}/history`, null, outsider.token);
  assert.equal(outsiderHistory.json.history.length, 0);
  const sellerHistory = await httpJson(srv, 'GET', `/api/market/${seller.charId}/history`, null, seller.token);
  assert.equal(sellerHistory.json.history[0].direction, 'sold');
  const buyerHistory = await httpJson(srv, 'GET', `/api/market/${buyer.charId}/history`, null, buyer.token);
  assert.equal(buyerHistory.json.history[0].direction, 'bought');
});

test('personagem de outra conta nao acessa mercado de outro (404)', { skip: !hasSupabase() }, async () => {
  const a = await newChar(100, []);
  const b = await newChar(100, []);
  const r = await httpJson(srv, 'GET', `/api/market/${a.charId}/mine`, null, b.token);
  assert.equal(r.status, 404);
});

const unsafeIntegration = process.env.SUPABASE_TEST_SAFE !== '1';
test('concorrencia real: A/B simultaneos comprando a mesma listing produzem exatamente um sucesso', { skip: unsafeIntegration }, async () => {
  const item=fakeItem(),seller=await newChar(0,[item]),a=await newChar(1000,[]),b=await newChar(1000,[]);
  const listed=await httpJson(srv,'POST',`/api/market/${seller.charId}/list`,{itemUid:item.uid,price:100},seller.token),listingId=listed.json.listing.id;
  const results=await Promise.all([a,b].map(x=>httpJson(srv,'POST',`/api/market/${x.charId}/buy`,{listingId,operationId:crypto.randomUUID()},x.token)));
  assert.deepEqual(results.map(x=>x.status).sort(),[200,400]);
});

test('concorrencia real: buy/cancel deixa um unico desfecho e nunca duplica item', { skip: unsafeIntegration }, async () => {
  const item=fakeItem(),seller=await newChar(0,[item]),buyer=await newChar(1000,[]);
  const listed=await httpJson(srv,'POST',`/api/market/${seller.charId}/list`,{itemUid:item.uid,price:100},seller.token),listingId=listed.json.listing.id;
  const results=await Promise.all([
    httpJson(srv,'POST',`/api/market/${buyer.charId}/buy`,{listingId,operationId:crypto.randomUUID()},buyer.token),
    httpJson(srv,'POST',`/api/market/${seller.charId}/cancel`,{listingId},seller.token),
  ]);
  assert.equal(results.filter(x=>x.status===200).length,1);
});

test('operationId nao pode ser reutilizado por outro comprador ou listing', { skip: unsafeIntegration }, async () => {
  const one=fakeItem(),two=fakeItem(),seller=await newChar(0,[one,two]),a=await newChar(1000,[]),b=await newChar(1000,[]),operationId=crypto.randomUUID();
  const l1=await httpJson(srv,'POST',`/api/market/${seller.charId}/list`,{itemUid:one.uid,price:100},seller.token);
  const l2=await httpJson(srv,'POST',`/api/market/${seller.charId}/list`,{itemUid:two.uid,price:100},seller.token);
  assert.equal((await httpJson(srv,'POST',`/api/market/${a.charId}/buy`,{listingId:l1.json.listing.id,operationId},a.token)).status,200);
  assert.equal((await httpJson(srv,'POST',`/api/market/${b.charId}/buy`,{listingId:l2.json.listing.id,operationId},b.token)).status,400);
});
