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
// envOverrides permite ligar algo desligado por padrao pra um arquivo
// especifico (ex.: { AI_ENABLED: '1' } em test/ai.test.js pra exercitar
// o fluxo real de WS/broadcast -- nunca o padrao, ver abaixo).
async function startServer(port, envOverrides) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    // AI_ENABLED=0 (Fase 5.16): desliga o spawn automatico de
    // Aventureiros IA em todo servidor de teste -- nenhuma suite espera
    // um ator nao controlado aparecendo sozinho no mapa compartilhado
    // de um teste (ja causou uma falha intermitente em
    // monster-movement.test.js antes desta linha existir). Testes que
    // exercitam IA de verdade (test/ai.test.js) chamam aiSpawnEntity()
    // direto, ou reativam explicitamente via envOverrides.
    env: Object.assign({}, process.env, { PORT: String(port), AI_ENABLED: '0' }, envOverrides || {}),
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

// Fase 5.16.6: dungeon_enter agora exige, como ultimo portao antes de
// criar a instancia, que o REQUISITANTE esteja de fato no mapa de campo
// da zona e dentro do raio da entrada da caverna (DUNGEON_CAVE_POS =
// {x:46*T,y:16*T} = {x:2208,y:768}, T=48; DUNGEON_CAVE_RADIUS=190, ver
// server.js) -- nunca mais um dungeon_enter "solto" sem posicao alguma.
// Simula a caminhada real de uma conexao AUTENTICADA (que passa pelo
// portal-radius de allowedFieldTransition, ao contrario do atalho que
// visitantes anonimos tem): primeiro um passo dentro da vila pra chegar
// perto do portal de campo (720,1042), depois a transicao de mapa pra
// zona de destino pousando exatamente na entrada da caverna.
async function moveToDungeonCave(conn, zone) {
  conn.ws.send(JSON.stringify({ type: 'state', map: 'vila', x: 720, y: 1042, dir: 0, moving: false }));
  await sleep(60);
  conn.ws.send(JSON.stringify({ type: 'state', map: zone, x: 2208, y: 768, dir: 0, moving: false }));
  await sleep(60);
}

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

// Chama uma funcao RPC do Postgres direto (mesmo mecanismo que server.js
// usa pra guild_*/bestiary_record_kill/etc, so que com a service-role key
// direto do teste). Usado pra simular um efeito server-side que ja tem
// cobertura de integracao real em outro teste (ex.: um abate confirmado
// via mob_damage) sem reconstruir o fluxo de combate inteiro so pra
// preparar estado -- mesmo espirito de adminPatchCharacter.
async function adminRpc(name, body) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const r = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('adminRpc ' + name + ' falhou: ' + JSON.stringify(data));
  return Array.isArray(data) ? data[0] : data;
}

module.exports = { hasSupabase, startServer, stopServer, httpJson, wsConnect, waitFor, joinWs, sleep, adminPatchCharacter, adminRpc, moveToDungeonCave };
