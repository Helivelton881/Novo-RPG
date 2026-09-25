'use strict';
// Fase 5.14 -- Admin + Observabilidade. Parte 1: nucleo puro (matriz de
// permissao RBAC, sanitizacao de metadata de auditoria, calculo de
// ban/mute ativo) -- sempre roda, sem HTTP/WS/Supabase. Parte 2: fluxo
// real via HTTP (login/join com ban, chat com mute, kick, cargo) -- so
// roda com Supabase configurado, usando o mesmo projeto de TESTE que o
// resto da suite (nunca o oficial).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, wsConnect, waitFor, sleep } = require('./helpers');
const S = require('../server.js');

// ===== Parte 1: nucleo puro =====
test('ADMIN_PERMS: owner tem manage_roles e view_economy, support nao tem nenhum dos dois', () => {
  assert.equal(S.adminHasPerm('owner', 'manage_roles'), true);
  assert.equal(S.adminHasPerm('owner', 'view_economy'), true);
  assert.equal(S.adminHasPerm('support', 'manage_roles'), false);
  assert.equal(S.adminHasPerm('support', 'view_economy'), false);
});
test('ADMIN_PERMS: moderator pode kick/mute/ban/unban mas nao view_economy/manage_roles', () => {
  for (const perm of ['kick','mute','ban','unban']) assert.equal(S.adminHasPerm('moderator', perm), true, perm);
  assert.equal(S.adminHasPerm('moderator', 'view_economy'), false);
  assert.equal(S.adminHasPerm('moderator', 'manage_roles'), false);
});
test('ADMIN_PERMS: support so tem view_dashboard/search_players/view_guilds/view_events (somente leitura)', () => {
  for (const perm of ['view_dashboard','search_players','view_guilds','view_events']) assert.equal(S.adminHasPerm('support', perm), true, perm);
  for (const perm of ['kick','mute','ban','unban','view_economy','manage_roles','view_security_log']) assert.equal(S.adminHasPerm('support', perm), false, perm);
});
test('adminHasPerm: cargo inexistente/invalido nunca tem nenhuma permissao (nunca derruba com excecao)', () => {
  assert.equal(S.adminHasPerm('hacker', 'ban'), false);
  assert.equal(S.adminHasPerm(undefined, 'ban'), false);
});

test('sanitizeAuditMetadata: nunca deixa passar password/token/service_role/session, mesmo por engano', () => {
  const out = S.sanitizeAuditMetadata({password:'x', authToken:'y', service_role_key:'z', sessionToken:'w', reason:'motivo valido', durationMs:60000});
  assert.equal('password' in out, false);
  assert.equal('authToken' in out, false);
  assert.equal('service_role_key' in out, false);
  assert.equal('sessionToken' in out, false);
  assert.equal(out.reason, 'motivo valido');
  assert.equal(out.durationMs, 60000);
});
test('sanitizeAuditMetadata: null/nao-objeto vira null, nunca quebra', () => {
  assert.equal(S.sanitizeAuditMetadata(null), null);
  assert.equal(S.sanitizeAuditMetadata('texto'), null);
  assert.equal(S.sanitizeAuditMetadata(undefined), null);
});

test('activeAmong: permanente (sem expires_at) e sem revoked_at conta como ativo', () => {
  const row = S.activeAmong([{expires_at:null, revoked_at:null}]);
  assert.ok(row);
});
test('activeAmong: prazo ja vencido nunca conta como ativo, mesmo sem revoked_at', () => {
  const row = S.activeAmong([{expires_at:new Date(Date.now()-1000).toISOString(), revoked_at:null}]);
  assert.equal(row, null);
});
test('activeAmong: prazo no futuro conta como ativo', () => {
  const row = S.activeAmong([{expires_at:new Date(Date.now()+60000).toISOString(), revoked_at:null}]);
  assert.ok(row);
});
test('activeAmong: revoked_at sempre desativa, mesmo permanente/prazo no futuro', () => {
  const row = S.activeAmong([{expires_at:null, revoked_at:new Date().toISOString()}]);
  assert.equal(row, null);
});
test('activeAmong: lista vazia nunca quebra, retorna null', () => {
  assert.equal(S.activeAmong([]), null);
});

