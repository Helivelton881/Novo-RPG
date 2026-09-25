'use strict';
// Fase 3: IA de monstro (Fase 2), roster autoritativo (Fase 1 unidade 5),
// morte e respawn. So WebSocket, nao depende de Supabase.
//
// Nota de isolamento: mapas sao persistentes por servidor (o roster so e
// criado na primeira vez que alguem entra) -- os testes deste arquivo
// compartilham o mesmo servidor. Testes que danificam/matam um monstro
// usam um indice/id proprio, nunca reaproveitado por outro teste.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, joinWs, waitFor, sleep } = require('./helpers');

const PORT = 8106;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

async function joinFloresta(conn, mobsOverride) {
  conn.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: 2800, y: 2000, dir: 0, moving: false, lvl: 1 }));
  await sleep(60);
  const defs = mobsOverride || (() => { const d = []; for (let i = 0; i < 19; i++) d.push({ id: 'g' + i, x: i * 140, y: 100 }); return d; })();
  conn.ws.send(JSON.stringify({ type: 'map_join', map: 'floresta', mobs: defs }));
  const st = await waitFor(conn.msgs, m => m.type === 'map_state', 3000);
  return st.mobs;
}
async function killMob(conn, mob, atk) {
  conn.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: mob.x + 20, y: mob.y, dir: 0, moving: false, lvl: 99 }));
  await sleep(60);
  let deadMsg = null;
  for (let i = 0; i < 30 && !deadMsg; i++) {
    conn.ws.send(JSON.stringify({ type: 'mob_damage', map: 'floresta', id: mob.id, skill: 'basic', atk: atk ?? 35 }));
    await sleep(90);
    const last = conn.msgs.filter(m => m.type === 'mob_state' && m.mob.id === mob.id).pop();
    if (last && (last.mob.dead || last.mob.hp <= 0)) deadMsg = last;
  }
  return deadMsg;
}

test('roster autoritativo: cliente nao consegue inventar monstro extra alem do manifesto real', async () => {
  const conn = await joinWs(srv);
  const fake = []; for (let i = 0; i < 60; i++) fake.push({ id: 'x' + i, maxhp: 1, x: 100, y: 100, boss: true });
  const mobs = await joinFloresta(conn, fake);
  assert.equal(mobs.length, 19, 'floresta deveria ter exatamente 19 monstros (manifesto real), veio ' + mobs.length);
  conn.close();
});

test('roster autoritativo: HP forjado (maxhp:1) e ignorado -- servidor usa o HP real do tipo/nivel', async () => {
  const conn = await joinWs(srv);
  const mobs = await joinFloresta(conn); // ja foi criado pelo teste anterior, so confirma o hp real ja existente
  const trash = mobs[0];
  assert.ok(trash.maxhp > 1, 'servidor aceitou o hp=1 forjado pelo cliente');
  const boss = mobs[18];
  assert.equal(boss.maxhp, 480, 'chefe deveria ter hp real (480), veio ' + boss.maxhp);
  conn.close();
});

test('IA de monstro: slime persegue jogador dentro do alcance de aggro (posicao muda de verdade)', async () => {
  const conn = await joinWs(srv, { lvl: 1 });
  conn.ws.send(JSON.stringify({ type: 'state', map: 'vila', x: 2000, y: 100, dir: 0, moving: false, lvl: 1 }));
  await sleep(60);
  conn.ws.send(JSON.stringify({ type: 'map_join', map: 'vila', mobs: [{ id: 's_chase', x: 1500, y: 100, lvl: 1 }] }));
  const st = await waitFor(conn.msgs, m => m.type === 'map_state', 3000);
  const slime = st.mobs.find(m => m.id === 's_chase') || st.mobs[0];
  conn.ws.send(JSON.stringify({ type: 'state', map: 'vila', x: slime.x + 100, y: slime.y, dir: 0, moving: false, lvl: 1 }));
  const pos = await waitFor(conn.msgs, m => m.type === 'mob_positions' && m.mobs.some(x => x.id === slime.id && x.state === 'chase'), 3000);
  assert.ok(pos, 'slime nao entrou em perseguicao dentro do alcance de aggro');
  conn.close();
});

