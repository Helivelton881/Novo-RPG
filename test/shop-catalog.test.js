'use strict';
// Fase 5.1 substituiu GEAR_TIERS/GEAR_PRICES (literais duplicados em
// server.js e index.html) por game-data/gear-data.js, fonte unica exigida
// pelos dois lados -- este arquivo testa exatamente essa unificacao: que
// ambos os lados realmente CARREGAM a mesma fonte (nao duas copias que
// podem divergir), e que o catalogo cobre as 11 faixas nas 4 classes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const S = require('../server.js');
const D = require('../game-data/gear-data.js');

const client = fs.readFileSync(require.resolve('../index.html'), 'utf8');

test('index.html carrega game-data/gear-data.js antes do script principal (mesma fonte do servidor, nao uma copia)', () => {
  const scriptIdx = client.indexOf('<script src="/game-data/gear-data.js">');
  const mainIdx = client.indexOf("<script>\n'use strict';");
  assert.ok(scriptIdx >= 0, 'index.html deveria referenciar /game-data/gear-data.js');
  assert.ok(mainIdx > scriptIdx, 'o script principal deveria vir depois de carregar gear-data.js');
});

test('buildShop() no cliente usa GEAR_DATA.GEAR_LEVELS/priceFor, nao uma tabela propria', () => {
  const fn = client.match(/function buildShop\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(fn, /GEAR_DATA\.GEAR_LEVELS/);
  assert.match(fn, /GEAR_DATA\.priceFor/);
});

test('catalogo server-side (GEAR_DATA, mesma fonte usada por handleShop): 4 classes tem arma+armadura nas 11 faixas, so basic', () => {
  const weapons = { guerreiro: 'sword', druida: 'staffd', mago: 'staffm', arqueiro: 'bow' };
  for (const [cls, weapon] of Object.entries(weapons)) {
    assert.ok(S.CLASS_ITEM_TYPES[cls].includes(weapon));
    assert.ok(S.CLASS_ITEM_TYPES[cls].includes('armor'));
    for (const lv of D.GEAR_LEVELS) {
      const w = S.createGear(weapon, lv, 'basic'), a = S.createGear('armor', lv, 'basic');
      assert.ok(w && w.atk > 0 && w.req === lv, `${weapon} lv${lv}`);
      assert.ok(a && a.def > 0 && a.hp > 0 && a.req === lv, `armor lv${lv}`);
    }
  }
  // so o guerreiro recebe escudo (classTypes() do cliente / CLASS_ITEM_TYPES do servidor concordam)
  assert.ok(S.CLASS_ITEM_TYPES.guerreiro.includes('shield'));
  for (const cls of ['druida', 'mago', 'arqueiro']) assert.ok(!S.CLASS_ITEM_TYPES[cls].includes('shield'));
});

test('capa/joia/bota tambem cobrem as 11 faixas (nao so arma/armadura)', () => {
  for (const type of ['cape', 'jewel', 'boots', 'shield']) {
    for (const lv of D.GEAR_LEVELS) {
      const it = S.createGear(type, lv, 'basic');
      assert.ok(it, `${type} lv${lv} deveria existir`);
    }
  }
});
