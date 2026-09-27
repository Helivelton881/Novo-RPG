'use strict';
// Fase 5.17.3 -- integridade de ranking contra o Supabase REAL de CI
// (projeto Novo-RPG CI). Sem credenciais: SKIPPED no job unit; no job de
// integracao (REQUIRE_SUPABASE=1) a ausencia de credencial FALHA.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, adminPatchCharacter, adminRpc } = require('./helpers');

const skip = !hasSupabase();
const PORT = 8232;
let srv;
before(async () => { if (!skip) srv = await startServer(PORT); });
after(() => { if (srv) stopServer(srv); });

const RUN = (process.env.GITHUB_RUN_ID || 'local') + '_' + Math.random().toString(36).slice(2, 6);
const rnd = () => ('q' + RUN + Math.random().toString(36).slice(2, 6)).replace(/[^a-z0-9_]/g, '').slice(0, 16);
async function rest(pathAndQuery, init = {}) {
  const url = String(process.env.SUPABASE_URL).replace(/\/$/, '') + '/rest/v1/' + pathAndQuery;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(url, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}
async function newAccountChar(name = 'RankQA') {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name, cls: 'guerreiro' }, reg.json.token);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return { token: reg.json.token, id: created.json.character.id };
}
const rankRow = async id => (await rest(`character_rank_stats?select=character_id,level,xp&character_id=eq.${id}`)).json;

test('personagem novo nasce com EXATAMENTE uma linha de rank (level 1, xp 0)', { skip }, async () => {
  const ch = await newAccountChar();
  const rows = await rankRow(ch.id);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].level, rows[0].xp], [1, 0]);
});

test('rank_stats_set_level_xp nunca mantem level > 40 (e xp 0 no cap)', { skip }, async () => {
  const ch = await newAccountChar();
  await adminRpc('rank_stats_set_level_xp', { p_character_id: ch.id, p_level: 99, p_xp: 5000 });
  const rows = await rankRow(ch.id);
  assert.deepEqual([rows[0].level, rows[0].xp], [40, 0]);
});

test('banco recusa characters.lvl > 40 e character_rank_stats.level > 40 (constraints)', { skip }, async () => {
  const ch = await newAccountChar();
  const c = await rest(`characters?id=eq.${ch.id}`, { method: 'PATCH', body: JSON.stringify({ lvl: 41 }) });
  assert.equal(c.status, 400, 'check constraint characters_lvl_range');
  const r = await rest(`character_rank_stats?character_id=eq.${ch.id}`, { method: 'PATCH', body: JSON.stringify({ level: 41 }) });
  assert.equal(r.status, 400, 'check constraint character_rank_stats_level_range');
});

test('PUT forjado lvl 99 / save.lvl 99 nao persiste; coluna e save.lvl continuam iguais', { skip }, async () => {
  const ch = await newAccountChar();
  await httpJson(srv, 'PUT', '/api/characters/' + ch.id, { lvl: 99, save: { lvl: 99, xp: 9e9 } }, ch.token);
  const rows = (await rest(`characters?select=lvl,save&id=eq.${ch.id}`)).json;
  assert.ok(rows[0].lvl <= 40);
  assert.equal(Number(rows[0].save.lvl), rows[0].lvl);
});

test('ranking publico nunca mostra level > 40 e nao duplica personagens', { skip }, async () => {
  await newAccountChar();
  const r = await httpJson(srv, 'GET', '/api/rankings?type=level');
  assert.equal(r.status, 200);
  for (const it of r.json.items) assert.ok(it.level <= 40);
  const keys = r.json.items.map(i => i.name + '|' + i.position);
  assert.equal(new Set(keys).size, keys.length);
});

test('DELETE do personagem apaga a linha de rank (FK cascade)', { skip }, async () => {
  const ch = await newAccountChar();
  assert.equal((await rankRow(ch.id)).length, 1);
  const del = await httpJson(srv, 'DELETE', '/api/characters/' + ch.id, null, ch.token);
  assert.equal(del.status, 200);
  assert.equal((await rankRow(ch.id)).length, 0);
});

test('duas criacoes/upserts concorrentes de rank nao duplicam', { skip }, async () => {
  const ch = await newAccountChar();
  await Promise.all([1, 2, 3].map(() => adminRpc('rank_stats_set_level_xp', { p_character_id: ch.id, p_level: 5, p_xp: 10 })));
  assert.equal((await rankRow(ch.id)).length, 1);
});

test('autosave (patchCharacterFields) + XP nunca ultrapassa o cap nem reverte normalizacao', { skip }, async () => {
  const ch = await newAccountChar();
  const user = (await rest(`characters?select=user_id&id=eq.${ch.id}`)).json[0].user_id;
  await adminPatchCharacter(ch.id, { lvl: 40, save: { lvl: 40, xp: 0, cls: 'guerreiro', map: 'vila' } });
  const S = require('../server.js');
  await S.patchCharacterFields(ch.id, user, { map: 'vila', x: 700, y: 1200, hp: 100, lvl: 99 });
  const rows = (await rest(`characters?select=lvl,save&id=eq.${ch.id}`)).json;
  assert.equal(rows[0].lvl, 40);
  assert.equal(Number(rows[0].save.lvl), 40);
  assert.equal(Number(rows[0].save.xp), 0);
});
