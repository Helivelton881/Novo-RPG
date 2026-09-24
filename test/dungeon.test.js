'use strict';
// Testes unitarios (sem HTTP/WS/Supabase) da Fase 5.2 -- instancia de
// masmorra, roster/seed deterministicos, colisao de mob contra parede,
// e o novo save inicial server-side. server.js exporta essas funcoes so
// pra isso (module.exports no fim do arquivo, atras de
// require.main===module -- nao muda como `node server.js` roda).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server.js');

test('createDungeonInstance: mesmo zone gera instancias com seeds diferentes (servidor escolhe, nao e fixo por zona)', () => {
  const a = S.createDungeonInstance('floresta', 'char-a', 'user-a');
  const b = S.createDungeonInstance('floresta', 'char-b', 'user-b');
  assert.notEqual(a.seed, b.seed, 'duas instancias novas nao deveriam cair no mesmo seed por coincidencia de design');
});

test('createDungeonInstance: roster nunca vem do cliente -- HP/tipo/nivel batem com mobStats real', () => {
  const state = S.createDungeonInstance('cripta', 'char-1', 'user-1');
  assert.ok(state.mobs.size > 1, 'deveria ter trash + chefe');
  let bossCount = 0;
  for (const mob of state.mobs.values()) {
    assert.equal(mob.dun, true);
    assert.ok(Number.isFinite(mob.hp) && mob.hp > 0);
    assert.equal(mob.hp, mob.maxhp);
    const stats = S.mobStats(mob.type, mob.lvl, mob.boss, mob.k);
    assert.ok(stats, `mobStats deveria reconhecer ${mob.type}`);
    if (mob.boss) { bossCount++; assert.equal(mob.maxhp, Math.round(stats.hp * 3), 'chefe de masmorra tem 3x o HP normal'); }
    else assert.equal(mob.maxhp, stats.hp);
  }
  assert.equal(bossCount, 1, 'exatamente um chefe por instancia');
});

test('createDungeonInstance: mob de masmorra nunca respawna sozinho (respawnAt sempre 0 ao nascer)', () => {
  const state = S.createDungeonInstance('serra', 'char-1', 'user-1');
  for (const mob of state.mobs.values()) assert.equal(mob.respawnAt, 0);
});

test('createDungeonInstance: todo mob carrega wallRects da mesma instancia (colisao real, nao mapa de campo)', () => {
  const state = S.createDungeonInstance('pantano', 'char-1', 'user-1');
  for (const mob of state.mobs.values()) assert.equal(mob.wallRects, state.layout.rects);
});

test('createDungeonInstance: zona invalida retorna null', () => {
  assert.equal(S.createDungeonInstance('vila', 'char-1', 'user-1'), null);
  assert.equal(S.createDungeonInstance('inexistente', 'char-1', 'user-1'), null);
});

test('createDungeonInstance: instancia fica registrada em server.maps com isDungeon=true', () => {
  const state = S.createDungeonInstance('torre', 'char-x', 'user-x');
  const found = S.maps.get(state.id);
  assert.equal(found, state);
  assert.equal(found.isDungeon, true);
  assert.equal(found.zone, 'torre');
  assert.equal(found.bossDefeated, false);
});

test('moveMob: mob de mapa de campo (sem wallRects) nao tem colisao de terreno -- comportamento preservado', () => {
  const mob = { x: 100, y: 100 };
  S.moveMob(mob, 20, 0);
  assert.equal(mob.x, 120);
});

test('moveMob: mob de masmorra (com wallRects) nao atravessa parede', () => {
  const mob = { x: 100, y: 100, wallRects: [{ x: 110, y: 80, w: 40, h: 40 }] };
  const before = mob.x;
  S.moveMob(mob, 40, 0); // tentaria ir pra dentro do retangulo bloqueado
  assert.ok(mob.x < 110, 'nao deveria atravessar a parede em ' + mob.x);
  assert.ok(mob.x >= before, 'ainda deveria poder se aproximar ate a parede');
});

test('rectsBlock: deteccao basica de sobreposicao AABB', () => {
  const rects = [{ x: 0, y: 0, w: 10, h: 10 }];
  assert.equal(S.rectsBlock(rects, 5, 5, 1, 1), true);
  assert.equal(S.rectsBlock(rects, 50, 50, 1, 1), false);
});

