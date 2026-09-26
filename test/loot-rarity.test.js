'use strict';
// Fase 5.3 -- drops de equipamento por raridade. Testes puros (sem HTTP/WS/
// Supabase), direto contra o que server.js exporta pra isso. RNG e sempre
// injetado (nunca Math.random real) pra chance baixa (0.25%/2.5%/5%) ser
// testavel de forma deterministica, sem flake.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server.js');

// Fila de valores pre-definidos consumidos em ordem por cada roll() --
// permite controlar exatamente qual branch (epic/rare/nada, legendary/nada,
// tipo sorteado) uma chamada de rollGearDrop vai tomar.
function queueRng(values) {
  const q = values.slice();
  return () => (q.length ? q.shift() : 0.999999);
}

test('gearLevelForMob: maior GEAR_LEVEL que nao ultrapassa o nivel real do mob', () => {
  const table = {
    1: 1, 3: 1, 4: 4, 5: 4, 8: 8, 10: 8, 12: 12, 15: 12, 16: 16, 19: 16,
    20: 20, 23: 20, 24: 24, 27: 24, 28: 28, 31: 28, 32: 32, 35: 32,
    36: 36, 39: 36, 40: 40, 99: 40,
  };
  for (const [lvl, expected] of Object.entries(table)) {
    assert.equal(S.gearLevelForMob(Number(lvl)), expected, `mob lv${lvl}`);
  }
});

test('gearLevelForMob: nunca retorna nivel fora de GEAR_DATA.GEAR_LEVELS', () => {
  for (let lvl = 1; lvl <= 99; lvl++) {
    assert.ok(S.GEAR_DATA.GEAR_LEVELS.includes(S.gearLevelForMob(lvl)), `lv${lvl}`);
  }
});

test('GEAR_DROP_RATES (Fase 5.17): alias da fonte central BALANCE.DROP_RATES com os valores oficiais', () => {
  assert.equal(S.GEAR_DROP_RATES, S.BALANCE.DROP_RATES);
  assert.deepEqual(S.GEAR_DROP_RATES.common, { rare: 0.003, epic: 0.0003, legendary: 0 });
  assert.deepEqual(S.GEAR_DROP_RATES.elite, { rare: 0.03, epic: 0.003, legendary: 0 });
  assert.deepEqual(S.GEAR_DROP_RATES.dungeonBoss, { rare: 0.12, epic: 0.025, legendary: 0.003 });
  assert.deepEqual(S.GEAR_DROP_RATES.worldBoss, { rare: 0.30, epic: 0.07, legendary: 0.01 });
  assert.equal(S.BALANCE.FIELD_BOSS_DROP_TIER, 'elite', 'chefe de campo usa a tabela de elite (sem Legendary)');
});

test('DROP_TYPES_BY_CLASS: exatamente arma da classe + armor + cape + boots, nunca escudo/capacete/joia', () => {
  assert.deepEqual(S.DROP_TYPES_BY_CLASS.guerreiro, ['sword', 'armor', 'cape', 'boots']);
  assert.deepEqual(S.DROP_TYPES_BY_CLASS.arqueiro, ['bow', 'armor', 'cape', 'boots']);
  assert.deepEqual(S.DROP_TYPES_BY_CLASS.mago, ['staffm', 'armor', 'cape', 'boots']);
  assert.deepEqual(S.DROP_TYPES_BY_CLASS.druida, ['staffd', 'armor', 'cape', 'boots']);
  for (const cls of Object.keys(S.DROP_TYPES_BY_CLASS)) {
    for (const bad of ['shield', 'helmet', 'jewel']) assert.ok(!S.DROP_TYPES_BY_CLASS[cls].includes(bad), `${cls} nao deveria poder dropar ${bad}`);
  }
});

// Fase 5.17: UM unico roll decide a raridade (faixas acumuladas
// legendary -> epic -> rare), o segundo roll decide o tipo.
function boundaryCases(tier) {
  const t = S.BALANCE.DROP_RATES[tier], e = 1e-9;
  const L = t.legendary, LE = t.legendary + t.epic, LER = t.legendary + t.epic + t.rare;
  const out = [];
  if (L > 0) out.push([L - e, 'legendary']);
  out.push([L, t.epic > 0 ? 'epic' : 'rare'], [LE - e, 'epic'], [LE, 'rare'], [LER - e, 'rare'], [LER, null], [0.999999, null]);
  return out;
}
for (const tier of ['common', 'elite', 'dungeonBoss', 'worldBoss']) {
  test(`rollGearDrop (${tier}): fronteiras exatas do roll unico (boundary RNG)`, () => {
    for (const [r, expected] of boundaryCases(tier)) {
      const drop = S.rollGearDrop({ mobLevel: 30, tier, cls: 'guerreiro', rng: queueRng([r, 0.1]) });
      assert.equal(drop ? drop.rarity : null, expected, `${tier} r=${r}`);
    }
  });
}

