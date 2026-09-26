// Fase 5.16.6 -- pathfinding compartilhado entre server.js (require,
// Node/CommonJS) e index.html (<script src>, expoe window.PATHFINDING).
//
// Nucleo PURO (sem DOM/canvas/rede) -- so recebe uma funcao `blocked(x,y)`
// (fornecida por quem chama) e coordenadas, nunca le kind[]/bgrid direto
// nem duplica geometria de colisao. Quem chama (index.html) passa o
// blocked() REAL do jogo (mesma fonte que o movimento por teclado ja usa),
// entao o grid de navegacao aqui e sempre um espelho, nunca uma segunda
// verdade.
'use strict';

(function () {

// Celula do grid de navegacao: T/2 (T=48 -> 24px). Mais fino que o grid
// espacial de colisao (bgrid, 96px) pra nao perder vaos estreitos (ex.
// corredores de 1 tile de masmorra), mais grosso que kind[] (2px, caro
// demais pra reconstruir por clique). Mundo de campo (2880x2112) vira
// so ~120x88 = 10560 celulas -- barato de reconstruir a cada clique.
const CELL = 24;

// Constroi o grid de navegacao amostrando blocked() no CENTRO de cada
// celula, com hw/hh = raio real do personagem (10,10 no jogo hoje) --
// isso e a "inflacao de obstaculo": uma celula cuja amostragem central
// already colide com o raio do jogador vira intransitavel, entao o A*
// nunca gera uma rota que passe por um vao menor que o proprio collider,
// sem precisar de uma segunda logica de inflacao geometrica.
function buildNavGrid(blockedFn, minX, minY, maxX, maxY, playerHw, playerHh) {
  const cols = Math.max(1, Math.ceil((maxX - minX) / CELL));
  const rows = Math.max(1, Math.ceil((maxY - minY) / CELL));
  const grid = new Uint8Array(cols * rows); // 0 = livre, 1 = bloqueado
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const wx = minX + (gx + 0.5) * CELL, wy = minY + (gy + 0.5) * CELL;
      grid[gy * cols + gx] = blockedFn(wx, wy, playerHw, playerHh) ? 1 : 0;
    }
  }
  return { grid, cols, rows, minX, minY, cell: CELL };
}

function worldToCell(nav, x, y) {
  return {
    gx: Math.min(nav.cols - 1, Math.max(0, Math.floor((x - nav.minX) / nav.cell))),
    gy: Math.min(nav.rows - 1, Math.max(0, Math.floor((y - nav.minY) / nav.cell))),
  };
}
function cellToWorld(nav, gx, gy) {
  return { x: nav.minX + (gx + 0.5) * nav.cell, y: nav.minY + (gy + 0.5) * nav.cell };
}
function cellFree(nav, gx, gy) {
  if (gx < 0 || gy < 0 || gx >= nav.cols || gy >= nav.rows) return false;
  return nav.grid[gy * nav.cols + gx] === 0;
}

// Acha a celula livre mais proxima de (gx,gy) por busca em anel
// (BFS por distancia de Chebyshev crescente) -- usado quando o clique
// cai em cima de um obstaculo ou fora do mundo. `maxRing` em celulas
// (nao em px) limita o quanto se afasta antes de desistir.
function nearestFreeCell(nav, gx, gy, maxRing) {
  if (cellFree(nav, gx, gy)) return { gx, gy };
  for (let r = 1; r <= maxRing; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // so o aro externo deste raio
        const nx = gx + dx, ny = gy + dy;
        if (cellFree(nav, nx, ny)) return { gx: nx, gy: ny };
      }
    }
  }
  return null;
}

// Min-heap binaria simples, indexada por `f` -- o open-set do A* com um
// Map()+busca linear vira O(n) por iteracao (O(n^2) no total), o que num
// grid de ~10k celulas media 200ms+ por clique (medido, inaceitavel pra
// "click-to-move" responsivo). Heap deixa extrair-minimo em O(log n).
function MinHeap() { this.a = []; }
MinHeap.prototype.push = function (item) {
  const a = this.a; a.push(item); let i = a.length - 1;
  while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; const t = a[p]; a[p] = a[i]; a[i] = t; i = p; }
};
MinHeap.prototype.pop = function () {
  const a = this.a, top = a[0], last = a.pop();
  if (a.length) { a[0] = last; let i = 0; for (;;) { let l = i * 2 + 1, r = l + 1, m = i; if (l < a.length && a[l].f < a[m].f) m = l; if (r < a.length && a[r].f < a[m].f) m = r; if (m === i) break; const t = a[m]; a[m] = a[i]; a[i] = t; i = m; } }
  return top;
};
Object.defineProperty(MinHeap.prototype, 'size', { get() { return this.a.length; } });

