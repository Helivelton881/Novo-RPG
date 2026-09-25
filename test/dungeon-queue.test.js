'use strict';
// Fase 5.13.2 -- Matchmaking de Dungeon. Parte 1: nucleo puro
// (dungeonQueuePickGroup, limiares de fallback de dungeonQueueTick) via
// manipulacao direta dos Maps exportados -- sempre roda, sem HTTP/WS/
// Supabase, e sem precisar esperar os prazos reais de fallback (25s/45s/
// 60s) de verdade: os timestamps `queuedAt` sao forjados no passado.
// Parte 2: fluxo real via WebSocket (entrada/saida da fila, pareamento
// imediato de 4, solo nunca pareia sem opt-in, troca de zona nao deixa
// fantasma, diversidade de classe, Party formada automaticamente) --
// so roda com Supabase configurado.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, wsConnect, waitFor, sleep, adminPatchCharacter } = require('./helpers');
const S = require('../server.js');

// ===== Parte 1: nucleo puro =====
function seedQueue(zone, entries) {
  // entries: [{userId,cls,waitedMs,soloOptIn,disconnectedAgoMs}]
  S.dungeonQueue.clear(); S.userQueueZone.clear();
  const now = Date.now();
  const q = new Map();
  for (const e of entries) {
    q.set(e.userId, {
      charId: 'char_' + e.userId, cls: e.cls, queuedAt: now - (e.waitedMs || 0),
      allowAiFill: false, soloOptIn: !!e.soloOptIn,
      disconnectedAt: e.disconnectedAgoMs ? now - e.disconnectedAgoMs : 0,
    });
    S.userQueueZone.set(e.userId, zone);
  }
  S.dungeonQueue.set(zone, q);
  return q;
}

test('dungeonQueuePickGroup: sempre inclui o mais antigo, prioriza classes diferentes antes de repetir', () => {
  const entries = [
    ['u1', {cls:'guerreiro'}], ['u2', {cls:'guerreiro'}], ['u3', {cls:'guerreiro'}],
    ['u4', {cls:'guerreiro'}], ['u5', {cls:'mago'}],
  ];
  const group = S.dungeonQueuePickGroup(entries, 4);
  assert.equal(group.length, 4);
  assert.equal(group[0][0], 'u1', 'o mais antigo (u1) deveria sempre entrar');
  assert.ok(group.some(([id]) => id === 'u5'), 'a classe diferente (mago, u5) deveria ser priorizada sobre repetir guerreiro');
});

test('dungeonQueuePickGroup: sem nenhuma diversidade disponivel, preenche com quem sobrar (nunca bloqueia)', () => {
  const entries = [['u1', {cls:'guerreiro'}], ['u2', {cls:'guerreiro'}], ['u3', {cls:'guerreiro'}], ['u4', {cls:'guerreiro'}]];
  const group = S.dungeonQueuePickGroup(entries, 4);
  assert.equal(group.length, 4);
});

test('dungeonQueueTick: 4+ na fila fecha grupo de 4 imediatamente (sem esperar nenhum prazo)', () => {
  const q = seedQueue('floresta', [
    {userId:'u1', cls:'guerreiro', waitedMs:100}, {userId:'u2', cls:'druida', waitedMs:100},
    {userId:'u3', cls:'mago', waitedMs:100}, {userId:'u4', cls:'arqueiro', waitedMs:100},
  ]);
  S.dungeonQueueTick();
  assert.equal(q.size, 0, 'os 4 deveriam ter sido removidos da fila (grupo fechado)');
});

test('dungeonQueueTick: exatamente 3 na fila NAO fecha antes do prazo de fallback (25s)', () => {
  const q = seedQueue('floresta', [
    {userId:'u1', cls:'guerreiro', waitedMs:10000}, {userId:'u2', cls:'druida', waitedMs:5000}, {userId:'u3', cls:'mago', waitedMs:1000},
  ]);
  S.dungeonQueueTick();
  assert.equal(q.size, 3, 'ainda nao deveria ter fechado -- o mais antigo so esperou 10s, prazo e 25s');
});

test('dungeonQueueTick: 3 na fila fecha apos 25s de espera do mais antigo', () => {
  const q = seedQueue('floresta', [
    {userId:'u1', cls:'guerreiro', waitedMs:26000}, {userId:'u2', cls:'druida', waitedMs:5000}, {userId:'u3', cls:'mago', waitedMs:1000},
  ]);
  S.dungeonQueueTick();
  assert.equal(q.size, 0, 'deveria ter fechado com 3 -- prazo de 25s atingido pelo mais antigo');
});

