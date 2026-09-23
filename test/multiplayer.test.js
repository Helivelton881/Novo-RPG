'use strict';
// Fase 3: WebSocket, dois jogadores simultaneos, troca de mapa, PvP
// (bloqueado na vila, liberado fora dela). So WebSocket, nao depende de
// Supabase.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, joinWs, waitFor, sleep } = require('./helpers');

const PORT = 8107;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

test('dois jogadores: o segundo a entrar aparece pro primeiro (player_join)', async () => {
  const a = await joinWs(srv, { name: 'Jogador A' });
  const before = a.msgs.length;
  const b = await joinWs(srv, { name: 'Jogador B' });
  const join = await waitFor(a.msgs, m => m.type === 'player_join' && m.player.name === 'Jogador B', 2000, before);
  assert.ok(join, 'jogador A nao recebeu o player_join do jogador B');
  a.close(); b.close();
});

test('dois jogadores: movimento de um e visto pelo outro (state broadcast)', async () => {
  const a = await joinWs(srv, { name: 'A' });
  const b = await joinWs(srv, { name: 'B' });
  await sleep(100);
  const before = a.msgs.length;
  b.ws.send(JSON.stringify({ type: 'state', map: 'vila', x: 777, y: 888, dir: 1, moving: true, lvl: 1 }));
  const st = await waitFor(a.msgs, m => m.type === 'state' && m.player.x === 777 && m.player.y === 888, 2000, before);
  assert.ok(st, 'jogador A nao recebeu a atualizacao de posicao do jogador B');
  a.close(); b.close();
});

test('desconexao: o outro jogador recebe player_leave', async () => {
  const a = await joinWs(srv, { name: 'A' });
  const b = await joinWs(srv, { name: 'B' });
  await sleep(100);
  const before = a.msgs.length;
  const bId = a.msgs.find(m => m.type === 'player_join')?.player?.id;
  b.close();
  const leave = await waitFor(a.msgs, m => m.type === 'player_leave', 2000, before);
  assert.ok(leave, 'jogador A nao recebeu player_leave apos o jogador B desconectar');
  a.close();
});

test('troca de mapa: monstros de um mapa nao vazam pra quem esta em outro mapa', async () => {
  const a = await joinWs(srv, { name: 'A' }); // fica na vila
  a.ws.send(JSON.stringify({ type: 'state', map: 'vila', x: 100, y: 100, dir: 0, moving: false, lvl: 1 }));
  await sleep(60);
  a.ws.send(JSON.stringify({ type: 'map_join', map: 'vila', mobs: [{ id: 's0', x: 1500, y: 100, lvl: 1 }] }));
  await waitFor(a.msgs, m => m.type === 'map_state', 2000);

  const b = await joinWs(srv, { name: 'B' }); // vai pra floresta
  b.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: 100, y: 100, dir: 0, moving: false, lvl: 1 }));
  await sleep(60);
  const before = a.msgs.length;
  b.ws.send(JSON.stringify({ type: 'map_join', map: 'floresta', mobs: [] }));
  await sleep(400);
  const leaked = a.msgs.slice(before).find(m => m.type === 'mob_positions' && m.map === 'floresta');
  assert.equal(leaked, undefined, 'jogador A (na vila) recebeu mob_positions do mapa floresta');
  a.close(); b.close();
});

test('PvP: bloqueado dentro da vila (nenhum player_hit chega)', async () => {
  const a = await joinWs(srv, { name: 'A' });
  const b = await joinWs(srv, { name: 'B' });
  a.ws.send(JSON.stringify({ type: 'state', map: 'vila', x: 100, y: 100, dir: 0, moving: false, lvl: 1 }));
  await sleep(60);
  const bId = a.msgs.find(m => m.type === 'player_join')?.player?.id;
  b.ws.send(JSON.stringify({ type: 'state', map: 'vila', x: 100, y: 100, dir: 0, moving: false, lvl: 1 }));
  await sleep(100);
  const before = b.msgs.length;
  a.ws.send(JSON.stringify({ type: 'player_damage', map: 'vila', targetId: bId, skill: 'basic', atk: 35 }));
  await sleep(300);
  const hit = b.msgs.slice(before).find(m => m.type === 'player_hit');
  assert.equal(hit, undefined, 'PvP aconteceu dentro da vila, deveria ser bloqueado');
  a.close(); b.close();
});

test('PvP: liberado fora da vila (player_hit chega com dano real)', async () => {
  const a = await joinWs(srv, { name: 'A', lvl: 99 });
  const b = await joinWs(srv, { name: 'B', lvl: 1 });
  a.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: 100, y: 100, dir: 0, moving: false, lvl: 99 }));
  await sleep(60);
  const bId = a.msgs.find(m => m.type === 'player_join')?.player?.id;
  b.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: 100, y: 100, dir: 0, moving: false, lvl: 1 }));
  await sleep(100);
  const before = b.msgs.length;
  a.ws.send(JSON.stringify({ type: 'player_damage', map: 'floresta', targetId: bId, skill: 'basic', atk: 35 }));
  const hit = await waitFor(b.msgs, m => m.type === 'player_hit', 2000, before);
  assert.ok(hit, 'PvP nao aconteceu fora da vila, deveria ser liberado');
  assert.ok(hit.dmg > 0, 'dano de PvP veio zero ou negativo');
  a.close(); b.close();
});

test('PvP: jogador nao consegue se auto-atacar', async () => {
  const a = await joinWs(srv, { name: 'A', lvl: 99 });
  a.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: 100, y: 100, dir: 0, moving: false, lvl: 99 }));
  await sleep(60);
  const before = a.msgs.length;
  a.ws.send(JSON.stringify({ type: 'player_damage', map: 'floresta', targetId: a.msgs.find(m => m.type === 'welcome')?.id, skill: 'basic', atk: 35 }));
  await sleep(200);
  const hit = a.msgs.slice(before).find(m => m.type === 'player_hit');
  assert.equal(hit, undefined, 'jogador conseguiu se auto-atacar via PvP');
  a.close();
});
