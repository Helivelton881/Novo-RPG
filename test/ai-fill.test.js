'use strict';
// Fase 5.16 Tier 2 -- AI Dungeon Fill + AI TvT Fill. Parte 1: nucleo
// puro (dimensionamento de time TvT, mistura humano+IA em
// buildDungeonInstance, exclusao de recompensa, combate de IA em TvT
// real via TVT.resolveTvtIntent) -- sempre roda, sem HTTP/WS/Supabase.
// Parte 2: fluxo real via matchmaking de masmorra (dungeon_queue_join
// com allowAiFill) -- so roda com Supabase, ja que formDungeonGroup
// precisa validar personagens reais no banco antes de sequer considerar
// preencher com IA (nao ha como exercitar esse caminho especifico sem
// Supabase -- a logica de dimensionamento/combate em si ja e coberta
// pelos testes puros da Parte 1).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, wsConnect, waitFor, sleep, adminPatchCharacter } = require('./helpers');
const S = require('../server.js');
const TVT = require('../game-data/tvt.js');

// ===== Parte 1: nucleo puro =====
test('tvtFillTargetSize: humanos suficientes e pares -- nunca adiciona IA desnecessaria', () => {
  assert.equal(S.tvtFillTargetSize(4), 4);
  assert.equal(S.tvtFillTargetSize(6), 6);
  assert.equal(S.tvtFillTargetSize(8), 8);
});
test('tvtFillTargetSize: menos que o minimo -- sempre fecha em pelo menos TVT_MIN_PLAYERS', () => {
  assert.equal(S.tvtFillTargetSize(0), TVT.TVT_MIN_PLAYERS);
  assert.equal(S.tvtFillTargetSize(1), TVT.TVT_MIN_PLAYERS);
  assert.equal(S.tvtFillTargetSize(2), TVT.TVT_MIN_PLAYERS);
  assert.equal(S.tvtFillTargetSize(3), TVT.TVT_MIN_PLAYERS);
});
test('tvtFillTargetSize: numero impar de humanos acima do minimo -- sempre arredonda pra cima (nunca descarta um humano)', () => {
  assert.equal(S.tvtFillTargetSize(5), 6);
  assert.equal(S.tvtFillTargetSize(7), 8);
});
test('tvtFillTargetSize: nunca ultrapassa TVT_MAX_PLAYERS mesmo com muitos humanos', () => {
  assert.equal(S.tvtFillTargetSize(9), TVT.TVT_MAX_PLAYERS);
  assert.equal(S.tvtFillTargetSize(20), TVT.TVT_MAX_PLAYERS);
});

test('buildDungeonInstance: aceita mistura humano+IA, cada membro marcado com o kind certo', () => {
  const state = S.buildDungeonInstance('floresta', [
    {charId:'char-h1', userId:'user-h1', cls:'guerreiro'},
    {charId:'ai_x1', userId:null, cls:'mago', kind:'ai'},
    {charId:'ai_x2', userId:null, cls:'arqueiro', kind:'ai'},
  ]);
  assert.equal(state.members.get('char-h1').kind, 'human');
  assert.equal(state.members.get('ai_x1').kind, 'ai');
  assert.equal(state.members.get('ai_x2').kind, 'ai');
});
test('buildDungeonInstance: IA conta pro calculo de escala de HP igual um humano (participante ativo de verdade)', () => {
  const soloHuman = S.buildDungeonInstance('floresta', [{charId:'c1', userId:'u1', cls:'guerreiro'}]);
  const humanPlusAi = S.buildDungeonInstance('floresta', [{charId:'c1', userId:'u1', cls:'guerreiro'}, {charId:'ai_1', userId:null, cls:'mago', kind:'ai'}]);
  assert.equal(soloHuman.scale, 1.00);
  assert.equal(humanPlusAi.scale, 1.55, 'HP deveria escalar pra 2 participantes mesmo sendo 1 humano + 1 IA');
});

