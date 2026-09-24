// Fase 5.2 — geracao de masmorra compartilhada entre server.js (require,
// Node/CommonJS) e index.html (<script src>, expoe window.DUNGEON_GEN).
//
// So a FORMA do labirinto (mazeGen) e o RNG (mulberry) moram aqui -- e
// matematica pura, sem DOM/canvas, entao da pra compartilhar sem risco.
// Decoracao visual (props/paredes desenhadas) continua 100% no cliente
// (buildMasmorra em index.html), sem mudanca -- nao afeta jogo/economia,
// so estetica, e reconstruir esse desenho inteiro fora do cliente seria
// modularizacao alem do necessario pra esta fase.
//
// O servidor usa mazeGen() (mesma funcao, mesma saida) pra saber onde
// ficam as paredes de verdade (colisao de IA de monstro) -- ver
// dungeonWallRects() abaixo, que espelha a MESMA matematica de bloqueio
// que buildMasmorra() usa pra desenhar/colidir no cliente (server.js
// "espelha" varias coisas do cliente do mesmo jeito ha varias fases,
// ver mobStats/GEAR_DATA/CLASS_DMG -- mesmo padrao aqui).
'use strict';

// Tudo dentro de um IIFE de proposito: este arquivo e carregado como
// <script> classico (nao module) em index.html, junto com gear-data.js e
// o script principal -- top-level let/const de scripts classicos
// distintos compartilham o MESMO escopo lexico global da pagina. Sem o
// IIFE, nomes daqui (T, MASMORRA_CELL, MASMORRA_PASS, MASMORRA_WALL,
// mazeGen, etc.) colidem com os mesmos nomes ja declarados no script
// principal de index.html ("Identifier 'X' has already been declared" --
// achado real rodando o servidor de verdade, quebrava a pagina inteira).
// Node (require) ja isola cada arquivo automaticamente, entao o IIFE nao
// muda nada la, so fecha a brecha do lado do browser.
(function () {

function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Identico ao mazeGen() de index.html -- gera um labirinto perfeito
// (DFS recursivo por pilha) de cols x rows, entrada no canto inferior
// esquerdo (sx,sy), e acha por BFS a sala mais distante da entrada (a
// sala do chefe, bx/by). Determinístico: mesmo seed = mesmo labirinto,
// sempre (sem isso a Fase 5.2 nao consegue provar layout server-side).
function mazeGen(cols, rows, seed) {
  const rnd = mulberry(seed), cell = () => ({ v: false, N: false, S: false, E: false, W: false });
  const g = Array.from({ length: rows }, () => Array.from({ length: cols }, cell));
  const sx = 0, sy = rows - 1, stack = [[sx, sy]]; g[sy][sx].v = true;
  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const opts = [[0, -1, 'N', 'S'], [0, 1, 'S', 'N'], [1, 0, 'E', 'W'], [-1, 0, 'W', 'E']].filter(([dx, dy]) => { const nx = cx + dx, ny = cy + dy; return nx >= 0 && ny >= 0 && nx < cols && ny < rows && !g[ny][nx].v; });
    if (!opts.length) { stack.pop(); continue; }
    const [dx, dy, a, b] = opts[Math.floor(rnd() * opts.length)];
    g[cy][cx][a] = true; const nx = cx + dx, ny = cy + dy; g[ny][nx][b] = true; g[ny][nx].v = true; stack.push([nx, ny]);
  }
  const dist = Array.from({ length: rows }, () => Array(cols).fill(-1)); dist[sy][sx] = 0;
  const q = [[sx, sy]]; let far = [sx, sy], fd = 0;
  while (q.length) {
    const [cx, cy] = q.shift(), d = dist[cy][cx];
    if (d > fd) { fd = d; far = [cx, cy]; }
    const c = g[cy][cx];
    for (const [dx, dy, k] of [[0, -1, 'N'], [0, 1, 'S'], [1, 0, 'E'], [-1, 0, 'W']]) if (c[k]) { const nx = cx + dx, ny = cy + dy; if (dist[ny][nx] < 0) { dist[ny][nx] = d + 1; q.push([nx, ny]); } }
  }
  return { g, sx, sy, bx: far[0], by: far[1], dist };
}

const T = 48, MASMORRA_CELL = 7, MASMORRA_PASS = 3, MASMORRA_WALL = 1;
// Mesmo layout de todas as 7 masmorras hoje (buildMasmorra em index.html):
// grade 7x5, offset fixo (ox=3,oy=4). Preservado exatamente -- nao e um
// numero mágico novo, é o mesmo hardcode que o cliente já usa.
const DUNGEON_COLS = 7, DUNGEON_ROWS = 5, DUNGEON_OX = 3, DUNGEON_OY = 4;

// Espelha o loop de paredes de buildMasmorra() (index.html) em retangulos
// puros {x,y,w,h} em pixels de mundo, pra o servidor checar colisao de IA
// sem precisar de canvas/DOM. Cliente continua desenhando/colidindo do
// jeito que sempre desenhou (inalterado) -- isto é só a cópia server-side
// da mesma matemática, não uma extração/remoção do código do cliente.
function dungeonWallRects(mz, cols, rows, ox, oy) {
  const C = MASMORRA_CELL, half = (C - MASMORRA_PASS) / 2, rects = [];
  const push = (x, y, w, h) => rects.push({ x, y, w, h });
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    const rx0 = ox + cx * C, ry0 = oy + cy * C, rx1 = rx0 + C, ry1 = ry0 + C;
    const c = mz.g[cy][cx];
    if (!c.N) push(rx0 * T, ry0 * T - MASMORRA_WALL * T, C * T, MASMORRA_WALL * T);
    else { push(rx0 * T, ry0 * T - MASMORRA_WALL * T, half * T, MASMORRA_WALL * T); push((rx0 + half + MASMORRA_PASS) * T, ry0 * T - MASMORRA_WALL * T, half * T, MASMORRA_WALL * T); }
    if (!c.S) push(rx0 * T, ry1 * T, C * T, MASMORRA_WALL * T);
    else { push(rx0 * T, ry1 * T, half * T, MASMORRA_WALL * T); push((rx0 + half + MASMORRA_PASS) * T, ry1 * T, half * T, MASMORRA_WALL * T); }
    if (!c.W) push(rx0 * T - MASMORRA_WALL * T, ry0 * T, MASMORRA_WALL * T, C * T);
    else { push(rx0 * T - MASMORRA_WALL * T, ry0 * T, MASMORRA_WALL * T, half * T); push(rx0 * T - MASMORRA_WALL * T, (ry0 + half + MASMORRA_PASS) * T, MASMORRA_WALL * T, half * T); }
    if (!c.E) push(rx1 * T, ry0 * T, MASMORRA_WALL * T, C * T);
    else { push(rx1 * T, ry0 * T, MASMORRA_WALL * T, half * T); push(rx1 * T, (ry0 + half + MASMORRA_PASS) * T, MASMORRA_WALL * T, half * T); }
  }
  return rects;
}

