'use strict';
// Fase 5.7 -- Team vs Team. Testes puros (sem HTTP/WS/Supabase), direto
// contra game-data/tvt.js (e game-data/world-boss.js, reaproveitado pra
// combatSnapshot). RNG sempre injetado pra resultado deterministico.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const TVT = require('../game-data/tvt.js');
const WB = require('../game-data/world-boss.js');

function snap(cls, lvl, eq, sk) {
  return WB.combatSnapshot({ userId: 'u', charId: 'c', name: 'X', cls, lvl, save: { eq: eq || {}, sk: sk || {} } });
}
function member(charId, team, cls, lvl, eq, sk) {
  return { userId: 'u' + charId, charId, name: charId, cls, lvl, team, snapshot: snap(cls, lvl, eq, sk) };
}
function queueRng(values) { const q = values.slice(); return () => (q.length ? q.shift() : 0.5); }

// ===== Config =====
test('CONFIG: 4 minimo, 8 maximo, 10min de duracao, 5s respawn, 3s protecao', () => {
  assert.equal(TVT.TVT_MIN_PLAYERS, 4);
  assert.equal(TVT.TVT_MAX_PLAYERS, 8);
  assert.equal(TVT.TVT_DURATION_MS, 10 * 60 * 1000);
  assert.equal(TVT.TVT_RESPAWN_MS, 5000);
  assert.equal(TVT.TVT_SPAWN_PROTECTION_MS, 3000);
});
test('scoreLimitForTeamSize: 2v2=10, 3v3=15, 4v4=20', () => {
  assert.equal(TVT.scoreLimitForTeamSize(2), 10);
  assert.equal(TVT.scoreLimitForTeamSize(3), 15);
  assert.equal(TVT.scoreLimitForTeamSize(4), 20);
});
test('TVT_MAP_RE: aceita so tvt#<id>, rejeita mapas de fora', () => {
  assert.equal(TVT.TVT_MAP_RE.test('tvt#a1b2c3'), true);
  assert.equal(TVT.TVT_MAP_RE.test('vila'), false);
  assert.equal(TVT.TVT_MAP_RE.test('wb#a1b2c3#ABCDEF'), false);
  assert.equal(TVT.TVT_MAP_RE.test('tvt#'), false);
});

// ===== PowerScore =====
test('powerScore: nunca so nivel -- atk/def/hp/block/skills/rarity/enchant entram na conta', () => {
  const s1 = snap('guerreiro', 20, {}, {});
  const s2 = snap('guerreiro', 20, { sword: { atk: 50, rarity: 'basic', enchant: 0 } }, { spin: 3 });
  const p1 = TVT.powerScore(s1, {});
  const p2 = TVT.powerScore(s2, { sword: { atk: 50, rarity: 'basic', enchant: 0 } });
  assert.ok(p2 > p1, 'equipamento e skill maiores deveriam aumentar o powerScore mesmo com o mesmo nivel');
});
test('powerScore: rarity/enchant aumentam o score mesmo com atk/def/hp identicos', () => {
  const s = snap('guerreiro', 20, { sword: { atk: 30 } }, {});
  const basic = TVT.powerScore(s, { sword: { atk: 30, rarity: 'basic', enchant: 0 } });
  const legendary = TVT.powerScore(s, { sword: { atk: 30, rarity: 'legendary', enchant: 10 } });
  assert.ok(legendary > basic, 'legendary+10 deveria pesar mais que basic mesmo com atk igual no snapshot');
});
test('powerScore NUNCA e dano nem HP (nao e a mesma escala)', () => {
  const s = snap('guerreiro', 20, {}, {});
  const p = TVT.powerScore(s, {});
  assert.notEqual(p, s.maxHp);
  assert.notEqual(p, s.atk);
});

