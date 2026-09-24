'use strict';
// Fase 5.4 -- Ferreiro + enchant (+0..+10) server-authoritative. Testes
// puros (sem HTTP/WS/Supabase), direto contra o que server.js/gear-data.js
// exportam pra isso. RNG sempre injetado (nunca Math.random/crypto reais)
// pra testar limites exatos de chance sem flake, conforme instruído.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server.js');
const D = require('../game-data/gear-data.js');

function queueRng(values) {
  const q = values.slice();
  return () => (q.length ? q.shift() : 0.999999);
}

// ===== Tabela de chances =====
test('ENCHANT_SUCCESS: tabela oficial exata (+1..+3=100%, +4..+10 decrescente)', () => {
  assert.deepEqual(D.ENCHANT_SUCCESS, { 1: 1.00, 2: 1.00, 3: 1.00, 4: 0.70, 5: 0.60, 6: 0.50, 7: 0.40, 8: 0.30, 9: 0.20, 10: 0.10 });
});

test('enchantChance: +1..+10 batem com a tabela; +11 e +0 invalidos (null)', () => {
  for (const t of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) assert.equal(D.enchantChance(t), D.ENCHANT_SUCCESS[t]);
  assert.equal(D.enchantChance(11), null);
  assert.equal(D.enchantChance(0), null);
});

test('rollEnchantSuccess: fronteira exata em +4 (roll<chance sucede, roll===chance falha)', () => {
  assert.equal(S.rollEnchantSuccess(4, queueRng([0.6999])), true);
  assert.equal(S.rollEnchantSuccess(4, queueRng([0.7000])), false);
});

test('rollEnchantSuccess: fronteira exata em +10 (10%)', () => {
  assert.equal(S.rollEnchantSuccess(10, queueRng([0.0999])), true);
  assert.equal(S.rollEnchantSuccess(10, queueRng([0.10])), false);
});

test('rollEnchantSuccess: +1/+2/+3 sempre true, mesmo com rng hostil (perto de 1)', () => {
  for (const t of [1, 2, 3]) assert.equal(S.rollEnchantSuccess(t, queueRng([0.999999])), true);
});

test('rollEnchantSuccess: alvo invalido (+11) nunca sucede', () => {
  assert.equal(S.rollEnchantSuccess(11, queueRng([0])), false);
});

// ===== Custo =====
test('ENCHANT_COST_RATE: tabela oficial exata', () => {
  assert.deepEqual(D.ENCHANT_COST_RATE, { 1: 0.05, 2: 0.07, 3: 0.10, 4: 0.15, 5: 0.20, 6: 0.30, 7: 0.40, 8: 0.55, 9: 0.75, 10: 1.00 });
});

test('enchantCost: percentual do preco BASIC do type+lv (nunca da rarity real do item)', () => {
  assert.equal(D.enchantCost('sword', 40, 10), D.priceFor('sword', 40) * 1.00);
  assert.equal(D.enchantCost('armor', 20, 5), Math.round(D.priceFor('armor', 20) * 0.20));
});

test('enchantCost: minimo de 25 ouro mesmo pra faixas baratas', () => {
  assert.equal(D.enchantCost('sword', 1, 1), 25); // 60*0.05=3, forcado pro minimo
});

test('enchantCost: alvo invalido devolve null', () => {
  assert.equal(D.enchantCost('sword', 40, 11), null);
});

// ===== +0 é 100% compatível (regressão explícita) =====
test('REGRESSAO: statsFor com enchant=0 (ou omitido) produz EXATAMENTE os mesmos stats de antes da Fase 5.4', () => {
  const cases = [
    ['sword', 1, 'basic'], ['sword', 40, 'legendary'], ['bow', 20, 'rare'], ['staffm', 8, 'epic'],
    ['armor', 40, 'basic'], ['armor', 1, 'legendary'], ['cape', 24, 'rare'], ['boots', 40, 'epic'],
    ['shield', 12, 'basic'], ['helmet', 20, 'rare'], ['jewel', 40, 'legendary'],
  ];
  for (const [type, lv, rarity] of cases) {
    const withEnchant0 = D.statsFor(type, lv, rarity, 0);
    const withoutArg = D.statsFor(type, lv, rarity);
    assert.deepEqual(withEnchant0, withoutArg, `${type} lv${lv} ${rarity}`);
  }
});

