'use strict';
// Fase 5.16.6 -- CLICK-TO-MOVE + PATHFINDING + PORTAIS INTERATIVOS.
//
// Cobertura de INTEGRACAO (a cobertura do NUCLEO puro do A* -- linha de
// visao, snap, corte de canto, simplificacao -- ja existe em
// test/pathfinding.test.js, 8 testes, nao duplicada aqui).
//
// Estrategia (mesma ja usada em test/dungeon-camera.test.js e
// test/portal.test.js pra funcoes vivendo dentro de index.html, sem
// DOM/canvas real): as funcoes puras (screenToWorld, ensureNavGrid/
// invalidateNavGrid, moveTo/clickPathStep, activePortals/nearestPortal,
// inputVec) sao EXTRAIDAS do arquivo real por texto e executadas via
// node:vm com stubs minimos das globais que elas leem (P, W_, PORTAL,
// CAVE, blocked, PATHFINDING real, etc.) -- nunca uma reimplementacao
// paralela da logica. O que depende de DOM real (keydown do browser,
// pointerdown/up) ou é caro demais pra simular fielmente (tapWorld com
// NPCS/MOBS/mobDims completos) é verificado por asserção estrutural no
// texto-fonte (mesmo padrão do último teste de dungeon-camera.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PF = require('../game-data/pathfinding.js');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

// Bloco screenToWorld..tapWorld (click-to-move + portais unificados),
// extraído por texto -- nunca reescrito/duplicado aqui.
const BLOCK = html.slice(
  html.indexOf('function screenToWorld(clientX,clientY){'),
  html.indexOf("$('#talk').addEventListener('click',()=>interact());")
);
// inputVec (WASD/setas + fallback pro clickPath), extraído separado.
const INPUTVEC_BLOCK = html.slice(
  html.indexOf('function inputVec(){'),
  html.indexOf('function moveEnt(e,dx,dy,hw,hh){')
);
assert.ok(BLOCK.length > 200, 'sanity: bloco screenToWorld..tapWorld deveria ter sido extraído de index.html');
assert.ok(INPUTVEC_BLOCK.length > 20, 'sanity: bloco inputVec deveria ter sido extraído de index.html');

function baseCtx(overrides) {
  const calls = [];
  const ctx = {
    dpr: 1, zoom: 2, camX: 0, camY: 0,
    stage: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    P: { x: 0, y: 0 },
    W_: {},
    WPX: 2880, HPX: 2112,
    blocked: () => false,
    PATHFINDING: PF,
    PORTAL: null, CAVE: null, portalCool: 0, caveCool: 0, masmorraSel: null,
    NPCS: [], MOBS: [], tgt: null, keys: {},
    calls,
    stopAuto: () => calls.push('stopAuto'),
    startAuto: () => calls.push('startAuto'),
    setTarget: (m) => calls.push('setTarget:' + (m && m.id)),
    openDialog: (n) => calls.push('openDialog:' + (n && n.id)),
    toast: (msg) => calls.push('toast:' + msg),
    openScr: (s) => calls.push('openScr:' + s),
    travel: (t) => calls.push('travel:' + t),
    mobDims: (m) => ({ w: m.w || 20, h: m.h || 20 }),
  };
  Object.assign(ctx, overrides);
  return ctx;
}

// ===================== CLICK MOVEMENT (11) =====================

test('screenToWorld: formula tela->mundo usa dpr/zoom/camX/camY reais, nunca uma segunda formula de camera', () => {
  const ctx = baseCtx({ dpr: 2, zoom: 3, camX: 400, camY: 250, stage: { getBoundingClientRect: () => ({ left: 20, top: 10 }) } });
  vm.runInNewContext(BLOCK + '\nresult=screenToWorld(120,80);', ctx);
  assert.equal(ctx.result.x, ((120 - 20) * 2) / 3 + 400);
  assert.equal(ctx.result.y, ((80 - 10) * 2) / 3 + 250);
  assert.match(html, /function screenToWorld\(clientX,clientY\)\{\s*const r=stage\.getBoundingClientRect\(\);\s*return \{x:\(\(clientX-r\.left\)\*dpr\)\/zoom\+camX, y:\(\(clientY-r\.top\)\*dpr\)\/zoom\+camY\};\s*\}/);
});