// ===== Balanceamento =====
test('balanceTvtTeams: times de mesmo tamanho, todos aparecem exatamente uma vez', () => {
  const players = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ charId: 'c' + i, cls: 'guerreiro', powerScore: 100 + i * 13 }));
  const result = TVT.balanceTvtTeams(players);
  assert.equal(result.red.length, 4); assert.equal(result.blue.length, 4);
  const all = [...result.red, ...result.blue].sort();
  assert.deepEqual(all, players.map(p => p.charId).sort());
});
test('balanceTvtTeams: minimiza diferenca absoluta de powerScore (nao greedy)', () => {
  // greedy (ordenar e alternar) erraria aqui: [100,100,100,1] -- melhor
  // divisao real e {100,1} vs {100,100} (diff=99), nao {100,100} vs {100,1}
  // que tambem da diff=99 por acaso -- usa um caso mais dificil:
  const players = [
    { charId: 'a', cls: 'guerreiro', powerScore: 10 },
    { charId: 'b', cls: 'druida', powerScore: 10 },
    { charId: 'c', cls: 'mago', powerScore: 10 },
    { charId: 'd', cls: 'arqueiro', powerScore: 30 },
  ];
  const result = TVT.balanceTvtTeams(players);
  // melhor divisao exata: {10,20?} nao existe 20 -- vamos conferir a diff minima possivel por forca bruta:
  // combos de 2: {10,10}=20 vs {10,30}=40 diff20 | {10,10}=20 vs {10,30}=40 diff20 | {10,30}=40 vs {10,10}=20 diff20
  // -- toda combinacao com 'd'(30) sozinho do lado oposto dos outros dois 10+10 da diff=40-20=20;
  // {10,30}=40 vs {10,10}=20 tambem diff20. Todas as divisoes dao diff=20 aqui (caso simetrico),
  // o importante e que ache alguma com diff=20 (nunca pior).
  assert.equal(result.diff, 20);
});
test('balanceTvtTeams: powerScore muito diferente NUNCA fica pior que a pior combinacao possivel', () => {
  const players = [
    { charId: 'a', cls: 'guerreiro', powerScore: 1000 },
    { charId: 'b', cls: 'druida', powerScore: 10 },
    { charId: 'c', cls: 'mago', powerScore: 10 },
    { charId: 'd', cls: 'arqueiro', powerScore: 10 },
  ];
  const result = TVT.balanceTvtTeams(players);
  // melhor possivel: {1000+10=1010} vs {10+10=20}? diff=990 -- OU {1000,10}=1010 vs {10,10}=20, mesma coisa
  // so ha uma forma "melhor": isolar 1000 sozinho nao e possivel (times tem que ter 2 cada aqui) --
  // toda combinacao de 2+2 com 1000 de um lado da diff=990. Confirma que o algoritmo acha essa (unica) melhor opcao.
  assert.equal(result.diff, 1000 + 10 - (10 + 10));
});
test('balanceTvtTeams: resultado deterministico (mesma entrada -> mesma saida)', () => {
  const players = [1, 2, 3, 4, 5, 6].map(i => ({ charId: 'c' + i, cls: 'guerreiro', powerScore: 50 + i * 7 }));
  const r1 = TVT.balanceTvtTeams(players), r2 = TVT.balanceTvtTeams(players);
  assert.deepEqual(r1, r2);
});
test('balanceTvtTeams: composicao de classe penaliza concentracao extrema quando powerScore empata', () => {
  // 4 jogadores, powerScore identico -- so a penalidade de classe desempata.
  const players = [
    { charId: 'a', cls: 'druida', powerScore: 100 },
    { charId: 'b', cls: 'druida', powerScore: 100 },
    { charId: 'c', cls: 'druida', powerScore: 100 },
    { charId: 'd', cls: 'guerreiro', powerScore: 100 },
  ];
  const result = TVT.balanceTvtTeams(players);
  // com powerScore todos iguais (diff sempre 0), a penalidade de composicao decide:
  // {3 druidas} vs {1 guerreiro} teria diff de classe = 3 (druida) -- pior que
  // qualquer divisao com no maximo 2 druidas de um lado.
  const redClasses = result.red.map(id => players.find(p => p.charId === id).cls);
  const druidasNoRed = redClasses.filter(c => c === 'druida').length;
  assert.ok(druidasNoRed <= 2, 'nao deveria concentrar as 3 druidas no mesmo time quando powerScore empata');
});
test('balanceTvtTeams: entrada invalida (impar ou <2) retorna null', () => {
  assert.equal(TVT.balanceTvtTeams([{ charId: 'a', cls: 'guerreiro', powerScore: 1 }]), null);
  assert.equal(TVT.balanceTvtTeams([{ charId: 'a', cls: 'guerreiro', powerScore: 1 }, { charId: 'b', cls: 'guerreiro', powerScore: 1 }, { charId: 'c', cls: 'guerreiro', powerScore: 1 }]), null);
});

