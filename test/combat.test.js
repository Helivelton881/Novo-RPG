'use strict';
// Fase 3: skill, cooldown/anti-spam, dano, alcance (server-autoritativo,
// Fase B/C1). So WebSocket, nao depende de Supabase -- roda sempre.
//
// Nota de isolamento: 'floresta' e um unico mapa persistente no servidor
// (o roster so e criado uma vez, na primeira vez que alguem entra) -- todos
// os testes deste arquivo compartilham o MESMO servidor (mesma porta) e
// portanto o MESMO estado de monstro entre testes. Cada teste que realmente
// causa dano usa um INDICE proprio e nunca usado por outro teste, senao um
// teste anterior pode ja ter deixado o monstro ferido/morto.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, joinWs, waitFor, sleep } = require('./helpers');

const PORT = 8105;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

async function joinFloresta(conn) {
  conn.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: 100, y: 100, dir: 0, moving: false, lvl: 99 }));
  await sleep(60);
  const defs = []; for (let i = 0; i < 19; i++) defs.push({ id: 'g' + i, x: i * 140, y: 100 });
  conn.ws.send(JSON.stringify({ type: 'map_join', map: 'floresta', mobs: defs }));
  const st = await waitFor(conn.msgs, m => m.type === 'map_state', 3000);
  return st.mobs;
}

test('alcance: golpe basico num monstro a mais de 550px e rejeitado (HP intacto)', async () => {
  const conn = await joinWs(srv, { lvl: 99 });
  const mobs = await joinFloresta(conn);
  const trash = mobs[0];
  const before = conn.msgs.length;
  conn.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: trash.x + 2000, y: trash.y, dir: 0, moving: false, lvl: 99 }));
  await sleep(60);
  conn.ws.send(JSON.stringify({ type: 'mob_damage', map: 'floresta', id: trash.id, skill: 'basic', atk: 35 }));
  await sleep(200);
  const st = conn.msgs.slice(before).find(m => m.type === 'mob_state' && m.mob.id === trash.id);
  assert.equal(st, undefined, 'servidor aceitou um golpe vindo de mais de 550px de distancia');
  conn.close();
});

test('alcance: golpe basico dentro do alcance reduz o HP do monstro', async () => {
  const conn = await joinWs(srv, { lvl: 99 });
  const mobs = await joinFloresta(conn);
  const trash = mobs[1];
  conn.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: trash.x + 20, y: trash.y, dir: 0, moving: false, lvl: 99 }));
  await sleep(60);
  const before = conn.msgs.length;
  conn.ws.send(JSON.stringify({ type: 'mob_damage', map: 'floresta', id: trash.id, skill: 'basic', atk: 35 }));
  const st = await waitFor(conn.msgs, m => m.type === 'mob_state' && m.mob.id === trash.id, 2000, before);
  assert.ok(st.mob.hp < trash.maxhp, 'HP do monstro nao diminuiu com um golpe dentro do alcance');
  conn.close();
});

test('anti-spam: dois golpes no mesmo par jogador/monstro em menos de 80ms -- so o primeiro conta', async () => {
  const conn = await joinWs(srv, { lvl: 99 });
  const mobs = await joinFloresta(conn);
  const trash = mobs[2];
  conn.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: trash.x + 20, y: trash.y, dir: 0, moving: false, lvl: 99 }));
  await sleep(60);
  const before = conn.msgs.length;
  conn.ws.send(JSON.stringify({ type: 'mob_damage', map: 'floresta', id: trash.id, skill: 'basic', atk: 35 }));
  conn.ws.send(JSON.stringify({ type: 'mob_damage', map: 'floresta', id: trash.id, skill: 'basic', atk: 35 })); // enviado quase junto, <80ms
  await sleep(300);
  const states = conn.msgs.slice(before).filter(m => m.type === 'mob_state' && m.mob.id === trash.id);
  assert.equal(states.length, 1, 'dois golpes em menos de 80ms deveriam contar como um so (veio ' + states.length + ')');
  conn.close();
});

test('skill: usar uma skill que nao pertence a classe do jogador nao concede dano', async () => {
  const conn = await joinWs(srv, { lvl: 99, cls: 'guerreiro' });
  const mobs = await joinFloresta(conn);
  const trash = mobs[3];
  conn.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: trash.x + 20, y: trash.y, dir: 0, moving: false, lvl: 99 }));
  await sleep(60);
  // 'fireball' e do mago, nao do guerreiro
  conn.ws.send(JSON.stringify({ type: 'cast_skill', map: 'floresta', id: 'fireball', sk: 3, atk: 35 }));
  await sleep(30);
  const before = conn.msgs.length;
  conn.ws.send(JSON.stringify({ type: 'mob_damage', map: 'floresta', id: trash.id, skill: 'fireball', atk: 35 }));
  await sleep(200);
  const st = conn.msgs.slice(before).find(m => m.type === 'mob_state' && m.mob.id === trash.id);
  assert.equal(st, undefined, 'dano foi aplicado usando uma skill que nao pertence a classe do jogador');
  conn.close();
});

test('skill: usar uma skill real da classe concede dano real (pendente calculado pelo servidor)', async () => {
  const conn = await joinWs(srv, { lvl: 99, cls: 'guerreiro' });
  const mobs = await joinFloresta(conn);
  const trash = mobs[4];
  conn.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: trash.x + 20, y: trash.y, dir: 0, moving: false, lvl: 99 }));
  await sleep(60);
  conn.ws.send(JSON.stringify({ type: 'cast_skill', map: 'floresta', id: 'spin', sk: 3, atk: 35 })); // spin e do guerreiro
  await sleep(30);
  const before = conn.msgs.length;
  conn.ws.send(JSON.stringify({ type: 'mob_damage', map: 'floresta', id: trash.id, skill: 'spin', atk: 35 }));
  const st = await waitFor(conn.msgs, m => m.type === 'mob_state' && m.mob.id === trash.id, 2000, before);
  assert.ok(st.mob.hp < trash.maxhp, 'skill valida da propria classe nao causou dano nenhum');
  conn.close();
});

test('skill: um golpe basico nunca alega dano maior que o teto plausivel do nivel', async () => {
  const conn = await joinWs(srv, { lvl: 99, cls: 'guerreiro' });
  const mobs = await joinFloresta(conn);
  const boss = mobs[18]; // chefe, hp alto (480), da pra observar sem matar
  conn.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: boss.x + 20, y: boss.y, dir: 0, moving: false, lvl: 99 }));
  await sleep(60);
  const before = conn.msgs.length;
  conn.ws.send(JSON.stringify({ type: 'mob_damage', map: 'floresta', id: boss.id, skill: 'basic', atk: 99999 })); // atk forjado, absurdo
  const st = await waitFor(conn.msgs, m => m.type === 'mob_state' && m.mob.id === boss.id, 2000, before);
  const dmg = boss.maxhp - st.mob.hp;
  assert.ok(dmg < boss.maxhp, 'um unico golpe basico derrubou o chefe inteiro com atk forjado absurdo');
  conn.close();
});