test('dungeonCleanupTick: instancia sem ninguem presente por muito tempo e removida', () => {
  const state = S.createDungeonInstance('ilhas', 'char-idle', 'user-idle');
  const id = state.id;
  state.lastActiveAt = Date.now() - (31 * 60 * 1000); // 31min atras, ninguem presente
  S.dungeonCleanupTick();
  assert.equal(S.maps.has(id), false, 'instancia idle ha mais de 30min deveria ter sido limpa');
});

test('dungeonCleanupTick: instancia recente nao e removida', () => {
  const state = S.createDungeonInstance('vulcao', 'char-fresh', 'user-fresh');
  const id = state.id;
  state.lastActiveAt = Date.now();
  S.dungeonCleanupTick();
  assert.equal(S.maps.has(id), true);
});

test('startingSave: personagem novo comeca com o default real (10 ouro, 3 pv, 2 pa, arma Nv1 basica da classe)', () => {
  for (const [cls, weapon] of [['guerreiro', 'sword'], ['druida', 'staffd'], ['mago', 'staffm'], ['arqueiro', 'bow']]) {
    const save = S.startingSave(cls, 'Teste');
    assert.equal(save.gold, 10); assert.equal(save.pv, 3); assert.equal(save.pa, 2); assert.equal(save.gem, 0);
    assert.equal(save.eq.sword.type, weapon);
    assert.equal(save.eq.sword.lv, 1);
    assert.equal(save.eq.sword.rarity, 'basic');
    assert.match(save.eq.sword.uid, /^[0-9a-f-]{36}$/i);
    assert.equal(save.bag.length, 0);
    assert.deepEqual(save.gunlock, {});
  }
});

test('ECONOMY_LOCK_FIELDS cobre todo campo economico conhecido (gold/gem/consumiveis/chaves/portais/bauis)', () => {
  for (const f of ['gold', 'gem', 'pv', 'pa', 'ap', 'key', 'scr', 'gunlock', 'chest', 'chest2', 'chest3', 'chest4', 'chest5', 'chest6', 'chest7']) {
    assert.ok(S.ECONOMY_LOCK_FIELDS.includes(f), `${f} deveria estar em ECONOMY_LOCK_FIELDS`);
  }
});

test('DUNGEON_UNLOCK_QUEST cobre as 7 masmorras nas mesmas faixas de quest do portal de campo', () => {
  assert.deepEqual(S.DUNGEON_UNLOCK_QUEST, { floresta: 3, cripta: 7, serra: 11, pantano: 15, torre: 19, ilhas: 23, vulcao: 27 });
});

test('clampAtk: teto cobre o maximo legitimo de Nv40 Basico (Fase 5.1) com folga, sem aceitar numero absurdo', () => {
  assert.ok(S.clampAtk(72) === 72, 'atk legitimo maximo hoje (~72) nao deveria ser cortado');
  assert.ok(S.clampAtk(999999) < 999999, 'numero absurdo ainda precisa ser limitado');
});

test('pickTier: sempre retorna um tier legado valido (1-5) mapeavel via GEAR_DATA', () => {
  for (const lvl of [1, 5, 9, 12, 17, 22, 27, 32, 38]) {
    const tier = S.pickTier(lvl);
    assert.ok(tier >= 1 && tier <= 5);
    assert.ok(S.GEAR_DATA.LEGACY_TIER_LEVEL[tier], `tier ${tier} deveria mapear pra um lv real`);
  }
});

test('rollDungeonTrashLoot/rollDungeonBossLoot: nunca incluem XP (masmorra nao concede XP, comportamento preservado)', () => {
  const trash = S.rollDungeonTrashLoot(20, 'guerreiro');
  const boss = S.rollDungeonBossLoot('guerreiro');
  assert.equal('xp' in trash, false);
  assert.equal('xp' in boss, false);
  assert.ok(boss.gold > 0);
  assert.equal(boss.gem, 6);
  assert.equal(boss.items.length, 3, 'chefe sempre da 3 itens');
});

test('DUNGEON_GEN.dungeonLayout: determinístico (mesmo seed = mesmo layout, seeds diferentes tendem a diferir)', () => {
  const a = S.DUNGEON_GEN.dungeonLayout(777);
  const b = S.DUNGEON_GEN.dungeonLayout(777);
  assert.deepEqual(a.start, b.start);
  assert.equal(a.rects.length, b.rects.length);
});
