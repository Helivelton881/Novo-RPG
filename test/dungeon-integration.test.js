'use strict';
// Fase 5.2, Partes 7/8: masmorra server-authoritative de ponta a ponta via
// WebSocket real (entrada, roster/seed vindos do servidor, abate de mob de
// masmorra, recompensa de chefe exatamente uma vez). Usa adminPatchCharacter
// (ver helpers.js) so pra montar o estado de setup (nivel/quest) que nao
// tem mais nenhuma rota client-facing pra forjar depois da Fase 5.2 -- os
// testes em si exercitam os fluxos reais (dungeon_enter/mob_damage) sem
// bypass. Precisa de Supabase (projeto de TESTE, nunca o oficial).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, wsConnect, waitFor, sleep, adminPatchCharacter, moveToDungeonCave } = require('./helpers');

const PORT = 8111;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'qa_' + Math.random().toString(36).slice(2, 10);
const DUNGEON_UNLOCK_QUEST = { floresta: 3, cripta: 7, serra: 11, pantano: 15, torre: 19, ilhas: 23, vulcao: 27 };

async function newChar(cls = 'guerreiro') {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Aventureiro', cls }, token);
  return { token, id: created.json.character.id, save: created.json.character.save, cls };
}

// Desbloqueia uma masmorra + sobe nivel pra matar rapido nos testes --
// escreve direto no banco de teste (ver adminPatchCharacter), unico jeito
// que sobra depois que quest/lvl deixaram de ser aceitos por PUT bruto.
async function unlockAndLevel(ch, zone, lvl) {
  await adminPatchCharacter(ch.id, { lvl, save: { ...ch.save, lvl, quest: DUNGEON_UNLOCK_QUEST[zone] } });
}

async function authedWs(ch) {
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'Aventureiro', cls: ch.cls, lvl: 1, token: ch.token, charId: ch.id }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  return conn;
}

async function enterDungeon(conn, zone) {
  const before = conn.msgs.length;
  conn.ws.send(JSON.stringify({ type: 'dungeon_enter', zone }));
  return waitFor(conn.msgs, m => (m.type === 'dungeon_state' || m.type === 'dungeon_error'), 3000, before);
}

async function hitMob(conn, map, mobId) {
  conn.ws.send(JSON.stringify({ type: 'mob_damage', map, id: mobId, skill: 'basic', atk: 120 }));
}

test('dungeon_enter: conexao anonima (sem token) e rejeitada', { skip: !hasSupabase() }, async () => {
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'Anonimo', cls: 'guerreiro', lvl: 1 }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  const res = await enterDungeon(conn, 'floresta');
  assert.equal(res.type, 'dungeon_error');
  conn.close();
});

test('dungeon_enter: zona invalida e rejeitada', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  const conn = await authedWs(ch);
  const res = await enterDungeon(conn, 'vila');
  assert.equal(res.type, 'dungeon_error');
  const res2 = await enterDungeon(conn, 'zona-que-nao-existe');
  assert.equal(res2.type, 'dungeon_error');
  conn.close();
});

test('dungeon_enter: personagem novo (quest=0) nao pode entrar em masmorra que exige quest>=3', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  const conn = await authedWs(ch);
  const res = await enterDungeon(conn, 'floresta');
  assert.equal(res.type, 'dungeon_error');
  assert.match(res.error, /liberad/i);
  conn.close();
});

test('dungeon_enter: com quest liberada, servidor devolve seed/roster/boss -- nunca aceita nada vindo do cliente', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  await unlockAndLevel(ch, 'floresta', 40);
  const conn = await authedWs(ch);
  await moveToDungeonCave(conn, 'floresta');
  const res = await enterDungeon(conn, 'floresta');
  assert.equal(res.type, 'dungeon_state');
  assert.equal(res.zone, 'floresta');
  assert.ok(Number.isInteger(res.seed), 'seed deveria ser um inteiro gerado pelo servidor');
  assert.ok(res.start && Number.isFinite(res.start.x) && Number.isFinite(res.start.y));
  assert.equal(res.bossDefeated, false);
  assert.ok(Array.isArray(res.roster) && res.roster.length > 1, 'deveria ter trash + chefe');
  const bosses = res.roster.filter(m => m.boss);
  assert.equal(bosses.length, 1, 'exatamente um chefe no roster');
  assert.equal(bosses[0].type, 'goblin');
  assert.equal(bosses[0].lvl, 10);
  for (const m of res.roster) {
    assert.equal(m.hp, m.maxhp, 'mob deveria nascer com hp cheio');
    assert.ok(m.hp > 0);
    assert.ok(Number.isFinite(m.x) && Number.isFinite(m.y));
  }
  conn.close();
});

