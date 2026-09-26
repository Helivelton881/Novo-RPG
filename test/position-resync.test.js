'use strict';
// Hotfix (fora da Fase 5.16.6/5.16.7): bug real de producao -- quando o
// mapa autoritativo do servidor diverge do mapa local do cliente (ex.:
// rede instavel durante uma transicao), o handler de 'position_resync'
// so aplicava a correcao se o mapa batesse, senao ficava IGNORANDO pra
// sempre: mob_damage nunca mais valia (servidor exige map===p.map) e a
// posicao real nunca mais persistia (proximo reconnect herdava o MESMO
// mapa desatualizado, via characterRuntime em server.js). Extraido de
// index.html pelo mesmo padrao de test/click-to-move-portals.test.js
// (extractFn via texto + vm, sem DOM/canvas real).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const BLOCK = html.slice(
  html.indexOf("else if(m.type==='position_resync'){"),
  html.indexOf("else if(m.type==='server_teleport'")
);
assert.ok(BLOCK.length > 50, 'sanity: bloco position_resync deveria ter sido extraído de index.html');
// a extração começa com "else if(...)" -- remove o "else" solto (sem um
// if anterior no mesmo trecho, "else" sozinho é erro de sintaxe), vira
// um "if" valido standalone.
const STANDALONE = BLOCK.replace(/^else\s+/, '');

function baseCtx(overrides) {
  const calls = [];
  const ctx = {
    P: { x: 0, y: 0 },
    W_: { name: 'floresta' },
    worlds: { vila: { name: 'vila' }, floresta: { name: 'floresta' } },
    clickPath: { points: [{ x: 0, y: 0 }], idx: 1 },
    calls,
    netMapId: () => ctx.W_.name,
    setWorld: (w) => { ctx.W_ = w; calls.push('setWorld:' + w.name); },
    stopAuto: () => calls.push('stopAuto'),
    toast: (msg) => calls.push('toast:' + msg),
  };
  Object.assign(ctx, overrides);
  return ctx;
}

test('position_resync: mapa bate -- so aplica x/y, comportamento original preservado', () => {
  const ctx = baseCtx({ W_: { name: 'floresta' } });
  vm.runInNewContext(STANDALONE.replace('if(', 'm={type:"position_resync",map:"floresta",x:111,y:222};\nif(') , ctx);
  assert.equal(ctx.P.x, 111);
  assert.equal(ctx.P.y, 222);
  assert.deepEqual(ctx.calls, [], 'mapa igual nunca deveria trocar de mundo nem tocar auto/clickPath');
});

test('position_resync: mapa diverge (mundo conhecido) -- troca de mundo e sincroniza, nunca fica preso pra sempre', () => {
  const ctx = baseCtx({ W_: { name: 'floresta' } });
  vm.runInNewContext(STANDALONE.replace('if(', 'm={type:"position_resync",map:"vila",x:702.1,y:1067.2};\nif('), ctx);
  assert.equal(ctx.W_.name, 'vila', 'deveria trocar pro mundo que o servidor mandou, nunca ignorar');
  assert.equal(ctx.P.x, 702.1);
  assert.equal(ctx.P.y, 1067.2);
  assert.ok(ctx.calls.includes('setWorld:vila'));
  assert.equal(ctx.clickPath, null, 'rota de clique-para-mover ativa nao deveria sobreviver a uma resincronizacao de mapa');
  assert.ok(ctx.calls.includes('stopAuto'));
});

test('position_resync: ja no mundo certo (setWorld nao deveria rodar de novo por engano)', () => {
  const sameW = { name: 'vila' };
  const ctx = baseCtx({ W_: sameW, worlds: { vila: sameW } });
  vm.runInNewContext(STANDALONE.replace('if(', 'm={type:"position_resync",map:"vila",x:5,y:9};\nif('), ctx);
  // mapa bate com netMapId() aqui (W_.name já é 'vila') -- cai no primeiro
  // ramo (if simples), nunca no de troca de mundo.
  assert.equal(ctx.P.x, 5); assert.equal(ctx.P.y, 9);
  assert.deepEqual(ctx.calls, []);
});
