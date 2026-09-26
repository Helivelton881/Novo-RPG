'use strict';
// Fase 5.4 (Ferreiro) + Fase 5.17 (enchant x1: ouro +1..+3, gemas +4..+10,
// falha NUNCA destroi/reduz). Testes puros (sem HTTP/WS/Supabase), direto
// contra o que server.js/gear-data.js/balance-data.js exportam. RNG sempre
// injetado (nunca Math.random/crypto reais) pra testar limites exatos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server.js');
const D = require('../game-data/gear-data.js');
const B = require('../game-data/balance-data.js');

function queueRng(values) {
  const q = values.slice();
  return () => (q.length ? q.shift() : 0.999999);
}

// ===== Tabela de chances (Fase 5.17) =====
test('ENCHANT_SUCCESS: tabela oficial exata da 5.17 (+1..+3=100%, +4 80% ... +10 15%)', () => {
  assert.deepEqual(B.ENCHANT_SUCCESS, { 1: 1.00, 2: 1.00, 3: 1.00, 4: 0.80, 5: 0.70, 6: 0.60, 7: 0.50, 8: 0.35, 9: 0.25, 10: 0.15 });
  assert.equal(D.ENCHANT_SUCCESS, B.ENCHANT_SUCCESS, 'gear-data consome a fonte central, nunca uma copia');
});

test('enchantChance: +1..+10 batem com a tabela; +11 e +0 invalidos (null)', () => {
  for (const t of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) assert.equal(D.enchantChance(t), B.ENCHANT_SUCCESS[t]);
  assert.equal(D.enchantChance(11), null);
  assert.equal(D.enchantChance(0), null);
});

test('rollEnchantSuccess: fronteiras exatas de TODAS as chances +4..+10 (roll<chance sucede, roll===chance falha)', () => {
  for (let t = 4; t <= 10; t++) {
    const c = B.ENCHANT_SUCCESS[t];
    assert.equal(S.rollEnchantSuccess(t, queueRng([c - 0.0001])), true, `+${t} abaixo da chance`);
    assert.equal(S.rollEnchantSuccess(t, queueRng([c])), false, `+${t} na fronteira`);
  }
});

test('rollEnchantSuccess: +1/+2/+3 sempre true, mesmo com rng hostil (perto de 1)', () => {
  for (const t of [1, 2, 3]) assert.equal(S.rollEnchantSuccess(t, queueRng([0.999999])), true);
});

test('rollEnchantSuccess: alvo invalido (+11) nunca sucede', () => {
  assert.equal(S.rollEnchantSuccess(11, queueRng([0])), false);
});

// ===== Custo (Fase 5.17) =====
test('custo +1..+3 em OURO: itemLv x rarityMul x alvo x 10 (arredondado a multiplo de 10)', () => {
  assert.deepEqual(B.ENCHANT_RARITY_GOLD_MUL, { basic: 1.0, rare: 1.5, epic: 2.5, legendary: 4.0 });
  const cases = [
    [5, 'basic', [50, 100, 150]],
    [20, 'rare', [300, 600, 900]],
    [36, 'epic', [900, 1800, 2700]],
    [36, 'legendary', [1440, 2880, 4320]],
    [40, 'legendary', [1600, 3200, 4800]],
  ];
  for (const [lv, rarity, expected] of cases) {
    for (let t = 1; t <= 3; t++) assert.deepEqual(B.enchantCostFor(lv, rarity, t), { currency: 'gold', amount: expected[t - 1] }, `${rarity} Lv${lv} +${t}`);
  }
});

test('custo em ouro: minimo de 10 (Basic Lv1 +1 = 10)', () => {
  assert.deepEqual(B.enchantCostFor(1, 'basic', 1), { currency: 'gold', amount: 10 });
});