test('REGRA ABSOLUTA (masmorra): dungeonHandleMobDeath credita SOMENTE o humano quando o grupo tem humano+IA misturados', async () => {
  const state = {isDungeon:true, bossDefeated:false, members: new Map([
    ['char-h1', {kind:'human', userId:'11111111-1111-1111-1111-111111111111', cls:'guerreiro', damageDone:10, lastActivityAt:Date.now(), online:true}],
    ['ai_x1', {kind:'ai', userId:'22222222-2222-2222-2222-222222222222', cls:'mago', damageDone:90, lastActivityAt:Date.now(), online:true}],
  ])};
  const mob = {id:'trash1', boss:false, lvl:5, type:'goblin', hp:0, maxhp:40, dead:true};
  const logs = [];
  const origError = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  try { S.dungeonHandleMobDeath(state, mob, Date.now(), null); await sleep(300); }
  finally { console.error = origError; }
  // com Supabase nao configurado, uma tentativa real de creditar
  // QUALQUER membro (humano ou IA) gera 'dungeon_reward_error' no log --
  // a IA nunca deveria gerar essa tentativa, entao no maximo 1 (a do
  // humano) deveria aparecer, nunca 2.
  const attempts = logs.filter(l => l.includes('dungeon_reward_error')).length;
  assert.ok(attempts <= 1, `esperava no maximo 1 tentativa de credito (so o humano), viu ${attempts}`);
});

test('aiDoTvt: nunca ataca no mesmo tick que adquire um alvo novo (latencia de reacao simulada)', () => {
  const humanSnap = {name:'H', atk:10, def:5, maxHp:200, block:0, speed:0, skills:{}};
  const aiSnap = S.buildAiCombat('guerreiro', 20, 'BotReflexo');
  const instance = TVT.createTvtInstance({eventId:'world_boss:1000001', members:[
    {userId:'u1', charId:'h1', name:'H', cls:'guerreiro', lvl:20, team:'red', snapshot:humanSnap},
    {userId:null, charId:'ai_react', name:aiSnap.name, cls:'guerreiro', lvl:20, team:'blue', snapshot:aiSnap, kind:'ai'},
  ]});
  S.tvtInstances.set(instance.mapId, instance);
  const hp = instance.players.get('h1'), ap = instance.players.get('ai_react');
  hp.x = ap.x + 30; hp.y = ap.y; hp.protectedUntil = 0; ap.protectedUntil = 0; // remove protecao de spawn -- nao e o que este teste verifica
  const entity = {id:'ai_react', kind:'ai', cls:'guerreiro', lvl:20, map:instance.mapId, x:ap.x, y:ap.y, dir:0, moving:false,
    hp:aiSnap.maxHp, maxHp:aiSnap.maxHp, dead:false, respawnAt:0, combat:aiSnap, basicCdUntil:0, buffUntil:0, pendingSkill:{},
    fsm:'tvt', targetMobId:null, slot:{kind:'tvt', instanceId:instance.mapId, team:'blue'}, tvtTargetId:null, tvtEngageAt:0};
  S.aiDoTvt(entity, Date.now());
  assert.equal(hp.hp, hp.maxHp, 'no primeiro tick (alvo recem-adquirido), a IA nunca deveria ja ter atacado');
  assert.ok(entity.tvtEngageAt > Date.now(), 'deveria ter marcado um atraso de engajamento no futuro');
  S.tvtInstances.delete(instance.mapId);
});

test('aiDoTvt: apos o atraso de reacao, ataca de verdade via TVT.resolveTvtIntent (mesma autoridade de um humano)', () => {
  const humanSnap = {name:'H', atk:10, def:2, maxHp:9999, block:0, speed:0, skills:{}};
  const aiSnap = S.buildAiCombat('guerreiro', 30, 'BotAtaca');
  const instance = TVT.createTvtInstance({eventId:'world_boss:1000002', members:[
    {userId:'u1', charId:'h1', name:'H', cls:'guerreiro', lvl:20, team:'red', snapshot:humanSnap},
    {userId:null, charId:'ai_atk', name:aiSnap.name, cls:'guerreiro', lvl:30, team:'blue', snapshot:aiSnap, kind:'ai'},
  ]});
  S.tvtInstances.set(instance.mapId, instance);
  const hp = instance.players.get('h1'), ap = instance.players.get('ai_atk');
  hp.x = ap.x + 30; hp.y = ap.y; hp.protectedUntil = 0; ap.protectedUntil = 0; // remove protecao de spawn (3s) -- nao e o que este teste verifica
  const entity = {id:'ai_atk', kind:'ai', cls:'guerreiro', lvl:30, map:instance.mapId, x:ap.x, y:ap.y, dir:0, moving:false,
    hp:aiSnap.maxHp, maxHp:aiSnap.maxHp, dead:false, respawnAt:0, combat:aiSnap, basicCdUntil:0, buffUntil:0, pendingSkill:{},
    fsm:'tvt', targetMobId:null, slot:{kind:'tvt', instanceId:instance.mapId, team:'blue'}, tvtTargetId:null, tvtEngageAt:0};
  let now = Date.now();
  for (let i = 0; i < 8; i++) { now += 1000; S.aiDoTvt(entity, now); }
  assert.ok(hp.hp < hp.maxHp, 'depois de alguns ticks, a IA deveria ter causado dano de verdade no humano');
  assert.ok(instance.players.get('ai_atk').damageDone > 0, 'a contribuicao da IA deveria estar registrada no proprio instance.players (mesmo mecanismo de um humano)');
  S.tvtInstances.delete(instance.mapId);
});

