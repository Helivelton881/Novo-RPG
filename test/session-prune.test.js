'use strict';
// Fase 5.16.7 -- poda de sessoes por usuario (MAX_SESSIONS_PER_USER=5,
// configuravel via env). Precisa de Supabase (mesma regra de auth.test.js):
// sem SUPABASE_URL/SUPABASE_SECRET_KEY, pula com aviso em vez de falhar.
// Cada teste usa uma conta propria e aleatoria (rnd()) -- nunca depende de
// outro teste nem da ordem de execucao. Nunca imprime token: os helpers
// (adminCountValidSessions) so devolvem created_at/expires_at.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, adminCountValidSessions, adminInsertExpiredSession } = require('./helpers');

const PORT = 8115;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'qa_' + Math.random().toString(36).slice(2, 10);

async function newAccount() {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  assert.equal(reg.status, 201);
  return { username, password, userId: reg.json.user.id, token: reg.json.token };
}
async function loginAgain(acc) {
  const r = await httpJson(srv, 'POST', '/api/auth/login', { username: acc.username, password: acc.password });
  assert.equal(r.status, 200);
  return r.json.token;
}

test('1 sessao: permanece sozinha depois do registro', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  const rows = await adminCountValidSessions(acc.userId);
  assert.equal(rows.length, 1);
});

test('5 sessoes: todas permanecem (limite ainda nao estourado)', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount(); // 1 sessao (registro)
  for (let i = 0; i < 4; i++) await loginAgain(acc); // +4 = 5
  const rows = await adminCountValidSessions(acc.userId);
  assert.equal(rows.length, 5);
});

test('6 sessoes: a mais antiga e removida, sobram exatamente 5', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  for (let i = 0; i < 5; i++) await loginAgain(acc); // 1 + 5 = 6 no total, 6a dispara a poda
  const rows = await adminCountValidSessions(acc.userId);
  assert.equal(rows.length, 5, 'deveria podar exatamente o excedente acima de MAX_SESSIONS_PER_USER');
});

test('20 sessoes: so as 5 mais recentes sobrevivem', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  for (let i = 0; i < 19; i++) await loginAgain(acc); // 1 + 19 = 20 logins no total
  const rows = await adminCountValidSessions(acc.userId);
  assert.equal(rows.length, 5);
});

test('sessao expirada: removida na proxima poda (proximo login), nunca contada como valida', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  await adminInsertExpiredSession(acc.userId);
  // a linha expirada nunca deveria aparecer numa contagem de "validas"
  // (filtro expires_at>now), mesmo antes de qualquer poda rodar:
  const beforePrune = await adminCountValidSessions(acc.userId);
  assert.equal(beforePrune.length, 1, 'sessao expirada nunca deveria contar como valida');
  await loginAgain(acc); // dispara pruneUserSessions, que tambem apaga expiradas de verdade
  const rows = await adminCountValidSessions(acc.userId);
  assert.equal(rows.length, 2, 'registro + este login -- a expirada foi de fato removida, nao so ignorada no filtro');
});

test('logout: remove SOMENTE o token corrente, outras sessoes do mesmo usuario continuam validas', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  const tokenB = await loginAgain(acc);
  const tokenC = await loginAgain(acc); // 3 sessoes validas: registro, B, C
  const before = await adminCountValidSessions(acc.userId);
  assert.equal(before.length, 3);
  const logout = await httpJson(srv, 'POST', '/api/auth/logout', {}, tokenB);
  assert.equal(logout.status, 200);
  const after = await adminCountValidSessions(acc.userId);
  assert.equal(after.length, 2, 'logout deveria remover so a sessao B, nunca as outras');
  // tokenC continua funcionando (nao foi derrubado por engano):
  const sessionCheck = await httpJson(srv, 'GET', '/api/auth/session', null, tokenC);
  assert.equal(sessionCheck.status, 200);
});

test('novo login com ja 5 sessoes validas: continua exatamente 5, nunca some/soma errado', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  for (let i = 0; i < 4; i++) await loginAgain(acc); // exatamente 5
  assert.equal((await adminCountValidSessions(acc.userId)).length, 5);
  await loginAgain(acc); // 6a -- poda de novo
  assert.equal((await adminCountValidSessions(acc.userId)).length, 5, 'deveria continuar exatamente 5, nunca 6 nem menos de 5');
});
