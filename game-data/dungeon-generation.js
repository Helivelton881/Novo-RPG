// Fase 5.2 — geracao de masmorra compartilhada entre server.js (require,
// Node/CommonJS) e index.html (<script src>, expoe window.DUNGEON_GEN).
//
// So a FORMA da masmorra (paredes/salas/corredores) e o RNG (mulberry)
// moram aqui -- e matematica pura, sem DOM/canvas, entao da pra
// compartilhar sem risco. Decoracao visual (props/sprites desenhados)
// continua 100% no cliente (buildMasmorra em index.html), sem mudanca --
// nao afeta jogo/economia, so estetica.
//
// O servidor usa o MESMO layout (mesmos rects de parede) pra saber onde
// ficam as paredes de verdade (colisao de IA de monstro) que o cliente
// usa pra desenhar/colidir -- nunca duas fontes que podem divergir.
//
// Fase 5.13 -- DUNGEON MAP V2: o labirinto procedural (mazeGen, grade 7x5
// por seed) foi SUBSTITUIDO por um layout FIXO, desenhado a mao (entrada
// -> 6 salas nomeadas -> saida, ligadas por corredores). mazeGen()
// continua exportada (nao removida -- nenhum outro sistema depende dela
// hoje, mas remover uma funcao pura sem necessidade seria alem do escopo
// desta fase), mas dungeonLayout() NAO A CHAMA MAIS. Motivo documentado
// em LEIA-PRIMEIRO.md "FASE 5.13": o layout precisou ser desenhado pra
// caber dentro do teto global de mundo (MW=60 x MH=44 tiles / 2880x2112px
// em index.html, o MESMO teto que o anti-teleport do servidor already
// usa pra QUALQUER mapa) -- nao e um numero novo, e o limite que ja
// existia, so nunca binding pra masmorra antes (o labirinto 7x5 antigo
// cabia com folga).
'use strict';

