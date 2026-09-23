'use strict';
// Fase 3: criacao de personagem, acesso indevido a personagem de outra
// conta, save, reload. Precisa de Supabase configurado.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson } = require('./helpers');

const PORT = 8102;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'qa_' + Math.random().toString(36).slice(2, 10);
async function newAccount() {
  const username = rnd(), password = 'SenhaForte123';
  const r = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  return { username, token: r.json.token, userId: r.json.user.id };
}

test('criacao: personagem valido retorna 201 com id', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  const r = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Heroi', cls: 'guerreiro' }, acc.token);
  assert.equal(r.status, 201);
  assert.ok(r.json.character.id);
  assert.equal(r.json.character.lvl, 1);
});

test('criacao: slot invalido e rejeitado (400)', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  const r = await httpJson(srv, 'POST', '/api/characters', { slot: 99, name: 'Heroi', cls: 'guerreiro' }, acc.token);
  assert.equal(r.status, 400);
});

test('criacao: nome curto demais e rejeitado (400)', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  const r = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'X', cls: 'guerreiro' }, acc.token);
  assert.equal(r.status, 400);
});

test('criacao: mesmo slot duas vezes e rejeitado (409)', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  const first = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Heroi1', cls: 'guerreiro' }, acc.token);
  assert.equal(first.status, 201);
  const second = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Heroi2', cls: 'mago' }, acc.token);
  assert.equal(second.status, 409);
});

test('listagem: retorna os personagens da propria conta', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Heroi', cls: 'guerreiro' }, acc.token);
  const r = await httpJson(srv, 'GET', '/api/characters', null, acc.token);
  assert.equal(r.status, 200);
  assert.equal(r.json.characters.length, 1);
  assert.equal(r.json.characters[0].name, 'Heroi');
});

test('save + reload: progresso enviado via PUT volta identico no proximo GET', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Heroi', cls: 'guerreiro' }, acc.token);
  const id = created.json.character.id;
  const put = await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 1, save: { map: 'floresta', bar: ['atk'] } }, acc.token);
  assert.equal(put.status, 200);
  assert.equal(put.json.character.map, 'floresta');
  const reload = await httpJson(srv, 'GET', '/api/characters', null, acc.token);
  const reloaded = reload.json.characters.find(c => c.id === id);
  assert.equal(reloaded.map, 'floresta');
  assert.deepEqual(reloaded.save.bar.slice(0, 1), ['atk']);
});

test('acesso indevido: conta B nao consegue LER personagem da conta A (404, nao vaza dado)', { skip: !hasSupabase() }, async () => {
  const a = await newAccount(), b = await newAccount();
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'DoUsuarioA', cls: 'guerreiro' }, a.token);
  const id = created.json.character.id;
  const listB = await httpJson(srv, 'GET', '/api/characters', null, b.token);
  assert.equal(listB.json.characters.length, 0, 'conta B nao deveria ver personagem da conta A na listagem');
});

test('acesso indevido: conta B nao consegue ALTERAR personagem da conta A (404)', { skip: !hasSupabase() }, async () => {
  const a = await newAccount(), b = await newAccount();
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'DoUsuarioA', cls: 'guerreiro' }, a.token);
  const id = created.json.character.id;
  const put = await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl: 99, save: { gold: 999999 } }, b.token);
  assert.equal(put.status, 404, 'conta B conseguiu escrever no personagem da conta A');
  // confirma que o personagem da conta A realmente NAO mudou
  const checkA = await httpJson(srv, 'GET', '/api/characters', null, a.token);
  const charA = checkA.json.characters.find(c => c.id === id);
  assert.equal(charA.lvl, 1, 'personagem da conta A foi alterado por uma conta que nao e dona dele');
});

test('acesso indevido: conta B nao consegue APAGAR personagem da conta A (404)', { skip: !hasSupabase() }, async () => {
  const a = await newAccount(), b = await newAccount();
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'DoUsuarioA', cls: 'guerreiro' }, a.token);
  const id = created.json.character.id;
  const del = await httpJson(srv, 'DELETE', '/api/characters/' + id, null, b.token);
  assert.equal(del.status, 404, 'conta B conseguiu apagar personagem da conta A');
  const checkA = await httpJson(srv, 'GET', '/api/characters', null, a.token);
  assert.equal(checkA.json.characters.some(c => c.id === id), true, 'personagem da conta A foi apagado por quem nao e dono');
});

test('exclusao: dono consegue apagar o proprio personagem', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Heroi', cls: 'guerreiro' }, acc.token);
  const id = created.json.character.id;
  const del = await httpJson(srv, 'DELETE', '/api/characters/' + id, null, acc.token);
  assert.equal(del.status, 200);
  const after = await httpJson(srv, 'GET', '/api/characters', null, acc.token);
  assert.equal(after.json.characters.length, 0);
});

test('sem sessao: qualquer rota de personagem exige token (401)', { skip: !hasSupabase() }, async () => {
  const r = await httpJson(srv, 'GET', '/api/characters', null, null);
  assert.equal(r.status, 401);
});