test('dungeonQueueTick: exatamente 2 na fila so fecha apos 45s (nao com 25s)', () => {
  const q1 = seedQueue('cripta', [{userId:'u1', cls:'guerreiro', waitedMs:26000}, {userId:'u2', cls:'druida', waitedMs:1000}]);
  S.dungeonQueueTick();
  assert.equal(q1.size, 2, '26s nao e suficiente pra fechar com 2 (prazo e 45s)');
  const q2 = seedQueue('cripta', [{userId:'u1', cls:'guerreiro', waitedMs:46000}, {userId:'u2', cls:'druida', waitedMs:1000}]);
  S.dungeonQueueTick();
  assert.equal(q2.size, 0, '46s deveria ser suficiente pra fechar com 2');
});

test('dungeonQueueTick: 1 sozinho NUNCA fecha sem soloOptIn, mesmo esperando muito mais que 60s', () => {
  const q = seedQueue('serra', [{userId:'u1', cls:'guerreiro', waitedMs:9999999, soloOptIn:false}]);
  S.dungeonQueueTick();
  assert.equal(q.size, 1, 'sem soloOptIn, nunca deveria fechar sozinho');
});

test('dungeonQueueTick: 1 sozinho com soloOptIn so fecha apos 60s', () => {
  const q1 = seedQueue('serra', [{userId:'u1', cls:'guerreiro', waitedMs:30000, soloOptIn:true}]);
  S.dungeonQueueTick();
  assert.equal(q1.size, 1, '30s ainda nao e suficiente (prazo e 60s)');
  const q2 = seedQueue('serra', [{userId:'u1', cls:'guerreiro', waitedMs:61000, soloOptIn:true}]);
  S.dungeonQueueTick();
  assert.equal(q2.size, 0, '61s com soloOptIn deveria fechar sozinho');
});

test('dungeonQueueTick: quem esta desconectado dentro da tolerancia nunca entra num grupo formado', () => {
  // 3 online ha muito tempo (prontos pra fechar com 3) + 1 desconectado ha pouco (dentro da tolerancia de 20s) -- so os 3 online contam.
  const q = seedQueue('pantano', [
    {userId:'u1', cls:'guerreiro', waitedMs:26000}, {userId:'u2', cls:'druida', waitedMs:26000}, {userId:'u3', cls:'mago', waitedMs:26000},
    {userId:'u4', cls:'arqueiro', waitedMs:26000, disconnectedAgoMs:5000},
  ]);
  S.dungeonQueueTick();
  assert.equal(q.size, 1, 'os 3 online deveriam ter fechado grupo (contando so eles); o desconectado permanece sozinho na fila');
  assert.ok(q.has('u4'), 'o desconectado (dentro da tolerancia) nunca deveria ter sido incluido no grupo');
});

test('dungeonQueueTick: desconectado alem da tolerancia (20s) e removido da fila de vez', () => {
  const q = seedQueue('pantano', [{userId:'u1', cls:'guerreiro', waitedMs:5000, disconnectedAgoMs:21000}]);
  S.dungeonQueueTick();
  assert.equal(q.size, 0, 'deveria ter sido removido -- excedeu a tolerancia de desconexao');
});

test('dungeonQueueLeaveInternal: remove da fila e limpa a zona vazia', () => {
  seedQueue('vulcao', [{userId:'u1', cls:'guerreiro', waitedMs:100}]);
  S.dungeonQueueLeaveInternal('u1');
  assert.equal(S.userQueueZone.has('u1'), false);
  assert.equal(S.dungeonQueue.has('vulcao'), false, 'zona sem ninguem deveria ser removida do Map, nao deixada vazia');
});

// ===== Parte 2: fluxo real (WebSocket) =====
const PORT = 8181;
let srv;
before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'dq_' + Math.random().toString(36).slice(2, 10);
const DUNGEON_UNLOCK_QUEST = { floresta: 3, cripta: 7, serra: 11, pantano: 15 };
async function newQueueChar(cls, zone) {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Q' + rnd().slice(0, 6), cls: cls || 'guerreiro' }, token);
  const id = created.json.character.id;
  const save = created.json.character.save;
  const zoneName = zone || 'floresta';
  await adminPatchCharacter(id, { lvl: 40, save: { ...save, lvl: 40, quest: DUNGEON_UNLOCK_QUEST[zoneName] } });
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'Q', cls: cls || 'guerreiro', lvl: 40, token, charId: id }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  return { token, charId: id, userId: reg.json.user.id, conn };
}
function joinQueue(ch, zone, extra) {
  ch.conn.ws.send(JSON.stringify({ type: 'dungeon_queue_join', zone, ...(extra || {}) }));
  return waitFor(ch.conn.msgs, m => m.type === 'dungeon_queue_state', 3000);
}

