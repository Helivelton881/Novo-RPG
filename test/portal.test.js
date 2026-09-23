'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');

test('portal inclui Vulcao Ardente e nao invalida a lista quando apenas o tempo passa', () => {
  assert.match(html, /n:'Vulcão Ardente'/);
  const fn = html.match(/function winSig\(\)\{[\s\S]*?\n\}/)[0];
  const P = { gunlock: {}, bar: [], chat: [], lvl: 35, quest: 27, kills: 0, gk: 0, ks: 0, kw: 0, kp: 0, kt: 0, ki: 0, kv: 0, gem: 0, pv: 0, pa: 0, ap: 0, key: 0, scr: 0, bag: [], eq: {}, sl: 0, gb: 0, bs: 0, dt: 0, pt: 59, chestOpen: false, sk: {}, name: 'Heroi' };
  const ctx = { P, scrOpen: 'portal', charTab: 'equip', shopOpen: false, shopTab: 'buy', shopCat: 0, shopSel: null, shopSold: [], invOpen: false, bagFilter: 0, skSel: '', mapView: 'vila', socTab: '', FRIENDS: [], PARTY: null, W_: { name: 'vila' }, skillPoints: () => 0, nearMerchant: () => false };
  vm.runInNewContext(fn + '; result=winSig;', ctx);
  const before = ctx.result();
  P.pt = 61;
  assert.equal(ctx.result(), before, 'tempo de jogo nao deve reconstruir a lista do portal');
});

test('painel de status continua atualizando os minutos exibidos', () => {
  assert.match(html, /scrOpen==='char'&&charTab==='status'\?Math\.floor\(P\.pt\/60\):0/);
});
