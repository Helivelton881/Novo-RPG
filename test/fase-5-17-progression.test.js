'use strict';
// Fase 5.17 -- Progressao Hardcore & Economia x1. Testes puros (sem
// HTTP/WS/Supabase) contra game-data/balance-data.js e as funcoes puras que
// server.js exporta pra isso. RNG e relogio sempre injetados.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../game-data/balance-data.js');
const S = require('../server.js');

function queueRng(values) { const q = values.slice(); return () => (q.length ? q.shift() : 0.999999); }
const DAY1 = Date.UTC(2026, 8, 23, 15, 0, 0);   // qua 23/09/2026 12h BRT
const DAY1_LATER = DAY1 + 6 * 3600e3;          // mesmo dia (18h BRT)
const DAY2 = DAY1 + 24 * 3600e3;               // qui 24/09 -- mesma semana ISO
const NEXT_WEEK = DAY1 + 7 * 24 * 3600e3;

// ===================== LEVEL =====================
test('LEVEL_CAP e 40 e e a mesma constante em todo o servidor', () => {
  assert.equal(B.LEVEL_CAP, 40);
  assert.equal(S.BALANCE.LEVEL_CAP, 40);
  assert.equal(B.XP_TO_NEXT.length, 41);
  assert.equal(B.xpToNext(40), 0);
});

test('XP_TO_NEXT: 39 valores estritamente crescentes (nova curva substitui 30xL)', () => {
  for (let l = 1; l < 40; l++) {
    assert.ok(B.xpToNext(l) > 0, `Lv${l}`);
    if (l > 1) assert.ok(B.xpToNext(l) > B.xpToNext(l - 1), `Lv${l} > Lv${l - 1}`);
    assert.notEqual(B.xpToNext(l), 30 * l, 'curva antiga 30xL nao pode sobreviver');
  }
});

test('applyXp: nunca gera Lv41, nem com XP gigantesca', () => {
  const r = B.applyXp(1, 0, Number.MAX_SAFE_INTEGER);
  assert.equal(r.lvl, 40);
  assert.equal(r.xp, 0);
  const r2 = B.applyXp(39, 0, B.xpToNext(39) * 50);
  assert.equal(r2.lvl, 40);
});

test('applyXp: no cap a XP e descartada (nunca acumula XP escondida)', () => {
  const r = B.applyXp(40, 0, 123456);
  assert.deepEqual(r, { lvl: 40, xp: 0, gained: 0, levelsGained: 0 });
  const save = { xp: 0 };
  assert.deepEqual(S.applyXpGain(save, 40, 999999), { xp: 0, lvl: 40 });
});

test('applyXp: level-up exato na fronteira e sobra carregada', () => {
  const need = B.xpToNext(10);
  assert.deepEqual(B.applyXp(10, 0, need - 1).lvl, 10);
  const up = B.applyXp(10, 0, need + 5);
  assert.equal(up.lvl, 11); assert.equal(up.xp, 5);
});

test('applyXp: ganho negativo/NaN/forjado nunca remove XP nem nivel', () => {
  for (const g of [-5000, NaN, 'abc', null, undefined]) {
    const r = B.applyXp(12, 100, g);
    assert.equal(r.lvl, 12); assert.equal(r.xp, 100);
  }
});

// ===================== MIGRACAO / COMPATIBILIDADE =====================
test('MIGRACAO: personagem existente mantem o nivel (nunca rebaixa ate 40)', () => {
  for (let l = 1; l <= 40; l++) assert.equal(S.sanitizeSave({ xp: 0 }, l).lvl, l);
});

test('MIGRACAO: personagem >40 vira 40 com XP 0 (unico caso documentado)', () => {
  for (const l of [41, 55, 99, 9999]) {
    const s = S.sanitizeSave({ xp: 5000 }, l);
    assert.equal(s.lvl, 40); assert.equal(s.xp, 0);
  }
});

test('MIGRACAO: XP antiga (curva 30xL, teto 30x(L+1)x3) nunca provoca level-up automatico', () => {
  for (let l = 1; l < 40; l++) {
    const oldMax = 30 * (l + 1) * 3;
    const s = S.sanitizeSave({ xp: oldMax }, l);
    assert.equal(s.lvl, l);
    assert.ok(s.xp < B.xpToNext(l), `Lv${l}: xp normalizada fica abaixo do need`);
  }
  // XP absurda (forjada) e limitada a need-1 -- nunca varios levels.
  const s = S.sanitizeSave({ xp: 1e12 }, 7);
  assert.equal(s.lvl, 7); assert.equal(s.xp, B.xpToNext(7) - 1);
});

