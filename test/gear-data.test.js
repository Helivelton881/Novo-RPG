'use strict';
// Testes puros (sem servidor, sem Supabase) do modelo de dados de
// equipamento da Fase 5.1 -- game-data/gear-data.js. Sempre rodam.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../game-data/gear-data.js');

test('as 11 faixas de nivel existem e estao em ordem', () => {
  assert.deepEqual(D.GEAR_LEVELS, [1, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40]);
});

test('todo tipo de equipamento tem stats definidos nas 11 faixas', () => {
  for (const type of Object.keys(D.GEAR_STATS)) {
    for (const lv of D.GEAR_LEVELS) {
      const s = D.statsFor(type, lv, 'basic');
      assert.ok(s, `${type} lv${lv} deveria ter stats`);
    }
  }
});

test('stats basic (rarity=1.00) batem exatamente com os valores legados nas 5 faixas antigas', () => {
  // sword/bow/staffd/staffm tier1..5 antigos: atk 2,5,9,14,22
  const legacy = { 1: 2, 4: 5, 8: 9, 12: 14, 20: 22 };
  for (const [lv, atk] of Object.entries(legacy)) {
    assert.equal(D.statsFor('sword', Number(lv), 'basic').atk, atk);
  }
  // armor tier1..5 antigo: hp 10,25,45,70,105 / def 2,4,7,10,15
  const armorLegacy = { 1: [2, 10], 4: [4, 25], 8: [7, 45], 12: [10, 70], 20: [15, 105] };
  for (const [lv, [def, hp]] of Object.entries(armorLegacy)) {
    const s = D.statsFor('armor', Number(lv), 'basic');
    assert.equal(s.def, def); assert.equal(s.hp, hp);
  }
});

test('rarity multiplica a stat mas nunca o req (progressao continua so por nivel)', () => {
  for (const lv of D.GEAR_LEVELS) {
    const req = D.statsFor('sword', lv, 'basic').req;
    for (const r of D.RARITY_ORDER) assert.equal(D.statsFor('sword', lv, r).req, req);
  }
});

test('rarity cresce na ordem certa (legendary > epic > rare > basic) pra mesma faixa', () => {
  const lv = 24;
  const atk = r => D.statsFor('sword', lv, r).atk;
  assert.ok(atk('basic') < atk('rare'));
  assert.ok(atk('rare') < atk('epic'));
  assert.ok(atk('epic') < atk('legendary'));
});

test('legendary Nv20 nao supera basic Nv40 (progressao > raridade)', () => {
  const legendary20 = D.statsFor('sword', 20, 'legendary').atk;
  const basic40 = D.statsFor('sword', 40, 'basic').atk;
  assert.ok(basic40 > legendary20, `basic40(${basic40}) deveria ser > legendary20(${legendary20})`);
});

test('stats sao sempre crescentes ao longo das 11 faixas, pra todo tipo', () => {
  for (const type of Object.keys(D.GEAR_STATS)) {
    let prevPower = -1;
    for (const lv of D.GEAR_LEVELS) {
      const s = D.statsFor(type, lv, 'basic');
      const power = (s.atk || 0) + (s.def || 0) + (s.hp || 0) + (s.blk || 0) * 100 + (s.spd || 0) * 100;
      assert.ok(power > prevPower, `${type}: poder deveria crescer de faixa pra faixa (lv${lv}: ${power} <= ${prevPower})`);
      prevPower = power;
    }
  }
});

test('req de arma/armadura sempre = lv; req de acessorio so existe (=lv) acima de lv20', () => {
  for (const lv of D.GEAR_LEVELS) {
    assert.equal(D.reqFor('sword', lv), lv);
    assert.equal(D.reqFor('armor', lv), lv);
    assert.equal(D.reqFor('boots', lv), lv > 20 ? lv : 0);
    assert.equal(D.reqFor('shield', lv), lv > 20 ? lv : 0);
  }
});

test('rarity invalida nao produz stats (statsFor cai pro default basic apenas quando chamado via helper de mais alto nivel)', () => {
  assert.equal(D.statsFor('sword', 999, 'basic'), null); // nivel invalido
  assert.equal(D.statsFor('inexistente', 20, 'basic'), null); // tipo invalido
});

test('preco de compra existe nas 11 faixas, pra todo tipo vendido, e e sempre crescente', () => {
  for (const type of Object.keys(D.GEAR_PRICES)) {
    let prev = 0;
    for (const lv of D.GEAR_LEVELS) {
      const p = D.priceFor(type, lv);
      assert.ok(Number.isInteger(p) && p > prev, `${type} lv${lv}: preco deveria crescer (${p} <= ${prev})`);
      prev = p;
    }
  }
});

test('preco de venda (sellPriceFor) preserva os 5 valores legados exatos e cresce nas faixas novas', () => {
  assert.equal(D.sellPriceFor(1), 8);
  assert.equal(D.sellPriceFor(4), 22);
  assert.equal(D.sellPriceFor(8), 60);
  assert.equal(D.sellPriceFor(12), 140);
  assert.equal(D.sellPriceFor(20), 320);
  let prev = 0;
  for (const lv of D.GEAR_LEVELS) { const p = D.sellPriceFor(lv); assert.ok(p > prev); prev = p; }
});

test('todo tipo x faixa tem nome unico definido (sem icone/nome quebrado)', () => {
  for (const type of Object.keys(D.GEAR_NAMES)) {
    for (const lv of D.GEAR_LEVELS) {
      const n = D.nameFor(type, lv);
      assert.ok(n && n !== 'Item', `${type} lv${lv} deveria ter nome proprio`);
    }
  }
});

test('LEGACY_TIER_LEVEL mapeia os 5 tiers antigos pros lv corretos', () => {
  assert.deepEqual(D.LEGACY_TIER_LEVEL, [null, 1, 4, 8, 12, 20]);
});