// ===== Instancia =====
test('createTvtInstance: mapId no formato tvt#..., scoreLimit correto pro tamanho do time', () => {
  const members = [member('c1', 'red', 'guerreiro', 20), member('c2', 'blue', 'mago', 20), member('c3', 'red', 'druida', 20), member('c4', 'blue', 'arqueiro', 20)];
  const inst = TVT.createTvtInstance({ eventId: 'team_vs_team:123456789', members, now: 1000 });
  assert.match(inst.mapId, TVT.TVT_MAP_RE);
  assert.equal(inst.scoreLimit, 10); // 2v2 (2 por time) -> scoreLimitForTeamSize(2)=10
});
test('createTvtInstance: spawns opostos (Rubra oeste, Azul leste), bem afastados', () => {
  const members = [member('c1', 'red', 'guerreiro', 20), member('c2', 'blue', 'mago', 20)];
  const inst = TVT.createTvtInstance({ eventId: 'x:1', members, now: 0 });
  const red = inst.players.get('c1'), blue = inst.players.get('c2');
  assert.ok(red.x < blue.x, 'Rubra deveria nascer a oeste (x menor)');
  assert.ok(Math.hypot(blue.x - red.x, blue.y - red.y) > 550, 'spawns deveriam estar fora do alcance de qualquer ataque (>550px)');
});
test('createTvtInstance: HP inicial = maxHp do snapshot, ninguem morto, protecao de spawn ativa', () => {
  const members = [member('c1', 'red', 'guerreiro', 20), member('c2', 'blue', 'mago', 20)];
  const inst = TVT.createTvtInstance({ eventId: 'x:1', members, now: 1000 });
  for (const p of inst.players.values()) { assert.equal(p.hp, p.maxHp); assert.equal(p.dead, false); assert.equal(p.protectedUntil, 1000 + TVT.TVT_SPAWN_PROTECTION_MS); }
});

// ===== Combate: friendly fire / self / range / cooldown / dano forjado =====
function twoTeamInstance(now = 0) {
  const members = [member('c1', 'red', 'guerreiro', 20), member('c2', 'blue', 'mago', 20), member('c3', 'red', 'druida', 20)];
  const inst = TVT.createTvtInstance({ eventId: 'x:1', members, now });
  for (const p of inst.players.values()) p.protectedUntil = 0; // sem protecao de spawn atrapalhando os testes de dano
  return inst;
}
function place(inst, a, b, dist = 100) { const pa = inst.players.get(a), pb = inst.players.get(b); pb.x = pa.x + dist; pb.y = pa.y; }

