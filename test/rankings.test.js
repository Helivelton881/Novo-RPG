'use strict';
// Fase 5.10 -- Rankings. Parte 1: logica pura de game-data/rankings.js
// (ordenacao, desempate, paginacao, K/D, cache TTL) -- sempre roda.
// Parte 2: endpoint real GET /api/rankings, com estado semeado direto via
// RPC (mesma funcao que server.js chama) -- so roda com Supabase.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, adminRpc } = require('./helpers');
const RANKINGS = require('../game-data/rankings.js');

// ===== Parte 1: logica pura =====
test('RANK_PAGE_SIZE e 20, RANK_CACHE_MS entre 30s e 60s', () => {
  assert.equal(RANKINGS.RANK_PAGE_SIZE, 20);
  assert.ok(RANKINGS.RANK_CACHE_MS >= 30000 && RANKINGS.RANK_CACHE_MS <= 60000);
});
test('isValidRankType aceita os 6 tipos pedidos, rejeita invencionice', () => {
  for (const t of ['level','pvp','tvt','world_boss','bestiary','guild']) assert.equal(RANKINGS.isValidRankType(t), true);
  assert.equal(RANKINGS.isValidRankType('economia'), false);
});
test('kdRatio: deaths=0 retorna o proprio numero de kills (nunca divide por zero)', () => {
  assert.equal(RANKINGS.kdRatio(7, 0), 7);
  assert.equal(RANKINGS.kdRatio(0, 0), 0);
});
test('kdRatio: arredonda pra 2 casas, nunca e armazenado -- so calculado', () => {
  assert.equal(RANKINGS.kdRatio(10, 3), 3.33);
});
test('paginate: recorta a pagina certa e calcula metadados', () => {
  const rows = Array.from({length:45}, (_,i)=>i);
  const p1 = RANKINGS.paginate(rows, 1, 20);
  assert.deepEqual(p1.items, rows.slice(0,20));
  assert.equal(p1.totalPages, 3);
  const p3 = RANKINGS.paginate(rows, 3, 20);
  assert.equal(p3.items.length, 5);
});
test('paginate: pagina alem do limite cai na ultima pagina valida (nunca vazio por engano)', () => {
  const rows = [1,2,3];
  const p = RANKINGS.paginate(rows, 999, 20);
  assert.equal(p.page, 1);
  assert.equal(p.items.length, 3);
});
test('ranking nivel: ordena por level DESC, xp DESC, nome como desempate estavel', () => {
  const rows = [
    {name:'Carlos', level:10, xp:50},
    {name:'Ana', level:10, xp:50},
    {name:'Bruno', level:12, xp:0},
  ];
  const sorted = RANKINGS.sortForType('level', rows).map(r=>r.name);
  assert.deepEqual(sorted, ['Bruno','Ana','Carlos']);
});
test('ranking pvp: kills DESC, deaths ASC como desempate', () => {
  const rows = [
    {name:'X', pvpKills:5, pvpDeaths:3},
    {name:'Y', pvpKills:5, pvpDeaths:1},
    {name:'Z', pvpKills:9, pvpDeaths:9},
  ];
  const sorted = RANKINGS.sortForType('pvp', rows).map(r=>r.name);
  assert.deepEqual(sorted, ['Z','Y','X']);
});
test('ranking tvt: wins DESC, depois kills DESC, depois losses ASC', () => {
  const rows = [
    {name:'A', tvtWins:3, tvtKills:10, tvtLosses:2},
    {name:'B', tvtWins:3, tvtKills:20, tvtLosses:1},
    {name:'C', tvtWins:5, tvtKills:1, tvtLosses:9},
  ];
  const sorted = RANKINGS.sortForType('tvt', rows).map(r=>r.name);
  assert.deepEqual(sorted, ['C','B','A']);
});
test('ranking world_boss: kills DESC, depois participations DESC', () => {
  const rows = [
    {name:'A', worldBossKills:2, worldBossParticipations:5},
    {name:'B', worldBossKills:2, worldBossParticipations:8},
    {name:'C', worldBossKills:9, worldBossParticipations:9},
  ];
  const sorted = RANKINGS.sortForType('world_boss', rows).map(r=>r.name);
  assert.deepEqual(sorted, ['C','B','A']);
});
test('ranking bestiario: discovered DESC', () => {
  const rows = [{name:'A', bestiaryDiscovered:3}, {name:'B', bestiaryDiscovered:9}];
  assert.deepEqual(RANKINGS.sortForType('bestiary', rows).map(r=>r.name), ['B','A']);
});
test('ranking guilda: soma de niveis DESC, depois numero de membros DESC (nunca chamado de "melhor guilda")', () => {
  const rows = [{name:'G1', totalLevel:100, memberCount:5}, {name:'G2', totalLevel:150, memberCount:2}];
  assert.deepEqual(RANKINGS.sortForType('guild', rows).map(r=>r.name), ['G2','G1']);
});
test('cache TTL: hit antes de expirar, miss depois', () => {
  const cache = RANKINGS.createRankCache();
  const t0 = 1000000;
  cache.set('level:1', {foo:1}, t0, 45000);
  assert.deepEqual(cache.get('level:1', t0 + 1000), {foo:1});
  assert.equal(cache.get('level:1', t0 + 45001), null);
});

