'use strict';
// Utilitarios compartilhados pela suite de testes (Fase 3). Cada arquivo de
// teste sobe sua propria instancia de server.js (processo filho, porta
// dedicada) pra nao disputar estado com os outros arquivos -- node:test
// roda arquivos em paralelo por padrao.
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');

function hasSupabase() {
  return !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));
}

// Sobe server.js como processo filho numa porta dedicada e espera responder.
async function startServer(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { out += d.toString(); });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    try {
      const r = await fetch(`http://localhost:${port}/`);
      if (r.status === 200) return { child, port, base: `http://localhost:${port}`, wsUrl: `ws://localhost:${port}/game`, log: () => out };
    } catch {}
    await sleep(100);
  }
  child.kill();
  throw new Error('server nao subiu a tempo. log:\n' + out);
}

function stopServer(srv) {
  if (srv && srv.child && !srv.child.killed) srv.child.kill();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpJson(srv, method, path, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(srv.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text) } catch { json = text }
  return { status: r.status, json };
}

function wsConnect(srv) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(srv.wsUrl);
    const msgs = [];
    ws.on('message', raw => { try { msgs.push(JSON.parse(raw)) } catch {} });
    ws.on('open', () => resolve({ ws, msgs, close: () => ws.close() }));
    ws.on('error', reject);
  });
}

function waitFor(msgs, pred, timeoutMs, fromIdx) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = msgs.slice(fromIdx || 0).find(pred);
      if (m) { clearInterval(iv); resolve(m); }
      else if (Date.now() - t0 > (timeoutMs || 3000)) { clearInterval(iv); reject(new Error('timeout esperando mensagem')); }
    }, 25);
  });
}

async function joinWs(srv, over) {
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify(Object.assign({ type: 'join', name: 'Testador', cls: 'guerreiro', lvl: 1 }, over || {})));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  return conn;
}

// Escreve DIRETO na tabela `characters` do Supabase de TESTE (mesmas
// SUPABASE_URL/SUPABASE_SECRET_KEY ja herdadas pelo processo filho em
// startServer -- nunca o Supabase oficial de producao, ver hasSupabase()).
// So serve pra montar estado de setup que nao tem mais nenhuma rota
// client-facing legitima pra forjar (ex.: quest/gunlock, travados desde a
// Fase 5.2 no PUT generico) -- os TESTES em si continuam validando os
// fluxos reais (dungeon_enter, mob_damage, shop) sem bypass nenhum.
async function adminPatchCharacter(id, patch) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const r = await fetch(`${url}/rest/v1/characters?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  const rows = await r.json();
  if (!r.ok) throw new Error('adminPatchCharacter falhou: ' + JSON.stringify(rows));
  return rows[0];
}

module.exports = { hasSupabase, startServer, stopServer, httpJson, wsConnect, waitFor, joinWs, sleep, adminPatchCharacter };