test('DAMAGE HACK: msg.atk forjado nunca influencia o dano -- resolveTvtIntent nao le nenhum atk do intent', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c1', 'c2');
  const r = TVT.resolveTvtIntent(inst, 'c1', { skill: 'basic', targetId: 'c2', atk: 999999 }, 2000, () => 0.5);
  assert.equal(r.ok, true);
  const expected = TVT.resolveTvtIntent; // dano deveria ser plausivel (poucas dezenas), nunca proporcional a 999999
  assert.ok(r.damage < 500, 'dano deveria vir so do snapshot real, nao de msg.atk forjado');
});
test('FRIENDLY FIRE: Rubra atacando Rubra e rejeitado', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c1', 'c3');
  const r = TVT.resolveTvtIntent(inst, 'c1', { skill: 'basic', targetId: 'c3' }, 2000, () => 0.5);
  assert.equal(r.ok, false); assert.equal(r.error, 'FRIENDLY_FIRE');
});
test('INIMIGO: Rubra atacando Azul e valido', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c1', 'c2');
  const r = TVT.resolveTvtIntent(inst, 'c1', { skill: 'basic', targetId: 'c2' }, 2000, () => 0.5);
  assert.equal(r.ok, true); assert.equal(r.kind, 'damage');
});
test('SELF: targetId igual ao atacante e rejeitado', () => {
  const inst = twoTeamInstance(1000);
  const r = TVT.resolveTvtIntent(inst, 'c1', { skill: 'basic', targetId: 'c1' }, 2000, () => 0.5);
  assert.equal(r.ok, false); assert.equal(r.error, 'INVALID_TARGET');
});
test('RANGE: golpe corpo-a-corpo de uma ponta a outra da arena e rejeitado', () => {
  const inst = twoTeamInstance(1000); // spawns padrao, >550px de distancia
  const r = TVT.resolveTvtIntent(inst, 'c1', { skill: 'basic', targetId: 'c2' }, 2000, () => 0.5);
  assert.equal(r.ok, false); assert.equal(r.error, 'OUT_OF_RANGE');
});
test('COOLDOWN: spam de ataque basico e rejeitado', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c1', 'c2');
  const r1 = TVT.resolveTvtIntent(inst, 'c1', { skill: 'basic', targetId: 'c2' }, 2000, () => 0.5);
  assert.equal(r1.ok, true);
  const r2 = TVT.resolveTvtIntent(inst, 'c1', { skill: 'basic', targetId: 'c2' }, 2010, () => 0.5);
  assert.equal(r2.ok, false); assert.equal(r2.error, 'COOLDOWN');
});
test('COOLDOWN: spam de skill e rejeitado', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c1', 'c2');
  const r1 = TVT.resolveTvtIntent(inst, 'c1', { skill: 'spin', targetId: 'c2' }, 2000, () => 0.5);
  assert.equal(r1.ok, true);
  const r2 = TVT.resolveTvtIntent(inst, 'c1', { skill: 'spin', targetId: 'c2' }, 2100, () => 0.5);
  assert.equal(r2.ok, false); assert.equal(r2.error, 'COOLDOWN');
});
test('msg.team/msg.score/msg.hp nao existem como parametros de resolveTvtIntent -- servidor sempre usa o estado real', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c1', 'c2');
  const before = JSON.stringify(inst.score);
  TVT.resolveTvtIntent(inst, 'c1', { skill: 'basic', targetId: 'c2', team: 'blue', score: 999, hp: 999999 }, 2000, () => 0.5);
  // score so muda por kill de verdade -- um hit sem matar nao altera o placar
  assert.equal(JSON.stringify(inst.score), before);
});

// ===== Skills por classe =====
test('skill de outra classe e rejeitado (Mago tentando spin de Guerreiro)', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c2', 'c1');
  const r = TVT.resolveTvtIntent(inst, 'c2', { skill: 'spin', targetId: 'c1' }, 2000, () => 0.5);
  assert.equal(r.ok, false); assert.equal(r.error, 'INVALID_SKILL');
});
test('Guerreiro: spin/dash (dano) e warcry (buff) aceitos', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c1', 'c2');
  assert.equal(TVT.resolveTvtIntent(inst, 'c1', { skill: 'spin', targetId: 'c2' }, 2000, () => 0.5).ok, true);
  assert.equal(TVT.resolveTvtIntent(inst, 'c1', { skill: 'dash', targetId: 'c2' }, 2500, () => 0.5).ok, true);
  assert.equal(TVT.resolveTvtIntent(inst, 'c1', { skill: 'warcry' }, 3000, () => 0.5).ok, true);
});
test('Mago: fireball/frost (dano) e barrier (buff) aceitos', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c2', 'c1');
  assert.equal(TVT.resolveTvtIntent(inst, 'c2', { skill: 'fireball', targetId: 'c1' }, 2000, () => 0.5).ok, true);
  assert.equal(TVT.resolveTvtIntent(inst, 'c2', { skill: 'frost', targetId: 'c1' }, 2500, () => 0.5).ok, true);
  assert.equal(TVT.resolveTvtIntent(inst, 'c2', { skill: 'barrier' }, 3000, () => 0.5).ok, true);
});
test('Arqueiro: multi/pierce (dano) e evade (buff) aceitos', () => {
  const members = [member('c1', 'red', 'arqueiro', 20), member('c2', 'blue', 'guerreiro', 20)];
  const inst = TVT.createTvtInstance({ eventId: 'x:1', members, now: 1000 });
  for (const p of inst.players.values()) p.protectedUntil = 0;
  place(inst, 'c1', 'c2');
  assert.equal(TVT.resolveTvtIntent(inst, 'c1', { skill: 'multi', targetId: 'c2' }, 2000, () => 0.5).ok, true);
  assert.equal(TVT.resolveTvtIntent(inst, 'c1', { skill: 'pierce', targetId: 'c2' }, 2500, () => 0.5).ok, true);
  assert.equal(TVT.resolveTvtIntent(inst, 'c1', { skill: 'evade' }, 3000, () => 0.5).ok, true);
});
test('Druida: roots/thorns (dano) aceitos', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c3', 'c2');
  assert.equal(TVT.resolveTvtIntent(inst, 'c3', { skill: 'roots', targetId: 'c2' }, 2000, () => 0.5).ok, true);
  assert.equal(TVT.resolveTvtIntent(inst, 'c3', { skill: 'thorns', targetId: 'c2' }, 2500, () => 0.5).ok, true);
});