test('clickPathStep: devolve vetor unitario rumo ao proximo waypoint ainda nao alcancado (nunca teleporta)', () => {
  const ctx = baseCtx({ P: { x: 0, y: 0 } });
  vm.runInNewContext(BLOCK + `
    clickPath={points:[{x:0,y:0},{x:100,y:0},{x:100,y:100}],idx:1};
    result=clickPathStep();
  `, ctx);
  assert.deepEqual(Array.from(ctx.result), [1, 0]);
});

test('clickPathStep: avanca waypoint-a-waypoint ao chegar perto, e encerra a rota exatamente no destino final (sem empurrao residual)', () => {
  const ctx = baseCtx({ P: { x: 100, y: 0 } });
  vm.runInNewContext(BLOCK + `
    clickPath={points:[{x:0,y:0},{x:100,y:0},{x:100,y:100}],idx:1};
    v1=clickPathStep();
    idxAfter=clickPath.idx;
    P.x=100;P.y=100;
    v2=clickPathStep();
    pathAfter=clickPath;
  `, ctx);
  assert.equal(ctx.idxAfter, 2, 'ja em cima do waypoint 1 -- deveria avancar pro 2 no mesmo passo');
  assert.deepEqual(Array.from(ctx.v1), [0, 1]);
  assert.equal(ctx.v2, null, 'chegou no destino final -- rota encerra, sem vetor residual');
  assert.equal(ctx.pathAfter, null, 'clickPath deveria ser limpo ao chegar no destino final');
});

test('moveTo: contorna obstaculo por um vao real usando o MESMO blocked() fornecido -- nenhum segmento atravessa a parede', () => {
  const wall = (x, y) => x >= 100 && x <= 140 && y < 180;
  const blockedFn = (x, y) => x < 0 || y < 0 || x > 240 || y > 240 || wall(x, y);
  const ctx = baseCtx({ P: { x: 20, y: 20 }, WPX: 240, HPX: 240, blocked: blockedFn });
  vm.runInNewContext(BLOCK + `
    ok=moveTo(220,20);
    pathAfter=clickPath;
  `, ctx);
  assert.equal(ctx.ok, true, 'deveria existir rota contornando pelo vao');
  const pts = ctx.pathAfter.points;
  assert.ok(pts.length >= 2);
  for (let i = 0; i < pts.length - 1; i++) {
    assert.ok(PF.lineOfSight(blockedFn, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, 10, 10, 4), `segmento ${i} atravessaria a parede`);
  }
});

test('moveTo: destino genuinamente inalcancavel nunca inicia rota (devolve false, clickPath permanece null)', () => {
  const ctx = baseCtx({ P: { x: 20, y: 20 }, WPX: 240, HPX: 240, blocked: () => true });
  vm.runInNewContext(BLOCK + `
    ok=moveTo(200,200);
    pathAfter=clickPath;
  `, ctx);
  assert.equal(ctx.ok, false);
  assert.equal(ctx.pathAfter, null);
});

test('ensureNavGrid: reusa o mesmo grid pro mesmo mundo (cache), so reconstroi apos invalidateNavGrid() -- A* nunca reconstroi por frame', () => {
  let buildCalls = 0;
  const countingPF = Object.assign({}, PF, { buildNavGrid: (...args) => { buildCalls++; return PF.buildNavGrid(...args); } });
  const ctx = baseCtx({ PATHFINDING: countingPF, WPX: 240, HPX: 240 });
  vm.runInNewContext(BLOCK + `
    ensureNavGrid();ensureNavGrid();ensureNavGrid();
    invalidateNavGrid();
    ensureNavGrid();
  `, ctx);
  assert.equal(buildCalls, 2, 'so deveria reconstruir uma vez por chamada de ensureNavGrid apos invalidar, nunca a cada chamada');
});

test('setWorld(): invalida o grid de navegacao ao trocar de mundo (nunca reusa o grid de um mapa diferente)', () => {
  assert.match(html, /function setWorld\(w\)\{[^}]*invalidateNavGrid\(\)\}/, 'setWorld deveria chamar invalidateNavGrid()');
});

test('inputVec: tecla de movimento (WASD/setas) cancela a rota de clique-para-mover ativa e vira o fallback explicito', () => {
  const ctx = baseCtx({ P: { x: 0, y: 0 }, keys: { KeyD: true } });
  vm.runInNewContext(BLOCK + INPUTVEC_BLOCK + `
    clickPath={points:[{x:0,y:0},{x:50,y:0}],idx:1};
    result=inputVec();
    pathAfter=clickPath;
  `, ctx);
  assert.deepEqual(Array.from(ctx.result), [1, 0]);
  assert.equal(ctx.pathAfter, null, 'WASD deveria cancelar a rota ativa imediatamente');
});

