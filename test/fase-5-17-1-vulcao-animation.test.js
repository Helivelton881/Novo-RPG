'use strict';
// Fase 5.17.1 -- Hotfix Vulcao Ardente: sprites & animacoes. Testes puros
// contra game-data/monster-animation.js (fonte unica, usada pelo cliente e
// pelo campo visual `face` do servidor) + os assets REAIS embutidos em SPR.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const A = require('../game-data/monster-animation.js');
const S = require('../server.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function loadSPR() {
  const line = HTML.split('\n').find(l => l.includes('"salamander":') && l.includes('"lorde":'));
  return JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
}
function pngSize(dataUri) {
  const b = Buffer.from(dataUri.split(',')[1], 'base64');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// ===== assets reais =====
test('ASSETS: config de cada monstro do Vulcao bate com o sprite sheet real (frame size, 1 linha x 3 frames)', () => {
  const SPR = loadSPR();
  for (const type of A.VOLCANO_TYPES) {
    const c = A.configFor(type), s = SPR[c.sheet];
    assert.ok(s, `${type}: sheet ${c.sheet} existe`);
    assert.equal(c.frameW, s.fw, `${type} frameW`);
    assert.equal(c.frameH, s.fh, `${type} frameH`);
    const { w, h } = pngSize(s.img);
    assert.equal(h, s.fh, `${type}: uma unica linha (sem linhas por direcao/ataque)`);
    assert.equal(w / s.fw, c.frames, `${type}: ${c.frames} colunas`);
  }
});

test('ASSETS: todo frame referenciado pela config existe no sheet (nunca coluna fora do PNG)', () => {
  for (const type of A.VOLCANO_TYPES) {
    const c = A.configFor(type);
    const frames = [c.idle, ...c.walk.cycle, c.attack.frame, ...(c.attack.cycle || [])].filter(f => f != null);
    for (const f of frames) assert.ok(Number.isInteger(f) && f >= 0 && f < c.frames, `${type} frame ${f}`);
  }
});

// ===== direcao / flip =====
test('FLIP: sprites nativos pra ESQUERDA so espelham olhando pra DIREITA (causa raiz do "andar de costas")', () => {
  for (const type of ['sala', 'elem', 'calc', 'lorde', 'ancient_titan']) {
    assert.equal(A.configFor(type).nativeFacing, A.LEFT, type);
    assert.equal(A.shouldMirror(type, A.LEFT), false, `${type} andando pra esquerda nao espelha`);
    assert.equal(A.shouldMirror(type, A.RIGHT), true, `${type} andando pra direita espelha`);
  }
});

test('FLIP: morcego de cinzas (frontal) nunca espelha', () => {
  for (const f of [A.LEFT, A.RIGHT, undefined, 0]) assert.equal(A.shouldMirror('cinza', f), false);
});

test('FLIP: um unico ponto de espelhamento por draw (sem double flip) e sempre dentro de save()/restore()', () => {
  for (const fn of ['drawSala', 'drawElem', 'drawCalc', 'drawLorde', 'drawCinza']) {
    const i = HTML.indexOf('function ' + fn + '(');
    const body = HTML.slice(i, HTML.indexOf('\n}\n', i));
    assert.ok(!/scale\(-1,1\)/.test(body), `${fn} nao espelha por conta propria (so via vulcMirror)`);
    assert.ok(body.includes('drawVulcSprite('), `${fn} usa o helper central`);
  }
  const i = HTML.indexOf('function drawVulcSprite(');
  const body = HTML.slice(i, HTML.indexOf('\n}\n', i));
  assert.match(body, /ctx\.save\(\);vulcMirror\(s\)/);
  assert.match(body, /ctx\.restore\(\);/);
});

test('DIRECAO: faceFromDx segue o movimento real com histerese (sem piscar com sub-pixel)', () => {
  assert.equal(A.faceFromDx(5, A.LEFT), A.RIGHT);
  assert.equal(A.faceFromDx(-5, A.RIGHT), A.LEFT);
  assert.equal(A.faceFromDx(0.2, A.LEFT), A.LEFT, 'empurrao de colisao nao vira o monstro');
  assert.equal(A.faceFromDx(-0.2, A.RIGHT), A.RIGHT);
  assert.equal(A.faceFromDx(0, undefined), A.RIGHT);
});

test('DIRECAO: durante ataque olha pro ALVO real, mesmo parado ou tendo andado pro outro lado', () => {
  assert.equal(A.resolveFace({ type: 'sala', state: 'wind', face: A.LEFT, moveDx: 0, targetDx: 40 }), A.RIGHT);
  assert.equal(A.resolveFace({ type: 'elem', state: 'slam', face: A.RIGHT, moveDx: 3, targetDx: -30 }), A.LEFT);
  assert.equal(A.resolveFace({ type: 'lorde', state: 'meteor', face: A.LEFT, moveDx: 0, targetDx: 200 }), A.RIGHT);
  // fora de ataque o alvo nao manda -- segue o movimento
  assert.equal(A.resolveFace({ type: 'sala', state: 'chase', face: A.LEFT, moveDx: -4, targetDx: 90 }), A.LEFT);
  // sem alvo conhecido em ataque: mantem o lado (nunca inverte sozinho)
  assert.equal(A.resolveFace({ type: 'calc', state: 'wind', face: A.LEFT, moveDx: 0 }), A.LEFT);
});

test('SERVIDOR: volcanoMobFace usa o alvo travado (mob.tgt) durante o ataque', () => {
  const player = { id: 'p1', x: 600, y: 500 };
  const present = [[{}, player]];
  const mob = { type: 'sala', state: 'wind', face: -1, x: 500, y: 500, tgt: 'p1' };
  assert.equal(S.volcanoMobFace(mob, 0, present), 1, 'alvo a direita -> olha pra direita');
  player.x = 420;
  assert.equal(S.volcanoMobFace({ ...mob, face: 1 }, 0, present), -1);
  assert.equal(S.volcanoMobFace({ ...mob, state: 'chase', face: -1 }, 0.1, present), -1, 'chase parado: mantem');
});

// ===== state machine =====
test('ESTADO: prioridade death > attack > hit > walk > idle', () => {
  assert.equal(A.visualState({ type: 'sala', dead: true, state: 'wind', flash: 1, moving: true }), 'death');
  assert.equal(A.visualState({ type: 'sala', state: 'wind', flash: 1, moving: true }), 'attack');
  assert.equal(A.visualState({ type: 'sala', state: 'chase', flash: .1, moving: true }), 'hit');
  assert.equal(A.visualState({ type: 'sala', state: 'chase', flash: 0, moving: true }), 'walk');
  assert.equal(A.visualState({ type: 'sala', state: 'chase', flash: 0, moving: false }), 'idle');
});

test('ESTADO: attack nunca e sobrescrito por walk (servidor manda moving=true durante o ataque)', () => {
  for (const [type, states] of [['sala', ['wind', 'breath']], ['elem', ['wind', 'slam']], ['calc', ['wind']], ['lorde', ['wind', 'wind2', 'meteor']], ['cinza', ['wind', 'swoop']]]) {
    for (const state of states) assert.equal(A.visualState({ type, state, moving: true }), 'attack', `${type} ${state}`);
  }
});

test('ESTADO: elemental no golpe (slam) mostra pose de ataque (antes caia no frame parado)', () => {
  assert.equal(A.frameFor('elem', A.visualState({ type: 'elem', state: 'slam', moving: false }), 0), A.configFor('elem').attack.frame);
});

test('ESTADO: morte nunca volta pra walk; fallback de fade termina em 0', () => {
  assert.equal(A.visualState({ type: 'calc', dead: true, moving: true, state: 'chase' }), 'death');
  assert.equal(A.deathAlpha(10, 10), 1);
  assert.ok(A.deathAlpha(10, 10 + A.DEATH_FADE_S / 2) > 0);
  assert.equal(A.deathAlpha(10, 10 + A.DEATH_FADE_S), 0);
  assert.equal(A.deathAlpha(10, 99), 0);
});

// ===== frames =====
test('WALK: ciclo em ordem pelo timer da entidade (nunca Date.now), sem frame fora do ciclo', () => {
  const c = A.configFor('sala');
  const seen = [];
  for (let i = 0; i < c.walk.cycle.length; i++) seen.push(A.frameFor('sala', 'walk', (i + .5) / c.walk.fps));
  assert.deepEqual(seen, c.walk.cycle);
  assert.equal(A.frameFor('sala', 'walk', c.walk.cycle.length / c.walk.fps + .01), c.walk.cycle[0], 'ciclo repete');
});

test('WALK/IDLE/ATTACK: frames esperados por tipo', () => {
  for (const type of ['sala', 'elem', 'calc', 'lorde']) {
    assert.equal(A.frameFor(type, 'idle', 3.3), 0, `${type} idle`);
    assert.equal(A.frameFor(type, 'attack', 3.3), 2, `${type} ataque (fallback: pose de passo avancado)`);
  }
  // morcego: asa sempre batendo; mais rapido no ataque
  assert.notEqual(A.frameFor('cinza', 'idle', 0), undefined);
  assert.equal(A.frameFor('cinza', 'attack', 1 / 18 + .001), 1);
  assert.equal(A.frameFor('cinza', 'walk', 1 / 18 + .001), 0);
});

test('HIT: sem frame de hit no asset -- mantem a pose atual (walk se andando, idle se parado)', () => {
  assert.equal(A.frameFor('sala', 'hit', .2, true), A.frameFor('sala', 'walk', .2));
  assert.equal(A.frameFor('sala', 'hit', .2, false), 0);
});

// ===== gameplay intocado =====
test('REGRESSAO: stats de gameplay do Vulcao (HP/XP/dano) inalterados', () => {
  assert.deepEqual(S.mobStats('sala', 36, false), { hp: 2880, xp: 444, dmg: 141 });
  assert.deepEqual(S.mobStats('elem', 37, false), { hp: 4960, xp: 536, dmg: 176 });
  assert.deepEqual(S.mobStats('calc', 38, false), { hp: 4160, xp: 558, dmg: 140 });
  assert.deepEqual(S.mobStats('lorde', 40, true), { hp: 26000, xp: 9000, dmg: 170 });
});

test('REGRESSAO: hitbox (mobDims) continua derivada do frame original x escala, sem mudanca', () => {
  const i = HTML.indexOf('function mobDims(');
  const body = HTML.slice(i, HTML.indexOf('\n', i));
  assert.match(body, /SPR\.bat_ash\.fw\*1\.3/);
});
