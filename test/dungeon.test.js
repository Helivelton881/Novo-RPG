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
  const boss = S.rollDungeonBossLoot('guerreiro', 40);
  assert.equal('xp' in trash, false);
  assert.equal('xp' in boss, false);
  assert.ok(boss.gold > 0);
  assert.equal(boss.gem, 6);
  // Fase 5.3: chefe de masmorra nao garante mais 3 itens Basic (era
  // compatibilidade temporaria da Fase 5.2) -- agora no maximo 1 item, e so
  // pode ser Legendary (rollGearDrop com boss:true). Cobertura
  // probabilistica completa com rng controlado fica em loot-rarity.test.js.
  assert.ok(boss.items.length <= 1, 'no maximo 1 item de chefe de masmorra');
  for (const it of boss.items) assert.equal(it.rarity, 'legendary');
});

test('DUNGEON_GEN.dungeonLayout: determinístico (mesmo seed = mesmo layout; Fase 5.13: qualquer seed = mesmo layout, mapa agora e fixo)', () => {
  const a = S.DUNGEON_GEN.dungeonLayout(777);
  const b = S.DUNGEON_GEN.dungeonLayout(777);
  assert.deepEqual(a.start, b.start);
  assert.equal(a.rects.length, b.rects.length);
});

// ===== Fase 5.13 -- DUNGEON MAP V2: layout fixo (mapa/colisao/spawn) =====
// A logica da masmorra (roster, combate, loot, reward, boss AI, anti-
// teleport, Bestiario, Party) NAO mudou -- so o mapa. Testes abaixo
// cobrem exatamente o que mudou: geometria fixa, bounding box dentro do
// teto global do mundo, conectividade real (toda porta e caminhavel),
// nada nasce dentro de parede, e a distribuicao de mobs por sala nomeada.

test('DUNGEON_GEN.dungeonLayout: layout e sempre o MESMO independente do seed (fixo, nao procedural)', () => {
  const seeds = [1, 777, 999999, 2147483646];
  const layouts = seeds.map(s => S.DUNGEON_GEN.dungeonLayout(s));
  for (let i = 1; i < layouts.length; i++) {
    assert.deepEqual(layouts[i].start, layouts[0].start);
    assert.deepEqual(layouts[i].boss, layouts[0].boss);
    assert.deepEqual(layouts[i].exitPoint, layouts[0].exitPoint);
    assert.equal(layouts[i].rects.length, layouts[0].rects.length);
  }
});

test('DUNGEON_GEN: bounding box do layout cabe no teto global do mundo (60x44 tiles / 2880x2112px, o mesmo limite do anti-teleport)', () => {
  const layout = S.DUNGEON_GEN.dungeonLayout(1);
  let maxX = 0, maxY = 0;
  for (const r of layout.rects) { maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h); }
  assert.ok(maxX <= 2880, `largura ${maxX}px excede o teto global de 2880px`);
  assert.ok(maxY <= 2112, `altura ${maxY}px excede o teto global de 2112px`);
});

test('DUNGEON_GEN: nenhuma sala/corredor se sobrepoe a outro', () => {
  const rooms = S.DUNGEON_GEN.DUNGEON_ROOMS_V2;
  const ids = Object.keys(rooms);
  const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    assert.equal(overlap(rooms[ids[i]], rooms[ids[j]]), false, `${ids[i]} e ${ids[j]} nao deveriam se sobrepor`);
  }
});

test('DUNGEON_GEN: toda sala nomeada tem pelo menos uma porta (nenhuma sala isolada)', () => {
  const layout = S.DUNGEON_GEN.dungeonLayout(1);
  const ids = Object.keys(S.DUNGEON_GEN.DUNGEON_ROOMS_V2);
  const touching = new Set();
  for (const [a, , b] of S.DUNGEON_GEN.DUNGEON_CONNECTIONS_V2) { touching.add(a); touching.add(b); }
  for (const id of ids) assert.ok(touching.has(id), `${id} nunca aparece em nenhuma conexao`);
});