test('custo +4..+10 em GEMAS: tabela exata 1/2/3/4/6/8/12, independente de lv/rarity', () => {
  const expected = { 4: 1, 5: 2, 6: 3, 7: 4, 8: 6, 9: 8, 10: 12 };
  for (const [t, gems] of Object.entries(expected)) {
    for (const [lv, rarity] of [[1, 'basic'], [40, 'legendary']]) assert.deepEqual(B.enchantCostFor(lv, rarity, Number(t)), { currency: 'gem', amount: gems });
  }
});

test('custo: alvo invalido devolve null', () => {
  assert.equal(B.enchantCostFor(40, 'basic', 11), null);
  assert.equal(B.enchantCostFor(40, 'basic', 0), null);
});

// ===== +0 é 100% compatível (regressão explícita) =====
test('REGRESSAO: statsFor com enchant=0 (ou omitido) produz EXATAMENTE os mesmos stats', () => {
  const cases = [
    ['sword', 1, 'basic'], ['sword', 40, 'legendary'], ['bow', 20, 'rare'], ['staffm', 8, 'epic'],
    ['armor', 40, 'basic'], ['armor', 1, 'legendary'], ['cape', 24, 'rare'], ['boots', 40, 'epic'],
    ['shield', 12, 'basic'], ['helmet', 20, 'rare'], ['jewel', 40, 'legendary'],
  ];
  for (const [type, lv, rarity] of cases) {
    const withEnchant0 = D.statsFor(type, lv, rarity, 0);
    const withoutArg = D.statsFor(type, lv, rarity);
    assert.deepEqual(withEnchant0, withoutArg, `${type} lv${lv} ${rarity}`);
    const b = D.GEAR_STATS[type][lv], mul = D.RARITY[rarity].mul;
    if (b.atk) assert.equal(withoutArg.atk, Math.round(b.atk * mul));
  }
});

// ===== Poder acumulado oficial (Fase 5.17) =====
test('ENCHANT_POWER: bonus acumulado oficial exato (+10 = 27,5%, nunca dobra o item)', () => {
  assert.deepEqual(B.ENCHANT_POWER, { 0: 0, 1: 0.02, 2: 0.04, 3: 0.06, 4: 0.085, 5: 0.11, 6: 0.135, 7: 0.165, 8: 0.195, 9: 0.225, 10: 0.275 });
  assert.ok(B.enchantPower(10) < 1, '+10 nunca pode duplicar o poder');
});

test('ARMA: atk = base x rarity x (1+ENCHANT_POWER[e]) pra todos os +0..+10', () => {
  const base = D.GEAR_STATS.sword[40].atk, mul = D.RARITY.legendary.mul;
  for (let e = 0; e <= 10; e++) assert.equal(D.statsFor('sword', 40, 'legendary', e).atk, Math.round(base * mul * (1 + B.ENCHANT_POWER[e])), `+${e}`);
});

test('ARMADURA/CAPA: def e hp recebem o mesmo bonus acumulado', () => {
  const a = D.GEAR_STATS.armor[40], c = D.GEAR_STATS.cape[24];
  assert.equal(D.statsFor('armor', 40, 'basic', 5).def, Math.round(a.def * 1.11));
  assert.equal(D.statsFor('armor', 40, 'basic', 5).hp, Math.round(a.hp * 1.11));
  assert.equal(D.statsFor('armor', 40, 'basic', 10).hp, Math.round(a.hp * 1.275));
  assert.equal(D.statsFor('cape', 24, 'rare', 6).def, Math.round(c.def * D.RARITY.rare.mul * 1.135));
  assert.equal(D.statsFor('cape', 24, 'rare', 6).hp, Math.round(c.hp * D.RARITY.rare.mul * 1.135));
});

test('BOTAS: DEF recebe bonus de enchant; SPD NUNCA muda com enchant', () => {
  const spd0 = D.statsFor('boots', 40, 'epic', 0).spd;
  const spd10 = D.statsFor('boots', 40, 'epic', 10).spd;
  assert.equal(spd0, spd10, 'spd nao deveria mudar entre +0 e +10');
  assert.equal(D.statsFor('boots', 40, 'epic', 10).def, Math.round(D.GEAR_STATS.boots[40].def * D.RARITY.epic.mul * 1.275));
});

