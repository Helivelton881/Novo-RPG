'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const client = fs.readFileSync(require.resolve('../index.html'), 'utf8');

function serverCatalog() {
  const src = [
    server.match(/const GEAR_TIERS = [\s\S]*?\n};/)[0],
    server.match(/const CLASS_ITEM_TYPES = [\s\S]*?\n};/)[0],
    server.match(/const GEAR_PRICES = [\s\S]*?\n};/)[0],
    'result={GEAR_TIERS,CLASS_ITEM_TYPES,GEAR_PRICES};',
  ].join('\n');
  const ctx = {};
  vm.runInNewContext(src, ctx);
  return ctx.result;
}

test('catalogo server-side oferece arma da classe e armadura nos niveis 1, 4, 8 e 12', () => {
  const { GEAR_TIERS, CLASS_ITEM_TYPES, GEAR_PRICES } = serverCatalog();
  const weapons = { guerreiro: 'sword', druida: 'staffd', mago: 'staffm', arqueiro: 'bow' };
  const levels = [1, 4, 8, 12];
  for (const [cls, weapon] of Object.entries(weapons)) {
    assert.ok(CLASS_ITEM_TYPES[cls].includes(weapon));
    assert.ok(CLASS_ITEM_TYPES[cls].includes('armor'));
    levels.forEach((level, i) => {
      const tier = i + 1;
      assert.equal(GEAR_TIERS[weapon][tier].req, level);
      assert.equal(GEAR_TIERS.armor[tier].req, level);
      assert.ok(GEAR_TIERS[weapon][tier].atk > 0);
      assert.ok(GEAR_TIERS.armor[tier].def > 0 && GEAR_TIERS.armor[tier].hp > 0);
      assert.ok(GEAR_PRICES[weapon][tier] > 0);
      assert.ok(GEAR_PRICES.armor[tier] > 0);
    });
  }
});

test('catalogo cliente espelha os precos server-side dos oito equipamentos', () => {
  assert.match(client, /\[CLS\.weapon,\[\[1,60,1\],\[2,180,4\],\[3,450,8\],\[4,900,12\]\]\]/);
  assert.match(client, /\['armor',\[\[1,30,1\],\[2,120,4\],\[3,320,8\],\[4,700,12\]\]\]/);
});