// ===== Stats por tipo (armas +3%, armadura/capa +2% def+hp, botas +2% so def) =====
test('ARMA: +0=100%, +1=+3%, +3=+9%, +5=+15%, +10=+30% sobre o atk (com rarity ja aplicada)', () => {
  const base = D.GEAR_STATS.sword[40].atk; // 42
  const rarityMul = D.RARITY.legendary.mul; // 1.35
  const atk0 = D.statsFor('sword', 40, 'legendary', 0).atk;
  assert.equal(atk0, Math.round(base * rarityMul));
  assert.equal(D.statsFor('sword', 40, 'legendary', 1).atk, Math.round(base * rarityMul * 1.03));
  assert.equal(D.statsFor('sword', 40, 'legendary', 3).atk, Math.round(base * rarityMul * 1.09));
  assert.equal(D.statsFor('sword', 40, 'legendary', 5).atk, Math.round(base * rarityMul * 1.15));
  assert.equal(D.statsFor('sword', 40, 'legendary', 10).atk, Math.round(base * rarityMul * 1.30));
});

test('ARMADURA: +5 = +10% em def e hp, +10 = +20%, spd nao existe em armor (sem regressao)', () => {
  const b = D.GEAR_STATS.armor[40], rarityMul = D.RARITY.basic.mul;
  assert.equal(D.statsFor('armor', 40, 'basic', 5).def, Math.round(b.def * rarityMul * 1.10));
  assert.equal(D.statsFor('armor', 40, 'basic', 5).hp, Math.round(b.hp * rarityMul * 1.10));
  assert.equal(D.statsFor('armor', 40, 'basic', 10).def, Math.round(b.def * rarityMul * 1.20));
  assert.equal(D.statsFor('armor', 40, 'basic', 10).hp, Math.round(b.hp * rarityMul * 1.20));
});

test('CAPA: mesma regra defensiva da armadura (+2% def e hp por enchant)', () => {
  const b = D.GEAR_STATS.cape[24], rarityMul = D.RARITY.rare.mul;
  assert.equal(D.statsFor('cape', 24, 'rare', 6).def, Math.round(b.def * rarityMul * 1.12));
  assert.equal(D.statsFor('cape', 24, 'rare', 6).hp, Math.round(b.hp * rarityMul * 1.12));
});