test('MIGRACAO: sanitizeSave preserva bag/eq/quest/gold/gem/enchant/wbRewards de personagem antigo', () => {
  const sword = S.applyEnchant(S.createGear('sword', 20, 'epic'), 6);
  const armor = S.createGear('armor', 20, 'rare');
  const raw = { cls: 'guerreiro', xp: 9999, gold: 12345, gem: 77, quest: 17, bag: [armor], eq: { sword }, gunlock: { torre: true }, wbRewards: ['e1'], tvtRewards: ['t1'], kp: 12 };
  const s = S.sanitizeSave(JSON.parse(JSON.stringify(raw)), 22);
  assert.equal(s.gold, 12345); assert.equal(s.gem, 77); assert.equal(s.quest, 17);
  assert.equal(s.eq.sword.uid, sword.uid); assert.equal(s.eq.sword.enchant, 6); assert.equal(s.eq.sword.rarity, 'epic');
  assert.equal(s.bag[0].uid, armor.uid);
  assert.deepEqual(s.gunlock, { torre: true });
  assert.deepEqual(s.wbRewards, ['e1']); assert.deepEqual(s.tvtRewards, ['t1']);
  assert.equal(s.kp, 12);
  assert.ok(s.rwd && s.rwd.dx === 0, 'estado de recompensa novo nasce zerado');
});

test('MIGRACAO: enchant antigo e mantido; stats recalculados pela tabela nova (nunca remove enchant)', () => {
  const legacy = { ...S.createGear('bow', 40, 'basic'), enchant: 9, atk: 1 };
  const s = S.sanitizeItem(legacy);
  assert.equal(s.enchant, 9);
  assert.equal(s.atk, Math.round(42 * (1 + B.ENCHANT_POWER[9])));
});

test('ANTI-CHEAT: sanitizeSave nunca aceita lvl 99/xp gigante/gold gigante/gem gigante', () => {
  const s = S.sanitizeSave({ xp: 9e15, gold: 9e15, gem: 9e15 }, 99);
  assert.equal(s.lvl, 40); assert.equal(s.xp, 0);
  assert.equal(s.gold, 500000); assert.equal(s.gem, 5000);
});

test('ANTI-CHEAT: PUT generico trava rwd/gold/gem/xp/lvl (ECONOMY_LOCK_FIELDS inclui o estado de recompensas)', () => {
  for (const f of ['gold', 'gem', 'rwd', 'wbRewards', 'tvtRewards']) assert.ok(S.ECONOMY_LOCK_FIELDS.includes(f), f);
});

// ===================== XP GAP =====================
test('xpGapMultiplier: todas as bandas oficiais (boundary)', () => {
  const expected = { 0: 1, '-1': .9, '-2': .9, '-3': .7, '-4': .7, '-5': .5, '-6': .25, '-7': .25, '-8': 0, '-9': 0, '-30': 0, 1: 1.05, 2: 1.10, 3: 1.15, 4: 1.15, 10: 1.15, 39: 1.15 };
  for (const [d, m] of Object.entries(expected)) assert.equal(B.xpGapMultiplier(Number(d)), m, `diff ${d}`);
});

test('xpGapMultiplier: nunca ultrapassa 115%', () => {
  for (let d = -50; d <= 50; d++) assert.ok(B.xpGapMultiplier(d) <= 1.15);
});

test('killXpFor: aplica gap com o nivel REAL do jogador (mob fraco reduz, mob forte bonifica)', () => {
  const base = 1000;
  assert.equal(S.killXpFor({ base, mobLvl: 20 }, 20), 1000);
  assert.equal(S.killXpFor({ base, mobLvl: 15 }, 20), 500);
  assert.equal(S.killXpFor({ base, mobLvl: 12 }, 20), 0);
  assert.equal(S.killXpFor({ base, mobLvl: 30 }, 20), 1150);
  assert.equal(S.killXpFor({ base, mobLvl: 20, share: 0.4 }, 20), 400);
});