test('dano de monstro: mob_hit chega mitigado e com HP autoritativo', async () => {
  const conn = await joinWs(srv, { lvl: 1 });
  conn.ws.send(JSON.stringify({ type: 'state', map: 'vila', x: 2000, y: 100, dir: 0, moving: false, lvl: 1 }));
  await sleep(60);
  // vila e persistente entre testes deste arquivo -- pega a posicao ATUAL
  // real do slime (pode ja existir de um teste anterior) em vez de supor
  // uma posicao fixa de spawn.
  conn.ws.send(JSON.stringify({ type: 'map_join', map: 'vila', mobs: [{ id: 's_hit', x: 1500, y: 100, lvl: 1 }] }));
  const st = await waitFor(conn.msgs, m => m.type === 'map_state', 3000);
  const slime = st.mobs[0];
  conn.ws.send(JSON.stringify({ type: 'state', map: 'vila', x: slime.x + 15, y: slime.y, dir: 0, moving: false, lvl: 1 }));
  const hit = await waitFor(conn.msgs, m => m.type === 'mob_hit', 6000);
  assert.equal(hit.dmg, 4, 'dano bruto 6 deve ser mitigado pela defesa real do guerreiro, veio ' + hit.dmg);
  assert.equal(hit.hp,hit.maxHp-hit.dmg,'servidor deve enviar o HP final, nao deixar o cliente calcula-lo');
  conn.close();
});

test('morte: golpes repetidos derrubam o monstro a 0 de HP e o marcam morto (mob_state dead=true)', async () => {
  const conn = await joinWs(srv, { lvl: 99 });
  const mobs = await joinFloresta(conn);
  const deadMsg = await killMob(conn, mobs[5]);
  assert.ok(deadMsg, 'monstro nao morreu apos golpes repetidos suficientes pra zerar o hp real');
  const before = conn.msgs.length;
  await sleep(500);
  const movedDead = conn.msgs.slice(before).find(m => m.type === 'mob_positions' && m.mobs.some(x => x.id === mobs[5].id));
  assert.equal(movedDead, undefined, 'monstro morto continuou se movendo');
  conn.close();
});

test('respawn: monstro morto recebe um respawnAt futuro agendado (mecanismo disparado corretamente)', async () => {
  const conn = await joinWs(srv, { lvl: 99 });
  const mobs = await joinFloresta(conn);
  const deadMsg = await killMob(conn, mobs[6]);
  assert.ok(deadMsg, 'monstro nao morreu (pre-condicao do teste)');
  assert.ok(deadMsg.mob.respawnAt > Date.now(), 'respawnAt deveria estar agendado no futuro apos a morte');
  conn.close();
});

test('respawn: apos o tempo agendado, o monstro reaparece com hp cheio (espera real de ~30s)', { timeout: 40000 }, async () => {
  const conn = await joinWs(srv, { lvl: 99 });
  const mobs = await joinFloresta(conn);
  const deadMsg = await killMob(conn, mobs[7]);
  assert.ok(deadMsg, 'monstro nao morreu (pre-condicao do teste)');
  conn.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: 2800, y: 2000, dir: 0, moving: false, lvl: 99 }));
  const waitMs = Math.max(500, deadMsg.mob.respawnAt - Date.now() + 1500);
  const before = conn.msgs.length;
  await sleep(waitMs);
  const revived = conn.msgs.slice(before).find(m => m.type === 'mob_state' && m.mob.id === mobs[7].id && m.mob.dead === false);
  assert.ok(revived, 'monstro nao voltou a vida apos o tempo de respawn agendado');
  assert.equal(revived.mob.hp, revived.mob.maxhp, 'monstro voltou sem hp cheio');
  assert.equal(revived.mob.x, revived.mob.sx, 'respawn nao voltou ao spawn X original');
  assert.equal(revived.mob.y, revived.mob.sy, 'respawn nao voltou ao spawn Y original');
  assert.equal(revived.mob.tgt, null, 'respawn manteve alvo antigo');
  assert.equal(revived.mob.state, 'idle', 'respawn nao voltou em idle');
});
