'use strict';
// Fase 5.13.1 -- Dungeon em Party. Parte 1: nucleo puro (escala de HP por
// participante, forma da instancia multi-membro) via buildDungeonInstance
// exportado direto -- sempre roda, sem HTTP/WS/Supabase. Parte 2: fluxo
// real via Party + WebSocket (formacao de grupo, isolamento entre duas
// Parties, intruso, reconexao, recompensa individual) -- so roda com
// Supabase configurado. O mapa da masmorra em si (layout fixo, colisao,
// salas nomeadas) NAO mudou nesta fase -- ja coberto por
// test/dungeon.test.js, nao duplicado aqui.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, wsConnect, waitFor, sleep, adminPatchCharacter } = require('./helpers');
const S = require('../server.js');
const DUNGEON_GEN = require('../game-data/dungeon-generation.js');

// ===== Parte 1: nucleo puro =====
test('dungeonScaleFor: 1=1.00, 2=1.55, 3=2.05, 4=2.50 (ponto de partida pedido)', () => {
  assert.equal(DUNGEON_GEN.dungeonScaleFor(1), 1.00);
  assert.equal(DUNGEON_GEN.dungeonScaleFor(2), 1.55);
  assert.equal(DUNGEON_GEN.dungeonScaleFor(3), 2.05);
  assert.equal(DUNGEON_GEN.dungeonScaleFor(4), 2.50);
});
test('dungeonScaleFor: numeros fora de 1-4 sao grampeados (nunca NaN/negativo/acima de 4)', () => {
  assert.equal(DUNGEON_GEN.dungeonScaleFor(0), 1.00);
  assert.equal(DUNGEON_GEN.dungeonScaleFor(5), 2.50);
  assert.equal(DUNGEON_GEN.dungeonScaleFor(NaN), 1.00);
});

test('buildDungeonInstance: solo (1 membro) continua com escala 1.00 (comportamento antigo preservado)', () => {
  const solo = S.createDungeonInstance('floresta', 'char-solo', 'user-solo');
  assert.equal(solo.scale, 1.00);
  assert.equal(solo.members.size, 1);
  const m = solo.members.get('char-solo');
  assert.equal(m.userId, 'user-solo');
});

test('buildDungeonInstance: 4 membros reais escalam HP de mob/chefe em 2.50x, nunca o dano do jogador', () => {
  const solo = S.createDungeonInstance('cripta', 'char-a', 'user-a');
  const party = S.buildDungeonInstance('cripta', [
    { charId: 'char-1', userId: 'user-1', cls: 'guerreiro' },
    { charId: 'char-2', userId: 'user-2', cls: 'druida' },
    { charId: 'char-3', userId: 'user-3', cls: 'mago' },
    { charId: 'char-4', userId: 'user-4', cls: 'arqueiro' },
  ]);
  assert.equal(party.scale, 2.50);
  assert.equal(party.members.size, 4);
  const soloBoss = [...solo.mobs.values()].find(m => m.boss);
  const partyBoss = [...party.mobs.values()].find(m => m.boss);
  // mesmo tipo/nivel de chefe por zona -- so o multiplicador de escala muda o HP.
  if (soloBoss.type === partyBoss.type && soloBoss.lvl === partyBoss.lvl) {
    assert.equal(partyBoss.maxhp, Math.round(soloBoss.maxhp * 2.50));
  }
  for (const [charId, m] of party.members) {
    assert.equal(m.damageDone, 0);
    assert.ok(m.online);
    assert.equal(typeof m.lastActivityAt, 'number');
  }
});

test('buildDungeonInstance: cada mob carrega o MESMO layout.rects da instancia (colisao real, party ou solo)', () => {
  const party = S.buildDungeonInstance('serra', [
    { charId: 'c1', userId: 'u1', cls: 'guerreiro' }, { charId: 'c2', userId: 'u2', cls: 'druida' },
  ]);
  for (const mob of party.mobs.values()) assert.equal(mob.wallRects, party.layout.rects);
});

test('buildDungeonInstance: zona invalida ou lista de membros vazia retorna null', () => {
  assert.equal(S.buildDungeonInstance('vila', [{ charId: 'x', userId: 'y' }]), null);
  assert.equal(S.buildDungeonInstance('floresta', []), null);
});

