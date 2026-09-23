'use strict';
// Fase 3: XP, level-up, ouro, quest, loot (baus). Cobre as unidades 1, 4 e 7
// da Fase 1 (recompensa de missao, bau, trava de lvl/quest apos progresso
// real) como testes de regressao formais, via HTTP real. Precisa de
// Supabase configurado.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson } = require('./helpers');

const PORT = 8103;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'qa_' + Math.random().toString(36).slice(2, 10);
async function newChar() {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Heroi', cls: 'guerreiro' }, token);
  return { token, id: created.json.character.id };
}

test('quest: recompensa exata concedida e quest avanca', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar();
  await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 1, save: { quest: 2, xp: 0, gold: 0, gem: 0, pv: 0 } }, token);
  const r = await httpJson(srv, 'POST', '/api/characters/' + id + '/quest', { from: 2 }, token);
  assert.equal(r.status, 200);
  assert.equal(r.json.character.save.gold, 30);
  assert.equal(r.json.character.save.pv, 1);
  assert.equal(r.json.character.save.xp, 20);
  assert.equal(r.json.character.save.quest, 3);
});

test('quest: reivindicar a mesma recompensa duas vezes e rejeitado', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar();
  await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 1, save: { quest: 2, xp: 0, gold: 0 } }, token);
  const first = await httpJson(srv, 'POST', '/api/characters/' + id + '/quest', { from: 2 }, token);
  assert.equal(first.status, 200);
  const second = await httpJson(srv, 'POST', '/api/characters/' + id + '/quest', { from: 2 }, token);
  assert.equal(second.status, 400);
});

test('quest: pular estagio sem ter passado pelos anteriores e rejeitado', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar(); // personagem novo: quest=0
  const r = await httpJson(srv, 'POST', '/api/characters/' + id + '/quest', { from: 8 }, token);
  assert.equal(r.status, 400);
});

test('level-up: XP suficiente sobe de nivel e restaura o teto de vida/mana implicitamente (lvl muda)', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar();
  await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 1, save: { quest: 28, xp: 25, gold: 0 } }, token);
  const r = await httpJson(srv, 'POST', '/api/characters/' + id + '/quest', { from: 28 }, token);
  assert.equal(r.status, 200);
  assert.ok(r.json.character.lvl > 1, 'nivel nao subiu apesar do XP acumulado (25+2500) ultrapassar o necessario');
});

test('bau: abertura concede ouro fixo e consome a chave', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar();
  await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 1, save: { key: 1, chest: false, gold: 0 } }, token);
  const r = await httpJson(srv, 'POST', '/api/characters/' + id + '/chest', { flag: 'chestOpen' }, token);
  assert.equal(r.status, 200);
  assert.equal(r.json.character.save.gold, 60);
  assert.equal(r.json.character.save.key, 0);
  assert.equal(r.json.character.save.chest, true);
});

test('bau: sem chave e rejeitado', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar();
  await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 1, save: { key: 0 } }, token);
  const r = await httpJson(srv, 'POST', '/api/characters/' + id + '/chest', { flag: 'chestOpen' }, token);
  assert.equal(r.status, 400);
});

test('bau: reabrir o mesmo bau e rejeitado', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar();
  await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 1, save: { key: 5, chest: false } }, token);
  const first = await httpJson(srv, 'POST', '/api/characters/' + id + '/chest', { flag: 'chestOpen' }, token);
  assert.equal(first.status, 200);
  const second = await httpJson(srv, 'POST', '/api/characters/' + id + '/chest', { flag: 'chestOpen' }, token);
  assert.equal(second.status, 400);
});

test('trava pos-progresso: PUT bruto nao consegue forjar lvl/xp/quest depois que o personagem ja tem progresso real', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar();
  // 1o PUT com progresso real -- confiado integralmente (personagem "novo")
  await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 5, save: { quest: 6, xp: 50 } }, token);
  // 2o PUT tentando forjar valores maiores -- deve ser ignorado
  const forged = await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 99, save: { quest: 28, xp: 99999 } }, token);
  assert.equal(forged.status, 200);
  assert.equal(forged.json.character.lvl, 5, 'lvl forjado foi aceito depois que o personagem ja era rastreado');
  assert.equal(forged.json.character.save.quest, 6, 'quest forjado foi aceito depois que o personagem ja era rastreado');
  assert.equal(forged.json.character.save.xp, 50, 'xp forjado foi aceito depois que o personagem ja era rastreado');
});

test('promocao de personagem novo: 1o PUT com progresso alto e confiado integralmente', { skip: !hasSupabase() }, async () => {
  const { token, id } = await newChar();
  const r = await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 20, save: { quest: 10, xp: 300, gold: 500 } }, token);
  assert.equal(r.status, 200);
  assert.equal(r.json.character.lvl, 20);
  assert.equal(r.json.character.save.quest, 10);
});