test('BOTAS: DEF recebe bonus de enchant; SPD NUNCA muda com enchant (so rarity pode afetar spd)', () => {
  const spd0 = D.statsFor('boots', 40, 'epic', 0).spd;
  const spd10 = D.statsFor('boots', 40, 'epic', 10).spd;
  assert.equal(spd0, spd10, 'spd nao deveria mudar entre +0 e +10');
  const def0 = D.statsFor('boots', 40, 'epic', 0).def;
  const def10 = D.statsFor('boots', 40, 'epic', 10).def;
  assert.ok(def10 > def0, 'def deveria aumentar com enchant');
  assert.equal(def10, Math.round(D.GEAR_STATS.boots[40].def * D.RARITY.epic.mul * 1.20));
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

// ===== Rarity + enchant combinados =====
test('RARITY + ENCHANT: Basic/Rare/Epic/Legendary +10 combinam corretamente -- enchant NUNCA substitui rarity', () => {
  for (const rarity of ['basic', 'rare', 'epic', 'legendary']) {
    const item = S.applyEnchant(S.createGear('sword', 40, rarity), 10);
    assert.equal(item.rarity, rarity, 'enchant nao deveria alterar a rarity');
    assert.equal(item.enchant, 10);
    const expected = Math.round(D.GEAR_STATS.sword[40].atk * D.RARITY[rarity].mul * 1.30);
    assert.equal(item.atk, expected);
  }
});

test('Epic +6 continua Epic (nao vira Legendary por enchant)', () => {
  const item = S.applyEnchant(S.createGear('armor', 20, 'epic'), 6);
  assert.equal(item.rarity, 'epic');
});

// ===== applyEnchant: lv/req/type/uid/n preservados =====
test('applyEnchant: preserva uid/type/lv/rarity/req/n exatamente -- so enchant e stats mudam', () => {
  const item = S.createGear('cape', 24, 'rare');
  const enchanted = S.applyEnchant(item, 7);
  assert.equal(enchanted.uid, item.uid);
  assert.equal(enchanted.type, item.type);
  assert.equal(enchanted.lv, item.lv);
  assert.equal(enchanted.rarity, item.rarity);
  assert.equal(enchanted.req, item.req);
  assert.equal(enchanted.n, item.n);
  assert.equal(enchanted.enchant, 7);
});

// ===== attemptEnchant: fluxo completo contra um save simulado =====
function freshSave(items) { return { gold: 100000, bag: items.slice(), eq: {} }; }

test('attemptEnchant SAFE: +0->+1->+2->+3 sempre sucede, mesmo com rng hostil', () => {
  const item = S.createGear('sword', 40, 'legendary');
  const save = freshSave([item]);
  let uid = item.uid, exp = 0;
  for (let target = 1; target <= 3; target++) {
    const { result } = S.attemptEnchant(save, uid, exp, queueRng([0.999999]));
    assert.equal(result.success, true);
    assert.equal(result.newEnchant, target);
    assert.equal(result.uid, uid, 'uid deveria permanecer identico no sucesso');
    exp = target;
  }
  assert.equal(save.bag[0].enchant, 3);
  assert.equal(save.bag[0].uid, uid);
});

test('attemptEnchant BREAK: falha forcada em +4 destroi o item (uid some, sem downgrade)', () => {
  const item = S.applyEnchant(S.createGear('armor', 40, 'basic'), 3);
  const save = freshSave([item]);
  const goldBefore = save.gold;
  const { result } = S.attemptEnchant(save, item.uid, 3, queueRng([0.9999])); // 0.9999 >= 0.70 -> falha
  assert.equal(result.success, false);
  assert.equal(result.destroyed, true);
  assert.equal(save.bag.length, 0, 'item deveria ter sido removido, nao rebaixado');
  assert.ok(save.gold < goldBefore, 'custo deveria ter sido cobrado mesmo na quebra');
});

test('attemptEnchant BREAK: falha em +5 e +9->+10 tambem destroi (nao so +4)', () => {
  for (const startEnchant of [4, 9]) {
    const item = S.applyEnchant(S.createGear('bow', 40, 'epic'), startEnchant);
    const save = freshSave([item]);
    const { result } = S.attemptEnchant(save, item.uid, startEnchant, queueRng([0.9999]));
    assert.equal(result.destroyed, true);
    assert.equal(save.bag.length, 0);
  }
});

test('attemptEnchant MAX: item +10 rejeitado (MAX_ENCHANT), gold nao muda, item permanece', () => {
  const item = S.applyEnchant(S.createGear('boots', 1, 'basic'), 10);
  const save = freshSave([item]);
  const goldBefore = save.gold;
  const { error } = S.attemptEnchant(save, item.uid, 10, queueRng([0.001]));
  assert.equal(error, 'MAX_ENCHANT');
  assert.equal(save.gold, goldBefore);
  assert.equal(save.bag[0].enchant, 10);
});

test('attemptEnchant GOLD: ouro insuficiente rejeita sem RNG, sem quebra, sem mudar enchant', () => {
  const item = S.createGear('sword', 40, 'legendary');
  const save = { gold: 10, bag: [item], eq: {} }; // 10 ouro nao cobre nem o +1 mais barato
  const { error } = S.attemptEnchant(save, item.uid, 0, queueRng([0.001])); // rng favoravel, nao deveria nem rolar
  assert.equal(error, 'Moedas insuficientes');
  assert.equal(save.gold, 10);
  assert.equal(save.bag[0].enchant, 0);
});

test('attemptEnchant DOUBLE REQUEST: expectedEnchant desatualizado (stale) e rejeitado sem cobrar', () => {
  const item = S.createGear('sword', 40, 'legendary');
  const save = freshSave([item]);
  const goldBefore = save.gold;
  // primeira tentativa (expectedEnchant=0) sucede de verdade
  const first = S.attemptEnchant(save, item.uid, 0, queueRng([0.5]));
  assert.equal(first.result.success, true);
  // segunda tentativa simulando o double-click: ainda manda expectedEnchant=0 (desatualizado)
  const second = S.attemptEnchant(save, item.uid, 0, queueRng([0.001]));
  assert.equal(second.error, 'STALE_ENCHANT_STATE');
  assert.equal(save.bag[0].enchant, 1, 'so a primeira tentativa deveria ter executado (nao foi +0->+1->+2)');
});

test('attemptEnchant EQUIPADO: sucesso mantem no mesmo slot com o mesmo uid; falha esvazia o slot', () => {
  const item = S.createGear('armor', 20, 'basic');
  const save = { gold: 100000, bag: [], eq: { armor: item } };
  const { result } = S.attemptEnchant(save, item.uid, 0, queueRng([0.5]));
  assert.equal(result.success, true);
  assert.equal(save.eq.armor.uid, item.uid);
  assert.equal(save.eq.armor.enchant, 1);
  assert.equal(save.bag.length, 0, 'nao deveria criar copia na mochila');

  const item2 = S.applyEnchant(S.createGear('armor', 20, 'basic'), 3);
  const save2 = { gold: 100000, bag: [], eq: { armor: item2 } };
  const fail = S.attemptEnchant(save2, item2.uid, 3, queueRng([0.9999]));
  assert.equal(fail.result.destroyed, true);
  assert.equal(save2.eq.armor, null, 'slot deveria ficar vazio apos a quebra');
});

test('attemptEnchant MOCHILA: sucesso substitui pelo mesmo uid com enchant+1; falha remove da mochila', () => {
  const item = S.createGear('cape', 8, 'rare');
  const save = freshSave([item]);
  const { result } = S.attemptEnchant(save, item.uid, 0, queueRng([0.5]));
  assert.equal(result.success, true);
  assert.equal(save.bag.length, 1);
  assert.equal(save.bag[0].uid, item.uid);
  assert.equal(save.bag[0].enchant, 1);
});

test('attemptEnchant ITEM NAO PERMITIDO: shield/helmet/jewel rejeitados sem cobrar', () => {
  for (const type of ['shield', 'helmet', 'jewel']) {
    const item = S.createGear(type, 20, 'basic');
    const save = freshSave([item]);
    const { error } = S.attemptEnchant(save, item.uid, 0, queueRng([0.001]));
    assert.equal(error, 'Este equipamento não pode ser encantado');
    assert.equal(save.gold, 100000, `${type} nao deveria cobrar nada`);
  }
});

test('attemptEnchant UID FORJADO: uid inexistente e rejeitado', () => {
  const save = freshSave([]);
  const { error } = S.attemptEnchant(save, '11111111-1111-1111-1111-111111111111', 0, queueRng([0.001]));
  assert.equal(error, 'Item não encontrado');
});

test('attemptEnchant: nunca duplica uid -- sucesso mantem exatamente 1 ocorrencia do uid', () => {
  const item = S.createGear('sword', 12, 'basic');
  const save = freshSave([item]);
  S.attemptEnchant(save, item.uid, 0, queueRng([0.5]));
  const occurrences = save.bag.filter(it => it.uid === item.uid).length + (Object.values(save.eq).filter(it => it && it.uid === item.uid).length);
  assert.equal(occurrences, 1);
});