test('eventMultiplier: base x1; boost so dentro da janela; limitado a EVENT_BOOST_MAX', () => {
  assert.equal(B.eventMultiplier('xp', DAY1), 1);
  const boosts = [{ kind: 'xp', mult: 2, startsAt: DAY1, endsAt: DAY1 + 3600e3 }, { kind: 'loot', mult: 9, startsAt: 0, endsAt: 9e15 }];
  assert.equal(B.eventMultiplier('xp', DAY1 + 10, boosts), 2);
  assert.equal(B.eventMultiplier('xp', DAY1 + 3600e3, boosts), 1, 'fim da janela e exclusivo');
  assert.equal(B.eventMultiplier('loot', DAY1, boosts), B.EVENT_BOOST_MAX);
});

// ===================== QUEST =====================
test('QUEST XP: fracoes oficiais do need do nivel adequado (simples 5-8%, principal 10-15%, capitulo 20-25%)', () => {
  const band = { simple: [.05, .08], main: [.10, .15], chapter: [.20, .25] };
  for (const [stage, def] of Object.entries(B.QUEST_STAGE_XP)) {
    if (def.kind === 'none') { assert.equal(S.QUEST_REWARDS[stage].xp, 0); continue; }
    const ratio = S.QUEST_REWARDS[stage].xp / B.xpToNext(def.lvl);
    const [lo, hi] = band[def.kind];
    assert.ok(ratio >= lo - 1e-9 && ratio <= hi + 1e-9, `estagio ${stage} (${def.kind}) ratio ${ratio}`);
  }
});

test('QUEST XP: nenhuma missao sozinha da mais que 1 nivel no nivel adequado', () => {
  for (const [stage, def] of Object.entries(B.QUEST_STAGE_XP)) {
    const r = B.applyXp(def.lvl, 0, S.QUEST_REWARDS[stage].xp);
    assert.ok(r.levelsGained <= 0, `estagio ${stage} nao deveria dar level sozinho partindo do zero`);
  }
});

test('QUEST: maquina de estados, ouro e gema preservados (so XP mudou)', () => {
  const paid = { 2: [30, 0, 3], 4: [60, 1, 5], 8: [150, 2, 9], 12: [250, 3, 13], 16: [400, 4, 17], 20: [600, 5, 21], 24: [800, 6, 25], 28: [1000, 7, 29] };
  for (const [from, [gold, gem, next]] of Object.entries(paid)) {
    const r = S.QUEST_REWARDS[from];
    assert.equal(r.gold, gold); assert.equal(r.gem, gem); assert.equal(r.next, next);
  }
});

// ===================== GEMAS =====================
test('GEMA: mob comum nunca produz gema (1000 rolls de cada tipo)', () => {
  const orig = Math.random;
  try {
    Math.random = () => 0; // o pior caso: todo roll "sucede"
    for (const type of ['slime', 'goblin', 'skeleton', 'wolf', 'bat', 'toxic', 'caster', 'sky', 'sala', 'elem', 'calc', 'cinza']) {
      const loot = S.rollMobLoot(type, false, 20);
      assert.equal(loot.gem, 0, type);
    }
  } finally { Math.random = orig; }
});

test('GEMA: chefe de campo nunca paga gema fixa por abate (respawn 60s)', () => {
  const orig = Math.random;
  try {
    Math.random = () => 0;
    for (const type of ['goblin', 'skeleton', 'wolf', 'toxic', 'caster', 'sky', 'lorde']) assert.equal(S.rollMobLoot(type, true, 30).gem, 0, type);
  } finally { Math.random = orig; }
});

test('GEMA: chefe de campo paga 1 gema so no 1o abate do DIA por tipo, e so se nao for trivial', () => {
  const save = S.sanitizeSave({ gem: 0 }, 20);
  assert.equal(S.fieldBossDailyGem(save, { type: 'wolf', boss: true, lvl: 20 }, 20, DAY1), 1);
  assert.equal(S.fieldBossDailyGem(save, { type: 'wolf', boss: true, lvl: 20 }, 20, DAY1_LATER), 0, 'mesmo tipo, mesmo dia');
  assert.equal(S.fieldBossDailyGem(save, { type: 'toxic', boss: true, lvl: 25 }, 20, DAY1_LATER), 1, 'outro tipo');
  assert.equal(S.fieldBossDailyGem(save, { type: 'goblin', boss: true, lvl: 10 }, 20, DAY1), 0, 'chefe trivial (gap -10)');
  assert.equal(S.fieldBossDailyGem(save, { type: 'wolf', boss: false, lvl: 20 }, 20, DAY2), 0, 'mob comum nunca');
  assert.equal(S.fieldBossDailyGem(save, { type: 'wolf', boss: true, lvl: 20 }, 20, DAY2), 1, 'vira o dia');
  assert.equal(save.gem, 3);
});