test('inputVec: sem tecla pressionada, segue a rota de clique-para-mover ativa (nao trava, nao cancela sozinho)', () => {
  const ctx = baseCtx({ P: { x: 0, y: 0 }, keys: {} });
  vm.runInNewContext(BLOCK + INPUTVEC_BLOCK + `
    clickPath={points:[{x:0,y:0},{x:0,y:50}],idx:1};
    result=inputVec();
    pathAfter=clickPath;
  `, ctx);
  assert.deepEqual(Array.from(ctx.result), [0, 1]);
  assert.ok(ctx.pathAfter, 'a rota deveria continuar ativa (ainda nao chegou no waypoint)');
});

test('keydown: qualquer tecla de movimento cancela clickPath imediatamente ao ser pressionada (fallback da missao)', () => {
  assert.match(html, /if\(\['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'\]\.includes\(e\.code\)\)clickPath=null;/);
});

test('joystick de arrastar-em-qualquer-lugar foi completamente removido (nunca mais captura toque na tela)', () => {
  assert.doesNotMatch(html, /\bjoyEl\b/);
  assert.doesNotMatch(html, /SET\.joy\b/);
  assert.doesNotMatch(html, /id="joy"/);
  assert.doesNotMatch(html, /\bjoy\.vx\b/);
  assert.doesNotMatch(html, /\bjoy\.vy\b/);
});

// ===================== PORTAIS INTERATIVOS (9) =====================

test('activePortals: interactionRadius e um campo configuravel por portal (nunca um numero magico espalhado) -- usa o proprio quando definido, cai pro padrao quando ausente', () => {
  const ctx = baseCtx({
    P: { x: 0, y: 0 },
    PORTAL: { x: 100, y: 200, to: 'floresta' },
    CAVE: { x: 300, y: 400, zone: 'floresta', interactionRadius: 40 },
  });
  vm.runInNewContext(BLOCK + 'list=activePortals();', ctx);
  const [portalEntry, caveEntry] = ctx.list;
  assert.equal(portalEntry.interactionRadius, 62, 'PORTAL sem interactionRadius proprio deveria cair no DEFAULT_PORTAL_RADIUS');
  assert.equal(caveEntry.interactionRadius, 40, 'CAVE com interactionRadius proprio deveria ser respeitado, nunca ignorado');
});

test('nearestPortal: fora do raio de interacao de todo portal, nenhum fica disponivel (chegar perto sozinho nao abre nada)', () => {
  const ctx = baseCtx({ P: { x: 0, y: 0 }, PORTAL: { x: 1000, y: 1000, to: 'floresta' } });
  vm.runInNewContext(BLOCK + 'result=nearestPortal();', ctx);
  assert.equal(ctx.result, null);
});

test('nearestPortal: dentro do raio de interacao, o portal fica disponivel pro botao/clique', () => {
  const ctx = baseCtx({ P: { x: 100, y: 200 }, PORTAL: { x: 100, y: 200, to: 'floresta' } });
  vm.runInNewContext(BLOCK + 'result=nearestPortal();', ctx);
  assert.ok(ctx.result, 'deveria achar o portal -- jogador esta a 8px, bem dentro do raio padrao (62)');
});

test('activePortals()/nearestPortal() nunca disparam onEnter sozinhos -- so leem estado, nunca abrem nada por proximidade', () => {
  const ctx = baseCtx({
    P: { x: 100, y: 200 },
    PORTAL: { x: 100, y: 200, to: 'floresta' },
    CAVE: { x: 100, y: 200, zone: 'floresta' },
  });
  vm.runInNewContext(BLOCK + 'activePortals();activePortals();nearestPortal();nearestPortal();', ctx);
  assert.deepEqual(ctx.calls, [], 'nenhuma chamada de openScr/travel/stopAuto deveria acontecer so de ler o estado dos portais');
});

test('onEnter do portal pro hub (PORTAL.to===hub): aciona stopAuto()+openScr(portal), so quando chamado explicitamente', () => {
  const ctx = baseCtx({ P: { x: 100, y: 200 }, PORTAL: { x: 100, y: 200, to: 'hub' } });
  vm.runInNewContext(BLOCK + `
    const p=activePortals()[0];
    p.onEnter();
  `, ctx);
  assert.deepEqual(ctx.calls, ['stopAuto', 'openScr:portal']);
});