// A* 8-direcoes, heuristica octile, SEM corte de canto: uma diagonal so
// e permitida se as DUAS celulas ortogonais adjacentes tambem estiverem
// livres (senao o personagem "cortaria" a quina de uma parede/arvore que
// blocked() classificaria como colisao se andasse em linha reta ali).
const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];
function aStar(nav, start, goal) {
  if (!cellFree(nav, start.gx, start.gy) || !cellFree(nav, goal.gx, goal.gy)) return null;
  const idx = (gx, gy) => gy * nav.cols + gx;
  const open = new MinHeap();
  const cameFrom = new Map();
  const gScore = new Map();
  const startIdx = idx(start.gx, start.gy);
  gScore.set(startIdx, 0);
  const h = (gx, gy) => { const dx = Math.abs(gx - goal.gx), dy = Math.abs(gy - goal.gy); return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy); };
  open.push({ idx: startIdx, gx: start.gx, gy: start.gy, f: h(start.gx, start.gy) });
  const closed = new Set();
  const MAX_STEPS = 20000; // trava de seguranca -- nunca deveria chegar perto disso num grid de ~10k celulas
  let steps = 0;
  while (open.size && steps++ < MAX_STEPS) {
    const cur = open.pop(), curIdx = cur.idx;
    if (closed.has(curIdx)) continue; // entrada obsoleta (mesma celula empurrada de novo com f melhor depois)
    if (cur.gx === goal.gx && cur.gy === goal.gy) {
      const path = [{ gx: cur.gx, gy: cur.gy }];
      let k = curIdx;
      while (cameFrom.has(k)) { k = cameFrom.get(k); const gy = Math.floor(k / nav.cols), gx = k % nav.cols; path.push({ gx, gy }); }
      path.reverse();
      return path;
    }
    closed.add(curIdx);
    for (const [dx, dy, cost] of DIRS) {
      const nx = cur.gx + dx, ny = cur.gy + dy;
      if (!cellFree(nav, nx, ny)) continue;
      if (dx !== 0 && dy !== 0) { if (!cellFree(nav, cur.gx + dx, cur.gy) || !cellFree(nav, cur.gx, cur.gy + dy)) continue; } // sem corte de canto
      const nIdx = idx(nx, ny);
      if (closed.has(nIdx)) continue;
      const tentativeG = (gScore.get(curIdx) || 0) + cost;
      if (tentativeG < (gScore.has(nIdx) ? gScore.get(nIdx) : Infinity)) {
        cameFrom.set(nIdx, curIdx);
        gScore.set(nIdx, tentativeG);
        open.push({ idx: nIdx, gx: nx, gy: ny, f: tentativeG + h(nx, ny) });
      }
    }
  }
  return null; // sem rota (ilha isolada, ou MAX_STEPS estourado)
}

// Line-of-sight amostrado a cada `step` px (mesma granularidade que
// update() ja usa pra mover o jogador, nunca mais grosso que isso --
// senao a simplificacao poderia "pular" por cima de uma parede fina).
function lineOfSight(blockedFn, x0, y0, x1, y1, playerHw, playerHh, step) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  if (dist < 1) return true;
  const n = Math.ceil(dist / step);
  for (let i = 1; i <= n; i++) {
    const t = i / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    if (blockedFn(x, y, playerHw, playerHh)) return false;
  }
  return true;
}

// String-pulling: de cada waypoint, tenta esticar direto ate o waypoint
// mais distante ainda com linha de visao livre, descartando os do meio.
// Nunca atravessa colisao porque cada tentativa e verificada por
// lineOfSight() contra o MESMO blocked() real.
function simplifyPath(blockedFn, worldPoints, playerHw, playerHh, losStep) {
  if (worldPoints.length <= 2) return worldPoints.slice();
  const out = [worldPoints[0]];
  let i = 0;
  while (i < worldPoints.length - 1) {
    let j = worldPoints.length - 1;
    for (; j > i + 1; j--) {
      if (lineOfSight(blockedFn, worldPoints[i].x, worldPoints[i].y, worldPoints[j].x, worldPoints[j].y, playerHw, playerHh, losStep)) break;
    }
    out.push(worldPoints[j]);
    i = j;
  }
  return out;
}

// Pipeline completo: mundo (start,goal) -> waypoints simplificados em
// coordenadas de mundo, ou null se goal ficou inalcancavel mesmo apos
// tentar achar a celula livre mais proxima. `maxSnapCells` limita o
// quanto o destino pode ser "puxado" pra dentro do mapa/pra fora de um
// obstaculo antes de desistir (pedido explicito: "se nao existir, nao
// iniciar rota").
function findPath(blockedFn, startX, startY, goalX, goalY, opts) {
  const o = opts || {};
  const minX = o.minX || 0, minY = o.minY || 0, maxX = o.maxX, maxY = o.maxY;
  const hw = o.playerHw != null ? o.playerHw : 10, hh = o.playerHh != null ? o.playerHh : 10;
  const maxSnapCells = o.maxSnapCells != null ? o.maxSnapCells : 12;
  const losStep = o.losStep || 12;
  const nav = o.nav || buildNavGrid(blockedFn, minX, minY, maxX, maxY, hw, hh);
  let start = worldToCell(nav, startX, startY);
  let goal = worldToCell(nav, goalX, goalY);
  if (!cellFree(nav, start.gx, start.gy)) { const f = nearestFreeCell(nav, start.gx, start.gy, maxSnapCells); if (!f) return null; start = f; }
  if (!cellFree(nav, goal.gx, goal.gy)) { const f = nearestFreeCell(nav, goal.gx, goal.gy, maxSnapCells); if (!f) return null; goal = f; }
  const cellPath = aStar(nav, start, goal);
  if (!cellPath) return null;
  const worldPoints = cellPath.map(c => cellToWorld(nav, c.gx, c.gy));
  worldPoints[0] = { x: startX, y: startY }; // comeca exatamente de onde o jogador esta, nunca do centro da celula
  worldPoints[worldPoints.length - 1] = cellFree(nav, worldToCell(nav, goalX, goalY).gx, worldToCell(nav, goalX, goalY).gy) ? { x: goalX, y: goalY } : worldPoints[worldPoints.length - 1];
  return simplifyPath(blockedFn, worldPoints, hw, hh, losStep);
}

const PATHFINDING = { CELL, buildNavGrid, worldToCell, cellToWorld, cellFree, nearestFreeCell, aStar, lineOfSight, simplifyPath, findPath };
if (typeof module !== 'undefined' && module.exports) module.exports = PATHFINDING;
else if (typeof window !== 'undefined') window.PATHFINDING = PATHFINDING;

})();