// ===== Parte 2: endpoint real =====
const PORT = 8160;
let srv;
before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'rq_' + Math.random().toString(36).slice(2, 10);
async function newChar(lvl) {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'R' + rnd().slice(0,6), cls: 'mago' }, token);
  const charId = created.json.character.id;
  if (lvl) await adminRpc('rank_stats_set_level_xp', { p_character_id: charId, p_level: lvl, p_xp: 0 });
  return { token, charId };
}

test('GET /api/rankings: tipo invalido e rejeitado (400)', { skip: !hasSupabase() }, async () => {
  const r = await httpJson(srv, 'GET', '/api/rankings?type=inventado');
  assert.equal(r.status, 400);
});

test('GET /api/rankings: publico (sem token), nunca vaza userId/token/save', { skip: !hasSupabase() }, async () => {
  await newChar(77);
  const r = await httpJson(srv, 'GET', '/api/rankings?type=level');
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.json);
  assert.equal(text.includes('userId'), false);
  assert.equal(text.includes('"save"'), false);
  assert.equal(text.includes('token'), false);
});

test('GET /api/rankings?type=level: personagem de nivel alto aparece perto do topo', { skip: !hasSupabase() }, async () => {
  const high = await newChar(88);
  const r = await httpJson(srv, 'GET', '/api/rankings?type=level&page=1');
  assert.equal(r.status, 200);
  assert.equal(r.json.pageSize, 20);
  const found = r.json.items.find(x => x.level === 88);
  assert.ok(found, 'personagem de nivel 88 deveria aparecer na pagina 1');
  assert.ok(found.position >= 1);
});

test('GET /api/rankings?type=tvt: soma kills/wins refletidos, kd calculado', { skip: !hasSupabase() }, async () => {
  const c = await newChar(10);
  await adminRpc('rank_stats_bump', { p_character_id: c.charId, p_field: 'tvt_wins', p_delta: 3 });
  await adminRpc('rank_stats_bump', { p_character_id: c.charId, p_field: 'tvt_kills', p_delta: 12 });
  await adminRpc('rank_stats_bump', { p_character_id: c.charId, p_field: 'tvt_deaths', p_delta: 4 });
  const r = await httpJson(srv, 'GET', '/api/rankings?type=tvt');
  const row = r.json.items.find(x => x.wins === 3);
  assert.ok(row);
  assert.equal(row.kills, 12);
  assert.equal(row.kd, 3);
});

test('paginacao: page=2 nunca repete itens da page=1', { skip: !hasSupabase() }, async () => {
  const r1 = await httpJson(srv, 'GET', '/api/rankings?type=level&page=1');
  const r2 = await httpJson(srv, 'GET', '/api/rankings?type=level&page=2');
  const names1 = new Set(r1.json.items.map(x => x.name));
  const overlap = r2.json.items.filter(x => names1.has(x.name));
  assert.equal(overlap.length, 0);
});

test('campo invalido no rank_stats_bump e rejeitado (protege contra SQL dinamico)', { skip: !hasSupabase() }, async () => {
  const c = await newChar(5);
  await assert.rejects(() => adminRpc('rank_stats_bump', { p_character_id: c.charId, p_field: 'gold_infinito' }));
});