// Coordenadas de mundo (pixels) do centro de uma celula (cx,cy) da grade,
// mesma formula de cxw/cyw em buildMasmorra().
function cellCenter(cx, cy, ox, oy) {
  const C = MASMORRA_CELL;
  return { x: (ox + cx * C + C / 2) * T, y: (oy + cy * C + C / 2) * T };
}

// Gera o layout completo de uma instancia de masmorra a partir so do seed
// -- mesma saida sempre pro mesmo seed (server e cliente concordam sem
// trocar geometria pela rede, so o seed).
function dungeonLayout(seed) {
  const mz = mazeGen(DUNGEON_COLS, DUNGEON_ROWS, seed);
  const rects = dungeonWallRects(mz, DUNGEON_COLS, DUNGEON_ROWS, DUNGEON_OX, DUNGEON_OY);
  const start = cellCenter(mz.sx, mz.sy, DUNGEON_OX, DUNGEON_OY);
  const boss = cellCenter(mz.bx, mz.by, DUNGEON_OX, DUNGEON_OY);
  return { mz, rects, start, boss, cols: DUNGEON_COLS, rows: DUNGEON_ROWS, ox: DUNGEON_OX, oy: DUNGEON_OY, cellPx: MASMORRA_CELL * T };
}

const DUNGEON_GEN_DATA = { mulberry, mazeGen, dungeonWallRects, cellCenter, dungeonLayout, T, MASMORRA_CELL, MASMORRA_PASS, MASMORRA_WALL, DUNGEON_COLS, DUNGEON_ROWS, DUNGEON_OX, DUNGEON_OY };
if (typeof module !== 'undefined' && module.exports) module.exports = DUNGEON_GEN_DATA;
else if (typeof window !== 'undefined') window.DUNGEON_GEN = DUNGEON_GEN_DATA;

})();