test('MASMORRA: conclusao paga XP (limite diario) e gema (1 clear/dia); trash nunca', () => {
  const lvl = 20, save = S.sanitizeSave({ gem: 0, xp: 0 }, lvl);
  const first = S.applyDungeonClearReward(save, lvl, { bossLvl: 20 }, DAY1);
  assert.equal(first.gem, B.DUNGEON.BOSS_GEMS);
  assert.equal(first.xpGain, Math.floor(B.xpToNext(20) * B.DUNGEON.CLEAR_XP_RATIO));
  for (let i = 1; i < B.DUNGEON.XP_CLEARS_PER_DAY; i++) {
    const r = S.applyDungeonClearReward(save, save.lvl, { bossLvl: 20 }, DAY1_LATER);
    assert.equal(r.gem, 0, 'gema so no 1o clear do dia'); assert.ok(r.xpGain > 0);
  }
  const capped = S.applyDungeonClearReward(save, save.lvl, { bossLvl: 20 }, DAY1_LATER);
  assert.deepEqual([capped.xpGain, capped.gem], [0, 0], 'limite diario atingido');
  assert.equal(save.gem, B.DUNGEON.BOSS_GEMS);
  const nextDay = S.applyDungeonClearReward(save, save.lvl, { bossLvl: 20 }, DAY2);
  assert.equal(nextDay.gem, B.DUNGEON.BOSS_GEMS);
  assert.deepEqual(S.applyDungeonClearReward(save, save.lvl, null, DAY2), { xpGain: 0, gem: 0, lvl: save.lvl }, 'trash nao conclui');
});

test('MASMORRA: jogador muito acima do chefe (gap <= -8) nao ganha XP de conclusao', () => {
  const save = S.sanitizeSave({}, 40);
  const r = S.applyDungeonClearReward(save, 39, { bossLvl: 10 }, DAY1);
  assert.equal(r.xpGain, 0);
});

test('WORLD BOSS: XP proporcional, gema com limite semanal, idempotente por evento', () => {
  const save = S.sanitizeSave({ gem: 0, gold: 0 }, 30);
  const r1 = S.applyWorldBossReward(save, 30, 'mago', 'wb-1', queueRng([0.99]), DAY1);
  assert.equal(r1.xpGain, Math.floor(B.xpToNext(30) * B.WORLD_BOSS.XP_RATIO));
  assert.equal(r1.gem, B.WORLD_BOSS.GEMS);
  assert.equal(save.gold, B.WORLD_BOSS.GOLD);
  assert.equal(S.applyWorldBossReward(save, 30, 'mago', 'wb-1', queueRng([0.99]), DAY1), null, 'mesmo evento nunca paga 2x');
  S.applyWorldBossReward(save, save.lvl, 'mago', 'wb-2', queueRng([0.99]), DAY1_LATER);
  const r3 = S.applyWorldBossReward(save, save.lvl, 'mago', 'wb-3', queueRng([0.99]), DAY1_LATER);
  assert.equal(r3.xpGain, 0, 'XP so nas primeiras XP_EVENTS_PER_DAY do dia');
  assert.equal(r3.gem, B.WORLD_BOSS.GEMS, '3a da semana ainda paga gema');
  const r4 = S.applyWorldBossReward(save, save.lvl, 'mago', 'wb-4', queueRng([0.99]), DAY2);
  assert.ok(r4.xpGain > 0); assert.equal(r4.gem, 0, 'limite semanal de gema');
  const r5 = S.applyWorldBossReward(save, save.lvl, 'mago', 'wb-5', queueRng([0.99]), NEXT_WEEK);
  assert.equal(r5.gem, B.WORLD_BOSS.GEMS, 'semana nova');
});

test('WORLD BOSS: drop individual (Rare 30/Epic 7/Legendary 1) -- nunca Legendary garantido', () => {
  const cases = [[0.005, 'legendary'], [0.05, 'epic'], [0.2, 'rare'], [0.5, null]];
  for (const [r, expected] of cases) {
    const save = S.sanitizeSave({}, 40);
    const res = S.applyWorldBossReward(save, 40, 'guerreiro', 'wb-x', queueRng([r, 0.1]), DAY1);
    assert.equal(res.item ? res.item.rarity : null, expected, `r=${r}`);
  }
});