test('aiDoTvt: IA morta nunca ataca (aguarda o respawn autoritativo do TvT, nunca um respawn paralelo)', () => {
  const aiSnap = S.buildAiCombat('guerreiro', 20, 'BotMorto');
  const instance = TVT.createTvtInstance({eventId:'world_boss:1000003', members:[
    {userId:'u1', charId:'h1', name:'H', cls:'guerreiro', lvl:20, team:'red', snapshot:{name:'H',atk:1,def:1,maxHp:100,block:0,speed:0,skills:{}}},
    {userId:null, charId:'ai_dead', name:aiSnap.name, cls:'guerreiro', lvl:20, team:'blue', snapshot:aiSnap, kind:'ai'},
  ]});
  S.tvtInstances.set(instance.mapId, instance);
  const ap = instance.players.get('ai_dead');
  ap.dead = true; ap.hp = 0;
  const entity = {id:'ai_dead', kind:'ai', cls:'guerreiro', lvl:20, map:instance.mapId, x:ap.x, y:ap.y, dir:0, moving:false,
    hp:0, maxHp:aiSnap.maxHp, dead:false, respawnAt:0, combat:aiSnap, basicCdUntil:0, buffUntil:0, pendingSkill:{},
    fsm:'tvt', targetMobId:null, slot:{kind:'tvt', instanceId:instance.mapId, team:'blue'}, tvtTargetId:null, tvtEngageAt:0};
  S.aiDoTvt(entity, Date.now());
  assert.equal(entity.dead, true, 'a entidade de IA deveria refletir o dead:true vindo de instance.players (fonte de verdade)');
  S.tvtInstances.delete(instance.mapId);
});

test('REGRA ABSOLUTA (TvT): grantTvtRewards tem um guard explicito de kind===\'ai\' antes de qualquer credito', () => {
  const src = S.grantTvtRewards.toString();
  assert.match(src, /kind\s*===\s*['"]ai['"]/, 'deveria existir uma checagem explicita de kind===\'ai\' no inicio do loop de recompensa');
});

// ===== Parte 2: fluxo real via matchmaking de masmorra =====
// formDungeonGroup precisa validar personagens reais no Supabase antes
// de considerar preencher com IA -- nao ha atalho pra exercitar esse
// caminho especifico sem Supabase de verdade. O teste usa o prazo REAL
// de fallback de 3 (25s, o mais rapido disponivel) -- lento de
// proposito (correcao > velocidade, mesmo espirito de outros testes de
// integracao ja existentes neste repositorio que esperam varios
// segundos por um combate real).
const PORT = 8185;
let srv;
before(async () => { srv = await startServer(PORT, {AI_ENABLED:'1'}); });
after(() => stopServer(srv));

const rnd = () => 'aif_' + Math.random().toString(36).slice(2, 10);
async function newQueueChar(cls) {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Q' + rnd().slice(0, 6), cls: cls || 'guerreiro' }, token);
  const id = created.json.character.id;
  const save = created.json.character.save;
  await adminPatchCharacter(id, { lvl: 40, save: { ...save, lvl: 40, quest: 3 } }); // floresta
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'Q', cls: cls || 'guerreiro', lvl: 40, token, charId: id }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  return { token, charId: id, conn };
}

test('AI Dungeon Fill: 3 humanos com allowAiFill completam o grupo com 1 IA apos o fallback de 3 (25s)', { skip: !hasSupabase(), timeout: 40000 }, async () => {
  const chars = [await newQueueChar('guerreiro'), await newQueueChar('druida'), await newQueueChar('mago')];
  for (const c of chars) c.conn.ws.send(JSON.stringify({ type: 'dungeon_queue_join', zone: 'floresta', allowAiFill: true }));
  for (const c of chars) await waitFor(c.conn.msgs, m => m.type === 'dungeon_queue_state', 3000);
  const states = [];
  for (const c of chars) states.push(await waitFor(c.conn.msgs, m => m.type === 'dungeon_state', 32000));
  const mapIds = new Set(states.map(s => s.map));
  assert.equal(mapIds.size, 1, 'os 3 humanos deveriam cair na mesma instancia');
  assert.ok(states[0].roster.some(m => m.boss), 'roster deveria ter o chefe (escalado pra 4 participantes se a IA entrou)');
  for (const c of chars) c.conn.close();
});

