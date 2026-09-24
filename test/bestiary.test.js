'use strict';
// Fase 5.9 -- Bestiario. Parte 1: catalogo puro (game-data/bestiary.js),
// sempre roda. Parte 2: endpoint publico do catalogo (sempre roda, nao
// depende de Supabase -- nao consulta banco). Parte 3: progresso real por
// personagem (GET /api/bestiary/:charId) + credito de abate via a mesma
// funcao RPC que server.js chama (bestiary_record_kill) -- so roda com
// credenciais Supabase configuradas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, adminRpc } = require('./helpers');
const BESTIARY = require('../game-data/bestiary.js');

// ===== Parte 1: catalogo puro =====
test('catalogo tem exatamente os tipos reais do jogo (13 de campo/masmorra + Titã Ancestral)', () => {
  assert.equal(BESTIARY.BESTIARY_TOTAL, 14);
  assert.equal(BESTIARY.BESTIARY_CATALOG.length, 14);
});
test('catalogo nao tem ids duplicados', () => {
  const ids = BESTIARY.BESTIARY_CATALOG.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
});
test('todo id do catalogo bate com um type real usado em server.js (mobStats/DUNGEON_CFG)', () => {
  const real = ['slime','goblin','skeleton','wolf','bat','toxic','caster','sky','lorde','sala','elem','calc','cinza','ancient_titan'];
  const ids = BESTIARY.BESTIARY_CATALOG.map(c => c.id).sort();
  assert.deepEqual(ids, real.sort());
});
test('isValidMonsterId: aceita ids reais, rejeita mob inventado', () => {
  assert.equal(BESTIARY.isValidMonsterId('goblin'), true);
  assert.equal(BESTIARY.isValidMonsterId('ancient_titan'), true);
  assert.equal(BESTIARY.isValidMonsterId('dragao_inexistente'), false);
  assert.equal(BESTIARY.isValidMonsterId(''), false);
  assert.equal(BESTIARY.isValidMonsterId(undefined), false);
});
test('Titã Ancestral e o unico boss de World Boss, e so ele dropa exclusivamente lendario', () => {
  const titan = BESTIARY.catalogEntry('ancient_titan');
  assert.equal(titan.boss, true);
  assert.deepEqual(titan.dropTiers, ['legendary']);
});
test('nenhum monstro de campo/masmorra (nao-chefe) promete legendary (so o chefe de vulcao e o titan)', () => {
  for (const c of BESTIARY.BESTIARY_CATALOG) {
    if (!c.boss) assert.equal(c.dropTiers.includes('legendary'), false, c.id + ' nao deveria prometer legendary');
  }
});

// ===== Parte 2: catalogo publico via HTTP (sem Supabase) =====
const PORT = 8150;
let srv;
before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

test('GET /api/bestiary/catalog: publico, sem autenticacao, sem vazar progresso de ninguem', async () => {
  const r = await httpJson(srv, 'GET', '/api/bestiary/catalog');
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 14);
  assert.equal(r.json.catalog.length, 14);
  assert.equal(JSON.stringify(r.json).includes('character_id'), false);
});

// ===== Parte 3: progresso real por personagem =====
const rnd = () => 'bq_' + Math.random().toString(36).slice(2, 10);
async function newChar() {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'B' + rnd().slice(0,6), cls: 'guerreiro' }, token);
  return { token, charId: created.json.character.id };
}

test('GET /api/bestiary/:charId: sem token e rejeitado (401)', { skip: !hasSupabase() }, async () => {
  const c = await newChar();
  const r = await httpJson(srv, 'GET', `/api/bestiary/${c.charId}`);
  assert.equal(r.status, 401);
});

test('GET /api/bestiary/:charId: personagem de outra conta e rejeitado (404, nunca vaza progresso alheio)', { skip: !hasSupabase() }, async () => {
  const a = await newChar(), b = await newChar();
  const r = await httpJson(srv, 'GET', `/api/bestiary/${a.charId}`, null, b.token);
  assert.equal(r.status, 404);
});