test('Epic Lv36 +8 vs Legendary Lv36 +3: decisao NAO obvia (mesmo ATK)', () => {
  const epic8 = D.statsFor('sword', 36, 'epic', 8).atk, leg3 = D.statsFor('sword', 36, 'legendary', 3).atk;
  assert.ok(Math.abs(epic8 - leg3) <= 2, `epic+8=${epic8} legendary+3=${leg3}`);
});

test('TIPOS NAO ENCHANTAVEIS (shield/helmet/jewel): enchant nunca produz bonus, mesmo se forcado', () => {
  for (const type of ['shield', 'helmet', 'jewel']) {
    const s0 = D.statsFor(type, 20, 'basic', 0), s10 = D.statsFor(type, 20, 'basic', 10);
    assert.deepEqual(s0, s10, `${type} nao deveria ter nenhum bonus de enchant`);
    assert.ok(!D.ENCHANTABLE_TYPES.has(type));
  }
});

test('ENCHANTABLE_TYPES: exatamente os 7 tipos tecnicos elegiveis (4 grupos do design)', () => {
  assert.deepEqual([...D.ENCHANTABLE_TYPES].sort(), ['armor', 'boots', 'bow', 'cape', 'staffd', 'staffm', 'sword'].sort());
});

test('RARITY + ENCHANT: Basic/Rare/Epic/Legendary +10 combinam corretamente -- enchant NUNCA substitui rarity', () => {
  for (const rarity of ['basic', 'rare', 'epic', 'legendary']) {
    const item = S.applyEnchant(S.createGear('sword', 40, rarity), 10);
    assert.equal(item.rarity, rarity);
    assert.equal(item.enchant, 10);
    assert.equal(item.atk, Math.round(D.GEAR_STATS.sword[40].atk * D.RARITY[rarity].mul * 1.275));
  }
});

test('applyEnchant: preserva uid/type/lv/rarity/req/n exatamente -- so enchant e stats mudam', () => {
  const item = S.createGear('cape', 24, 'rare');
  const enchanted = S.applyEnchant(item, 7);
  for (const k of ['uid', 'type', 'lv', 'rarity', 'req', 'n']) assert.equal(enchanted[k], item[k], k);
  assert.equal(enchanted.enchant, 7);
});

// ===== attemptEnchant: fluxo completo contra um save simulado =====
function freshSave(items, extra) { return { gold: 100000, gem: 1000, bag: items.slice(), eq: {}, ...extra }; }

test('attemptEnchant +1/+2/+3: cobra OURO exato, 100% de sucesso mesmo com rng hostil, nao toca gema', () => {
  const item = S.createGear('sword', 40, 'legendary');
  const save = freshSave([item]);
  let exp = 0;
  for (let target = 1; target <= 3; target++) {
    const goldBefore = save.gold;
    const { result } = S.attemptEnchant(save, item.uid, exp, queueRng([0.999999]));
    assert.equal(result.success, true);
    assert.equal(result.currency, 'gold');
    assert.equal(goldBefore - save.gold, B.enchantCostFor(40, 'legendary', target).amount);
    assert.equal(result.newEnchant, target);
    assert.equal(result.uid, item.uid);
    exp = target;
  }
  assert.equal(save.gem, 1000, '+1..+3 nunca cobra gema');
  assert.equal(save.bag[0].enchant, 3);
});

test('attemptEnchant +4..+10: cobra GEMAS exatas, nunca ouro', () => {
  for (let start = 3; start <= 9; start++) {
    const item = S.applyEnchant(S.createGear('bow', 40, 'epic'), start);
    const save = freshSave([item]);
    const { result } = S.attemptEnchant(save, item.uid, start, queueRng([0]));
    assert.equal(result.success, true);
    assert.equal(result.currency, 'gem');
    assert.equal(1000 - save.gem, B.ENCHANT_GEM_COST[start + 1], `+${start + 1}`);
    assert.equal(save.gold, 100000, `+${start + 1} nunca cobra ouro`);
    assert.equal(save.bag[0].enchant, start + 1, 'sucesso persiste no save');
  }
});

