// Fase 5.17.1 — Hotfix Vulcão Ardente: sprites & animações.
//
// FONTE UNICA da animacao dos monstros do Vulcao (sala/elem/calc/cinza/
// lorde) -- compartilhada entre index.html (<script src>, expoe
// window.MONSTER_ANIM) e server.js (require, so pra decidir o campo VISUAL
// `face` que ja era transmitido em mob_positions). Nada aqui toca em
// gameplay: hitbox, dano, alcance, IA, XP e loot continuam onde sempre
// estiveram.
//
// Layout REAL dos assets (auditado nos PNGs embutidos em SPR, index.html):
// todos sao UMA linha de 3 frames, sem linhas por direcao e sem frames
// dedicados de ataque/hit/morte:
//   frame 0 = parado, frame 1 = passo A, frame 2 = passo B (pose mais
//   "avancada", reaproveitada como pose de ataque -- fallback documentado).
// Orientacao nativa: salamander/elemental/skel_ash/lorde foram desenhados
// OLHANDO PARA A ESQUERDA; bat_ash e frontal (nunca espelha). O bug de
// "andar de costas" vinha de espelhar quando face===-1, como se o sprite
// nativo olhasse para a direita.
//
// IIFE: no navegador os <script> classicos dividem o escopo global (ver
// incidente da Fase 5.17 com balance-data.js).
(function () {
'use strict';

const LEFT = -1, RIGHT = 1;

// Estados de IA (mesmos nomes em updX do cliente e stepX do servidor) que
// representam um ataque JA decidido pela IA -- a animacao so reflete isso.
const MONSTER_ANIMATIONS = {
  sala:  { sheet: 'salamander', frameW: 76, frameH: 64, frames: 3, nativeFacing: LEFT, idle: 0, walk: { cycle: [1, 0, 2, 0], fps: 7 }, attack: { frame: 2, states: ['wind', 'breath'] } },
  elem:  { sheet: 'elemental', frameW: 62, frameH: 78, frames: 3, nativeFacing: LEFT, idle: 0, walk: { cycle: [1, 0, 2, 0], fps: 5 }, attack: { frame: 2, states: ['wind', 'slam'] } },
  calc:  { sheet: 'skel_ash', frameW: 54, frameH: 66, frames: 3, nativeFacing: LEFT, idle: 0, walk: { cycle: [1, 0, 2, 0], fps: 7 }, attack: { frame: 2, states: ['wind'] } },
  lorde: { sheet: 'lorde', frameW: 102, frameH: 118, frames: 3, nativeFacing: LEFT, idle: 0, walk: { cycle: [1, 0, 2, 0], fps: 6 }, attack: { frame: 2, states: ['wind', 'wind2', 'meteor'] } },
  // Morcego de Cinzas: sprite frontal (nunca espelha), asa bate sempre --
  // "walk" e o bater de asas continuo; no rasante (swoop) bate mais rapido.
  cinza: { sheet: 'bat_ash', frameW: 55, frameH: 34, frames: 3, nativeFacing: 0, idle: null, walk: { cycle: [0, 1, 2], fps: 12 }, attack: { cycle: [0, 1, 2], fps: 18, states: ['wind', 'swoop'] } },
};
// Titã Ancestral (World Boss) reusa o sprite e o draw do Senhor das Chamas.
MONSTER_ANIMATIONS.ancient_titan = MONSTER_ANIMATIONS.lorde;

// Sem frame de morte no asset: fallback = ultimo frame visivel some em
// DEATH_FADE_S (nunca volta a andar -- death tem a maior prioridade).
const DEATH_FADE_S = 0.35;
// Histerese do `face`: deslocamento horizontal minimo (px por tick do
// servidor) pra trocar de lado -- mata o "pisca" causado por empurrao de
// colisao de sub-pixel.
const FACE_MIN_DX = 0.5;

function configFor(type) { return MONSTER_ANIMATIONS[type] || null; }
function isAttackState(type, state) {
  const c = configFor(type);
  return !!(c && c.attack && c.attack.states.includes(state));
}

// Prioridade de estado visual: death > attack > hit > walk > idle.
// `hit` so vira estado quando o flash de dano esta ativo e o monstro nao
// esta atacando -- o asset nao tem frame de hit, entao ele usa a pose atual
// (idle/walk) + o overlay branco que ja existia (sem inventar frame).
function visualState(mob) {
  if (!mob) return 'idle';
  if (mob.dead) return 'death';
  if (isAttackState(mob.type, mob.state)) return 'attack';
  if (mob.flash > 0) return 'hit';
  if (mob.moving) return 'walk';
  return 'idle';
}

// Frame (coluna do sheet) pra um estado visual + tempo de animacao da
// propria entidade (s.anim, acumulado por dt -- nunca Date.now()).
function frameFor(type, vstate, animT, moving) {
  const c = configFor(type);
  if (!c) return 0;
  const t = Math.max(0, Number(animT) || 0);
  const cyc = (seq) => seq.cycle[Math.floor(t * seq.fps) % seq.cycle.length];
  if (vstate === 'attack') return c.attack.cycle ? cyc(c.attack) : c.attack.frame;
  if (vstate === 'walk' || (vstate === 'hit' && moving) || (vstate === 'death' && moving)) return cyc(c.walk);
  if (c.idle == null) return cyc(c.walk); // voador: asa nunca para
  return c.idle;
}

// true = desenhar espelhado. face: -1 esquerda, 1 direita (convencao de
// todo o jogo). Sprite nativo virado pra esquerda so espelha quando o
// monstro olha pra DIREITA; sprite frontal (nativeFacing 0) nunca espelha.
function shouldMirror(type, face) {
  const c = configFor(type);
  if (!c || !c.nativeFacing) return false;
  const f = face === LEFT ? LEFT : RIGHT;
  return f !== c.nativeFacing;
}

function faceFromDx(dx, prevFace, minDx) {
  const m = Number.isFinite(minDx) ? minDx : FACE_MIN_DX;
  if (dx > m) return RIGHT;
  if (dx < -m) return LEFT;
  return prevFace === LEFT ? LEFT : RIGHT;
}

// Decide o `face` VISUAL de um monstro do Vulcao num tick do servidor:
// durante ataque, olha pro alvo real (targetDx = alvo.x - mob.x) se houver;
// fora de ataque, segue o movimento real (moveDx) com histerese; parado,
// mantem o lado anterior (nunca troca sozinho).
function resolveFace({ type, state, face, moveDx, targetDx }) {
  const prev = face === LEFT ? LEFT : RIGHT;
  if (isAttackState(type, state) && Number.isFinite(targetDx) && Math.abs(targetDx) > 2) return targetDx < 0 ? LEFT : RIGHT;
  return faceFromDx(Number(moveDx) || 0, prev);
}

// Alpha do fallback de morte: 1 -> 0 em DEATH_FADE_S a partir de deadSince.
function deathAlpha(deadSince, now) {
  if (!Number.isFinite(deadSince)) return 1;
  const elapsed = now - deadSince;
  if (elapsed >= DEATH_FADE_S - 1e-9) return 0; // tolerancia de ponto flutuante
  return Math.max(0, Math.min(1, 1 - elapsed / DEATH_FADE_S));
}

const DATA = {
  LEFT, RIGHT, MONSTER_ANIMATIONS, DEATH_FADE_S, FACE_MIN_DX,
  VOLCANO_TYPES: ['sala', 'elem', 'calc', 'cinza', 'lorde'],
  configFor, isAttackState, visualState, frameFor, shouldMirror, faceFromDx, resolveFace, deathAlpha,
};

if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
else if (typeof window !== 'undefined') window.MONSTER_ANIM = DATA;
})();