// Fase 5.16.3 (V3): layout de ENCRUZILHADA -- substitui o antigo layout
// V2, que era estritamente linear (cada sala com no maximo 1 pai + 1
// filho). O novo layout e uma ARVORE enraizada em 'entrada' (ainda sem
// ciclos -- todo ponto tem exatamente 1 caminho desde a entrada -- mas
// com ramificacao real: a 'encruzilhada' abre pra 3 direcoes).
test('DUNGEON_GEN: conexoes formam uma ARVORE enraizada em entrada (sem ciclo, toda sala alcancavel por exatamente 1 caminho) -- ramificacao real permitida', () => {
  const conns = S.DUNGEON_GEN.DUNGEON_CONNECTIONS_V2;
  const ids = Object.keys(S.DUNGEON_GEN.DUNGEON_ROOMS_V2);
  // arvore valida com N nos tem exatamente N-1 arestas
  assert.equal(conns.length, ids.length - 1, `uma arvore com ${ids.length} salas deveria ter ${ids.length - 1} conexoes (achado ${conns.length})`);
  const adj = {}; for (const id of ids) adj[id] = [];
  for (const [a, , b] of conns) { adj[a].push(b); adj[b].push(a); }
  const seen = new Set(['entrada']), queue = ['entrada'];
  while (queue.length) { const cur = queue.shift(); for (const n of adj[cur]) if (!seen.has(n)) { seen.add(n); queue.push(n); } }
  for (const id of ids) assert.ok(seen.has(id), `${id} deveria ser alcancavel a partir de 'entrada' (arvore conectada)`);
});
test('DUNGEON_GEN: a encruzilhada e um HUB de verdade -- abre pra sala esquerda, sala direita e sala de elite (3 filhos, nao mais so passagem)', () => {
  const conns = S.DUNGEON_GEN.DUNGEON_CONNECTIONS_V2;
  const children = conns.filter(([a]) => a === 'encruzilhada').map(([, , b]) => b);
  assert.deepEqual(new Set(children), new Set(['salaEsquerda', 'salaDireita', 'salaElite']), 'encruzilhada deveria conectar exatamente com salaEsquerda, salaDireita e salaElite');
});
test('DUNGEON_GEN: sala esquerda e sala direita sao alas opcionais (dead-end) -- nao fazem parte do caminho obrigatorio ate o chefe', () => {
  const conns = S.DUNGEON_GEN.DUNGEON_CONNECTIONS_V2;
  for (const wing of ['salaEsquerda', 'salaDireita']) {
    const touches = conns.filter(([a, , b]) => a === wing || b === wing);
    assert.equal(touches.length, 1, `${wing} deveria ter exatamente 1 conexao (dead-end, nao passagem)`);
  }
});

test('DUNGEON_GEN: start/boss/exitPoint nunca caem dentro de um rect de parede', () => {
  const layout = S.DUNGEON_GEN.dungeonLayout(1);
  const insideAnyWall = (pt) => layout.rects.some(r => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h);
  assert.equal(insideAnyWall(layout.start), false, 'spawn do jogador nao pode nascer dentro de parede');
  assert.equal(insideAnyWall(layout.boss), false, 'chefe nao pode nascer dentro de parede');
  assert.equal(insideAnyWall(layout.exitPoint), false, 'portal de saida nao pode ficar dentro de parede');
});

test('DUNGEON_GEN: o ponto medio de cada conexao (porta) e caminhavel (nao coberto por nenhum rect de parede)', () => {
  const layout = S.DUNGEON_GEN.dungeonLayout(1), rooms = S.DUNGEON_GEN.DUNGEON_ROOMS_V2, T = S.DUNGEON_GEN.T;
  const insideAnyWall = (pt) => layout.rects.some(r => pt.x > r.x && pt.x < r.x + r.w && pt.y > r.y && pt.y < r.y + r.h);
  for (const [a, , b] of S.DUNGEON_GEN.DUNGEON_CONNECTIONS_V2) {
    const A = rooms[a], B = rooms[b];
    const midX = (Math.max(A.x, B.x) + Math.min(A.x + A.w, B.x + B.w)) / 2 * T;
    const midY = (Math.max(A.y, B.y) + Math.min(A.y + A.h, B.y + B.h)) / 2 * T;
    assert.equal(insideAnyWall({ x: midX, y: midY }), false, `porta entre ${a} e ${b} deveria estar aberta`);
  }
});

test('createDungeonInstance (Fase 5.13): mobs comuns ficam dentro da sala certa, na quantidade sugerida por sala', () => {
  const state = S.createDungeonInstance('floresta', 'char-rooms', 'user-rooms');
  const rooms = S.DUNGEON_GEN.DUNGEON_ROOMS_V2, T = S.DUNGEON_GEN.T;
  const countByRoom = {};
  for (const mob of state.mobs.values()) {
    if (mob.boss) continue;
    let placed = null;
    for (const id of state.layout.mobRooms) {
      const r = rooms[id];
      if (mob.x >= r.x * T && mob.x <= (r.x + r.w) * T && mob.y >= r.y * T && mob.y <= (r.y + r.h) * T) { placed = id; break; }
    }
    assert.ok(placed, `mob comum em (${mob.x},${mob.y}) deveria cair dentro de alguma sala com mob (mobRooms)`);
    countByRoom[placed] = (countByRoom[placed] || 0) + 1;
  }
  for (const id of Object.keys(countByRoom)) {
    const [lo, hi] = S.DUNGEON_ROOM_MOB_COUNTS[id];
    assert.ok(countByRoom[id] >= lo && countByRoom[id] <= hi, `${id} tem ${countByRoom[id]} mobs, esperado entre ${lo} e ${hi}`);
  }
});

test('createDungeonInstance (Fase 5.13): chefe nasce exatamente no centro da sala boss (layout.boss)', () => {
  const state = S.createDungeonInstance('cripta', 'char-boss', 'user-boss');
  const boss = [...state.mobs.values()].find(m => m.boss);
  assert.ok(boss);
  assert.equal(boss.x, state.layout.boss.x);
  assert.equal(boss.y, state.layout.boss.y);
});

test('createDungeonInstance (Fase 5.13): nenhum mob (comum ou chefe) nasce dentro de um rect de colisao', () => {
  const state = S.createDungeonInstance('serra', 'char-safe', 'user-safe');
  for (const mob of state.mobs.values()) {
    assert.equal(S.rectsBlock(state.layout.rects, mob.x - 4, mob.y - 4, 8, 8), false, `mob ${mob.type} nasceu dentro de uma parede em (${mob.x},${mob.y})`);
  }
});