test('progresso inicial: tudo nao descoberto, 0/14', { skip: !hasSupabase() }, async () => {
  const c = await newChar();
  const r = await httpJson(srv, 'GET', `/api/bestiary/${c.charId}`, null, c.token);
  assert.equal(r.status, 200);
  assert.equal(r.json.discovered, 0);
  assert.equal(r.json.total, 14);
  assert.ok(r.json.catalog.every(x => x.discovered === false));
});

test('primeiro abate confirmado: descobre a criatura, kills=1, first=last=discovered', { skip: !hasSupabase() }, async () => {
  const c = await newChar();
  // Simula exatamente o que creditBestiaryKill(charId,'goblin') faz no
  // servidor quando mob.hp<=0 e confirmado em mob_damage -- mesma funcao
  // RPC, so chamada direto (evita reconstruir o fluxo de combate completo
  // so pra preparar estado; a integracao real do PONTO DE CHAMADA em
  // server.js e coberta pela regressao de combat.test.js/monsters.test.js,
  // que continuam verdes sem nenhuma mudanca de comportamento).
  await adminRpc('bestiary_record_kill', { p_character_id: c.charId, p_monster_id: 'goblin' });
  const r = await httpJson(srv, 'GET', `/api/bestiary/${c.charId}`, null, c.token);
  assert.equal(r.json.discovered, 1);
  const goblin = r.json.catalog.find(x => x.id === 'goblin');
  assert.equal(goblin.discovered, true);
  assert.equal(goblin.kills, 1);
  assert.equal(goblin.firstKillAt, goblin.lastKillAt);
  assert.equal(goblin.discoveredAt, goblin.firstKillAt);
});

test('segundo abate: kills incrementa, first_kill_at nao muda, last_kill_at avanca', { skip: !hasSupabase() }, async () => {
  const c = await newChar();
  const first = await adminRpc('bestiary_record_kill', { p_character_id: c.charId, p_monster_id: 'skeleton' });
  await new Promise(r => setTimeout(r, 1100)); // garante timestamp diferente (resolucao de segundo)
  const second = await adminRpc('bestiary_record_kill', { p_character_id: c.charId, p_monster_id: 'skeleton' });
  assert.equal(second.kills, 2);
  assert.equal(second.first_kill_at, first.first_kill_at);
  assert.notEqual(second.last_kill_at, first.last_kill_at);
  const r = await httpJson(srv, 'GET', `/api/bestiary/${c.charId}`, null, c.token);
  const sk = r.json.catalog.find(x => x.id === 'skeleton');
  assert.equal(sk.kills, 2);
});

test('contador concorrente: 5 abates "simultaneos" do mesmo mob nunca perdem incremento', { skip: !hasSupabase() }, async () => {
  const c = await newChar();
  await Promise.all(Array.from({length:5}, () => adminRpc('bestiary_record_kill', { p_character_id: c.charId, p_monster_id: 'wolf' })));
  const r = await httpJson(srv, 'GET', `/api/bestiary/${c.charId}`, null, c.token);
  assert.equal(r.json.catalog.find(x => x.id === 'wolf').kills, 5);
});

test('World Boss (ancient_titan) integra o mesmo mecanismo de credito', { skip: !hasSupabase() }, async () => {
  const c = await newChar();
  await adminRpc('bestiary_record_kill', { p_character_id: c.charId, p_monster_id: 'ancient_titan' });
  const r = await httpJson(srv, 'GET', `/api/bestiary/${c.charId}`, null, c.token);
  const titan = r.json.catalog.find(x => x.id === 'ancient_titan');
  assert.equal(titan.discovered, true);
  assert.equal(titan.kills, 1);
});

test('progresso percentual correto conforme criaturas distintas descobertas', { skip: !hasSupabase() }, async () => {
  const c = await newChar();
  for (const id of ['slime','bat','toxic']) await adminRpc('bestiary_record_kill', { p_character_id: c.charId, p_monster_id: id });
  const r = await httpJson(srv, 'GET', `/api/bestiary/${c.charId}`, null, c.token);
  assert.equal(r.json.discovered, 3);
  assert.equal(r.json.total, 14);
});