(function () {

function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Preservada por compatibilidade (matematica pura, sem custo mante-la) --
// nao e mais chamada por dungeonLayout() desde a Fase 5.13.
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

const T = 48, WALL = 1;

// ===== Fase 5.13: Dungeon Map V2 -- layout fixo (Ruinas Antigas) =====
// Sequencia unica, linear, sem ramificacoes: ENTRADA -> SALA1 -> CORR1 ->
// SALA2 -> (cotovelo) -> SALA3 -> SALA4 -> SALA5 -> (folga) -> CHECKPOINT
// -> CORRFINAL -> BOSS -> SAIDA. Coordenadas em TILES (x,y = canto
// superior-esquerdo, w/h = largura/altura incluindo a propria parede).
// Dimensoes ligeiramente reduzidas em relacao a proposta original pra
// caber no teto global de mundo (60x44 tiles) -- ver LEIA-PRIMEIRO.md.
const DUNGEON_ROOMS_V2 = {
  entrada:    { x:3,  y:4,  w:10, h:8  },
  sala1:      { x:13, y:3,  w:14, h:10 },
  corr1:      { x:27, y:6,  w:8,  h:3  },
  sala2:      { x:35, y:3,  w:16, h:10 },
  corr2v:     { x:41, y:13, w:3,  h:3  },
  sala3:      { x:37, y:16, w:12, h:10 },
  sala4:      { x:19, y:15, w:18, h:12 },
  sala5:      { x:5,  y:16, w:14, h:10 },
  gap23:      { x:10, y:26, w:3,  h:4  },
  checkpoint: { x:7,  y:30, w:10, h:8  },
  corrfinal:  { x:17, y:32, w:8,  h:4  },
  boss:       { x:25, y:28, w:20, h:12 },
  saida:      { x:45, y:30, w:10, h:8  },
};
// [idA, ladoDeSaidaEmA, idB, larguraDaPassagem(tiles)]
const DUNGEON_CONNECTIONS_V2 = [
  ['entrada','E','sala1',5],
  ['sala1','E','corr1',3],
  ['corr1','E','sala2',3],
  ['sala2','S','corr2v',3],
  ['corr2v','S','sala3',3],
  ['sala3','W','sala4',5],
  ['sala4','W','sala5',5],
  ['sala5','S','gap23',3],
  ['gap23','S','checkpoint',3],
  ['checkpoint','E','corrfinal',4],
  ['corrfinal','E','boss',6],
  ['boss','E','saida',6],
];
// Salas que recebem monstros comuns (nunca entrada/corredores/checkpoint/
// saida -- checkpoint e area segura de proposito, o resto e so passagem).
const DUNGEON_MOB_ROOMS_V2 = ['sala1', 'sala2', 'sala3', 'sala4', 'sala5'];

function wallSegments(rangeFrom, rangeTo, openings) {
  let segments = [[rangeFrom, rangeTo]];
  for (const [a, b] of openings) {
    const next = [];
    for (const [s, e] of segments) {
      if (b <= s || a >= e) { next.push([s, e]); continue; }
      if (a > s) next.push([s, a]);
      if (b < e) next.push([b, e]);
    }
    segments = next;
  }
  return segments.filter(([s, e]) => e - s > 0.01);
}

// Constroi os rects de parede (com vaos/portas exatamente nas conexoes)
// a partir de DUNGEON_ROOMS_V2/DUNGEON_CONNECTIONS_V2 -- roda uma vez
// (cacheado), mesma saida sempre (layout fixo, sem seed).
let _cachedFixedLayout = null;
function buildFixedDungeonLayout() {
  if (_cachedFixedLayout) return _cachedFixedLayout;
  const rooms = DUNGEON_ROOMS_V2;
  const openingsByRoomSide = {};
  const addOpening = (id, side, from, to) => { const key = id + side; (openingsByRoomSide[key] = openingsByRoomSide[key] || []).push([from, to]); };
  for (const [idA, sideA, idB, pass] of DUNGEON_CONNECTIONS_V2) {
    const A = rooms[idA], B = rooms[idB], opposite = { N: 'S', S: 'N', E: 'W', W: 'E' }[sideA];
    if (sideA === 'E' || sideA === 'W') {
      const from0 = Math.max(A.y, B.y), to0 = Math.min(A.y + A.h, B.y + B.h), len = to0 - from0;
      if (len <= 0) continue;
      const p = Math.min(pass, len), from = from0 + (len - p) / 2, to = from + p;
      addOpening(idA, sideA, from, to); addOpening(idB, opposite, from, to);
    } else {
      const from0 = Math.max(A.x, B.x), to0 = Math.min(A.x + A.w, B.x + B.w), len = to0 - from0;
      if (len <= 0) continue;
      const p = Math.min(pass, len), from = from0 + (len - p) / 2, to = from + p;
      addOpening(idA, sideA, from, to); addOpening(idB, opposite, from, to);
    }
  }
  const rects = [];
  const push = (x, y, w, h) => { if (w > 0.01 && h > 0.01) rects.push({ x: Math.round(x * T), y: Math.round(y * T), w: Math.round(w * T), h: Math.round(h * T) }); };
  for (const id of Object.keys(rooms)) {
    const r = rooms[id];
    for (const [s, e] of wallSegments(r.x, r.x + r.w, openingsByRoomSide[id + 'N'] || [])) push(s, r.y - WALL, e - s, WALL);
    for (const [s, e] of wallSegments(r.x, r.x + r.w, openingsByRoomSide[id + 'S'] || [])) push(s, r.y + r.h, e - s, WALL);
    for (const [s, e] of wallSegments(r.y, r.y + r.h, openingsByRoomSide[id + 'W'] || [])) push(r.x - WALL, s, WALL, e - s);
    for (const [s, e] of wallSegments(r.y, r.y + r.h, openingsByRoomSide[id + 'E'] || [])) push(r.x + r.w, s, WALL, e - s);
  }
  const entrada = rooms.entrada, boss = rooms.boss, saida = rooms.saida;
  const start = { x: Math.round((entrada.x + entrada.w / 2) * T), y: Math.round((entrada.y + entrada.h * 0.62) * T) };
  const bossCenter = { x: Math.round((boss.x + boss.w / 2) * T), y: Math.round((boss.y + boss.h / 2) * T) };
  const exitPoint = { x: Math.round((saida.x + saida.w / 2) * T), y: Math.round((saida.y + saida.h * 0.4) * T) };
  _cachedFixedLayout = { rects, start, boss: bossCenter, exitPoint, rooms, mobRooms: DUNGEON_MOB_ROOMS_V2 };
  return _cachedFixedLayout;
}

// Coordenadas de mundo (pixels) do centro de uma sala nomeada, em tiles.
function roomCenter(room) {
  return { x: (room.x + room.w / 2) * T, y: (room.y + room.h / 2) * T };
}
// Ponto aleatorio dentro da area caminhavel de uma sala (encolhida pela
// espessura da parede + uma margem extra, pra nunca nascer colado nela).
function roomRandomPoint(room, rnd, marginTiles) {
  const m = (marginTiles == null ? 1.5 : marginTiles);
  const x0 = (room.x + m) * T, x1 = (room.x + room.w - m) * T;
  const y0 = (room.y + m) * T, y1 = (room.y + room.h - m) * T;
  return { x: x0 + rnd() * Math.max(0, x1 - x0), y: y0 + rnd() * Math.max(0, y1 - y0) };
}

// Gera o layout completo de uma instancia de masmorra. `seed` fica na
// assinatura por compatibilidade de chamada (o roster de monstros ainda
// usa seu proprio stream de RNG derivado do seed, mulberry(seed+1),
// independente da geometria) -- mas a partir da Fase 5.13 a GEOMETRIA em
// si e sempre a mesma (layout fixo), nunca procedural.
function dungeonLayout(seed) {
  return buildFixedDungeonLayout();
}

const DUNGEON_GEN_DATA = {
  mulberry, mazeGen, cellCenter: undefined, dungeonLayout, T, WALL,
  DUNGEON_ROOMS_V2, DUNGEON_CONNECTIONS_V2, DUNGEON_MOB_ROOMS_V2,
  roomCenter, roomRandomPoint,
};
delete DUNGEON_GEN_DATA.cellCenter; // nunca existiu de verdade no V2 (era so da grade antiga); nao exportar undefined
if (typeof module !== 'undefined' && module.exports) module.exports = DUNGEON_GEN_DATA;
else if (typeof window !== 'undefined') window.DUNGEON_GEN = DUNGEON_GEN_DATA;

})();