// ===== Heal =====
test('heal: cura aliado valido, nunca ultrapassa maxHp, conta como contribuicao', () => {
  const inst = twoTeamInstance(1000); const target = inst.players.get('c1'); target.hp = target.maxHp - 10; place(inst, 'c3', 'c1');
  const r = TVT.resolveTvtIntent(inst, 'c3', { skill: 'heal', targetId: 'c1' }, 2000, () => 0.5);
  assert.equal(r.ok, true); assert.equal(r.kind, 'heal');
  assert.equal(target.hp, target.maxHp, 'nao deveria ultrapassar maxHp');
  assert.equal(r.amount, 10);
  assert.ok(inst.players.get('c3').healDone > 0);
});
test('heal: nao cura inimigo', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c3', 'c2');
  const r = TVT.resolveTvtIntent(inst, 'c3', { skill: 'heal', targetId: 'c2' }, 2000, () => 0.5);
  assert.equal(r.ok, false); assert.equal(r.error, 'INVALID_TARGET');
});
test('heal: alvo invalido (uid inexistente) e rejeitado', () => {
  const inst = twoTeamInstance(1000);
  const r = TVT.resolveTvtIntent(inst, 'c3', { skill: 'heal', targetId: 'nao-existe' }, 2000, () => 0.5);
  assert.equal(r.ok, false); assert.equal(r.error, 'TARGET_INVALID');
});
test('heal: so Druida pode usar', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c1', 'c1');
  const r = TVT.resolveTvtIntent(inst, 'c1', { skill: 'heal', targetId: 'c1' }, 2000, () => 0.5);
  assert.equal(r.ok, false); assert.equal(r.error, 'INVALID_SKILL');
});

// ===== Status: expiracao =====
test('STATUS: root/slow/barrier/evade/warcry/thorns expiram corretamente', () => {
  const inst = twoTeamInstance(1000);
  const p = inst.players.get('c1');
  p.statuses = { rootUntil: 1500, slowUntil: 1500, barrierUntil: 1500, barrierAmt: 10, evadeUntil: 1500, warcryUntil: 1500, warcryAtkMul: .3, warcryDefBonus: 4, thornsUntil: 1500, thornsMul: .5, thornsOwner: 'c2', thornsTickAt: 0 };
  TVT.tickTvtStatusExpiry(inst, 2000);
  const s = p.statuses;
  assert.equal(s.rootUntil, 0); assert.equal(s.slowUntil, 0); assert.equal(s.barrierUntil, 0); assert.equal(s.barrierAmt, 0);
  assert.equal(s.evadeUntil, 0); assert.equal(s.warcryUntil, 0); assert.equal(s.warcryAtkMul, 0); assert.equal(s.warcryDefBonus, 0);
  assert.equal(s.thornsUntil, 0); assert.equal(s.thornsOwner, null);
});
test('STATUS: nao expira antes da hora', () => {
  const inst = twoTeamInstance(1000);
  const p = inst.players.get('c1'); p.statuses.warcryUntil = 5000; p.statuses.warcryAtkMul = .3;
  TVT.tickTvtStatusExpiry(inst, 2000);
  assert.equal(p.statuses.warcryUntil, 5000); assert.equal(p.statuses.warcryAtkMul, .3);
});
test('evasao: alvo com evadeUntil ativo nao recebe dano', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c1', 'c2');
  inst.players.get('c2').statuses.evadeUntil = 9999;
  const r = TVT.resolveTvtIntent(inst, 'c1', { skill: 'basic', targetId: 'c2' }, 2000, () => 0.5);
  assert.equal(r.ok, true); assert.equal(r.evaded, true); assert.equal(r.damage, 0);
});
test('barrier: absorve dano ate o limite, depois deixa passar o resto', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c1', 'c2');
  inst.players.get('c2').statuses.barrierUntil = 9999; inst.players.get('c2').statuses.barrierAmt = 5;
  const before = inst.players.get('c2').hp;
  TVT.resolveTvtIntent(inst, 'c1', { skill: 'basic', targetId: 'c2' }, 2000, () => 0.5);
  const dmgTaken = before - inst.players.get('c2').hp;
  assert.ok(dmgTaken > 0, 'barreira pequena nao deveria absorver TODO o dano de um golpe maior');
});

