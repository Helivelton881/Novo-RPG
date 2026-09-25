'use strict';
// Fase 5.16 -- Living World / Aventureiros IA. Parte 1: nucleo puro
// (geracao de stats simulados, FSM, distribuicao de populacao,
// isolamento economico) -- sempre roda, sem HTTP/WS/Supabase, e sem
// depender do tick de 1s de verdade (aiStep e chamado diretamente com
// timestamps forjados). Parte 2: fluxo real via WebSocket -- prova que
// uma IA aparece pra um jogador real (player_join/state) e some
// (player_leave) exatamente como um jogador de verdade, reusando 100%
// do pipeline existente. So roda com Supabase configurado (a conta do
// jogador humano precisa de autenticacao real).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, wsConnect, waitFor, sleep } = require('./helpers');
const S = require('../server.js');

// ===== Parte 1: nucleo puro =====
test('buildAiSave/buildAiCombat: gera stats simulados coerentes por classe/nivel, nunca zero em maxHp', () => {
  for (const cls of S.AI_CLASS_POOL) {
    const combat = S.buildAiCombat(cls, 20, 'TesteIA');
    assert.equal(combat.cls, cls);
    assert.equal(combat.lvl, 20);
    assert.ok(combat.maxHp > 0);
    assert.ok(combat.atk >= 0);
    assert.equal(combat.userId, null, 'IA nunca tem userId real');
    assert.equal(combat.charId, null, 'IA nunca tem charId real');
  }
});
test('buildAiSave: equipamento simulado nunca tem UID reconhecido por sistema de posse real (gerado do zero a cada chamada)', () => {
  const s1 = S.buildAiSave('guerreiro', 15), s2 = S.buildAiSave('guerreiro', 15);
  assert.notEqual(s1.eq.sword.uid, s2.eq.sword.uid, 'cada geracao e independente -- nunca reusa/persiste um UID entre IAs');
});
test('aiZoneLevelRange: deriva do MOB_MANIFEST real da zona, nunca uma tabela paralela', () => {
  const [lo, hi] = S.aiZoneLevelRange('floresta');
  assert.ok(lo >= 1 && hi >= lo);
});
test('aiZoneLevelRange: zona desconhecida cai num intervalo padrao seguro, nunca quebra', () => {
  const [lo, hi] = S.aiZoneLevelRange('zona-que-nao-existe');
  assert.ok(lo >= 1 && hi >= lo);
});
test('aiPersonalityProfile: cada personalidade tem um perfil distinto (diversidade real, nao so um rotulo)', () => {
  const kinds = ['agressivo', 'cauteloso', 'equilibrado'].map(S.aiPersonalityProfile);
  const radii = new Set(kinds.map(k => k.aggroRadius));
  assert.ok(radii.size > 1, 'personalidades diferentes deveriam ter raios de agressividade diferentes');
});

test('aiSpawnEntity/aiDespawnEntity: entra e sai do Map, nunca deixa rastro', () => {
  S.aiEntities.clear();
  const ai = S.aiSpawnEntity('floresta');
  assert.ok(ai);
  assert.equal(ai.kind, 'ai');
  assert.equal(ai.map, 'floresta');
  assert.equal(S.aiEntities.size, 1);
  S.aiDespawnEntity(ai.id);
  assert.equal(S.aiEntities.size, 0);
  assert.equal(S.aiEntities.has(ai.id), false);
});
test('aiSpawnEntity: nunca passa do teto de populacao (AI_MAX_POPULATION)', () => {
  S.aiEntities.clear();
  for (let i = 0; i < S.AI_MAX_POPULATION + 5; i++) S.aiSpawnEntity(S.AI_FIELD_ZONES[i % S.AI_FIELD_ZONES.length]);
  assert.equal(S.aiEntities.size, S.AI_MAX_POPULATION);
  S.aiEntities.clear();
});
test('aiPublicPlayer: formato identico a publicPlayer real + kind:\'ai\' + charId sempre null -- nunca falsificavel como humano', () => {
  S.aiEntities.clear();
  const ai = S.aiSpawnEntity('cripta');
  const pub = S.aiPublicPlayer(ai);
  assert.equal(pub.kind, 'ai');
  assert.equal(pub.charId, null);
  for (const field of ['id','name','cls','map','x','y','dir','moving','lvl','atkT','atkAng']) assert.ok(field in pub, `campo ${field} deveria existir (mesmo formato de publicPlayer)`);
  S.aiEntities.clear();
});