test('attemptEnchant FALHA +4..+10: consome gemas, item NAO quebra, NAO some, NAO reduz', () => {
  for (let start = 3; start <= 9; start++) {
    const item = S.applyEnchant(S.createGear('armor', 40, 'epic'), start);
    const snapshot = JSON.parse(JSON.stringify(item));
    const save = freshSave([item]);
    const { result } = S.attemptEnchant(save, item.uid, start, queueRng([0.9999]));
    assert.equal(result.success, false);
    assert.equal(result.destroyed, false);
    assert.equal(result.newEnchant, start);
    assert.equal(1000 - save.gem, B.ENCHANT_GEM_COST[start + 1], 'gemas consumidas na falha');
    assert.equal(save.bag.length, 1, 'item continua na mochila');
    assert.deepEqual(save.bag[0], snapshot, 'item exatamente igual (uid/enchant/stats)');
  }
});

test('attemptEnchant exemplo oficial: Epic +7 tenta +8, paga 6 gemas, falha, continua Epic +7', () => {
  const item = S.applyEnchant(S.createGear('sword', 36, 'epic'), 7);
  const save = freshSave([], { eq: { sword: item } });
  const { result } = S.attemptEnchant(save, item.uid, 7, queueRng([0.5])); // 0.5 >= 0.35 -> falha
  assert.equal(result.success, false);
  assert.equal(result.gemCost, 6);
  assert.equal(save.gem, 994);
  assert.equal(save.eq.sword.uid, item.uid);
  assert.equal(save.eq.sword.enchant, 7);
  assert.equal(save.eq.sword.rarity, 'epic');
});

test('attemptEnchant MAX: item +10 rejeitado (MAX_ENCHANT), nada cobrado, item permanece', () => {
  const item = S.applyEnchant(S.createGear('boots', 1, 'basic'), 10);
  const save = freshSave([item]);
  const { error } = S.attemptEnchant(save, item.uid, 10, queueRng([0.001]));
  assert.equal(error, 'MAX_ENCHANT');
  assert.equal(save.gold, 100000);
  assert.equal(save.gem, 1000);
  assert.equal(save.bag[0].enchant, 10);
});

test('attemptEnchant SEM OURO: rejeita sem RNG, sem cobrar, sem mudar enchant', () => {
  const item = S.createGear('sword', 40, 'legendary');
  const save = { gold: 10, gem: 0, bag: [item], eq: {} };
  const { error } = S.attemptEnchant(save, item.uid, 0, queueRng([0.001]));
  assert.equal(error, 'Moedas insuficientes');
  assert.equal(save.gold, 10);
  assert.equal(save.bag[0].enchant, 0);
});

test('attemptEnchant SEM GEMA: +4..+10 rejeita sem cobrar e sem tocar no item (mesmo com muito ouro)', () => {
  const item = S.applyEnchant(S.createGear('sword', 40, 'legendary'), 7); // +8 custa 6 gemas
  const save = { gold: 999999, gem: 5, bag: [item], eq: {} };
  const { error } = S.attemptEnchant(save, item.uid, 7, queueRng([0]));
  assert.equal(error, 'Gemas insuficientes');
  assert.equal(save.gem, 5);
  assert.equal(save.gold, 999999);
  assert.equal(save.bag[0].enchant, 7);
});

test('attemptEnchant DOUBLE REQUEST: expectedEnchant desatualizado (stale) e rejeitado sem cobrar', () => {
  const item = S.createGear('sword', 40, 'legendary');
  const save = freshSave([item]);
  const first = S.attemptEnchant(save, item.uid, 0, queueRng([0.5]));
  assert.equal(first.result.success, true);
  const goldAfterFirst = save.gold;
  const second = S.attemptEnchant(save, item.uid, 0, queueRng([0.001]));
  assert.equal(second.error, 'STALE_ENCHANT_STATE');
  assert.equal(save.gold, goldAfterFirst);
  assert.equal(save.bag[0].enchant, 1);
});