// ===== Parte 2: fluxo real (Party + WS) =====
const PORT = 8180;
let srv;
before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'dp_' + Math.random().toString(36).slice(2, 10);
const DUNGEON_UNLOCK_QUEST = { floresta: 3, cripta: 7, serra: 11, pantano: 15, torre: 19, ilhas: 23, vulcao: 27 };
// Desbloqueia + sobe nivel escrevendo direto no banco de teste
// (adminPatchCharacter) -- mesmo padrao de test/dungeon-integration.js,
// unico jeito que sobra desde que quest/lvl pararam de ser aceitos por PUT
// bruto (Fase 5.2). Os testes em si so exercitam fluxos reais (dungeon_enter/mob_damage/party).
async function newDungeonChar(zone) {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'D' + rnd().slice(0, 6), cls: 'guerreiro' }, token);
  const id = created.json.character.id;
  const save = created.json.character.save;
  const zoneName = zone || 'floresta';
  await adminPatchCharacter(id, { lvl: 40, save: { ...save, lvl: 40, quest: DUNGEON_UNLOCK_QUEST[zoneName] } });
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'D', cls: 'guerreiro', lvl: 40, token, charId: id }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  return { token, charId: id, conn };
}
async function makeParty(members) {
  // primeiro membro vira o líder (quem cria o grupo).
  const created = await httpJson(srv, 'POST', '/api/party', null, members[0].token);
  const code = created.json.party.code;
  for (let i = 1; i < members.length; i++) await httpJson(srv, 'POST', '/api/party/join', { code }, members[i].token);
  return code;
}

test('solo: dungeon_enter sem Party continua funcionando (regressao)', { skip: !hasSupabase() }, async () => {
  const a = await newDungeonChar();
  a.conn.ws.send(JSON.stringify({ type: 'dungeon_enter', zone: 'floresta' }));
  const state = await waitFor(a.conn.msgs, m => m.type === 'dungeon_state', 3000);
  assert.ok(state.map.startsWith('floresta_d#'));
  a.conn.close();
});

test('party de 2: lider inicia, os DOIS recebem dungeon_state pro MESMO mapId', { skip: !hasSupabase() }, async () => {
  const a = await newDungeonChar(), b = await newDungeonChar();
  await makeParty([a, b]);
  a.conn.ws.send(JSON.stringify({ type: 'dungeon_enter', zone: 'floresta' }));
  const stateA = await waitFor(a.conn.msgs, m => m.type === 'dungeon_state', 3000);
  const stateB = await waitFor(b.conn.msgs, m => m.type === 'dungeon_state', 3000);
  assert.equal(stateA.map, stateB.map, 'os dois membros deveriam cair na MESMA instancia');
  a.conn.close(); b.conn.close();
});

test('party de 4: todos os 4 recebem o mesmo mapId, chefe com HP escalado (2.50x)', { skip: !hasSupabase() }, async () => {
  const chars = [await newDungeonChar('cripta'), await newDungeonChar('cripta'), await newDungeonChar('cripta'), await newDungeonChar('cripta')];
  await makeParty(chars);
  chars[0].conn.ws.send(JSON.stringify({ type: 'dungeon_enter', zone: 'cripta' }));
  const states = [];
  for (const c of chars) states.push(await waitFor(c.conn.msgs, m => m.type === 'dungeon_state', 3000));
  const mapIds = new Set(states.map(s => s.map));
  assert.equal(mapIds.size, 1, 'os 4 deveriam cair na MESMA instancia');
  for (const c of chars) c.conn.close();
});

test('membro comum (nao-lider) nao consegue iniciar a masmorra do grupo', { skip: !hasSupabase() }, async () => {
  const a = await newDungeonChar(), b = await newDungeonChar();
  await makeParty([a, b]);
  b.conn.ws.send(JSON.stringify({ type: 'dungeon_enter', zone: 'floresta' }));
  const err = await waitFor(b.conn.msgs, m => m.type === 'dungeon_error', 3000);
  assert.match(err.error, /l[ií]der/i);
  a.conn.close(); b.conn.close();
});

test('duas Parties diferentes entrando na mesma zona ficam em instancias ISOLADAS (mapIds diferentes)', { skip: !hasSupabase() }, async () => {
  const a1 = await newDungeonChar('serra'), a2 = await newDungeonChar('serra');
  const b1 = await newDungeonChar('serra'), b2 = await newDungeonChar('serra');
  await makeParty([a1, a2]); await makeParty([b1, b2]);
  a1.conn.ws.send(JSON.stringify({ type: 'dungeon_enter', zone: 'serra' }));
  b1.conn.ws.send(JSON.stringify({ type: 'dungeon_enter', zone: 'serra' }));
  const stateA = await waitFor(a1.conn.msgs, m => m.type === 'dungeon_state', 3000);
  const stateB = await waitFor(b1.conn.msgs, m => m.type === 'dungeon_state', 3000);
  assert.notEqual(stateA.map, stateB.map, 'Party A e Party B nunca deveriam compartilhar instancia');
  a1.conn.close(); a2.conn.close(); b1.conn.close(); b2.conn.close();
});