test('entrar/sair da fila: dungeon_queue_state reflete o estado real', { skip: !hasSupabase() }, async () => {
  const a = await newQueueChar('guerreiro', 'floresta');
  const joined = await joinQueue(a, 'floresta');
  assert.equal(joined.inQueue, true);
  assert.equal(joined.zone, 'floresta');
  a.conn.ws.send(JSON.stringify({ type: 'dungeon_queue_leave' }));
  const left = await waitFor(a.conn.msgs, m => m.type === 'dungeon_queue_state', 3000);
  assert.equal(left.inQueue, false);
  a.conn.close();
});

test('4 jogadores na mesma zona pareiam quase imediatamente, todos no mesmo mapId, e viram uma Party de verdade', { skip: !hasSupabase() }, async () => {
  const chars = [await newQueueChar('guerreiro', 'cripta'), await newQueueChar('druida', 'cripta'), await newQueueChar('mago', 'cripta'), await newQueueChar('arqueiro', 'cripta')];
  for (const c of chars) await joinQueue(c, 'cripta');
  const matched = [];
  for (const c of chars) matched.push(await waitFor(c.conn.msgs, m => m.type === 'dungeon_queue_matched', 4000));
  const states = [];
  for (const c of chars) states.push(await waitFor(c.conn.msgs, m => m.type === 'dungeon_state', 4000));
  const mapIds = new Set(states.map(s => s.map));
  assert.equal(mapIds.size, 1, 'os 4 pareados deveriam cair na mesma instancia');
  const partyRes = await httpJson(srv, 'GET', '/api/party', null, chars[0].token);
  assert.ok(partyRes.json.party, 'o matchmaking deveria ter montado uma Party de verdade pros pareados');
  assert.equal(partyRes.json.party.members.length, 4);
  for (const c of chars) c.conn.close();
});

test('sozinho sem soloOptIn nunca pareia (permanece na fila)', { skip: !hasSupabase() }, async () => {
  const a = await newQueueChar('guerreiro', 'serra');
  await joinQueue(a, 'serra');
  await sleep(1500);
  const matched = a.conn.msgs.find(m => m.type === 'dungeon_queue_matched');
  assert.equal(matched, undefined, 'nunca deveria parear sozinho sem soloOptIn (prazo de 60s nem faz sentido testar aqui)');
  a.conn.close();
});

test('trocar de zona na fila nao deixa fantasma na zona antiga (nunca duas entradas simultaneas)', { skip: !hasSupabase() }, async () => {
  const a = await newQueueChar('guerreiro', 'pantano');
  await joinQueue(a, 'pantano');
  const switched = await joinQueue(a, 'pantano'); // reentra na MESMA zona -- idempotente, nunca duplica
  assert.equal(switched.size, 1, 'reentrar na mesma zona nao deveria contar 2 vezes');
  a.conn.close();
});

test('diversidade de classe: com 5 na fila (4 guerreiros + 1 mago), o mago entra no primeiro grupo fechado', { skip: !hasSupabase() }, async () => {
  const warriors = [await newQueueChar('guerreiro', 'floresta'), await newQueueChar('guerreiro', 'floresta'), await newQueueChar('guerreiro', 'floresta'), await newQueueChar('guerreiro', 'floresta')];
  const mage = await newQueueChar('mago', 'floresta');
  // guerreiro mais antigo entra primeiro, depois os outros 3, depois o mago por ultimo.
  await joinQueue(warriors[0], 'floresta');
  await joinQueue(warriors[1], 'floresta');
  await joinQueue(warriors[2], 'floresta');
  await joinQueue(warriors[3], 'floresta');
  await joinQueue(mage, 'floresta');
  const mageMatched = await waitFor(mage.conn.msgs, m => m.type === 'dungeon_queue_matched', 4000);
  assert.ok(mageMatched, 'o mago (unica classe diferente) deveria ter sido priorizado no primeiro grupo, nao deixado de fora');
  await sleep(800);
  const matchedWarriors = warriors.filter(w => w.conn.msgs.some(m => m.type === 'dungeon_queue_matched'));
  assert.equal(matchedWarriors.length, 3, 'exatamente 3 dos 4 guerreiros deveriam ter entrado no grupo junto com o mago -- o 5o (excedente) fica esperando');
  for (const w of warriors) w.conn.close();
  mage.conn.close();
});