test('attemptEnchant EQUIPADO: sucesso mantem no mesmo slot com o mesmo uid; falha mantem o slot intacto', () => {
  const item = S.createGear('armor', 20, 'basic');
  const save = freshSave([], { eq: { armor: item } });
  const { result } = S.attemptEnchant(save, item.uid, 0, queueRng([0.5]));
  assert.equal(result.success, true);
  assert.equal(save.eq.armor.uid, item.uid);
  assert.equal(save.eq.armor.enchant, 1);
  assert.equal(save.bag.length, 0);

  const item2 = S.applyEnchant(S.createGear('armor', 20, 'basic'), 3);
  const save2 = freshSave([], { eq: { armor: item2 } });
  const fail = S.attemptEnchant(save2, item2.uid, 3, queueRng([0.9999]));
  assert.equal(fail.result.destroyed, false);
  assert.equal(save2.eq.armor.uid, item2.uid, 'slot nunca fica vazio por falha');
  assert.equal(save2.eq.armor.enchant, 3);
});

test('attemptEnchant ITEM NAO PERMITIDO: shield/helmet/jewel rejeitados sem cobrar', () => {
  for (const type of ['shield', 'helmet', 'jewel']) {
    const item = S.createGear(type, 20, 'basic');
    const save = freshSave([item]);
    const { error } = S.attemptEnchant(save, item.uid, 0, queueRng([0.001]));
    assert.equal(error, 'Este equipamento não pode ser encantado');
    assert.equal(save.gold, 100000);
  }
});

test('attemptEnchant UID FORJADO: uid inexistente e rejeitado', () => {
  const save = freshSave([]);
  const { error } = S.attemptEnchant(save, '11111111-1111-1111-1111-111111111111', 0, queueRng([0.001]));
  assert.equal(error, 'Item não encontrado');
});

test('attemptEnchant: nunca duplica uid -- sucesso/falha mantem exatamente 1 ocorrencia do uid', () => {
  for (const [start, r] of [[0, 0.5], [5, 0.9999]]) {
    const item = S.applyEnchant(S.createGear('sword', 12, 'basic'), start);
    const save = freshSave([item]);
    S.attemptEnchant(save, item.uid, start, queueRng([r]));
    const occurrences = save.bag.filter(it => it.uid === item.uid).length + Object.values(save.eq).filter(it => it && it.uid === item.uid).length;
    assert.equal(occurrences, 1);
  }
});

// ===== Anti-cheat: nada vindo do cliente decide o enchant =====
test('ANTI-CHEAT: attemptEnchant so aceita (save, uid, expectedEnchant) -- success/chance/custo nunca sao parametros', () => {
  // A API server-side nao tem nenhum parametro de "success"/"cost"/"chance":
  // o handler (handleShop enchant_item) so repassa uid+expectedEnchant.
  assert.equal(S.attemptEnchant.length, 4); // save, uid, expectedEnchant, rng (rng so em teste)
  const item = S.applyEnchant(S.createGear('sword', 40, 'basic'), 9);
  const save = freshSave([item]);
  // rng de producao hostil (falha) -- mesmo "querendo" +10, nao sobe.
  const { result } = S.attemptEnchant(save, item.uid, 9, queueRng([0.9]));
  assert.equal(result.success, false);
  assert.equal(save.bag[0].enchant, 9);
});

test('ANTI-CHEAT: enchant forjado no save (+10 em item que nunca foi encantado) nao cria bonus em tipo inelegivel e nunca passa de +10', () => {
  const forged = S.sanitizeItem({ ...S.createGear('jewel', 40, 'basic'), enchant: 10 });
  assert.equal(forged.enchant, 0);
  const over = S.sanitizeItem({ ...S.createGear('sword', 40, 'basic'), enchant: 99 });
  assert.equal(over.enchant, 10);
});