test('Fase 5.16.2 -- map-ID consistency: aiSpawnEntity(zone).map e aiPublicPlayer(...).map sao IDENTICOS ao nome da zona nas 7 zonas de campo (nenhuma transformacao/sufixo que quebraria o filtro p.map===W_.name no cliente)', () => {
  S.aiEntities.clear();
  for (const zone of S.AI_FIELD_ZONES) {
    const ai = S.aiSpawnEntity(zone);
    assert.equal(ai.map, zone, `aiSpawnEntity('${zone}') deveria colocar a IA exatamente na zona pedida`);
    assert.equal(S.aiPublicPlayer(ai).map, zone, 'aiPublicPlayer nao deveria alterar o map -- o filtro do cliente depende de igualdade exata de string');
  }
  S.aiEntities.clear();
});

test('Fase 5.16.2 -- IA social da vila: aiSpawnEntity(\'vila\') funciona, respeita VILLAGE_SOCIAL_CAP (separado do fieldWorldCap), e aiPopulationTick mantem a vila povoada sem afetar as zonas de campo', () => {
  S.aiEntities.clear();
  for (let i = 0; i < S.VILLAGE_SOCIAL_CAP + 2; i++) S.aiSpawnEntity('vila');
  assert.equal(S.villageAiEntities().length, S.VILLAGE_SOCIAL_CAP, 'nunca deveria passar do teto social da vila, mesmo pedindo mais que isso');
  S.aiEntities.clear();
  for (let i = 0; i < S.VILLAGE_SOCIAL_CAP + 3; i++) S.aiPopulationTick(); // um de cada vez por tick, igual a reposicao de campo -- nunca instantaneo
  assert.equal(S.villageAiEntities().length, S.VILLAGE_SOCIAL_CAP, 'aiPopulationTick deveria povoar a vila ate o teto ao longo de alguns ticks de 1s, sem setInterval novo, e sem nunca passar do teto');
  for (const ai of S.villageAiEntities()) assert.equal(ai.map, 'vila');
  S.aiEntities.clear();
});

test('Fase 5.16.2 -- IA social da vila NUNCA entra em combate: fsm fica restrito a idle/wander/rest mesmo apos muitos ticks (guard de travel bloqueado pra quem mora na vila)', () => {
  S.aiEntities.clear();
  const ai = S.aiSpawnEntity('vila');
  assert.equal(ai.map, 'vila');
  let now = Date.now();
  for (let i = 0; i < 500; i++) { now += 1000; S.aiStep(ai, now); assert.ok(['idle','wander','rest'].includes(ai.fsm), `fsm inesperado pra IA social da vila: ${ai.fsm} (nunca deveria sair de idle/wander/rest)`); assert.equal(ai.map, 'vila', 'IA social da vila nunca deveria trocar de mapa (guard de travel)'); }
  S.aiEntities.clear();
});

test('Fase 5.16.2 -- aiSpawnAnchor(\'vila\') ancora perto do ponto real de spawn/respawn da vila (720,1258), nunca dentro da area de mobs de campo', () => {
  for (let i = 0; i < 20; i++) {
    const a = S.aiSpawnAnchor('vila');
    assert.ok(Math.hypot(a.x - 720, a.y - 1258) <= 200, 'ancora da vila deveria ficar perto do ponto real de spawn/respawn (720,1258)');
  }
});

test('Fase 5.16.2 -- aiSpawnAnchor: ancora perto do centroide dos mobs da zona, nunca num outlier isolado (bias de descobribilidade)', () => {
  S.maps.set('__ai_test_anchor__', {id:'__ai_test_anchor__', mobs:new Map(), hitGuard:new Map()});
  const state = S.maps.get('__ai_test_anchor__');
  for (let i = 0; i < 10; i++) state.mobs.set('c'+i, {id:'c'+i, x:100+i, y:100+i});
  state.mobs.set('outlier', {id:'outlier', x:5000, y:5000}); // sempre o mob mais distante do centroide -> nunca entra na metade mais proxima
  for (let i = 0; i < 30; i++) {
    const anchor = S.aiSpawnAnchor('__ai_test_anchor__');
    assert.ok(anchor.x < 1000 && anchor.y < 1000, 'nunca deveria ancorar perto do outlier isolado (5000,5000), so perto do centroide dos demais mobs');
  }
  S.maps.delete('__ai_test_anchor__');
});