// ===== Parte 2: fluxo real (HTTP) =====
const PORT = 8182;
let srv;
before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'ad_' + Math.random().toString(36).slice(2, 10);
async function newAccount() {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  return { userId: reg.json.user.id, token: reg.json.token, username, password };
}
async function adminInsertRole(userId, role, grantedBy) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const r = await fetch(`${url}/rest/v1/admin_roles`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify({ user_id: userId, role, granted_by: grantedBy || null }),
  });
  const rows = await r.json();
  if (!r.ok) throw new Error('adminInsertRole falhou: ' + JSON.stringify(rows));
  return rows[0];
}
async function adminListOwnerIds() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const r = await fetch(`${url}/rest/v1/admin_roles?select=user_id&role=eq.owner`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const rows = await r.json();
  if (!r.ok) throw new Error('adminListOwnerIds falhou: ' + JSON.stringify(rows));
  return rows.map(row => row.user_id);
}
async function adminDeleteRole(userId) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  await fetch(`${url}/rest/v1/admin_roles?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}`, prefer: 'return=minimal' },
  });
}

test('sem cargo nenhum: /api/admin/me retorna 403 (acesso restrito)', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  const res = await httpJson(srv, 'GET', '/api/admin/me', null, acc.token);
  assert.equal(res.status, 403);
});

test('cargo support: enxerga dashboard/players mas 403 em ban/economy/roles', { skip: !hasSupabase() }, async () => {
  const acc = await newAccount();
  await adminInsertRole(acc.userId, 'support');
  const me = await httpJson(srv, 'GET', '/api/admin/me', null, acc.token);
  assert.equal(me.json.admin.role, 'support');
  const dash = await httpJson(srv, 'GET', '/api/admin/dashboard', null, acc.token);
  assert.equal(dash.status, 200);
  const ban = await httpJson(srv, 'POST', '/api/admin/ban', {userId:acc.userId, reason:'teste'}, acc.token);
  assert.equal(ban.status, 403);
  const eco = await httpJson(srv, 'GET', '/api/admin/economy', null, acc.token);
  assert.equal(eco.status, 403);
  const roles = await httpJson(srv, 'GET', '/api/admin/roles', null, acc.token);
  assert.equal(roles.status, 403);
});

test('ban: conta banida nao consegue logar de novo, e e desconectada do WS na hora', { skip: !hasSupabase() }, async () => {
  const owner = await newAccount(); await adminInsertRole(owner.userId, 'owner');
  const victim = await newAccount();
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'V', cls: 'guerreiro', lvl: 1, token: victim.token }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);

  let closeCode = null;
  conn.ws.on('close', code => { closeCode = code; });
  const banRes = await httpJson(srv, 'POST', '/api/admin/ban', {userId:victim.userId, reason:'teste de banimento'}, owner.token);
  assert.equal(banRes.status, 200);
  await new Promise(resolve => { const check = () => closeCode !== null ? resolve() : setTimeout(check, 25); check(); });
  assert.equal(closeCode, 4003, 'deveria ter sido desconectado com o codigo de ban assim que banido');

  const login = await httpJson(srv, 'POST', '/api/auth/login', {username:victim.username, password:victim.password});
  assert.equal(login.status, 403, 'conta banida nunca deveria conseguir logar de novo');
});

test('unban: restaura o login depois de removido', { skip: !hasSupabase() }, async () => {
  const owner = await newAccount(); await adminInsertRole(owner.userId, 'owner');
  const victim = await newAccount();
  await httpJson(srv, 'POST', '/api/admin/ban', {userId:victim.userId, reason:'teste'}, owner.token);
  const blocked = await httpJson(srv, 'POST', '/api/auth/login', {username:victim.username, password:victim.password});
  assert.equal(blocked.status, 403);
  await httpJson(srv, 'POST', '/api/admin/unban', {userId:victim.userId}, owner.token);
  const restored = await httpJson(srv, 'POST', '/api/auth/login', {username:victim.username, password:victim.password});
  assert.equal(restored.status, 200, 'deveria conseguir logar de novo depois do unban');
});

test('mute: bloqueia chat em tempo real pra quem ja esta conectado, sem precisar reconectar', { skip: !hasSupabase() }, async () => {
  const owner = await newAccount(); await adminInsertRole(owner.userId, 'owner');
  const victim = await newAccount();
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'M', cls: 'guerreiro', lvl: 1, token: victim.token }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);

  await httpJson(srv, 'POST', '/api/admin/mute', {userId:victim.userId, reason:'teste de mute'}, owner.token);
  await sleep(150);
  const before = conn.msgs.length;
  conn.ws.send(JSON.stringify({ type: 'chat', text: 'ola' }));
  const muted = await waitFor(conn.msgs, m => m.type === 'muted', 3000, before);
  assert.ok(muted, 'deveria ter recebido a notificacao de mute em vez do chat passar');
  conn.close();
});