test('mesmo personagem reentrando na mesma masmorra reusa a MESMA instancia (mesmo seed, nao gera outra aleatoria)', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  await unlockAndLevel(ch, 'floresta', 40);
  const conn = await authedWs(ch);
  await moveToDungeonCave(conn, 'floresta');
  const first = await enterDungeon(conn, 'floresta');
  const second = await enterDungeon(conn, 'floresta');
  assert.equal(second.seed, first.seed);
  assert.equal(second.map, first.map);
  conn.close();
});

test('abate de mob comum de masmorra: recompensa vem do servidor (dungeon_reward), nunca concede xp', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  await unlockAndLevel(ch, 'floresta', 40);
  const conn = await authedWs(ch);
  await moveToDungeonCave(conn, 'floresta');
  const state = await enterDungeon(conn, 'floresta');
  const trash = state.roster.find(m => !m.boss);
  const before = conn.msgs.length;
  await hitMob(conn, state.map, trash.id);
  const reward = await waitFor(conn.msgs, m => m.type === 'dungeon_reward', 3000, before);
  assert.ok(reward, 'deveria ter recebido dungeon_reward pelo abate');
  assert.equal('xp' in reward, false, 'masmorra nao concede xp');
  conn.close();
});

test('chefe de masmorra: recompensa exatamente UMA vez mesmo com golpes extras logo apos a morte (sem duplicar)', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  await unlockAndLevel(ch, 'floresta', 40);
  const conn = await authedWs(ch);
  await moveToDungeonCave(conn, 'floresta');
  const state = await enterDungeon(conn, 'floresta');
  const boss = state.roster.find(m => m.boss);
  assert.ok(boss, 'roster deveria ter um chefe');

  const before = conn.msgs.length;
  // hp do chefe (1440 = 480*3) precisa de varios golpes de ~257-260 de
  // dano (guerreiro Nv40, atk 120 clampado) -- respeita o cooldown real do
  // basico (420ms) entre golpes legitimos, depois dispara 2 golpes quase
  // simultaneos no ultimo hp restante pra tentar forcar a corrida.
  let hp = boss.maxhp;
  const perHit = 257;
  while (hp > perHit) {
    await hitMob(conn, state.map, boss.id);
    hp -= perHit;
    await sleep(450);
  }
  // golpe final: dispara 2 mensagens de dano quase juntas, sem esperar
  // resposta entre elas, pra tentar acertar o mesmo mob "morrendo" 2x.
  await hitMob(conn, state.map, boss.id);
  await hitMob(conn, state.map, boss.id);

  await sleep(600);
  const rewards = conn.msgs.slice(before).filter(m => m.type === 'dungeon_reward');
  assert.equal(rewards.length, 1, `chefe deveria recompensar exatamente 1 vez, recebeu ${rewards.length}`);
  assert.equal(rewards[0].gem, 6, 'recompensa de chefe tem gema fixa (6) -- gema dobrada indicaria credito duplicado');
  // Fase 5.3: chefe de masmorra nao garante mais 3 itens Basic -- agora e
  // no maximo 1 roll de Legendary a 5% (rollDungeonBossLoot). Aqui so
  // confirma que, SE um drop aconteceu (m.drop presente), ele e sempre
  // legendary e nunca mais de 1 -- a cobertura probabilistica completa
  // (epic/rare/legendary/nada com rng controlado) fica em
  // test/loot-rarity.test.js, deterministica.
  const totalItems = rewards[0].bag.length + Object.values(rewards[0].eq).filter(Boolean).length;
  if (rewards[0].drop) { assert.equal(rewards[0].drop.rarity, 'legendary'); assert.ok(totalItems >= 1); }
  conn.close();
});

test('reconectar apos derrotar o chefe: dungeon_state seguinte mostra bossDefeated=true e chefe nao aparece mais vivo', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  await unlockAndLevel(ch, 'floresta', 40);
  const conn = await authedWs(ch);
  await moveToDungeonCave(conn, 'floresta');
  const state = await enterDungeon(conn, 'floresta');
  const boss = state.roster.find(m => m.boss);
  let hp = boss.maxhp;
  while (hp > 0) { await hitMob(conn, state.map, boss.id); hp -= 257; await sleep(450); }
  await sleep(300);

  const reentry = await enterDungeon(conn, 'floresta');
  assert.equal(reentry.type, 'dungeon_state');
  assert.equal(reentry.bossDefeated, true);
  conn.close();
});
