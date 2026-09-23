'use strict';
// Fase 3: registro, login, sessao, logout. Precisa de Supabase configurado
// (SUPABASE_URL + SUPABASE_SECRET_KEY no ambiente) -- sem isso, pula com
// aviso em vez de falhar, ja que nao ha como fabricar essas credenciais.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson } = require('./helpers');

const PORT = 8101;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'qa_' + Math.random().toString(36).slice(2, 10);

test('registro: usuario novo recebe token e sessao', { skip: !hasSupabase() }, async () => {
  const username = rnd(), password = 'SenhaForte123';
  const r = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  assert.equal(r.status, 201);
  assert.ok(r.json.token);
  assert.equal(r.json.user.name, username);
});

test('registro: usuario duplicado e rejeitado (409)', { skip: !hasSupabase() }, async () => {
  const username = rnd(), password = 'SenhaForte123';
  const first = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  assert.equal(first.status, 201);
  const second = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  assert.equal(second.status, 409);
});

test('registro: senha curta e rejeitada (400)', { skip: !hasSupabase() }, async () => {
  const r = await httpJson(srv, 'POST', '/api/auth/register', { username: rnd(), password: '123' });
  assert.equal(r.status, 400);
});

test('registro: usuario com caracteres invalidos e rejeitado (400)', { skip: !hasSupabase() }, async () => {
  const r = await httpJson(srv, 'POST', '/api/auth/register', { username: 'Usuário Com Espaço!', password: 'SenhaForte123' });
  assert.equal(r.status, 400);
});

test('login: credenciais corretas retornam token valido', { skip: !hasSupabase() }, async () => {
  const username = rnd(), password = 'SenhaForte123';
  await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const r = await httpJson(srv, 'POST', '/api/auth/login', { username, password });
  assert.equal(r.status, 200);
  assert.ok(r.json.token);
});

test('login: senha errada e rejeitada (401)', { skip: !hasSupabase() }, async () => {
  const username = rnd(), password = 'SenhaForte123';
  await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const r = await httpJson(srv, 'POST', '/api/auth/login', { username, password: 'SenhaErrada999' });
  assert.equal(r.status, 401);
});

test('login: usuario inexistente e rejeitado (401)', { skip: !hasSupabase() }, async () => {
  const r = await httpJson(srv, 'POST', '/api/auth/login', { username: rnd(), password: 'SenhaForte123' });
  assert.equal(r.status, 401);
});

test('sessao: token valido retorna o usuario', { skip: !hasSupabase() }, async () => {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const r = await httpJson(srv, 'GET', '/api/auth/session', null, reg.json.token);
  assert.equal(r.status, 200);
  assert.equal(r.json.user.name, username);
});

test('sessao: sem token e rejeitada (401)', { skip: !hasSupabase() }, async () => {
  const r = await httpJson(srv, 'GET', '/api/auth/session', null, null);
  assert.equal(r.status, 401);
});

test('sessao: token forjado/invalido e rejeitado (401)', { skip: !hasSupabase() }, async () => {
  const r = await httpJson(srv, 'GET', '/api/auth/session', null, 'token-forjado-que-nao-existe');
  assert.equal(r.status, 401);
});

test('logout: invalida a sessao (token deixa de funcionar depois)', { skip: !hasSupabase() }, async () => {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const before = await httpJson(srv, 'GET', '/api/auth/session', null, token);
  assert.equal(before.status, 200);
  const logout = await httpJson(srv, 'POST', '/api/auth/logout', {}, token);
  assert.equal(logout.status, 200);
  const after = await httpJson(srv, 'GET', '/api/auth/session', null, token);
  assert.equal(after.status, 401, 'token continua valido depois do logout -- sessao nao foi invalidada');
});