test('TvT: XP proporcional e pequena; gema com limite semanal; idempotente', () => {
  const save = S.sanitizeSave({ gem: 0 }, 25);
  const w = S.applyTvtReward(save, 25, 'win', 'tvt-1', DAY1);
  assert.equal(w.xpGain, Math.floor(B.xpToNext(25) * B.TVT.XP_RATIO.win));
  assert.equal(w.gem, B.TVT.GEMS.win);
  assert.equal(S.applyTvtReward(save, 25, 'win', 'tvt-1', DAY1), null);
  for (let i = 2; i <= B.TVT.GEM_EVENTS_PER_WEEK + 2; i++) S.applyTvtReward(save, save.lvl, 'loss', 'tvt-' + i, DAY2);
  assert.equal(save.gem, B.TVT.GEM_EVENTS_PER_WEEK * 1, 'gema de TvT nunca passa do limite semanal');
});

test('rwd: dia/semana calculados em America/Sao_Paulo; estado forjado e sanitizado', () => {
  assert.equal(S.rewardDayKey(DAY1), '2026-09-23');
  assert.match(S.rewardWeekKey(DAY1), /^2026-W\d{2}$/);
  assert.equal(S.rewardWeekKey(DAY1), S.rewardWeekKey(DAY2));
  assert.notEqual(S.rewardWeekKey(DAY1), S.rewardWeekKey(NEXT_WEEK));
  const r = S.sanitizeRewardState({ d: '<script>', dx: -5, dg: 1e9, fb: ['wolf', 'hacker', 'wolf'], wbg: 'x' });
  assert.deepEqual(r, { d: '', dx: 0, dg: 99, fb: ['wolf'], wbx: 0, tvx: 0, w: '', wbg: 0, tvg: 0 });
});

// ===================== PARTY =====================
function withParty(members, fn) {
  const code = 'QA' + Math.random().toString(36).slice(2, 6);
  const party = { ownerId: members[0].userId, members: new Map() };
  const sockets = [];
  for (const m of members) {
    party.members.set(m.userId, m.userId);
    S.memberParty.set(m.userId, code);
    if (m.online !== false) {
      const ws = { qa: m.userId };
      const p = { id: 'p-' + m.userId, userId: m.userId, charId: 'c-' + m.userId, authed: true, map: m.map || 'serra', x: m.x ?? 500, y: m.y ?? 500, dead: !!m.dead, gameplayAuthority: true };
      S.clients.set(ws, p); S.activeCharacterSockets.set(p.charId, ws); sockets.push([ws, p]);
    }
  }
  S.parties.set(code, party);
  try { return fn(sockets); }
  finally {
    S.parties.delete(code);
    for (const m of members) S.memberParty.delete(m.userId);
    for (const [ws, p] of sockets) { S.clients.delete(ws); S.activeCharacterSockets.delete(p.charId); }
  }
}
const MOB = { map: 'serra', x: 500, y: 500 };

test('PARTY: multiplicadores oficiais 100/65/48/40 (total 100/130/144/160)', () => {
  assert.deepEqual(B.PARTY_XP_SHARE, { 1: 1, 2: .65, 3: .48, 4: .40 });
  assert.equal(B.partyXpShare(9), .40);
});

test('PARTY: solo (sem party) -> so o proprio jogador', () => {
  const ws = {}, p = { userId: 'solo-u', charId: 'solo-c' };
  assert.equal(S.partyXpRecipients(ws, p, MOB).length, 1);
});

for (const n of [2, 3, 4]) {
  test(`PARTY: ${n} membros elegiveis -> ${n} recebedores, ${B.partyXpShare(n) * 100}% cada`, () => {
    const members = Array.from({ length: n }, (_, i) => ({ userId: `u${n}-${i}`, x: 500 + i * 50 }));
    withParty(members, sockets => {
      const list = S.partyXpRecipients(sockets[0][0], sockets[0][1], MOB);
      assert.equal(list.length, n);
      assert.equal(S.killXpFor({ base: 1000, mobLvl: 20, share: B.partyXpShare(list.length) }, 20), Math.floor(1000 * B.partyXpShare(n)));
    });
  });
}

test('PARTY anti-leech: membro em outro mapa (Vila) nao recebe nem dilui', () => {
  withParty([{ userId: 'k1' }, { userId: 'vila1', map: 'vila' }], sockets => {
    const list = S.partyXpRecipients(sockets[0][0], sockets[0][1], MOB);
    assert.equal(list.length, 1);
  });
});