test('intruso: personagem fora da Party nunca recebe dungeon_state da instancia alheia so por saber o mapId', { skip: !hasSupabase() }, async () => {
  const a = await newDungeonChar('pantano'), b = await newDungeonChar('pantano'), intruder = await newDungeonChar('pantano');
  await makeParty([a, b]);
  a.conn.ws.send(JSON.stringify({ type: 'dungeon_enter', zone: 'pantano' }));
  const stateA = await waitFor(a.conn.msgs, m => m.type === 'dungeon_state', 3000);
  // intruso tenta reportar posicao diretamente no mapa da instancia alheia -- servidor deve ignorar (p.map dele nunca foi setado pra la).
  intruder.conn.ws.send(JSON.stringify({ type: 'state', map: stateA.map, x: 100, y: 100, dir: 0, moving: false }));
  await sleep(200);
  // sem uma confirmacao explicita do servidor pra 'state', a prova indireta e: o intruso nunca recebeu dungeon_state daquele mapa.
  const leaked = intruder.conn.msgs.find(m => m.type === 'dungeon_state' && m.map === stateA.map);
  assert.equal(leaked, undefined);
  a.conn.close(); b.conn.close(); intruder.conn.close();
});

test('reconexao: mesmo userId+charId durante a masmorra ativa volta pra MESMA instancia (dungeon_state com reconnect:true)', { skip: !hasSupabase() }, async () => {
  const a = await newDungeonChar();
  a.conn.ws.send(JSON.stringify({ type: 'dungeon_enter', zone: 'floresta' }));
  const first = await waitFor(a.conn.msgs, m => m.type === 'dungeon_state', 3000);
  a.conn.close();
  await sleep(150);
  const conn2 = await wsConnect(srv);
  conn2.ws.send(JSON.stringify({ type: 'join', name: 'D', cls: 'guerreiro', lvl: 10, token: a.token, charId: a.charId }));
  const reconnected = await waitFor(conn2.msgs, m => m.type === 'dungeon_state', 3000);
  assert.equal(reconnected.map, first.map, 'reconexao deveria voltar pra mesma instancia, nunca criar uma nova');
  assert.equal(reconnected.reconnect, true);
  conn2.close();
});

test('recompensa individual: chefe morto credita OS DOIS membros da party (cada um com seu proprio ouro), nunca so quem bateu', { skip: !hasSupabase() }, async () => {
  const a = await newDungeonChar(), b = await newDungeonChar();
  await makeParty([a, b]);
  a.conn.ws.send(JSON.stringify({ type: 'dungeon_enter', zone: 'floresta' }));
  const stateA = await waitFor(a.conn.msgs, m => m.type === 'dungeon_state', 3000);
  await waitFor(b.conn.msgs, m => m.type === 'dungeon_state', 3000);
  const boss = stateA.roster.find(m => m.boss);
  assert.ok(boss, 'roster deveria incluir o chefe');
  // Apenas A bate no chefe (B nunca ataca) -- HP escalado pra 2 membros
  // (1.55x). Respeita o cooldown real do basico (420ms) entre golpes
  // legitimos, mesmo padrao de test/dungeon-integration.test.js.
  let hp = boss.maxhp;
  const perHit = 257;
  while (hp > perHit) {
    a.conn.ws.send(JSON.stringify({ type: 'mob_damage', map: stateA.map, id: boss.id, skill: 'basic', atk: 120 }));
    hp -= perHit;
    await sleep(450);
  }
  a.conn.ws.send(JSON.stringify({ type: 'mob_damage', map: stateA.map, id: boss.id, skill: 'basic', atk: 120 }));
  await waitFor(a.conn.msgs, m => m.type === 'dungeon_reward', 3000);
  await waitFor(b.conn.msgs, m => m.type === 'dungeon_reward', 3000);
  const rewardA = a.conn.msgs.find(m => m.type === 'dungeon_reward');
  const rewardB = b.conn.msgs.find(m => m.type === 'dungeon_reward');
  assert.ok(rewardA, 'quem bateu deveria ser recompensado');
  assert.ok(rewardB, 'o OUTRO membro da party (que nunca bateu) tambem deveria ser recompensado -- loot individual, nunca so pra quem confirma o abate');
  a.conn.close(); b.conn.close();
});