test('rollGearDrop: mob comum e elite NUNCA geram Legendary nem Basic', () => {
  for (const tier of ['common', 'elite']) {
    for (let i = 0; i <= 1000; i++) {
      const drop = S.rollGearDrop({ mobLevel: 30, tier, cls: 'mago', rng: queueRng([i / 1000 * 0.05, 0.3]) });
      if (drop) { assert.notEqual(drop.rarity, 'legendary'); assert.notEqual(drop.rarity, 'basic'); }
    }
  }
});

test('rollGearDrop: boss:true sem tier = chefe de CAMPO = tabela elite (nunca Legendary)', () => {
  assert.equal(S.rollGearDrop({ mobLevel: 40, boss: true, cls: 'arqueiro', rng: queueRng([0, 0.4]) }).rarity, 'epic');
  assert.equal(S.rollGearDrop({ mobLevel: 40, boss: true, cls: 'arqueiro', rng: queueRng([0.01, 0.4]) }).rarity, 'rare');
  assert.equal(S.rollGearDrop({ mobLevel: 40, boss: true, cls: 'arqueiro', rng: queueRng([0.5]) }), null);
});

test('rollGearDrop: no maximo UM item especial por roll (mutuamente exclusivo, 1 roll de raridade)', () => {
  let calls = 0;
  const rng = () => { calls++; return 0; };
  const drop = S.rollGearDrop({ mobLevel: 40, tier: 'worldBoss', cls: 'druida', rng });
  assert.equal(drop.rarity, 'legendary');
  assert.equal(calls, 2, '1 roll de raridade + 1 roll de tipo, nunca rolls extras por raridade');
});

test('rollGearDrop: tipo sempre dentro de DROP_TYPES_BY_CLASS da classe real (nunca fora da classe)', () => {
  for (const cls of ['guerreiro', 'arqueiro', 'mago', 'druida']) {
    for (let i = 0; i < 20; i++) {
      const rng = queueRng([0.0001, i / 20]);
      const drop = S.rollGearDrop({ mobLevel: 20, boss: false, cls, rng });
      assert.ok(drop);
      assert.ok(S.DROP_TYPES_BY_CLASS[cls].includes(drop.type), `${cls} nao deveria receber ${drop.type}`);
    }
  }
});