test('aiPopulationTick: sempre povoa a zona MENOS povoada primeiro, nunca concentra tudo numa zona so', () => {
  S.aiEntities.clear();
  // forja 3 IA ja em 'floresta' -- a proxima automatica deveria ir pra outra zona.
  for (let i = 0; i < 3; i++) S.aiSpawnEntity('floresta');
  const beforeIds = new Set(S.aiEntities.keys());
  S.aiPopulationTick();
  // acha o ID novo por diferenca de conjunto -- nunca por createdAt (varias
  // IA podem nascer no mesmo milissegundo, tornando um sort por timestamp
  // ambiguo/instavel entre empates).
  const newId = [...S.aiEntities.keys()].find(id => !beforeIds.has(id));
  if (newId) {
    const newest = S.aiEntities.get(newId);
    assert.notEqual(newest.map, 'floresta', 'a proxima IA deveria ter ido pra uma zona menos povoada, nao empilhar em floresta de novo');
  }
  S.aiEntities.clear();
});
test('aiPopulationTick: respeita AI_ENABLED=0 explicito (nunca spawna com o gate desligado)', () => {
  S.aiEntities.clear();
  const prev = process.env.AI_ENABLED;
  process.env.AI_ENABLED = '0';
  assert.equal(S.aiEnabled(), false, 'aiEnabled() deveria refletir a env var na hora, nunca um valor congelado do carregamento do modulo');
  S.aiPopulationTick();
  assert.equal(S.aiEntities.size, 0, 'com AI_ENABLED=0, aiPopulationTick nunca deveria spawnar');
  if (prev === undefined) delete process.env.AI_ENABLED; else process.env.AI_ENABLED = prev;
  S.aiEntities.clear();
});

// FSM: idle -> hunt -> combat -> mob morre (IA nunca recebe recompensa)
test('FSM de campo: idle acha mob proximo e vai pra hunt; hunt se aproxima; combat mata o mob sem conceder nada a IA', () => {
  S.maps.set('__ai_test_field__', {id:'__ai_test_field__', mobs:new Map(), hitGuard:new Map()});
  const state = S.maps.get('__ai_test_field__');
  state.mobs.set('m1', {id:'m1', maxhp:40, hp:40, dead:false, x:500, y:500, sx:500, sy:500, state:'idle', respawnAt:0, boss:false, type:'goblin', lvl:5});
  S.aiEntities.clear();
  const ai = S.aiSpawnEntity('floresta');
  ai.map = '__ai_test_field__'; ai.x = 490; ai.y = 490; ai.fsm = 'idle';
  let now = Date.now();
  S.aiStep(ai, now);
  assert.equal(ai.fsm, 'hunt', 'com um mob proximo, idle deveria ir direto pra hunt');
  for (let i = 0; i < 40 && state.mobs.get('m1').hp > 0; i++) { now += 1000; S.aiStep(ai, now); }
  assert.equal(state.mobs.get('m1').dead, true, 'o mob deveria ter sido derrotado pela IA');
  S.aiEntities.clear(); S.maps.delete('__ai_test_field__');
});

test('FSM: HP baixo durante combate transiciona pra retreat (nunca luta ate morrer feito uma maquina sem instinto de sobrevivencia)', () => {
  S.maps.set('__ai_test_flee__', {id:'__ai_test_flee__', mobs:new Map(), hitGuard:new Map()});
  const state = S.maps.get('__ai_test_flee__');
  state.mobs.set('m1', {id:'m1', maxhp:99999, hp:99999, dead:false, x:500, y:500, sx:500, sy:500, state:'idle', respawnAt:0, boss:false, type:'goblin', lvl:5});
  S.aiEntities.clear();
  const ai = S.aiSpawnEntity('floresta');
  ai.map = '__ai_test_flee__'; ai.x = 490; ai.y = 490; ai.fsm = 'combat'; ai.targetMobId = 'm1';
  ai.hp = Math.floor(ai.maxHp * ai.profile.fleeHpRatio * 0.5); // ja abaixo do limiar de fuga
  S.aiStep(ai, Date.now());
  assert.equal(ai.fsm, 'retreat', 'HP abaixo do limiar de fuga deveria interromper o combate');
  S.aiEntities.clear(); S.maps.delete('__ai_test_flee__');
});

test('FSM: dead so respawna apos respawnAt, nunca antes', () => {
  S.aiEntities.clear();
  const ai = S.aiSpawnEntity('floresta');
  ai.dead = true; ai.hp = 0; ai.respawnAt = Date.now() + 5000;
  S.aiStep(ai, Date.now());
  assert.equal(ai.dead, true, 'nao deveria ter respawnado antes do prazo');
  S.aiStep(ai, ai.respawnAt + 10);
  assert.equal(ai.dead, false, 'deveria ter respawnado apos o prazo');
  assert.equal(ai.hp, ai.maxHp);
  S.aiDespawnEntity(ai.id);
});