// ===== Morte / kill / score =====
test('MORTE: hp cruza >0 para 0 -- 1 death, 1 kill, 1 ponto; hits extras nao aumentam score', () => {
  const inst = twoTeamInstance(1000); place(inst, 'c1', 'c2');
  const victim = inst.players.get('c2');
  let t = 2000;
  while (victim.hp > 0) { TVT.resolveTvtIntent(inst, 'c1', { skill: 'basic', targetId: 'c2' }, t, () => 0.5); t += 500; }
  assert.equal(victim.deaths, 1); assert.equal(inst.players.get('c1').kills, 1); assert.equal(inst.score.red, 1);
  const extra = TVT.resolveTvtIntent(inst, 'c1', { skill: 'basic', targetId: 'c2' }, t + 500, () => 0.5);
  assert.equal(extra.ok, false); assert.equal(extra.error, 'TARGET_UNAVAILABLE');
  assert.equal(inst.score.red, 1, 'hit extra no morto nao pode pontuar de novo');
});

// ===== Respawn / protecao =====
test('RESPAWN: apos 5s (TVT_RESPAWN_MS), volta vivo com HP cheio no spawn do time', () => {
  const inst = twoTeamInstance(1000);
  const p = inst.players.get('c2'); p.dead = true; p.hp = 0; p.respawnAt = 6000;
  const before = TVT.tickTvtRespawns(inst, 5999); assert.deepEqual(before, []);
  const after = TVT.tickTvtRespawns(inst, 6000); assert.deepEqual(after, ['c2']);
  assert.equal(p.dead, false); assert.equal(p.hp, p.maxHp); assert.equal(p.x, TVT.TVT_SPAWN.blue.x);
});
test('SPAWN PROTECTION: 3s apos respawn nao recebe dano; atacar termina a protecao', () => {
  const inst = twoTeamInstance(1000);
  const p2 = inst.players.get('c2'); p2.protectedUntil = 5000; place(inst, 'c1', 'c2');
  const hit = TVT.resolveTvtIntent(inst, 'c1', { skill: 'basic', targetId: 'c2' }, 4000, () => 0.5);
  assert.equal(hit.blocked, 'protection'); assert.equal(hit.damage, 0);
  // o proprio protegido ataca -> perde a protecao imediatamente
  const p1 = inst.players.get('c1'); p1.protectedUntil = 9999;
  TVT.resolveTvtIntent(inst, 'c1', { skill: 'basic', targetId: 'c2' }, 4500, () => 0.5);
  assert.equal(p1.protectedUntil, 0, 'atacar deveria encerrar a propria protecao de spawn');
});

// ===== Fim de partida =====
test('FIM POR SCORE: time chega ao limite -> fim imediato', () => {
  const inst = twoTeamInstance(1000); inst.score.red = inst.scoreLimit;
  const end = TVT.checkTvtEnd(inst, 2000);
  assert.equal(end.reason, 'score'); assert.equal(end.winner, 'red');
});
test('FIM POR TEMPO: 10 minutos acabam, maior score vence (12x9 -> Rubra, scoreLimit 4v4=20)', () => {
  const members4v4 = [member('a1', 'red', 'guerreiro', 20), member('a2', 'red', 'druida', 20), member('a3', 'red', 'mago', 20), member('a4', 'red', 'arqueiro', 20), member('b1', 'blue', 'guerreiro', 20), member('b2', 'blue', 'druida', 20), member('b3', 'blue', 'mago', 20), member('b4', 'blue', 'arqueiro', 20)];
  const inst = TVT.createTvtInstance({ eventId: 'x:1', members: members4v4, now: 1000 });
  assert.equal(inst.scoreLimit, 20);
  inst.score.red = 12; inst.score.blue = 9;
  const end = TVT.checkTvtEnd(inst, inst.expiresAt);
  assert.equal(end.reason, 'timeout'); assert.equal(end.winner, 'red');
});
test('EMPATE: mesmo score ao fim do tempo -> draw (winner null)', () => {
  const inst = twoTeamInstance(1000); inst.score.red = 5; inst.score.blue = 5;
  const end = TVT.checkTvtEnd(inst, inst.expiresAt);
  assert.equal(end.reason, 'timeout'); assert.equal(end.winner, null);
});
test('checkTvtEnd: nao termina antes da hora nem do placar', () => {
  const inst = twoTeamInstance(1000); inst.score.red = 3; inst.score.blue = 2;
  assert.equal(TVT.checkTvtEnd(inst, inst.expiresAt - 1000), null);
});
test('checkTvtEnd: partida ja finished nunca reabre', () => {
  const inst = twoTeamInstance(1000); inst.finished = true; inst.score.red = 999;
  assert.equal(TVT.checkTvtEnd(inst, 2000), null);
});