test('rollGearDrop: modelo canonico completo -- enchant 0, uid valido (UUID), stats/req/nome de GEAR_DATA', () => {
  const rng = queueRng([0.001, 0.4]);
  const drop = S.rollGearDrop({ mobLevel: 24, tier: 'dungeonBoss', cls: 'guerreiro', rng });
  assert.equal(drop.item.enchant, 0);
  assert.match(drop.item.uid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const expectedStats = S.GEAR_DATA.statsFor(drop.item.type, drop.item.lv, 'legendary');
  assert.equal(drop.item.req, expectedStats.req);
  assert.equal(drop.item.n, S.GEAR_DATA.nameFor(drop.item.type, drop.item.lv));
  if (expectedStats.atk) assert.equal(drop.item.atk, expectedStats.atk);
});

test('rollGearDrop: dois drops identicos (mesmo tipo/nivel/rarity) tem UIDs diferentes -- nunca reutiliza uid', () => {
  const rngA = queueRng([0.001, 0]), rngB = queueRng([0.001, 0]);
  const a = S.rollGearDrop({ mobLevel: 20, boss: false, cls: 'guerreiro', rng: rngA });
  const b = S.rollGearDrop({ mobLevel: 20, boss: false, cls: 'guerreiro', rng: rngB });
  assert.equal(a.type, b.type); assert.equal(a.lv, b.lv); assert.equal(a.rarity, b.rarity);
  assert.notEqual(a.item.uid, b.item.uid);
});

test('rollGearDrop: Legendario de nivel baixo nao supera Basico de nivel alto (GEAR_DATA preservado, nao rebalanceado)', () => {
  const lowLegendary = S.createGear('sword', 1, 'legendary');
  const highBasic = S.createGear('sword', 40, 'basic');
  assert.ok(highBasic.atk > lowLegendary.atk, 'progressao de nivel ainda deveria pesar mais que raridade');
});

test('applyGearDrops: item concedido com sucesso (slot vazio) -- granted preenchido, lost nulo', () => {
  const save = { eq: {}, bag: [] };
  const item = S.createGear('cape', 8, 'rare');
  const { granted, lost } = S.applyGearDrops(save, 8, [item]);
  assert.equal(granted.uid, item.uid);
  assert.equal(lost, null);
  assert.equal(save.eq.cape.uid, item.uid);
});

test('applyGearDrops: mochila cheia (24 itens) e slot ocupado -- item perdido, nao duplica, nao altera outro item', () => {
  const bagFull = Array.from({ length: 24 }, () => S.createGear('boots', 1, 'basic'));
  const save = { eq: { cape: S.createGear('cape', 1, 'basic') }, bag: bagFull };
  const before = save.bag.length;
  const beforeEq = save.eq.cape.uid;
  const item = S.createGear('cape', 12, 'epic');
  const { granted, lost } = S.applyGearDrops(save, 12, [item]);
  assert.equal(granted, null);
  assert.equal(lost.uid, item.uid);
  assert.equal(save.bag.length, before, 'mochila cheia nao deveria ganhar item nenhum');
  assert.equal(save.eq.cape.uid, beforeEq, 'item ja equipado nao deveria ser sobrescrito');
});

test('applyGearDrops: item acima do nivel do personagem NAO auto-equipa, vai pra mochila se houver espaco', () => {
  const save = { eq: {}, bag: [] };
  const item = S.createGear('armor', 40, 'legendary'); // req 40
  const { granted } = S.applyGearDrops(save, 1, [item]); // personagem Nv1
  assert.ok(granted);
  assert.equal(save.eq.armor, undefined, 'nao deveria ter auto-equipado acima do nivel');
  assert.equal(save.bag.length, 1);
  assert.equal(save.bag[0].uid, item.uid);
});

test('rollDungeonTrashLoot: nao gera mais Basic garantido (compatibilidade da Fase 5.2 removida) -- so nada, Rare ou Epic', () => {
  for (let i = 0; i < 60; i++) {
    const loot = S.rollDungeonTrashLoot(20, 'mago');
    assert.ok(Array.isArray(loot.items));
    assert.ok(loot.items.length <= 1, 'no maximo 1 item por trash');
    for (const it of loot.items) { assert.notEqual(it.rarity, 'basic'); assert.notEqual(it.rarity, 'legendary'); }
  }
});

test('rollDungeonTrashLoot: gold/pv preservados; gema = 0 (Fase 5.17)', () => {
  const loot = S.rollDungeonTrashLoot(20, 'guerreiro');
  assert.ok(loot.gold >= 3 && loot.gold <= 3 * 8 + 2 * 8); // 3-5 moedas de 1-6
  assert.equal(loot.gem, 0);
  assert.ok(typeof loot.pv === 'number' && (loot.pv === 0 || loot.pv === 1));
});

test('rollDungeonBossLoot: no maximo 1 item, tabela dungeonBoss (Rare/Epic/Legendary)', () => {
  for (let i = 0; i < 60; i++) {
    const loot = S.rollDungeonBossLoot('arqueiro', 20);
    assert.ok(loot.items.length <= 1, 'no maximo 1 item de chefe de masmorra');
    for (const it of loot.items) assert.ok(['rare', 'epic', 'legendary'].includes(it.rarity));
  }
});

test('rollDungeonBossLoot: ouro/pocao preservados; gema saiu do loot (vai pela recompensa diaria de conclusao)', () => {
  const loot = S.rollDungeonBossLoot('guerreiro', 40);
  assert.equal(loot.gem, 0);
  assert.equal(loot.pv, 1);
  assert.ok(loot.gold >= 22);
  assert.deepEqual(loot.bossClear, { bossLvl: 40 });
});

test('rollDungeonBossLoot: nivel do item segue gearLevelForMob(bossLvl), nao mais fixo em lv12', () => {
  const rng = queueRng([0.001, 0.5]);
  const drop = S.rollGearDrop({ mobLevel: 40, boss: true, cls: 'guerreiro', rng });
  assert.equal(drop.lv, 40, 'chefe de masmorra do vulcao (lv40) deveria dar item lv40, nao lv12 fixo');
});

test('sellPriceForItem: multiplicador por raridade (1x/2x/4x/8x) aplicado sobre o preco base por nivel', () => {
  const base = S.GEAR_DATA.sellPriceFor(20); // 320
  assert.equal(S.GEAR_DATA.sellPriceForItem({ lv: 20, rarity: 'basic' }), base);
  assert.equal(S.GEAR_DATA.sellPriceForItem({ lv: 20, rarity: 'rare' }), base * 2);
  assert.equal(S.GEAR_DATA.sellPriceForItem({ lv: 20, rarity: 'epic' }), base * 4);
  assert.equal(S.GEAR_DATA.sellPriceForItem({ lv: 20, rarity: 'legendary' }), base * 8);
});

test('sellPriceForItem: arredonda pra inteiro', () => {
  const price = S.GEAR_DATA.sellPriceForItem({ lv: 1, rarity: 'rare' }); // 8*2=16, ja inteiro; confirma que nunca quebra em decimal
  assert.equal(Number.isInteger(price), true);
});