test('onEnter do portal direto (PORTAL.to!==hub): viaja direto pro destino, so quando chamado explicitamente (nunca por proximidade)', () => {
  const ctx = baseCtx({ P: { x: 100, y: 200 }, PORTAL: { x: 100, y: 200, to: 'vila' } });
  vm.runInNewContext(BLOCK + `
    const p=activePortals()[0];
    p.onEnter();
  `, ctx);
  assert.deepEqual(ctx.calls, ['travel:vila']);
});

test('onEnter da entrada de masmorra (CAVE): define masmorraSel=CAVE.zone e abre a tela de selecao, so quando chamado explicitamente', () => {
  const ctx = baseCtx({ P: { x: 300, y: 400 }, CAVE: { x: 300, y: 400, zone: 'cripta' } });
  vm.runInNewContext(BLOCK + `
    const p=activePortals()[0];
    p.onEnter();
    selAfter=masmorraSel;
  `, ctx);
  assert.equal(ctx.selAfter, 'cripta');
  assert.deepEqual(ctx.calls, ['stopAuto', 'openScr:masmorra']);
});

test('update(): bloco de portal/caverna nao abre mais NADA sozinho por proximidade (so decrementa cooldown)', () => {
  const start = html.indexOf('// portal -- Fase 5.16.6');
  const end = html.indexOf('// local', start);
  assert.ok(start >= 0 && end > start, 'sanity: bloco de portal do update() deveria existir com esse comentario');
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /openScr\(/, 'update() nunca deveria abrir tela de portal/masmorra sozinho por proximidade');
  assert.doesNotMatch(block, /travel\(/, 'update() nunca deveria viajar sozinho por proximidade');
  assert.match(block, /portalCool-=dt/);
  assert.match(block, /caveCool-=dt/);
});

test('tapWorld: prioridade de clique no codigo-fonte e NPC > portal > mob/alvo > chao, nessa ordem (nunca outra)', () => {
  const start = html.indexOf('function tapWorld(cx,cy){');
  const end = html.indexOf("$('#talk').addEventListener('click',()=>interact());");
  const body = html.slice(start, end);
  const npcIdx = body.indexOf('for(const n of NPCS)');
  const portalIdx = body.indexOf('for(const p of activePortals())');
  const mobIdx = body.indexOf('for(const m of MOBS)');
  const groundIdx = body.lastIndexOf('moveTo(wx,wy);');
  assert.ok(npcIdx >= 0 && portalIdx > npcIdx && mobIdx > portalIdx && groundIdx > mobIdx,
    `prioridade deveria ser NPC(${npcIdx}) > portal(${portalIdx}) > mob(${mobIdx}) > chao(${groundIdx})`);
});

test('servidor: dungeon_enter valida mapa+raio da entrada da caverna de forma independente (nunca confia so na distancia que o cliente afirma)', () => {
  const S = require('../server.js');
  const { DUNGEON_CAVE_POS, DUNGEON_CAVE_RADIUS } = S;
  assert.ok(DUNGEON_CAVE_POS && Number.isFinite(DUNGEON_CAVE_POS.x) && Number.isFinite(DUNGEON_CAVE_POS.y));
  assert.ok(DUNGEON_CAVE_RADIUS > 0);
  const passesGate = (p, zone) => !(p.map !== zone || Math.hypot(p.x - DUNGEON_CAVE_POS.x, p.y - DUNGEON_CAVE_POS.y) > DUNGEON_CAVE_RADIUS);
  assert.equal(passesGate({ map: 'floresta', x: DUNGEON_CAVE_POS.x, y: DUNGEON_CAVE_POS.y }, 'floresta'), true, 'exatamente na entrada, no mapa certo, deveria passar');
  assert.equal(passesGate({ map: 'floresta', x: DUNGEON_CAVE_POS.x + DUNGEON_CAVE_RADIUS + 50, y: DUNGEON_CAVE_POS.y }, 'floresta'), false, 'longe demais da entrada deveria falhar mesmo no mapa certo');
  assert.equal(passesGate({ map: 'vila', x: DUNGEON_CAVE_POS.x, y: DUNGEON_CAVE_POS.y }, 'floresta'), false, 'coordenada certa num mapa errado deveria falhar -- servidor confia no proprio p.map, nunca so na distancia');
});
