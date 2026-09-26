'use strict';
// Fase 5.16.6 -- click-to-move + pathfinding. Nucleo puro
// (game-data/pathfinding.js), sem DOM/canvas/rede -- sempre roda, sem
// Supabase. A funcao blocked() de teste aqui e uma REIMPLEMENTACAO
// simples que imita o formato real (blocked(x,y,hw,hh) -> bool), mas o
// modulo em si nunca sabe nada sobre o jogo -- so recebe essa funcao
// como parametro, exatamente como index.html vai fazer com o blocked()
// real do jogo (mesma fonte de colisao, nunca uma segunda geometria).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const PF = require('../game-data/pathfinding.js');

function wallBox(x0, y0, x1, y1) {
  return (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
}
function combine(...fns) { return (x, y, hw, hh) => fns.some(f => f(x, y, hw, hh)); }
function boundsOnly(maxX, maxY) { return (x, y) => x < 0 || y < 0 || x > maxX || y > maxY; }

test('findPath: linha reta quando nao ha obstaculo entre origem e destino', () => {
  const blocked = boundsOnly(240, 240);
  const path = PF.findPath(blocked, 20, 20, 220, 20, { maxX: 240, maxY: 240 });
  assert.ok(path, 'deveria achar rota');
  assert.equal(path.length, 2, 'sem obstaculo, a simplificacao deveria colapsar tudo em start->goal direto');
  assert.deepEqual(path[0], { x: 20, y: 20 });
  assert.deepEqual(path[path.length - 1], { x: 220, y: 20 });
});

test('findPath: contorna uma parede vertical com vao, nunca atravessa a parede', () => {
  const wall = (x, y) => x >= 108 && x <= 132 && y < 180; // vao so nos ultimos 60px
  const blocked = combine(boundsOnly(240, 240), wall);
  const path = PF.findPath(blocked, 20, 20, 220, 20, { maxX: 240, maxY: 240 });
  assert.ok(path, 'deveria achar rota contornando pelo vao');
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(PF.lineOfSight(blocked, path[i].x, path[i].y, path[i + 1].x, path[i + 1].y, 10, 10, 4),
      `segmento ${i} nao deveria atravessar a parede`);
  }
  // a rota precisa mesmo ter descido ate a faixa do vao (y>=180) em algum waypoint --
  // senao a "volta" seria so um artefato e não uma travessia real do vao.
  assert.ok(path.some(p => p.y >= 175), 'rota deveria realmente passar pelo vao, nao so contornar no ar');
});

test('findPath: obstaculo com espessura realista (48px, igual WALL=1 tile de masmorra) fechado sem vao -> destino inalcancavel devolve rota que nunca entra no interior', () => {
  // anel fechado de 24px de espessura ao redor de uma area central -- nenhum vao.
  const ring = (x, y) => {
    const inBand = x >= 90 && x <= 150 && y >= 90 && y <= 150;
    if (!inBand) return false;
    const wallTop = y < 114, wallBottom = y >= 126, wallLeft = x < 114, wallRight = x >= 126;
    return wallTop || wallBottom || wallLeft || wallRight;
  };
  const blocked = combine(boundsOnly(240, 240), ring);
  const path = PF.findPath(blocked, 20, 20, 120, 120, { maxX: 240, maxY: 240, maxSnapCells: 2 });
  if (path) {
    for (const p of path) {
      const insideHole = p.x > 114 && p.x < 126 && p.y > 114 && p.y < 126;
      assert.ok(!insideHole, `waypoint (${p.x},${p.y}) nunca deveria cair dentro do anel fechado`);
    }
  }
  // (path pode ser null OU uma rota que para fora do anel -- as duas sao corretas;
  // o que NUNCA pode acontecer é um waypoint dentro do buraco genuinamente cercado.)
});

test('findPath: clique em cima de obstaculo faz snap pro ponto caminhavel mais proximo, nunca fica dentro do obstaculo', () => {
  const box = wallBox(100, 100, 140, 140);
  const blocked = combine(boundsOnly(240, 240), box);
  const path = PF.findPath(blocked, 20, 20, 120, 120, { maxX: 240, maxY: 240 });
  assert.ok(path, 'deveria snapar pra um destino valido em vez de desistir');
  const last = path[path.length - 1];
  assert.ok(!(last.x >= 100 && last.x <= 140 && last.y >= 100 && last.y <= 140), 'destino final nunca pode estar dentro do obstaculo original');
});

test('findPath: destino genuinamente fora do alcance (sem celula livre proxima) devolve null -- nunca inicia rota', () => {
  const wholeMap = wallBox(0, 0, 500, 500); // tudo bloqueado, sem lugar livre nenhum
  const blocked = combine(boundsOnly(240, 240), wholeMap);
  const path = PF.findPath(blocked, 20, 20, 120, 120, { maxX: 240, maxY: 240, maxSnapCells: 2 });
  assert.equal(path, null, 'mapa totalmente bloqueado nunca deveria produzir uma rota');
});

test('aStar: nunca corta canto de obstaculo (diagonal so permitida se as duas celulas ortogonais tambem estiverem livres)', () => {
  // bloco solido num quadrado 2x2 de celulas -- uma diagonal "passando pela quina"
  // do bloco precisaria atravessar uma das celulas ortogonais bloqueadas.
  const CELL = PF.CELL;
  const blockAt = (gx, gy) => (x, y) => {
    const cx = gx * CELL, cy = gy * CELL;
    return x >= cx && x < cx + CELL && y >= cy && y < cy + CELL;
  };
  const blocked = combine(boundsOnly(240, 240), blockAt(3, 3));
  const nav = PF.buildNavGrid(blocked, 0, 0, 240, 240, 10, 10);
  // celula (2,2) livre, celula (4,4) livre, tentando ir na diagonal cortando perto de (3,3) bloqueada:
  // se (3,2) ou (2,3) tambem estiverem bloqueadas, a diagonal (2,2)->(3,3) nunca deveria ser usada.
  const path = PF.aStar(nav, { gx: 2, gy: 2 }, { gx: 4, gy: 4 });
  assert.ok(path, 'deveria existir rota contornando');
  for (const c of path) assert.notDeepEqual(c, { gx: 3, gy: 3 }, 'rota nunca deveria passar pela celula bloqueada');
});

test('simplifyPath: colapsa waypoints redundantes em linha reta sem atravessar colisao', () => {
  const blocked = boundsOnly(1000, 1000);
  const zigzag = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }, { x: 100, y: 100 }];
  const simplified = PF.simplifyPath(blocked, zigzag, 10, 10, 8);
  assert.ok(simplified.length < zigzag.length, 'deveria colapsar os pontos intermediarios colineares');
  assert.deepEqual(simplified[0], zigzag[0]);
  assert.deepEqual(simplified[simplified.length - 1], zigzag[zigzag.length - 1]);
});

test('simplifyPath: nunca simplifica atravessando uma parede real', () => {
  const wall = (x, y) => x >= 45 && x <= 55 && y >= 0 && y <= 80;
  const blocked = combine(boundsOnly(240, 240), wall);
  const detour = [{ x: 0, y: 0 }, { x: 50, y: 90 }, { x: 100, y: 0 }]; // rota valida que desviou por baixo do vao
  const simplified = PF.simplifyPath(blocked, detour, 10, 10, 4);
  for (let i = 0; i < simplified.length - 1; i++) {
    assert.ok(PF.lineOfSight(blocked, simplified[i].x, simplified[i].y, simplified[i + 1].x, simplified[i + 1].y, 10, 10, 4),
      'simplificacao nunca pode introduzir um segmento que atravesse a parede');
  }
});
