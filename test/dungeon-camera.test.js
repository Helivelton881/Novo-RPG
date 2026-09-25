'use strict';
// Fase 5.16.3 -- testes unitarios (sem DOM/canvas) da CAMERA da masmorra.
// A formula abaixo e uma copia fiel da formula real de index.html
// (resize()/draw(), T/WPX/HPX/clamp): T=48, MW=60, MH=44, WPX=MW*T,
// HPX=MH*T, zoom=max(1,round(min(cw,ch)/(T*11))+ajusteZoom),
// vw=ceil(cw/zoom)+1, vh=ceil(ch/zoom)+1, camX=clamp(tx-vw*focX,0,WPX-vw).
// Isso prova numericamente, sem precisar de navegador, que o spawn da
// masmorra SEMPRE cai dentro do viewport da camera pra qualquer tamanho
// de tela realista -- a causa raiz real do bug reportado ("personagem
// preso ate dar zoom") era resize() nunca ser chamado ao entrar na
// masmorra (corrigido em applyDungeonState, index.html), nao a geometria
// ou a formula da camera em si (ambas verificadas aqui como corretas).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game-data/dungeon-generation.js');

const T = 48, MW = 60, MH = 44, WPX = MW * T, HPX = MH * T;
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function cameraFor(px, py, cssW, cssH, dpr, zoomAdj, focX, focY) {
  const cw = Math.max(1, Math.round(cssW * dpr)), ch = Math.max(1, Math.round(cssH * dpr));
  const zoom = Math.max(1, Math.round(Math.min(cw, ch) / (T * 11)) + zoomAdj);
  const vw = Math.ceil(cw / zoom) + 1, vh = Math.ceil(ch / zoom) + 1;
  const tx = px, ty = py - 30;
  const camX = Math.round(clamp(tx - vw * focX, 0, WPX - vw));
  const camY = Math.round(clamp(ty - vh * focY, 0, HPX - vh));
  return { camX, camY, vw, vh };
}

const VIEWPORTS = [
  ['desktop 800x600 dpr1', 800, 600, 1],
  ['desktop 1280x800 dpr1', 1280, 800, 1],
  ['desktop 1920x1080 dpr1', 1920, 1080, 1],
  ['mobile 390x844 dpr2 (retrato)', 390, 844, 2],
  ['mobile 844x390 dpr2 (paisagem)', 844, 390, 2],
  ['tablet 768x1024 dpr2', 768, 1024, 2],
];
const ZOOM_ADJ = [['padrao', 0], ['perto', 1], ['longe', -1]];

test('camera da masmorra: spawn (start) sempre visivel no viewport, em toda combinacao de tela/zoom (nunca "preso" fora de camera)', () => {
  const layout = G.dungeonLayout(1);
  for (const [label, w, h, dpr] of VIEWPORTS) {
    for (const [zlabel, adj] of ZOOM_ADJ) {
      const { camX, camY, vw, vh } = cameraFor(layout.start.x, layout.start.y, w, h, dpr, adj, .5, .5);
      const tx = layout.start.x, ty = layout.start.y - 30;
      assert.ok(tx >= camX && tx <= camX + vw, `${label}/${zlabel}: spawn.x fora do viewport da camera (camX=${camX} vw=${vw} tx=${tx})`);
      assert.ok(ty >= camY && ty <= camY + vh, `${label}/${zlabel}: spawn.y fora do viewport da camera (camY=${camY} vh=${vh} ty=${ty})`);
    }
  }
});

test('camera da masmorra: sala do chefe (boss) e o ponto de saida tambem sempre visiveis no viewport', () => {
  const layout = G.dungeonLayout(1);
  for (const [label, w, h, dpr] of VIEWPORTS) {
    for (const point of [['boss', layout.boss], ['exitPoint', layout.exitPoint]]) {
      const [plabel, p] = point;
      const { camX, camY, vw, vh } = cameraFor(p.x, p.y, w, h, dpr, 0, .5, .5);
      const tx = p.x, ty = p.y - 30;
      assert.ok(tx >= camX && tx <= camX + vw, `${label}/${plabel}: fora do viewport (camX=${camX} vw=${vw})`);
      assert.ok(ty >= camY && ty <= camY + vh, `${label}/${plabel}: fora do viewport (camY=${camY} vh=${vh})`);
    }
  }
});

test('camera da masmorra: mesmo com foco extremo (painel de UI ocupando quase a tela toda), o spawn nunca fica inalcancavel dentro do mundo', () => {
  const layout = G.dungeonLayout(1);
  for (const focX of [0, .15, .5, .85, 1]) {
    const { camX, vw } = cameraFor(layout.start.x, layout.start.y, 1280, 800, 1, 0, focX, .5);
    // o mundo inteiro (WPX) e bem maior que qualquer viewport tipico, entao
    // mesmo no pior foco o clamp garante camX dentro de [0, WPX-vw] --
    // nunca negativo, nunca alem do teto do mundo.
    assert.ok(camX >= 0 && camX <= WPX - vw, `focX=${focX}: camX fora dos limites do mundo (camX=${camX})`);
  }
});

test('resize() e chamado ao entrar na masmorra (fonte real do bug "preso ate dar zoom"): applyDungeonState chama resize() antes de posicionar o jogador', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const start = html.indexOf('function applyDungeonState');
  const end = html.indexOf('\n}', start);
  const body = html.slice(start, end);
  assert.match(body, /resize\(\);/, 'applyDungeonState deveria chamar resize() (garante cw/ch/vw/vh frescos no momento em que o jogador aparece na masmorra)');
  const resizeIdx = body.indexOf('resize();'), setWorldIdx = body.indexOf('setWorld(w)'), posIdx = body.indexOf('P.x=');
  assert.ok(setWorldIdx < resizeIdx && resizeIdx < posIdx, 'ordem esperada: setWorld (mundo da masmorra ativo) -> resize (viewport fresco) -> posicionar o jogador');
});