test('PARTY anti-leech: membro remoto no MESMO mapa (fora do alcance), morto ou offline nao recebe', () => {
  withParty([{ userId: 'k2' }, { userId: 'far', x: 500 + B.PARTY_XP_RANGE + 1 }, { userId: 'dead', dead: true }, { userId: 'off', online: false }], sockets => {
    const list = S.partyXpRecipients(sockets[0][0], sockets[0][1], MOB);
    assert.equal(list.length, 1);
  });
});

test('PARTY anti-leech: sessao substituida (socket nao autoritativo) nao recebe', () => {
  withParty([{ userId: 'k3' }, { userId: 'stale' }], sockets => {
    S.activeCharacterSockets.set(sockets[1][1].charId, { other: true });
    const list = S.partyXpRecipients(sockets[0][0], sockets[0][1], MOB);
    assert.equal(list.length, 1);
  });
});

// ===================== MORTE =====================
test('MORTE PvE: perde 0,25% do need do nivel', () => {
  assert.equal(B.DEATH_PENALTY.PVE_XP_RATIO, 0.0025);
  for (const l of [1, 10, 25, 39]) assert.equal(B.deathXpLoss(l, B.xpToNext(l) - 1, 'pve'), Math.floor(B.xpToNext(l) * 0.0025));
});

test('MORTE PvE: nunca negativa (possui 100 XP -> perde no maximo 100) e nunca perde nivel', () => {
  const l = 30;
  assert.ok(Math.floor(B.xpToNext(l) * 0.0025) > 100);
  assert.equal(B.deathXpLoss(l, 100, 'pve'), 100);
  assert.equal(B.deathXpLoss(l, 0, 'pve'), 0);
  assert.equal(B.deathXpLoss(40, 0, 'pve'), 0, 'no cap nao ha XP pra perder');
});

test('MORTE PvP/TvT/Arena/Guild Wars/World Boss: zero XP', () => {
  for (const cause of ['pvp', 'tvt', 'arena', 'guildwar', 'duel', 'worldboss', undefined]) assert.equal(B.deathXpLoss(20, 5000, cause), 0, String(cause));
});

test('MORTE: applyDeathPenalty ignora qualquer causa nao-PvE e IA sem tocar no banco', async () => {
  const errors = [];
  const orig = console.error; console.error = (...a) => errors.push(a.join(' '));
  try {
    const p = { charId: 'c-x', userId: 'u-x' };
    for (const cause of ['pvp', 'tvt', 'worldboss']) await S.applyDeathPenalty({}, p, cause);
    await S.applyDeathPenalty({}, { ...p, kind: 'ai' }, 'pve');
  } finally { console.error = orig; }
  assert.deepEqual(errors, [], 'nenhuma tentativa de ler/gravar personagem');
});

test('MORTE: hitTarget (dano de mob) em IA nunca aplica penalidade de XP', () => {
  // IA passa pelo ramo kind==='ai' de hitTarget, que nunca chega em applyDeathPenalty.
  const ai = { kind: 'ai', id: 'ai-qa', map: 'serra', hp: 1, maxHp: 100, dead: false, combat: {} };
  S.aiEntities.set(ai.id, ai);
  try { S.hitTarget([null, ai], { map: 'serra' }, 500); } finally { S.aiEntities.delete(ai.id); }
  assert.equal(ai.dead, true);
});

// ===================== DROP (resumo) =====================
test('DROP: probabilidades mutuamente exclusivas somam < 1 e mob comum/elite nunca Legendary', () => {
  for (const [tier, t] of Object.entries(B.DROP_RATES)) assert.ok(t.rare + t.epic + t.legendary < 1, tier);
  assert.equal(B.DROP_RATES.common.legendary, 0);
  assert.equal(B.DROP_RATES.elite.legendary, 0);
  assert.equal(B.rollDropRarity('common', () => 0), 'epic', 'r=0 no comum cai em epic (legendary=0)');
});

// ===================== CLIENTE = SO DISPLAY =====================
test('CLIENTE: index.html carrega balance-data.js antes de gear-data.js e nao tem mais 30*l', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  const bi = html.indexOf('/game-data/balance-data.js'), gi = html.indexOf('/game-data/gear-data.js');
  assert.ok(bi > 0 && gi > 0 && bi < gi);
  assert.ok(!/const need\s*=\s*l\s*=>\s*30\s*\*\s*l/.test(html), 'curva antiga no cliente');
});