test('kick: expulsa uma conta conectada na hora, socket fecha com o codigo certo', { skip: !hasSupabase() }, async () => {
  const owner = await newAccount(); await adminInsertRole(owner.userId, 'owner');
  const victim = await newAccount();
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'K', cls: 'guerreiro', lvl: 1, token: victim.token }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  let closeCode = null;
  conn.ws.on('close', code => { closeCode = code; });
  const res = await httpJson(srv, 'POST', '/api/admin/kick', {userId:victim.userId, reason:'teste'}, owner.token);
  assert.equal(res.json.socketsClosed, 1);
  await new Promise(resolve => { const check = () => closeCode !== null ? resolve() : setTimeout(check, 25); check(); });
  assert.equal(closeCode, 4004);
});

test('cargo: owner concede moderator a outra conta, que passa a poder kickar mas nao gerenciar cargos', { skip: !hasSupabase() }, async () => {
  const owner = await newAccount(); await adminInsertRole(owner.userId, 'owner');
  const newMod = await newAccount();
  const grant = await httpJson(srv, 'POST', '/api/admin/roles', {userId:newMod.userId, role:'moderator'}, owner.token);
  assert.equal(grant.status, 200);
  const target = await newAccount();
  const kick = await httpJson(srv, 'POST', '/api/admin/kick', {userId:target.userId, reason:'teste'}, newMod.token);
  assert.equal(kick.status, 200);
  const roleGrant = await httpJson(srv, 'POST', '/api/admin/roles', {userId:target.userId, role:'support'}, newMod.token);
  assert.equal(roleGrant.status, 403, 'moderator nunca deveria poder gerenciar cargos');
});

test('cargo: nunca deixa remover o ultimo owner (travaria o painel)', { skip: !hasSupabase() }, async () => {
  const owner = await newAccount(); await adminInsertRole(owner.userId, 'owner');
  // Achado na revisao pre-merge: testes anteriores neste MESMO arquivo
  // ja inserem seus proprios owners e nunca fazem limpeza -- sem isso,
  // owners.length nunca chega a 1 de verdade e o guard testado aqui
  // nunca dispara (o revoke sempre "passava" mesmo com o bug presente).
  // Remove qualquer outro owner acumulado ANTES de testar, garantindo
  // que este e realmente o unico no momento da asserção.
  for (const id of await adminListOwnerIds()) if (id !== owner.userId) await adminDeleteRole(id);
  const res = await httpJson(srv, 'POST', '/api/admin/roles/revoke', {userId:owner.userId}, owner.token);
  assert.equal(res.status, 400);
  assert.deepEqual(await adminListOwnerIds(), [owner.userId], 'o unico owner nao deveria ter sido removido');
});

test('auditoria: ban gera entrada no audit log, sem nenhum campo sensivel', { skip: !hasSupabase() }, async () => {
  const owner = await newAccount(); await adminInsertRole(owner.userId, 'owner');
  const victim = await newAccount();
  await httpJson(srv, 'POST', '/api/admin/ban', {userId:victim.userId, reason:'auditoria de teste'}, owner.token);
  const after = await httpJson(srv, 'GET', '/api/admin/audit', null, owner.token);
  // Achado na revisao pre-merge: comparar o TAMANHO da lista antes/depois
  // quebra assim que o log passa de 100 linhas (o limite da propria rota)
  // -- as duas leituras ficam presas no mesmo teto e a comparacao nunca
  // aumenta, mesmo com uma entrada nova de verdade. victim.userId e
  // gerado fresco a cada execucao, entao localizar a entrada especifica
  // (sempre a mais recente, sempre dentro da janela de 100) e a unica
  // checagem que realmente importa.
  const entry = after.json.audit.find(a => a.action === 'ban' && a.target_user_id === victim.userId);
  assert.ok(entry, 'a entrada do ban deveria estar no audit log');
  assert.equal(entry.reason, 'auditoria de teste');
  const flat = JSON.stringify(entry).toLowerCase();
  assert.equal(flat.includes('password'), false);
  assert.equal(flat.includes('service_role'), false);
});