test('REGRA ABSOLUTA: mob de masmorra morto pela IA credita SOMENTE membros humanos, nunca a propria IA (mesmo com charId/userId parecendo validos)', async () => {
  const state = {isDungeon:true, bossDefeated:false, members: new Map([
    ['ai_fake123', {kind:'ai', userId:'11111111-1111-1111-1111-111111111111', cls:'guerreiro', damageDone:50, lastActivityAt:Date.now(), online:true}],
  ])};
  const mob = {id:'boss1', boss:true, lvl:10, type:'goblin', hp:0, maxhp:1000, dead:true};
  const logs = [];
  const origError = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  try {
    S.dungeonHandleMobDeath(state, mob, Date.now(), null);
    await sleep(300); // creditDungeonReward e fire-and-forget (withCharLock async) -- da tempo dele tentar rodar se o guard falhasse
  } finally { console.error = origError; }
  assert.equal(state.bossDefeated, true, 'o chefe morre pro mundo normalmente');
  const triedToCredit = logs.some(l => l.includes('dungeon_reward_error'));
  assert.equal(triedToCredit, false, 'creditDungeonReward NUNCA deveria ter sido chamado pro membro kind:\'ai\' -- se tivesse sido, teria logado dungeon_reward_error (Supabase nao configurado neste teste)');
});

test('REGRA ABSOLUTA: nenhuma funcao do FSM de combate da IA menciona credito de economia no proprio codigo-fonte', () => {
  const src = S.aiTick.toString() + S.aiStep.toString() + S.aiDoCombat.toString() + S.aiDoHunt.toString() + S.aiDoIdle.toString();
  for (const forbidden of ['creditKillReward', 'applyGearDrops', 'rollGearDrop', 'grantItem', 'market_buy', 'market_list_item', 'creditBestiaryKill', 'syncRankLevelXp', 'creditDungeonReward']) {
    assert.equal(src.includes(forbidden), false, `funcao de economia proibida encontrada no codigo da IA: ${forbidden}`);
  }
});
test('REGRA ABSOLUTA: dungeonHandleMobDeath so credita quando kind!==\'ai\' -- o guard existe explicitamente no codigo-fonte', () => {
  const src = S.dungeonHandleMobDeath.toString();
  assert.match(src, /kind\s*===\s*['"]ai['"]/, 'deveria existir uma checagem explicita de kind===\'ai\' antes de qualquer credito');
});

// ===== Parte 2: fluxo real via WebSocket =====
const PORT = 8184;
let srv;
before(async () => { srv = await startServer(PORT, {AI_ENABLED:'1'}); });
after(() => stopServer(srv));

test('IA aparece pra um jogador humano real via player_join/state (mesmo pipeline de sempre, kind:\'ai\' visivel)', { skip: !hasSupabase() }, async () => {
  const username = 'ai_' + Math.random().toString(36).slice(2, 10), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'Observador', cls: 'guerreiro', lvl: 1, token: reg.json.token }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  // AI_ENABLED=1 neste servidor -- da tempo do tick de 1s rodar algumas vezes e popular pelo menos uma zona.
  const aiJoin = await waitFor(conn.msgs, m => m.type === 'player_join' && m.player && m.player.kind === 'ai', 15000).catch(() => null);
  assert.ok(aiJoin, 'deveria ter recebido pelo menos um player_join de uma IA dentro de 15s (AI_ENABLED=1 neste servidor)');
  assert.equal(aiJoin.player.charId, null, 'IA nunca deveria aparecer com um charId real pro cliente');
  conn.close();
});

test('Fase 5.16.2 -- welcome: IA ja existente antes do join aparece no snapshot inicial (kind:\'ai\'), sem esperar o proximo broadcast periodico do aiTick', { skip: !hasSupabase() }, async () => {
  S.aiEntities.clear();
  const ai = S.aiSpawnEntity('floresta');
  const username = 'aiwc_' + Math.random().toString(36).slice(2, 10), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'Observador2', cls: 'guerreiro', lvl: 1, token: reg.json.token }));
  const welcome = await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  const found = welcome.players.find(p => p.id === ai.id);
  assert.ok(found, 'IA ja existente antes da conexao deveria vir no snapshot inicial de welcome, nao so no proximo broadcast periodico (ate ~1s de atraso antes desta correcao)');
  assert.equal(found.kind, 'ai');
  conn.close();
  S.aiDespawnEntity(ai.id);
});

test('/api/admin/ai: lista as entidades ativas, sempre marcadas kind:\'ai\', nunca contadas como humano', { skip: !hasSupabase() }, async () => {
  const username = 'aiad_' + Math.random().toString(36).slice(2, 10), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  await fetch(`${url}/rest/v1/admin_roles`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ user_id: reg.json.user.id, role: 'owner' }) });
  await sleep(2000); // deixa o tick de 1s popular pelo menos uma zona
  const res = await httpJson(srv, 'GET', '/api/admin/ai', null, reg.json.token);
  assert.equal(res.status, 200);
  assert.ok(res.json.total >= 0);
  for (const e of res.json.entities) assert.equal(e.kind, 'ai');
  const dash = await httpJson(srv, 'GET', '/api/admin/dashboard', null, reg.json.token);
  assert.ok('aiOnline' in dash.json, 'dashboard deveria separar aiOnline de online (humano)');
});