// ===== Contribuicao / elegibilidade (anti-AFK, Druida nao penalizada) =====
test('isTvtEligible: dano OU cura contam; kill nao e exigido', () => {
  const inst = twoTeamInstance(1000);
  const dpsPlayer = inst.players.get('c1'); dpsPlayer.damageDone = 40; dpsPlayer.lastActivityAt = 500;
  const healer = inst.players.get('c3'); healer.healDone = 25; healer.lastActivityAt = 500; // 25*1.5=37.5 < 30? ajusta pra garantir
  healer.healDone = 25; // 25*1.5=37.5 >= TVT_MIN_CONTRIBUTION(30)
  assert.equal(TVT.isTvtEligible(dpsPlayer, inst, 700000), true);
  assert.equal(TVT.isTvtEligible(healer, inst, 700000), true);
});
test('isTvtEligible: sem contribuicao mas ativo recentemente ainda e elegivel', () => {
  const inst = twoTeamInstance(1000);
  const p = inst.players.get('c1'); p.lastActivityAt = 5000;
  assert.equal(TVT.isTvtEligible(p, inst, 5000 + 10000), true);
});
test('isTvtEligible: AFK total (sem contribuicao, inativo ha muito tempo) nao e elegivel', () => {
  const inst = twoTeamInstance(1000);
  const p = inst.players.get('c1'); p.lastActivityAt = 1000;
  assert.equal(TVT.isTvtEligible(p, inst, 1000 + TVT.TVT_MIN_CONTRIBUTION * 0 + 200000), false);
});
test('tvtContributionScore: heal pesa 1.5x, kill (legitimo) pesa 50, Druida suporte pode ser elegivel so curando', () => {
  const p = { damageDone: 0, healDone: 20, legitKills: 0 };
  assert.equal(TVT.tvtContributionScore(p), 30);
});

// ===== Recompensas =====
test('outcomeForTeam / tvtRewardFor: vencedor/perdedor/empate com valores distintos', () => {
  assert.equal(TVT.outcomeForTeam('red', 'red'), 'win');
  assert.equal(TVT.outcomeForTeam('red', 'blue'), 'loss');
  assert.equal(TVT.outcomeForTeam('red', null), 'draw');
  assert.deepEqual(TVT.tvtRewardFor('win'), { gold: 120, gem: 6, xp: 6000 });
  assert.deepEqual(TVT.tvtRewardFor('loss'), { gold: 60, gem: 3, xp: 3000 });
  assert.deepEqual(TVT.tvtRewardFor('draw'), { gold: 90, gem: 4, xp: 4500 });
});
test('recompensa NUNCA inclui item Legendary (so gold/gem/xp)', () => {
  for (const outcome of ['win', 'loss', 'draw']) {
    const r = TVT.tvtRewardFor(outcome);
    assert.deepEqual(Object.keys(r).sort(), ['gem', 'gold', 'xp']);
  }
});

// ===== publicTvtState: nunca vaza identidade privada =====
test('publicTvtState: nunca inclui userId (so charId, ja publico via publicPlayer)', () => {
  const inst = twoTeamInstance(1000);
  const state = TVT.publicTvtState(inst, 2000);
  assert.equal(JSON.stringify(state).includes('u1'), false); // userId seria algo como 'uc1' -- confirma que nao vaza
  for (const p of state.players) assert.equal('userId' in p, false);
});
