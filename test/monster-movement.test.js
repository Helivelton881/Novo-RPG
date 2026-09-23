'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, stopServer, joinWs, waitFor, sleep } = require('./helpers');

const PORT = 8113;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

function slimeDefs() {
  return Array.from({ length: 15 }, (_, i) => ({ id: 'move-s' + i, x: 1600 + i * 24, y: 500 + (i % 3) * 40, lvl: 1 + (i % 3) }));
}

async function enterVila(conn, x = 1700, y = 500) {
  conn.ws.send(JSON.stringify({ type: 'state', map: 'vila', x, y, dir: 0, moving: false, lvl: 12 }));
  await sleep(60);
  conn.ws.send(JSON.stringify({ type: 'map_join', map: 'vila', mobs: slimeDefs() }));
  return waitFor(conn.msgs, m => m.type === 'map_state' && m.map === 'vila', 3000);
}

test('cliente online nao envia nem aplica autoridade local de posicao dos monstros', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const runtime = html.slice(html.indexOf('let NET=null'), html.indexOf('/* ================= desenho ================= */'));
  assert.doesNotMatch(runtime, /type:\s*['"]mob_snapshot['"]/, 'cliente ainda envia mob_snapshot');
  assert.match(runtime, /serverX/);
  assert.match(runtime, /1-Math\.exp\(-18\*/, 'interpolacao deve ser independente do FPS');
  assert.match(runtime, /netLockMobs\(dt\)/, 'interpolacao deve rodar no update com dt');
  assert.match(runtime, /MOB_NET_VISUAL_FIELDS/, 'cliente deve aplicar o estado visual autoritativo dos ataques');
});

test('dispatcher cobre os 13 tipos e todo deslocamento usa dt medido e limitado', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.slice(src.indexOf('const MOB_AI_STEP'), src.indexOf('setInterval(tickMobAI'));
  for (const type of ['slime','goblin','skeleton','wolf','bat','cinza','toxic','caster','sky','sala','elem','calc','lorde']) {
    assert.match(block, new RegExp('(?:^|[,{\\s])' + type + '\\s*:'), 'tipo ausente do dispatcher: ' + type);
  }
  assert.match(block, /performance\.now\(\)/);
  assert.match(block, /Math\.min\(\.2,/);
  assert.match(block, /Math\.ceil\(elapsed \/ \.05\)/);
  assert.doesNotMatch(src, /msg\.type === ['"]mob_snapshot['"]/, 'servidor ainda aceita posicao forjada do cliente');
  assert.match(block, /mobPositionPayload\(mob, moving\)/, 'broadcast deve incluir estado visual autoritativo');
});

test('broadcast sincroniza telegraph de ataque sem dar autoridade ao cliente', async () => {
  const c = await joinWs(srv, { name: 'Attack Visual', lvl: 20 });
  c.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: 460, y: 300, dir: 0, moving: false, lvl: 20 }));
  await sleep(60);
  c.ws.send(JSON.stringify({ type: 'map_join', map: 'floresta', mobs: Array.from({ length: 19 }, (_, i) => ({ id: 'attack-ai-' + i, x: 400 + (i % 10) * 120, y: 300 + Math.floor(i / 10) * 150 })) }));
  const telegraph = await waitFor(c.msgs, m => m.type === 'mob_positions' && m.mobs.some(x => x.state === 'wind' && Number.isFinite(x.t) && Number.isFinite(x.t0) && Number.isFinite(x.lx) && Number.isFinite(x.ly)), 5000);
  const mob = telegraph.mobs.find(x => x.state === 'wind' && Number.isFinite(x.t) && Number.isFinite(x.t0));
  assert.equal(typeof mob.moving, 'boolean');
  assert.ok(mob.t0 > 0 && mob.t <= mob.t0, 'temporizacao do telegraph invalida');
  await waitFor(c.msgs, m => m.type === 'mob_hit' && m.mobId === mob.id, 5000);
  c.close();
});

test('snapshot forjado pelo cliente nao altera a posicao autoritativa', async () => {
  const c = await joinWs(srv, { name: 'Forge', lvl: 12 });
  const st = await enterVila(c);
  const mob = st.mobs[0];
  const before = c.msgs.length;
  c.ws.send(JSON.stringify({ type: 'mob_snapshot', map: 'vila', mobs: [{ id: mob.id, x: 2800, y: 2000, state: 'dash' }] }));
  const pos = await waitFor(c.msgs, m => m.type === 'mob_positions' && m.mobs.some(x => x.id === mob.id), 3000, before);
  const current = pos.mobs.find(x => x.id === mob.id);
  assert.ok(Math.hypot(current.x - 2800, current.y - 2000) > 500, 'snapshot forjado moveu o monstro');
  c.close();
});

test('movimento produz apenas coordenadas finitas e nenhum salto absurdo por broadcast', async () => {
  const c = await joinWs(srv, { name: 'Delta', lvl: 12 });
  const st = await enterVila(c);
  const mob = st.mobs[1];
  c.ws.send(JSON.stringify({ type: 'state', map: 'vila', x: mob.x + 100, y: mob.y, dir: 0, moving: false, lvl: 12 }));
  const before = c.msgs.length;
  await sleep(1200);
  const samples = c.msgs.slice(before).filter(m => m.type === 'mob_positions').map(m => m.mobs.find(x => x.id === mob.id)).filter(Boolean);
  assert.ok(samples.length >= 4, 'amostras insuficientes da IA');
  for (const p of samples) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'IA publicou NaN/Infinity');
  for (let i = 1; i < samples.length; i++) assert.ok(Math.hypot(samples[i].x - samples[i-1].x, samples[i].y - samples[i-1].y) <= 40, 'salto excessivo em um broadcast');
  c.close();
});

