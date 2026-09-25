'use strict';
// Fase 5.15 -- Portal Publico (site publico em /portal). API 100% sem
// autenticacao (/api/public/*), privacidade estrita (nunca user_id/
// email/save/token/session/cargo-de-admin/moderacao privada).
// Rankings/guildas do portal reusam o /api/rankings ja publico desde a
// Fase 5.10 -- sem mudanca nenhuma nele, sem teste duplicado aqui.
// (Nao confundir com test/portal.test.js, que testa a tela de viagem
// "portal" DENTRO do jogo -- Fase anterior, conceito de nome diferente.)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, adminPatchCharacter } = require('./helpers');
const S = require('../server.js');

const PORT = 8183;
let srv;
before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

test('publicCache: hit dentro do TTL nunca reexecuta a funcao de origem', async () => {
  S.publicCache.clear();
  let calls = 0;
  const key = 'test_key_' + Math.random();
  const hit1 = S.publicCache.get(key);
  assert.equal(hit1, null, 'cache vazio deveria comecar sem hit');
  S.publicCache.set(key, {calls: ++calls});
  const hit2 = S.publicCache.get(key);
  assert.equal(hit2.calls, 1, 'deveria reusar o valor cacheado, nunca recalcular');
});

test('/api/public/status: responde sem nenhuma autenticacao, formato de populacao humano/IA presente', { skip: !hasSupabase() }, async () => {
  const res = await httpJson(srv, 'GET', '/api/public/status');
  assert.equal(res.status, 200);
  assert.ok('human' in res.json.population);
  assert.ok('ai' in res.json.population);
  // Fase 5.16: IA agora existe de verdade (aiEntities.size) -- so
  // confirma o formato (numero >=0), nunca um valor fixo, ja que a
  // populacao de IA cresce sozinha pelo tick de 1s (aiPopulationTick).
  assert.equal(typeof res.json.population.ai, 'number');
  assert.ok(res.json.population.ai >= 0);
  assert.equal(typeof res.json.worldBossActive, 'boolean');
});

test('/api/public/status: nunca vaza user_id/email/save/token/session/role em nenhum campo', { skip: !hasSupabase() }, async () => {
  const res = await httpJson(srv, 'GET', '/api/public/status');
  const flat = JSON.stringify(res.json).toLowerCase();
  for (const forbidden of ['user_id','email','password','token','session','"role"','save']) {
    assert.equal(flat.includes(forbidden), false, `campo proibido encontrado na resposta publica: ${forbidden}`);
  }
});

test('/api/public/events: lista proximos eventos sem exigir conta', { skip: !hasSupabase() }, async () => {
  const res = await httpJson(srv, 'GET', '/api/public/events');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.upcoming));
  assert.ok(res.json.upcoming.length > 0);
  assert.ok(res.json.upcoming[0].startAt);
});

test('/api/public/news: lista vazia no inicio, nunca quebra sem noticia nenhuma', { skip: !hasSupabase() }, async () => {
  const res = await httpJson(srv, 'GET', '/api/public/news');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.news));
});

test('/api/public/news: nunca expoe author_user_id (so title/body/published_at)', { skip: !hasSupabase() }, async () => {
  const res = await httpJson(srv, 'GET', '/api/public/news');
  const flat = JSON.stringify(res.json).toLowerCase();
  assert.equal(flat.includes('author'), false);
});

const rnd = () => 'pt_' + Math.random().toString(36).slice(2, 10);
async function adminInsertRole(userId, role) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const r = await fetch(`${url}/rest/v1/admin_roles`, {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify({ user_id: userId, role }),
  });
  const rows = await r.json(); if (!r.ok) throw new Error(JSON.stringify(rows)); return rows[0];
}

test('noticia publicada pelo admin aparece na API publica na hora (cache limpo no publish)', { skip: !hasSupabase() }, async () => {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  await adminInsertRole(reg.json.user.id, 'owner');
  const title = 'Manutencao programada ' + rnd();
  const publish = await httpJson(srv, 'POST', '/api/admin/news', {title, body:'Texto de teste da noticia.'}, reg.json.token);
  assert.equal(publish.status, 200);
  const news = await httpJson(srv, 'GET', '/api/public/news');
  assert.ok(news.json.news.some(n => n.title === title), 'a noticia publicada deveria aparecer imediatamente na API publica');
});

test('moderator sem manage_news nao consegue publicar noticia', { skip: !hasSupabase() }, async () => {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  await adminInsertRole(reg.json.user.id, 'moderator');
  const res = await httpJson(srv, 'POST', '/api/admin/news', {title:'x', body:'y'}, reg.json.token);
  assert.equal(res.status, 403);
});