test('dois jogadores recebem a mesma posicao autoritativa do mesmo monstro', async () => {
  const a = await joinWs(srv, { name: 'Sync A', lvl: 12 });
  const st = await enterVila(a);
  const b = await joinWs(srv, { name: 'Sync B', lvl: 12 });
  await enterVila(b, 1720, 500);
  const id = st.mobs[2].id, ai = a.msgs.length, bi = b.msgs.length;
  const [pa, pb] = await Promise.all([
    waitFor(a.msgs, m => m.type === 'mob_positions' && m.mobs.some(x => x.id === id), 3000, ai),
    waitFor(b.msgs, m => m.type === 'mob_positions' && m.mobs.some(x => x.id === id), 3000, bi),
  ]);
  assert.deepEqual(pa.mobs.find(x => x.id === id), pb.mobs.find(x => x.id === id));
  a.close(); b.close();
});

test('todos os 13 tipos nascem com x/y e sx/sy finitos', async () => {
  const c = await joinWs(srv, { name: 'Roster AI', lvl: 99 });
  const maps = { vila: 15, floresta: 19, cripta: 22, serra: 26, pantano: 30, torre: 26, ilhas: 40, vulcao: 33 };
  const types = new Set();
  for (const [map, count] of Object.entries(maps)) {
    c.ws.send(JSON.stringify({ type: 'state', map, x: 2800, y: 2000, dir: 0, moving: false, lvl: 99 }));
    await sleep(30);
    const before = c.msgs.length;
    const defs = Array.from({ length: count }, (_, i) => ({ id: map + '-ai-' + i, x: 400 + (i % 10) * 120, y: 300 + Math.floor(i / 10) * 150, lvl: 1 + (i % 3) }));
    c.ws.send(JSON.stringify({ type: 'map_join', map, mobs: defs }));
    const st = await waitFor(c.msgs, m => m.type === 'map_state' && m.map === map, 3000, before);
    for (const mob of st.mobs) {
      types.add(mob.type);
      for (const key of ['x','y','sx','sy']) assert.ok(Number.isFinite(mob[key]), map + '/' + mob.id + ' sem ' + key + ' valido');
    }
  }
  assert.deepEqual([...types].sort(), ['bat','calc','caster','cinza','elem','goblin','lorde','sala','skeleton','sky','slime','toxic','wolf']);
  c.close();
});

test('alvo desconectado e trocado sem paralisar a perseguicao', async () => {
  const a = await joinWs(srv, { name: 'Target A', lvl: 20 });
  const b = await joinWs(srv, { name: 'Target B', lvl: 20 });
  a.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: 520, y: 300, dir: 0, moving: false, lvl: 20 }));
  b.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: 300, y: 300, dir: 0, moving: false, lvl: 20 }));
  await sleep(60);
  a.ws.send(JSON.stringify({ type: 'map_join', map: 'floresta', mobs: Array.from({ length: 19 }, (_, i) => ({ id: 'floresta-ai-' + i, x: 400 + (i % 10) * 120, y: 300 + Math.floor(i / 10) * 150 })) }));
  const st = await waitFor(a.msgs, m => m.type === 'map_state' && m.map === 'floresta', 3000);
  b.ws.send(JSON.stringify({ type: 'map_join', map: 'floresta', mobs: [] }));
  const id = st.mobs[0].id;
  const first = await waitFor(b.msgs, m => m.type === 'mob_positions' && m.mobs.some(x => x.id === id && x.state === 'chase'), 3000);
  const xBefore = first.mobs.find(x => x.id === id).x;
  a.close();
  b.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: 300, y: 300, dir: 0, moving: false, lvl: 20 }));
  const start = b.msgs.length;
  await sleep(900);
  const samples = b.msgs.slice(start).filter(m => m.type === 'mob_positions').map(m => m.mobs.find(x => x.id === id)).filter(Boolean);
  assert.ok(samples.length >= 3, 'IA parou de publicar apos desconexao do alvo');
  assert.ok(samples.at(-1).x < xBefore, 'monstro nao trocou para o jogador restante');
  b.close();
});
