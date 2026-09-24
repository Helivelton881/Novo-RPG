'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { WebSocketServer, WebSocket } = require('ws');
const GEAR_DATA = require('./game-data/gear-data.js');
const DUNGEON_GEN = require('./game-data/dungeon-generation.js');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const authAttempts = new Map();
const clients = new Map();
const maps = new Map();
// Fase 5.2: masmorra agora usa uma chave de mapa por INSTANCIA
// (`<zona>_d#<id8hex>`) em vez de compartilhar um unico `<zona>_d` global
// entre qualquer personagem que entrar -- reaproveita playersOnMap/
// broadcastMap/tickMobAI sem nenhuma mudanca estrutural neles (so
// precisam que p.map seja essa string; ver handleDungeonEnter). `_d` sem
// sufixo continua aceito por compatibilidade de mensagens antigas, mas
// nenhum fluxo novo o gera mais.
const ALLOWED_MAP = /^(vila|floresta|cripta|serra|pantano|torre|ilhas|vulcao)(?:_d(?:#[0-9a-f]{8})?)?$/;
const DUNGEON_MAP_RE = /^([a-z]+)_d(?:#([0-9a-f]{8}))?$/;
const ALLOWED_CLASS = new Set(['guerreiro', 'druida', 'mago', 'arqueiro']);

// ===== Roster de monstro autoritativo (Fase 1) =====
// Espelha exatamente as formulas de hp/xp por tipo do index.html (SLIME_STATS,
// gobStats, skStats, wfStats, btStats, txStats, caStats, skyStats, vlStats) --
// usado pra: (1) nunca aceitar o maxhp que o cliente reivindica pra um
// monstro, sempre recalcular a partir do tipo/nivel real; (2) calcular o XP
// exato concedido quando o servidor confirma que aquele monstro morreu de
// verdade (mob.hp<=0 em mob_damage), nunca aceitando o que o cliente ja
// tinha somado sozinho em P.xp.
function mobStats(type, lvl, boss, k) {
  switch (type) {
    case 'slime': { const t = { 1: { hp: 28, xp: 12, dmg: 6 }, 2: { hp: 44, xp: 20, dmg: 9 }, 3: { hp: 62, xp: 30, dmg: 12 } }[lvl]; return t || null; }
    case 'goblin': return boss ? { hp: 480, xp: 320, dmg: 30 } : { hp: 70 + (lvl - 5) * 14, xp: 40 + (lvl - 5) * 9, dmg: 14 + (lvl - 5) * 2 };
    case 'skeleton': return boss ? { hp: 1800, xp: 800, dmg: 52 } : { hp: 260 + (lvl - 10) * 36, xp: 100 + (lvl - 10) * 14, dmg: 28 + (lvl - 10) * 3 };
    case 'wolf': return boss ? { hp: 3400, xp: 1200, dmg: 95 } : { hp: 420 + (lvl - 15) * 55, xp: 130 + (lvl - 15) * 16, dmg: 52 + (lvl - 15) * 5 };
    case 'bat': return lvl >= 30 ? { hp: 1700 + (lvl - 30) * 180, xp: 300 + (lvl - 30) * 30, dmg: 110 + (lvl - 30) * 10 } : { hp: 340 + (lvl - 20) * 50, xp: 160 + (lvl - 20) * 20, dmg: 56 + (lvl - 20) * 5 };
    case 'toxic': return boss ? { hp: 5200, xp: 2000, dmg: 120 } : { hp: 520 + (lvl - 20) * 70, xp: 170 + (lvl - 20) * 22, dmg: 50 + (lvl - 20) * 5 };
    case 'caster': return boss ? { hp: 9000, xp: 3500, dmg: 130 } : { hp: 1400 + (lvl - 25) * 160, xp: 240 + (lvl - 25) * 30, dmg: 92 + (lvl - 25) * 8 };
    case 'sky': {
      if (k === 'b') return { hp: 14000, xp: 6000, dmg: 150 };
      const d = lvl - 30;
      if (k === 'h') return { hp: 1900 + d * 220, xp: 300 + d * 36, dmg: 100 + d * 10 };
      if (k === 's') return { hp: 2100 + d * 240, xp: 320 + d * 38, dmg: 90 + d * 10 };
      return { hp: 2900 + d * 300, xp: 360 + d * 40, dmg: 135 + d * 12 }; // 'g' (guardiao)
    }
    case 'lorde': return { hp: 26000, xp: 9000, dmg: 170 };
    case 'sala': { const d = lvl - 35; return { hp: 2600 + d * 280, xp: 400 + d * 44, dmg: 130 + d * 11 }; }
    case 'elem': { const d = lvl - 35; return { hp: 4200 + d * 380, xp: 440 + d * 48, dmg: 150 + d * 13 }; }
    case 'calc': case 'cinza': { const d = lvl - 35; return { hp: 3200 + d * 320, xp: 420 + d * 46, dmg: 110 + d * 10 }; } // cinza usa a formula de calc de proposito -- e o mesmo "bug" que o cliente ja tem (newCinza so escala o hp de spawn com base em sala*.6, mas o xp em killVulcao recalcula com vlStats(s) que cai no default = calc). O DANO DE ATAQUE de cinza e diferente: usa a formula de SALA*.7 (ver stepCinza), nao esse campo dmg do default.
    default: return null;
  }
}
// newCinza (index.html) fixa o hp de spawn como Math.round(hp da formula de
// sala * .6) em vez de usar a formula default (calc) que mobStats('cinza',..)
// devolve -- so pro HP DE SPAWN precisamos espelhar essa excecao; o XP de
// abate usa mobStats('cinza',...) normalmente (bate com o cliente).
function cinzaSpawnHp(lvl) { const d = lvl - 35; return Math.round((2600 + d * 280) * .6); }

// Cada entrada mistura contagem+nivel exatos com o que os packs literais do
// cliente definem (buildFloresta/buildCripta/... em index.html) -- nao e
// posicao (isso continua vindo do cliente, so nunca decide premio/hp). So
// 'vila' (slime) fica de fora: a posicao/nivel de cada spawn ali vem de
// amostragem por rejeicao contra o mapa real (blocked()), sem um array
// literal pra espelhar sem portar o tilemap inteiro -- pra ela, valida so
// contagem (<=15) e nivel (1..3) com hp exato por nivel, mais solto que o
// roster exato dos outros mapas.
function flattenLevels(packs, type, idx) {
  const out = [];
  for (const p of packs) for (const lvl of p[idx]) out.push({ type, lvl, boss: false });
  return out;
}
function flattenLetterLevels(packs, typeByLetter, letterIdx, levelsIdx) {
  const out = [];
  for (const p of packs) { const type = typeByLetter[p[letterIdx]]; for (const lvl of p[levelsIdx]) out.push({ type, lvl, boss: false }); }
  return out;
}
function flattenNested(packs, typeByLetter) {
  const out = [];
  for (const p of packs) for (const [k, lvl] of p[1]) { const type = typeByLetter[k]; out.push(type === 'bat' ? { type, lvl, boss: false } : { type, lvl, boss: false, k }); }
  return out;
}
const MOB_MANIFEST = {
  floresta: [
    ...flattenLevels([[18, 32, [5, 5]], [24, 28.5, [5, 6]], [14, 21, [6, 6]], [31, 22, [6, 7, 7]], [36, 29, [7, 7]], [39, 17, [8, 8]], [43, 14.8, [8, 9]], [47, 29.5, [7, 8]], [27, 36, [5]]], 'goblin', 2),
    { type: 'goblin', lvl: 10, boss: true },
  ],
  cripta: [
    ...flattenLevels([[18, 32, [10, 10]], [24, 27.5, [10, 11]], [14, 21, [11, 11]], [29, 22, [11, 12, 12]], [36, 26, [12, 12]], [38, 17, [13, 13]], [43, 15, [13, 14]], [47, 29.5, [12, 13]], [27, 36, [10]]], 'skeleton', 2),
    { type: 'skeleton', lvl: 15, boss: true },
    { type: 'skeleton', lvl: 11, boss: false, temp: true }, { type: 'skeleton', lvl: 11, boss: false, temp: true }, { type: 'skeleton', lvl: 11, boss: false, temp: true },
  ],
  serra: [
    ...flattenLevels([[18, 35, [15, 15]], [24, 31, [15, 16, 16]], [19, 26, [16, 16]], [27, 22.5, [16, 17, 17]], [34, 25, [17, 17]], [38, 19, [17, 18, 18]], [35, 15, [18, 18]], [41, 12, [18, 19]], [47, 29.5, [17, 18]], [13, 20, [15, 16]]], 'wolf', 2),
    { type: 'wolf', lvl: 20, boss: true },
    { type: 'wolf', lvl: 17, boss: false, temp: true }, { type: 'wolf', lvl: 17, boss: false, temp: true },
  ],
  pantano: [
    ...flattenLetterLevels([[18, 34, 'b', [20, 20, 21]], [24, 29.5, 't', [21, 21]], [15, 25, 'b', [21, 21, 22]], [29, 25.5, 't', [22, 22]], [33, 19, 'b', [22, 22, 23]], [38, 22, 't', [23, 23]], [35, 14, 'b', [23, 23, 24]], [41, 14, 't', [24, 24]], [46, 29, 'b', [22, 23]], [40, 29, 't', [22, 23]], [12, 22, 't', [21, 22]]], { b: 'bat', t: 'toxic' }, 2, 3),
    { type: 'toxic', lvl: 25, boss: true },
    { type: 'toxic', lvl: 22, boss: false, temp: true }, { type: 'toxic', lvl: 22, boss: false, temp: true }, { type: 'toxic', lvl: 22, boss: false, temp: true },
  ],
  torre: [
    ...flattenLetterLevels([[18, 34, 's', [25, 25]], [24, 29.5, 'c', [25, 26]], [15, 25, 'c', [26, 26]], [29, 25.5, 's', [26, 27]], [33, 19, 'c', [27, 27, 28]], [38, 22, 's', [27, 28]], [35, 14, 'c', [28, 28]], [41, 14, 's', [28, 29]], [46, 29, 'c', [27, 28]], [40, 29, 's', [27, 28]], [12, 22, 'c', [25, 26]]], { s: 'skeleton', c: 'caster' }, 2, 3),
    { type: 'caster', lvl: 30, boss: true },
    { type: 'caster', lvl: 27, boss: false, temp: true }, { type: 'caster', lvl: 27, boss: false, temp: true },
  ],
  ilhas: [
    ...flattenNested([[[17, 29], [['g', 30], ['g', 30], ['h', 30]]], [[28, 33], [['h', 31], ['h', 31], ['s', 31]]], [[24, 22], [['g', 31], ['g', 32], ['s', 32], ['b', 30], ['b', 30], ['b', 31]]], [[12, 17], [['h', 31], ['h', 32], ['b', 31], ['b', 31]]], [[37, 27], [['g', 32], ['g', 33], ['s', 32], ['s', 33], ['h', 32]]], [[31.5, 14.5], [['b', 32], ['b', 32], ['b', 33], ['g', 33], ['s', 33]]], [[46, 32], [['h', 33], ['h', 33], ['g', 33]]], [[50, 20], [['s', 34], ['b', 33], ['b', 34], ['b', 34], ['h', 34]]], [[21, 8.5], [['h', 32], ['h', 33], ['s', 33]]]], { g: 'sky', h: 'sky', s: 'sky', b: 'bat' }),
    { type: 'sky', k: 'b', lvl: 35, boss: true },
    { type: 'sky', k: 'h', lvl: 33, boss: false, temp: true }, { type: 'sky', k: 'h', lvl: 33, boss: false, temp: true },
  ],
  vulcao: [
    ...flattenLetterLevels([[18, 34, 'e', [35, 35]], [24, 29.5, 'c', [35, 36]], [15, 25, 's', [36, 36]], [29, 25.5, 'e', [36, 37]], [33, 19, 'c', [37, 37, 38]], [38, 22, 's', [37, 38]], [35, 14, 'e', [38, 38]], [41, 14, 'c', [38, 39]], [46, 29, 's', [37, 38]], [40, 29, 'e', [37, 38]], [12, 22, 's', [35, 36]], [20, 17, 'b', [35, 36]], [44, 20, 'b', [36, 37]], [16, 29, 'b', [36, 37]]], { e: 'elem', c: 'calc', s: 'sala', b: 'cinza' }, 2, 3),
    { type: 'lorde', lvl: 40, boss: true },
    { type: 'sala', lvl: 35, boss: false, temp: true }, { type: 'sala', lvl: 35, boss: false, temp: true }, { type: 'sala', lvl: 35, boss: false, temp: true },
  ],
};
// Fase 5.2 — roster de masmorra server-side. Espelha exatamente as
// escolhas de tipo/faixa de nivel de MASMORRA_CFG (index.html): mesmo
// range de nivel de trash, mesmas proporcoes por zona (pantano/torre 50/50,
// ilhas 35/35/30, vulcao 30/30/25/15), mesmo nivel/HPx3 de chefe. Só a
// escolha de QUAL classe entra em qual zona muda (nada) -- preservado.
const DUNGEON_CFG = {
  floresta: { lvlLo: 6, lvlHi: 9, trash: rnd => ({ type: 'goblin', lvl: 6 + Math.floor(rnd() * 4) }), boss: { type: 'goblin', lvl: 10 } },
  cripta:   { lvlLo: 11, lvlHi: 14, trash: rnd => ({ type: 'skeleton', lvl: 11 + Math.floor(rnd() * 4) }), boss: { type: 'skeleton', lvl: 15 } },
  serra:    { lvlLo: 16, lvlHi: 19, trash: rnd => ({ type: 'wolf', lvl: 16 + Math.floor(rnd() * 4) }), boss: { type: 'wolf', lvl: 20 } },
  pantano:  { lvlLo: 21, lvlHi: 24, trash: rnd => rnd() < .5 ? { type: 'bat', lvl: 21 + Math.floor(rnd() * 4) } : { type: 'toxic', lvl: 21 + Math.floor(rnd() * 4) }, boss: { type: 'toxic', lvl: 25 } },
  torre:    { lvlLo: 26, lvlHi: 29, trash: rnd => rnd() < .5 ? { type: 'caster', lvl: 26 + Math.floor(rnd() * 4) } : { type: 'skeleton', lvl: 26 + Math.floor(rnd() * 4) }, boss: { type: 'caster', lvl: 30 } },
  ilhas:    { lvlLo: 31, lvlHi: 34, trash: rnd => { const r = rnd(); return r < .35 ? { type: 'sky', k: 'h', lvl: 31 + Math.floor(rnd() * 4) } : r < .7 ? { type: 'sky', k: 's', lvl: 31 + Math.floor(rnd() * 4) } : { type: 'bat', lvl: 31 + Math.floor(rnd() * 4) }; }, boss: { type: 'sky', k: 'b', lvl: 35 } },
  vulcao:   { lvlLo: 36, lvlHi: 39, trash: rnd => { const r = rnd(); return r < .3 ? { type: 'sala', lvl: 36 + Math.floor(rnd() * 4) } : r < .6 ? { type: 'elem', lvl: 36 + Math.floor(rnd() * 4) } : r < .85 ? { type: 'calc', lvl: 36 + Math.floor(rnd() * 4) } : { type: 'cinza', lvl: 36 + Math.floor(rnd() * 4) }; }, boss: { type: 'lorde', lvl: 40 } },
};
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.json':'application/json; charset=utf-8'};

// Modelo canonico de item (Fase 5.1): uid + type + lv (progressao 1..40) +
// rarity (basic/rare/epic/legendary) + enchant (0..10, so 0 nesta fase) --
// ver game-data/gear-data.js (fonte unica, compartilhada com o cliente) pra
// as tabelas de stats/nome/preco por type x lv x rarity.
function createGear(type, lv, rarity) {
  const stats = GEAR_DATA.statsFor(type, lv, rarity);
  if (!stats) return null;
  return {
    uid: crypto.randomUUID(), type, lv, rarity, enchant: 0,
    n: GEAR_DATA.nameFor(type, lv),
    atk: stats.atk || 0, def: stats.def || 0, hp: stats.hp || 0, blk: stats.blk || 0, spd: stats.spd || 0, req: stats.req || 0,
  };
}
const EQ_SLOTS = ['sword','shield','armor','helmet','cape','jewel','boots'];
const COUNTER_FIELDS = ['gk','ki','kit','kt','ktt','kp','kpt','ks','ke','kw','kwt','kv','kvt','ap','key','scr','sl','gb','bs','dt'];
// Espelha exatamente a cadeia de contadores no comeco de killMob() (index.html):
// qual(is) campo(s) de COUNTER_FIELDS um abate real incrementa, por tipo.
function killCounterFields(type, lvl, boss) {
  const fields = [];
  if (type === 'slime') fields.push('sl');
  else if (type === 'skeleton') { fields.push('ke'); if (lvl >= 25) fields.push('ktt'); if (boss) fields.push('bs'); }
  else if (type === 'wolf') { fields.push('kwt'); if (boss) fields.push('bs'); }
  else if (type === 'bat' || type === 'toxic') { fields.push('kpt'); if (type === 'bat' && lvl >= 30) fields.push('kit'); if (boss) fields.push('bs'); }
  else if (type === 'sky') { fields.push('kit'); if (boss) fields.push('bs'); }
  else if (type === 'sala' || type === 'elem' || type === 'calc' || type === 'cinza') { fields.push('kvt'); if (boss) fields.push('bs'); }
  else if (type === 'lorde') fields.push('bs');
  else if (type === 'caster') { fields.push('ktt'); if (boss) fields.push('bs'); }
  else if (boss) fields.push('bs'); // goblin boss
  else fields.push('gb'); // goblin comum
  return fields;
}
// Espelha dropLoot/dropExtra por tipo/chefe (index.html: killSkeleton,
// killWolf, killSwamp, killCaster, killSky, killVulcao, killLorde, mais
// slime/goblin em killMob). So mapas de campo: nenhuma dessas funcoes chama
// dropItem -- equipamento nesses mapas so vem de loja/bau (dropItem so
// existe no loot de masmorra, fora do escopo do roster). Sequitos
// temporarios (mob.temp) nao dropam nada no cliente (bloco inteiro pulado
// via `else if(!s.temp)`), diferente do XP que ainda paga metade -- por
// isso rollMobLoot nunca e chamado pra mob.temp (ver mob_damage).
function rollMobLoot(type, boss, lvl) {
  let p;
  if (type === 'slime') p = { coins: Math.random() < .75 ? 1 + Math.floor(Math.random() * (lvl + 1)) : 0, maxv: lvl, pPot: .09, pGem: 0, pApple: .16, pScroll: 0 };
  else if (type === 'goblin') p = boss ? { coins: 8, maxv: 4, pPot: 1, pGem: 2, pApple: .5, pScroll: .6 } : { coins: 2 + Math.floor(Math.random() * 3), maxv: 3, pPot: .14, pGem: .07, pApple: .15, pScroll: .05 };
  else if (type === 'skeleton') p = boss ? { coins: 12, maxv: 5, pPot: 1, pGem: 3, pApple: .6, pScroll: .7 } : { coins: 3 + Math.floor(Math.random() * 4), maxv: 4, pPot: .16, pGem: .1, pApple: .16, pScroll: .06 };
  else if (type === 'wolf') p = boss ? { coins: 14, maxv: 6, pPot: 1, pGem: 3, pApple: .7, pScroll: .8 } : { coins: 3 + Math.floor(Math.random() * 4), maxv: 5, pPot: .16, pGem: .12, pApple: .16, pScroll: .08 };
  else if (type === 'bat') p = { coins: 3 + Math.floor(Math.random() * 4), maxv: 6, pPot: .16, pGem: .12, pApple: .16, pScroll: .08 }; // bat nunca e chefe
  else if (type === 'toxic') p = boss ? { coins: 16, maxv: 7, pPot: 1, pGem: 4, pApple: .7, pScroll: .8 } : { coins: 3 + Math.floor(Math.random() * 4), maxv: 6, pPot: .16, pGem: .12, pApple: .16, pScroll: .08 };
  else if (type === 'caster') p = boss ? { coins: 20, maxv: 8, pPot: 1, pGem: 5, pApple: .8, pScroll: .9 } : { coins: 3 + Math.floor(Math.random() * 4), maxv: 7, pPot: .16, pGem: .14, pApple: .16, pScroll: .1 };
  else if (type === 'sky') p = boss ? { coins: 24, maxv: 9, pPot: 1, pGem: 6, pApple: .9, pScroll: 1 } : { coins: 4 + Math.floor(Math.random() * 4), maxv: 8, pPot: .16, pGem: .16, pApple: .16, pScroll: .12 };
  else if (type === 'sala' || type === 'elem' || type === 'calc' || type === 'cinza') p = { coins: 4 + Math.floor(Math.random() * 4), maxv: 8, pPot: .16, pGem: .16, pApple: .16, pScroll: .12 };
  else if (type === 'lorde') p = { coins: 26, maxv: 10, pPot: 1, pGem: 7, pApple: 1, pScroll: 1 };
  else return null;
  let gold = 0; for (let i = 0; i < p.coins; i++) gold += 1 + Math.floor(Math.random() * p.maxv);
  return {
    gold,
    gem: p.pGem >= 1 ? p.pGem : (Math.random() < p.pGem ? 1 : 0),
    pv: Math.random() < p.pPot ? 1 : 0,
    ap: Math.random() < p.pApple ? 1 : 0,
    scr: Math.random() < p.pScroll ? 1 : 0,
  };
}
// Chefe derrotado solta 1 chave (drops.push({kind:'key',...})) so se o baui
// daquele mapa ainda nao foi aberto (mesma condicao do cliente: if(!P.chestOpenN)).
const BOSS_CHEST_FIELD = { goblin: 'chest', skeleton: 'chest2', wolf: 'chest3', toxic: 'chest4', caster: 'chest5', sky: 'chest6', lorde: 'chest7' };

// ===== Fase 5.2: loot de masmorra (server-side) =====
// Espelha pickTier() do cliente (index.html) exatamente -- decide o tier
// LEGADO (1-5) do item de trash de masmorra a partir do nivel do mob.
// Convertido pra lv real via LEGACY_TIER_LEVEL (mesma migracao que
// qualquer item legado passa em sanitizeItem). rarity sempre 'basic' --
// Épico/Lendário são Fase 5.3, ainda não ligados aqui.
function pickTier(l) {
  const r = Math.random();
  if (l <= 3) return r < .8 ? 1 : 2;
  if (l <= 7) return r < .15 ? 1 : (r < .85 ? 2 : 3);
  if (l >= 35) return r < .02 ? 3 : (r < .28 ? 4 : 5);
  if (l >= 30) return r < .03 ? 3 : (r < .35 ? 4 : 5);
  if (l >= 25) return r < .05 ? 3 : (r < .5 ? 4 : 5);
  if (l >= 20) return r < .05 ? 2 : (r < .35 ? 3 : (r < .85 ? 4 : 5));
  if (l >= 15) return r < .12 ? 2 : (r < .55 ? 3 : 4);
  if (l >= 10) return r < .25 ? 2 : (r < .8 ? 3 : 4);
  return r < .5 ? 2 : (r < .95 ? 3 : 4);
}
// Espelha dropLoot(3+rand*3,6,.14,.08) do ramo `s.dun` de killMob() no
// cliente -- mob comum de masmorra nunca concede XP (preservado, ver
// creditDungeonReward). Fase 5.3: o equipamento Basic garantido a 35%
// (compatibilidade temporaria da Fase 5.2, ver git history) foi REMOVIDO --
// agora usa a MESMA politica de raridade de mob comum de campo
// (rollGearDrop: Epic 0.25%, Rare 2.5%, nunca Basic/Legendary aqui), pra
// campo e masmorra nao terem duas politicas diferentes sem motivo.
function rollDungeonTrashLoot(lvl, cls, rng) {
  let gold = 0; const coins = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < coins; i++) gold += 1 + Math.floor(Math.random() * 6);
  const pv = Math.random() < .14 ? 1 : 0, gem = Math.random() < .08 ? 1 : 0;
  const items = [];
  const drop = rollGearDrop({ mobLevel: lvl, boss: false, cls, rng });
  if (drop) items.push(drop.item);
  return { gold, gem, pv, items };
}
// Espelha dropLoot(22,9,1,6) do ramo de chefe -- chefe de masmorra sempre
// da 6 gemas e 1 pocao de vida (preservado). Fase 5.3: os 3 equipamentos
// Basic garantidos (compatibilidade temporaria da Fase 5.2) foram
// REMOVIDOS -- agora 1 unico roll de Legendary a 5% (GEAR_DROP_RATES.boss),
// mesma politica de boss de campo. `bossLvl` decide a faixa do item
// (gearLevelForMob) -- antes era sempre fixo em lv12 independente da zona,
// agora seque a progressao real de cada masmorra.
function rollDungeonBossLoot(cls, bossLvl, rng) {
  let gold = 0; for (let i = 0; i < 22; i++) gold += 1 + Math.floor(Math.random() * 9);
  const items = [];
  const drop = rollGearDrop({ mobLevel: bossLvl, boss: true, cls, rng });
  if (drop) items.push(drop.item);
  return { gold, gem: 6, pv: 1, items };
}

// Espelha a maquina de estados de progressao de P.quest: os ~15 checkpoints
// "if(P.quest===N)" dentro de killMob/killSkeleton/killWolf/killSwamp/
// killCaster/killSky/killVulcao/killLorde no cliente. So estagios IMPARES
// avancam por abate (contador ou chefe direto); os PARES so avancam por
// dialogo (ja tratado em handleQuest/QUEST_REWARDS, unidade 1). Roda so em
// cima de abates ja confirmados pelo servidor -- fecha a brecha de forjar
// P.quest/contador via PUT bruto pra reivindicar recompensa sem ter matado
// nada. killLorde no cliente muda P.quest=30 sem nenhuma checagem previa
// (unico chefe sem gate) -- aqui o gate em 29 e aplicado de qualquer forma,
// fechando esse detalhe tambem.
const QUEST_COUNTER_CAP = { kills: 999999 };
// Os 8 contadores que travam avanco de missao (advanceQuestOnKill) -- usado
// tambem pelo PUT de personagem pra saber quais campos travar depois que o
// personagem ja tem progresso real (ver isTracked em handleCharacters).
const QUEST_GATE_FIELDS = ['kills', 'gk', 'ks', 'kw', 'kp', 'kt', 'ki', 'kv'];
// Fase 5.2: campos com valor economico real que o PUT generico de
// personagem NUNCA mais aceita do cliente pra um personagem que ja existe
// no banco -- so mudam por operacao server-side dedicada (handleShop,
// handleChest, handleQuest, creditKillReward, dungeon). gunlock e os
// chestN entram aqui pela mesma razao (desbloqueio de portal so por
// buy_portal; abertura de bau de campo so por handleChest).
const ECONOMY_LOCK_FIELDS = ['gold', 'gem', 'pv', 'pa', 'ap', 'key', 'scr', 'gunlock', 'chest', 'chest2', 'chest3', 'chest4', 'chest5', 'chest6', 'chest7'];
function advanceQuestOnKill(save, type, boss, lvl) {
  const q = save.quest, changed = {};
  const bump = (field, need, next) => {
    const cap = QUEST_COUNTER_CAP[field] || 999;
    save[field] = Math.min(cap, (save[field] || 0) + 1); changed[field] = save[field];
    if (save[field] >= need) { save.quest = next; changed.quest = next; }
  };
  const flip = (from, to) => { if (q === from) { save.quest = to; changed.quest = to; } };
  if (type === 'slime' && !boss && q === 1) bump('kills', 3, 2);
  else if (type === 'goblin' && !boss && q === 3) bump('gk', 5, 4);
  else if (type === 'goblin' && boss) flip(5, 6);
  else if (type === 'skeleton' && !boss && q === 7) bump('ks', 8, 8);
  else if (type === 'skeleton' && !boss && q === 19 && lvl >= 25) bump('kt', 12, 20);
  else if (type === 'skeleton' && boss) flip(9, 10);
  else if (type === 'wolf' && !boss && q === 11) bump('kw', 10, 12);
  else if (type === 'wolf' && boss) flip(13, 14);
  else if ((type === 'bat' || type === 'toxic') && !boss && q === 15) bump('kp', 12, 16);
  else if (type === 'bat' && !boss && q === 23 && lvl >= 30) bump('ki', 14, 24);
  else if (type === 'toxic' && boss) flip(17, 18);
  else if (type === 'caster' && !boss && q === 19) bump('kt', 12, 20);
  else if (type === 'caster' && boss) flip(21, 22);
  else if (type === 'sky' && !boss && q === 23) bump('ki', 14, 24);
  else if (type === 'sky' && boss) flip(25, 26);
  else if ((type === 'sala' || type === 'elem' || type === 'calc' || type === 'cinza') && q === 27) bump('kv', 16, 28);
  else if (type === 'lorde') flip(29, 30);
  return changed;
}

// Espelha classTypes() do cliente: quais tipos de item cada classe pode
// receber de sorteio (a propria arma da classe, e escudo so pro guerreiro).
const CLASS_ITEM_TYPES = {
  guerreiro: ['sword','shield','armor','helmet','cape','jewel','boots'],
  druida:    ['staffd','armor','helmet','cape','jewel','boots'],
  mago:      ['staffm','armor','helmet','cape','jewel','boots'],
  arqueiro:  ['bow','armor','helmet','cape','jewel','boots'],
};
// ===== Fase 5.3: drops de equipamento por raridade =====
// Grupos que participam do drop Rare/Epic/Legendary -- por design, so os 4
// definidos aqui (arma da classe + armadura + capa + botas). Escudo/
// capacete/joia continuam existindo normalmente (loja, bau de campo,
// CLASS_ITEM_TYPES acima) mas NAO entram nesta tabela nesta fase -- decisao
// de design explicita, nao uma omissao.
const DROP_TYPES_BY_CLASS = {
  guerreiro: ['sword', 'armor', 'cape', 'boots'],
  arqueiro:  ['bow', 'armor', 'cape', 'boots'],
  mago:      ['staffm', 'armor', 'cape', 'boots'],
  druida:    ['staffd', 'armor', 'cape', 'boots'],
};
// Fonte unica das chances de drop -- nunca espalhar 0.025/0.0025/0.05 em
// mais de um lugar. Mutuamente exclusivos por design (rollGearDrop testa
// Epic primeiro, so testa Rare se Epic falhar -- nunca os dois no mesmo
// abate) e no maximo 1 equipamento especial por morte confirmada.
const GEAR_DROP_RATES = {
  common: { epic: 0.0025, rare: 0.025 }, // mob comum: NUNCA legendary, NUNCA basic como drop
  boss:   { legendary: 0.05 },           // boss (campo ou masmorra): SO legendary ou nada
};
// Maior faixa de GEAR_DATA.GEAR_LEVELS que nao ultrapassa o nivel real do
// mob/boss -- fonte central, nunca duplicar esta matematica em outro lugar
// (chamada tanto pra drop de mob comum quanto pra Legendary de boss).
// GEAR_LEVELS ja vem ordenado crescente (1,4,8,...,40) de game-data/gear-data.js.
function gearLevelForMob(lvl) {
  const levels = GEAR_DATA.GEAR_LEVELS;
  let best = levels[0];
  for (const l of levels) { if (l <= lvl) best = l; else break; }
  return best;
}
// Funcao central de drop -- server-side, nunca confia em nada vindo do
// cliente (rarity/type/lv sempre decididos aqui). `rng` e injetavel pra
// teste deterministico (default Math.random em producao); nunca usar um
// rng/seed vindo do cliente. Retorna null (nada dropou) ou
// {rarity,type,lv,item}. Chamada tanto por mob de campo quanto de masmorra
// (mesma politica nos dois, ver LEIA-PRIMEIRO.md "Fase 5.3").
function rollGearDrop({ mobLevel, boss, cls, rng }) {
  const roll = typeof rng === 'function' ? rng : Math.random;
  let rarity;
  if (boss) {
    if (roll() < GEAR_DROP_RATES.boss.legendary) rarity = 'legendary';
    else return null;
  } else {
    // ordem: testa Epic primeiro; so testa Rare se Epic falhar -- nunca os
    // dois no mesmo kill (mutuamente exclusivos por construcao, cada teste
    // consome seu proprio roll()).
    if (roll() < GEAR_DROP_RATES.common.epic) rarity = 'epic';
    else if (roll() < GEAR_DROP_RATES.common.rare) rarity = 'rare';
    else return null;
  }
  const types = DROP_TYPES_BY_CLASS[cls] || DROP_TYPES_BY_CLASS.guerreiro;
  const type = types[Math.min(types.length - 1, Math.floor(roll() * types.length))];
  const lv = gearLevelForMob(mobLevel);
  const item = createGear(type, lv, rarity);
  if (!item) return null;
  return { rarity, type, lv, item };
}

// Precos de compra/venda de equipamento agora vem de GEAR_DATA (fonte unica,
// compartilhada com o cliente) -- ver priceFor()/sellPriceFor().
const STK_PRICES = {pv:10, pa:10, ap:5, scr:30};
const PORTAL_PRICES = {floresta:400, cripta:900, serra:1600, pantano:2500, torre:3600, ilhas:5000, vulcao:7000};
const GEM_SELL_PRICE = 25;
const SKILL_RESET_PRICE = 30;
const SHOP_BAG_MAX = 12;
function typeSlot(type) { return (type === 'sword' || type === 'bow' || type === 'staffd' || type === 'staffm') ? 'sword' : type; }

// Espelha as recompensas de missao dos dialogos (NPC_SCRIPT em index.html,
// callbacks end() dos estagios que dao premio) pra conceder ouro/gema/XP no
// servidor em vez de aceitar o que o cliente ja gravou no P.gold/P.gem/P.xp.
// So os 8 estagios que realmente pagam premio estao aqui; os demais (aceitar
// missao, "portal liberado" sem recompensa) nao movem nada de valor e
// continuam so no cliente.
const QUEST_REWARDS = {
  2:  {next:3,  gold:30,   gem:0, xp:20,   pv:1},
  4:  {next:5,  gold:60,   gem:1, xp:80},
  8:  {next:9,  gold:150,  gem:2, xp:300},
  12: {next:13, gold:250,  gem:3, xp:500},
  16: {next:17, gold:400,  gem:4, xp:800},
  20: {next:21, gold:600,  gem:5, xp:1200},
  24: {next:25, gold:800,  gem:6, xp:1800},
  28: {next:29, gold:1000, gem:7, xp:2500},
};
// Espelha need() do cliente (index.html): XP necessario pra passar do nivel l.
// Generico -- usado tanto pra recompensa de missao quanto pra XP de abate.
const questNeed = l => 30 * l;
function applyXpGain(save, lvl, xpGain) {
  let xp = save.xp + xpGain;
  while (xp >= questNeed(lvl)) { xp -= questNeed(lvl); lvl = Math.min(99, lvl + 1); }
  return { xp, lvl };
}

// Espelha os 7 bauis de mapa (um por area de campo, floresta..vulcao -- o
// baui de masmorra usa outro fluxo, sem flag persistido, fora do escopo) --
// cada `flag` e o nome que o cliente usa em P[ch.flag] (openChest em
// index.html); `field` e o nome correspondente gravado no save (chest,
// chest2..chest7). So abre uma vez por personagem: field vira true e trava.
const CHEST_REWARDS = {
  chestOpen:  {field:'chest',  gold:60,  tier:4},
  chestOpen2: {field:'chest2', gold:60,  tier:4},
  chestOpen3: {field:'chest3', gold:60,  tier:4},
  chestOpen4: {field:'chest4', gold:100, tier:5},
  chestOpen5: {field:'chest5', gold:150, tier:5},
  chestOpen6: {field:'chest6', gold:200, tier:5},
  chestOpen7: {field:'chest7', gold:250, tier:5},
};
// Compartilhado por qualquer fonte de loot de equipamento (bau de campo,
// bau/chefe de masmorra): equipa direto se o slot tiver vazio e o nivel
// bater (mesma regra de giveItem() no cliente), senao vai pra mochila se
// houver espaco. Nunca perde o item nem sobrescreve algo ja equipado.
function grantItem(save, lvl, item) {
  if (!item) return null;
  const slot = typeSlot(item.type), canEquip = !save.eq[slot] && (!item.req || lvl >= item.req);
  if (canEquip) save.eq[slot] = item;
  else if (save.bag.length < 24) save.bag.push(item);
  else return null;
  return item;
}
// `tier` aqui e o campo legado de CHEST_REWARDS (4 ou 5) -- convertido pra lv
// real via LEGACY_TIER_LEVEL, rarity sempre 'basic' (drop de raridade melhor
// fica pra Fase 5.3, ver LEIA-PRIMEIRO.md). uid novo garantido por createGear.
function rollChestItem(save, lvl, tier) {
  const types = CLASS_ITEM_TYPES[save.cls] || ['armor'];
  const type = types[Math.floor(Math.random() * types.length)];
  const lv = GEAR_DATA.LEGACY_TIER_LEVEL[tier] || 12;
  return grantItem(save, lvl, createGear(type, lv, 'basic'));
}

// shopSold e efemero por personagem (lista de recompra), como party --
// nao sobrevive a um restart, nao precisa de tabela.
const shopSoldByChar = new Map();

// Mutex simples por personagem (Fase 5.1): serializa qualquer operacao que
// faz leitura-altera-grava no mesmo characters.save (compra/venda/equipar/
// desequipar em handleShop, loot de bau em handleChest) pra duas requisicoes
// concorrentes do mesmo personagem nunca lerem o mesmo estado "antigo" e
// sobrescreverem uma a outra (perderia ouro debitado ou duplicaria item).
// So protege dentro desta instancia Node (o Render roda uma instancia unica
// hoje) -- se um dia houver mais de uma instancia, isso precisa virar um lock
// real no banco (ex.: transacao Postgres); documentado como limitacao atual.
const charLocks = new Map();
function withCharLock(charId, fn) {
  const run = () => fn();
  const prior = charLocks.get(charId) || Promise.resolve();
  const result = prior.then(run, run);
  charLocks.set(charId, result.catch(() => {}));
  return result;
}

// Espelha a formula de dano e o cooldown de cada skill (CLASSES/SKILL_FX em
// index.html) pra computar o dano no servidor em vez de aceitar o numero que
// o cliente manda. O cliente so informa QUAL skill/rank foi usada; o "quanto
// de dano" sai sempre do calculo abaixo.
const CLASS_DMG = {
  guerreiro: {dmg0:11, dmgL:3.2}, druida: {dmg0:9, dmgL:2.8},
  mago: {dmg0:13, dmgL:3.7}, arqueiro: {dmg0:10, dmgL:3},
};
const BASIC_CD_MS = {guerreiro:420, druida:500, mago:620, arqueiro:400};
const SKILL_CD_MS = {spin:5000, dash:4000, warcry:18000, heal:7000, roots:9000, thorns:10000, fireball:4000, frost:7000, barrier:16000, multi:4000, evade:5000, pierce:8000};
const CLASS_SKILLS = {
  guerreiro: ['spin','dash','warcry'], druida: ['heal','roots','thorns'],
  mago: ['fireball','frost','barrier'], arqueiro: ['multi','evade','pierce'],
};
const DAMAGE_SKILLS = new Set(['spin','dash','roots','thorns','fireball','frost','multi','pierce']);

// Save inicial de um personagem novo, definido pelo servidor (Fase 5.2) --
// espelha os defaults reais do objeto P no cliente (index.html): ouro 10,
// 3 pocoes de vida, 2 de mana, arma Nv1 Basica da classe ja equipada, tudo
// mais zerado. Usado no POST /api/characters (grava isso direto no banco
// na criacao) -- personagem online novo nunca mais depende do que o
// primeiro PUT do cliente reivindica pra nascer com ouro/item/progresso
// (ver handleCharacters: a partir desta fase TODO PUT trava campos
// economicos no que o servidor ja tem, sem excecao pro "primeiro save").
function startingSave(cls, name) {
  const weapon = (CLASS_ITEM_TYPES[cls] || CLASS_ITEM_TYPES.guerreiro)[0];
  const skills = CLASS_SKILLS[cls] || CLASS_SKILLS.guerreiro;
  const raw = {
    cls, gold: 10, gem: 0, pv: 3, pa: 2, quest: 0,
    map: 'vila', name, bar: [], gunlock: {}, skSeen: {},
    sk: Object.fromEntries(skills.map(id => [id, 1])),
    bag: [], eq: { sword: createGear(weapon, 1, 'basic') },
    chat: [],
  };
  return sanitizeSave(raw, 1);
}
function skillDamageMul(id, r) {
  switch (id) {
    case 'spin': return 1.4 + .3 * (r - 1);
    case 'dash': return 1.2 + .25 * (r - 1);
    case 'roots': return .8 + .2 * (r - 1);
    case 'thorns': return .45 + .1 * (r - 1);
    case 'fireball': return 1.8 + .4 * (r - 1);
    case 'frost': return 1 + .25 * (r - 1);
    case 'multi': return .75 + .05 * (r - 1);
    case 'pierce': return 2.2 + .4 * (r - 1);
    default: return 0;
  }
}
// Teto solto pro atk que o cliente reivindica em cada golpe (msg.atk) --
// nao prova o valor (o servidor ainda nao deriva ATK real do equipamento,
// ver LEIA-PRIMEIRO.md "Fase 5.2" pro que falta), so evita o caso obvio de
// um cliente adulterado mandando um numero absurdo. 35 (valor pre-Fase-5.1)
// ja ficou defasado: arma Nv40 basica sozinha soma ~55 depois do
// multiplicador de classe (42*1.3), +joia Nv40 (17) = ~72 hoje so com
// equipamento Basico; Lendario (unico ainda nao vendido/dropado, 1.35x)
// chegaria a ~97. 120 cobre os dois com folga sem abrir vantagem real.
function clampAtk(v) { return Math.max(0, Math.min(120, Number(v) || 0)); }
function baseDmgOf(cls, lvl) { const c = CLASS_DMG[cls] || CLASS_DMG.guerreiro; return c.dmg0 + c.dmgL * (lvl - 1); }
function buffMulOf(p) { return 1 + ((p.buffUntil && Date.now() < p.buffUntil) ? (p.buffAtk || 0) : 0); }
function skBaseOf(p, atk) { return (baseDmgOf(p.cls, p.lvl) + clampAtk(atk) + 2) * buffMulOf(p); }

// Compartilhado por mob_damage e player_damage: nunca confia no numero que o
// cliente manda, so em qual skill foi usada (basic com formula+cooldown por
// classe, ou o valor "pendente" computado no cast_skill). Retorna null se a
// skill nao pode causar dano agora (sem cast valido, cooldown, ou spam).
function resolveAttackDamage(p, msg, now) {
  const skill = cleanText(msg.skill, 16) || 'basic';
  let dmg = 0;
  if (skill === 'basic') {
    p.recentBasic = (p.recentBasic || []).filter(t => now - t < (BASIC_CD_MS[p.cls] || 420));
    if (p.recentBasic.length >= 6) return null;
    p.recentBasic.push(now);
    dmg = Math.round((baseDmgOf(p.cls, p.lvl) + clampAtk(msg.atk)) * buffMulOf(p)) + Math.floor(Math.random() * 4);
  } else if (DAMAGE_SKILLS.has(skill)) {
    const pend = p.pendingSkill && p.pendingSkill[skill];
    if (!pend || now > pend.expiresAt) return null;
    dmg = msg.splash ? Math.round(pend.dmg * .6) : pend.dmg;
  } else return null;
  const lvl = Math.max(1, Math.min(99, Number(p.lvl) || 1)), maxHit = Math.min(6500, 50 + lvl * 60);
  dmg = Math.max(0, Math.min(maxHit, dmg));
  return dmg || null;
}

function cleanText(value, max) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
}

function json(res, status, payload) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 262144) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('INVALID_JSON')); } });
    req.on('error', reject);
  });
}

const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Reconstroi um item inteiro a partir de limites plausiveis, nunca confiando
// em nenhum campo que o cliente manda (tipo precisa existir em GEAR_DATA;
// nivel/raridade precisam ser valores validos; stats/nome SEMPRE recalculados
// no servidor, o que o cliente mandar nesses campos e ignorado).
//
// Aceita dois formatos de entrada:
// - Canonico (modelo novo): {uid, type, lv, rarity, enchant}. uid e mantido
//   se for um UUID valido (posse/identidade nunca muda so por passar aqui de
//   novo -- ver lockOwnedItems() pra onde a POSSE de fato e garantida).
// - Legado (pre-Fase-5.1): {type, tier} (tier 1-5). Migra pra lv via
//   LEGACY_TIER_LEVEL (os 5 valores reais de stats sao identicos, entao um
//   item existente nao muda de forca ao migrar), rarity vira 'basic', e
//   ganha um uid novo (nunca existiu antes) -- so acontece aqui, na leitura;
//   depois de gravado de volta com uid, o item passa a bater no formato
//   canonico nas proximas leituras e o uid nunca mais muda.
function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!GEAR_DATA.GEAR_STATS[raw.type]) return null;
  let lv = Math.round(Number(raw.lv));
  let rarity = typeof raw.rarity === 'string' && GEAR_DATA.RARITY[raw.rarity] ? raw.rarity : null;
  if (!GEAR_DATA.GEAR_LEVELS.includes(lv) || !rarity) {
    const legacyLv = GEAR_DATA.LEGACY_TIER_LEVEL[Math.round(Number(raw.tier))];
    if (!legacyLv) return null;
    lv = legacyLv; rarity = 'basic';
  }
  const stats = GEAR_DATA.statsFor(raw.type, lv, rarity);
  if (!stats) return null;
  const enchant = Math.max(0, Math.min(10, Math.round(Number(raw.enchant) || 0)));
  const uid = typeof raw.uid === 'string' && UID_RE.test(raw.uid) ? raw.uid : crypto.randomUUID();
  return {
    uid, type: raw.type, lv, rarity, enchant,
    n: GEAR_DATA.nameFor(raw.type, lv),
    atk: stats.atk || 0, def: stats.def || 0, hp: stats.hp || 0, blk: stats.blk || 0, spd: stats.spd || 0, req: stats.req || 0,
  };
}
// Garante que nenhum uid se repete numa lista de itens (mantem a primeira
// ocorrencia). Usado tanto dentro da mochila quanto no cruzamento
// mochila+equipado -- um mesmo item fisico nunca pode "existir" duas vezes.
function dedupeByUid(items, seen) {
  const out = [];
  for (const it of items) { if (!it || seen.has(it.uid)) continue; seen.add(it.uid); out.push(it); }
  return out;
}

// Reconstroi o save inteiro a partir de limites plausiveis em vez de
// confiar no JSON que o cliente manda: mesmo com o jogo ainda calculando
// dano/inventario no cliente, isso impede que editar localStorage/memoria
// vire ouro, itens ou XP infinitos persistidos na nuvem.
function sanitizeSave(raw, lvl) {
  const save = raw && typeof raw === 'object' ? raw : {};
  const clampInt = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  const map = ALLOWED_MAP.test(cleanText(save.map, 24)) ? cleanText(save.map, 24) : 'vila';
  const out = {
    cls: ALLOWED_CLASS.has(save.cls) ? save.cls : 'guerreiro', lvl,
    xp: clampInt(save.xp, 30 * (lvl + 1) * 3), gold: clampInt(save.gold, 500000), gem: clampInt(save.gem, 5000),
    pv: clampInt(save.pv, 999), pa: clampInt(save.pa, 999), quest: clampInt(save.quest, 40), kills: clampInt(save.kills, 999999),
    hp: clampInt(save.hp, 100000), mp: clampInt(save.mp, 100000),
    x: Number.isFinite(Number(save.x)) ? Number(save.x) : 0, y: Number.isFinite(Number(save.y)) ? Number(save.y) : 0,
    pt: clampInt(save.pt, 10000000), map,
    chest: !!save.chest, chest2: !!save.chest2, chest3: !!save.chest3, chest4: !!save.chest4, chest5: !!save.chest5, chest6: !!save.chest6, chest7: !!save.chest7,
    name: cleanText(save.name, 14) || 'Herói',
    bar: Array.isArray(save.bar) ? save.bar.slice(0, 8).map(x => typeof x === 'string' && x.length < 20 ? x : null) : [],
    gunlock: save.gunlock && typeof save.gunlock === 'object' ? Object.fromEntries(Object.entries(save.gunlock).slice(0, 20).map(([k, v]) => [cleanText(k, 24), !!v])) : {},
    skSeen: save.skSeen && typeof save.skSeen === 'object' ? Object.fromEntries(Object.entries(save.skSeen).slice(0, 20).map(([k, v]) => [cleanText(k, 20), !!v])) : {},
    sk: save.sk && typeof save.sk === 'object' ? Object.fromEntries(Object.entries(save.sk).slice(0, 10).map(([k, v]) => [cleanText(k, 20), clampInt(v, 3)])) : {},
    bag: [],
    eq: {},
    chat: Array.isArray(save.chat) ? save.chat.slice(-40).map(m => ({n: cleanText(m && m.n, 20), t: cleanText(m && m.t, 240), sys: !!(m && m.sys)})) : [],
  };
  for (const f of COUNTER_FIELDS) out[f] = clampInt(save[f], 999);
  // Um uid nunca pode aparecer duas vezes (mochila+mochila ou mochila+
  // equipado) -- o segundo lugar onde apareceria e descartado (nunca gera
  // copia extra do item).
  const seenUids = new Set();
  out.bag = dedupeByUid(Array.isArray(save.bag) ? save.bag.slice(0, 24).map(sanitizeItem) : [], seenUids);
  // Um item equipado com req (nivel minimo) maior que o nivel real nunca
  // acontece num cliente honesto (giveItem/loja so equipam se lvl>=req) --
  // so surge editando o save direto. Em vez de aceitar, desequipa e devolve
  // pra mochila (nunca perde o item, so tira a vantagem indevida do slot).
  for (const s of EQ_SLOTS) {
    let item = save.eq && save.eq[s] ? sanitizeItem(save.eq[s]) : null;
    if (item && seenUids.has(item.uid)) item = null; // ja apareceu (mochila ou outro slot) -- descarta a copia
    if (item && item.req && item.req > lvl) { if (out.bag.length < 24) { out.bag.push(item); seenUids.add(item.uid); } item = null; }
    if (item) seenUids.add(item.uid);
    out.eq[s] = item;
  }
  // Pontos de habilidade gastos (rank-1 por skill) nunca podem passar de
  // lvl-1 disponivel (skillPoints() no cliente) -- um cliente honesto nunca
  // sobe rank sem ter ponto livre. Sem isso, um save editado podia upar as
  // 3 skills da classe pro rank maximo (3) em qualquer nivel. Se o total
  // gasto excede o orcamento, reseta as 3 pro rank base -- mesmo resultado
  // que a acao "redistribuir" da loja ja produz normalmente.
  const validSkills = CLASS_SKILLS[out.cls] || [];
  const filteredSk = {}; for (const id of validSkills) filteredSk[id] = out.sk[id] || 1;
  const spentPts = validSkills.reduce((sum, id) => sum + (filteredSk[id] - 1), 0);
  out.sk = spentPts > Math.max(0, lvl - 1) ? Object.fromEntries(validSkills.map(id => [id, 1])) : filteredSk;
  return out;
}

// Bloqueador critico de posse (Fase 5.1): usado so pelo PUT generico de
// personagem (handleCharacters), quando o personagem ja tem progresso real
// (isTracked). Ate aqui, sanitizeItem/sanitizeSave garantem que um item tem
// STATS legitimos pro lv/rarity dele -- mas nao provam que o personagem
// realmente ADQUIRIU aquele item. Sem essa trava, editar localStorage/save
// em memoria e mandar um PUT com bag/eq forjado (item novo com uid
// inventado) criava equipamento de graca.
//
// Regra: um item so sobrevive no PUT se o uid dele ja existia no save
// PERSISTIDO antes desse PUT (em qualquer lugar -- mochila ou equipado, nao
// importa o slot: so a posse). Itens legitimamente novos (compra, baú,
// recompensa de missao/abate) nunca passam por aqui -- entram direto no
// banco pelos proprios endpoints (handleShop/handleChest/creditKillReward).
//
// Isso NAO quebra equipar/desequipar client-side: contanto que o cliente so
// mova itens que ja possuia entre bag/eq (exatamente o que equipFromBag/
// unequipSlot fazem hoje), o conjunto de uids não muda, so a posicao -- passa
// pela trava sem problema nenhum, sem precisar de nenhuma mudanca no fluxo
// existente. Só barra uid que o servidor nunca viu.
function lockOwnedItems(candidateSave, ownedSave) {
  const byUid = new Map();
  for (const it of ownedSave.bag) byUid.set(it.uid, it);
  for (const s of EQ_SLOTS) if (ownedSave.eq[s]) byUid.set(ownedSave.eq[s].uid, ownedSave.eq[s]);
  const used = new Set();
  const bag = [];
  for (const it of candidateSave.bag) {
    if (!it || !byUid.has(it.uid) || used.has(it.uid)) continue;
    used.add(it.uid); bag.push(byUid.get(it.uid)); // sempre a copia canonica do servidor, nunca a do cliente
  }
  const eq = {};
  for (const s of EQ_SLOTS) {
    const it = candidateSave.eq[s];
    if (it && byUid.has(it.uid) && !used.has(it.uid)) { used.add(it.uid); eq[s] = byUid.get(it.uid); }
    else eq[s] = null;
  }
  // Item que o personagem possuia mas o cliente "esqueceu" de mandar de
  // volta nesse PUT (bug de sincronizacao, aba antiga, etc.) volta pra
  // mochila em vez de desaparecer -- essa trava nunca é motivo pra perder item.
  for (const it of ownedSave.bag) if (!used.has(it.uid) && bag.length < 24) { used.add(it.uid); bag.push(it); }
  for (const s of EQ_SLOTS) { const it = ownedSave.eq[s]; if (it && !used.has(it.uid) && bag.length < 24) { used.add(it.uid); bag.push(it); } }
  return { bag, eq };
}

function authIp(req) {
  return cleanText(String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0], 64);
}

function rateLimited(req) {
  const now = Date.now(), key = authIp(req), recent = (authAttempts.get(key) || []).filter(t => now - t < 60000);
  recent.push(now); authAttempts.set(key, recent);
  return recent.length > 12;
}

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function scrypt(password, salt, keylen, options) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, keylen, options, (err, key) => err ? reject(err) : resolve(key)));
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16), N = 16384, r = 8, p = 1;
  const key = await scrypt(password, salt, 32, {N, r, p, maxmem: 64 * 1024 * 1024});
  return `scrypt$${N}$${r}$${p}$${b64url(salt)}$${b64url(key)}`;
}
async function verifyPassword(password, encoded) {
  if (/^\$2[aby]\$/.test(String(encoded || ''))) {
    try { return await bcrypt.compare(password, encoded); } catch { return false; }
  }
  const parts = String(encoded || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [,n,rr,pp,salt64,key64] = parts, expected = Buffer.from(key64, 'base64url');
  if (!expected.length) return false;
  try {
    const actual = await scrypt(password, Buffer.from(salt64, 'base64url'), expected.length, {N:Number(n), r:Number(rr), p:Number(pp), maxmem:64 * 1024 * 1024});
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

async function supabase(table, {method='GET', query='', body, prefer}={}) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('SUPABASE_NOT_CONFIGURED');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method,
    headers:{apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${SUPABASE_SECRET_KEY}`,'Content-Type':'application/json',...(prefer?{Prefer:prefer}:{})},
    body:body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) { const err = new Error('SUPABASE_REQUEST_FAILED'); err.status=response.status; err.detail=data; throw err; }
  return data;
}

async function createSession(userId) {
  const token = b64url(crypto.randomBytes(32)), expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await supabase('sessions', {method:'POST', body:{token:tokenHash(token),user_id:userId,expires_at:expiresAt}, prefer:'return=minimal'});
  return {token, expiresAt};
}

function bearer(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  return match ? match[1] : '';
}

// Extraido de resolveUser() (Fase 5.2) pra ser reusavel fora de um request
// HTTP -- o WebSocket agora autentica o 'join' com o MESMO token de sessao
// usado pelas rotas REST (ver handleJoin), entao precisa da mesma validacao
// sem depender de um objeto `req`.
async function resolveUserByToken(token) {
  if (!token) return null;
  const rows = await supabase('sessions', {query:`?select=expires_at,users(id,username)&token=eq.${tokenHash(token)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`});
  const row = rows[0], user = Array.isArray(row?.users) ? row.users[0] : row?.users;
  return user ? {id: user.id, username: user.username, expiresAt: row.expires_at} : null;
}
async function resolveUser(req) { return resolveUserByToken(bearer(req)); }

async function handleAuth(req, res, pathname) {
  if (!pathname.startsWith('/api/auth/')) return false;
  if (req.method === 'POST' && rateLimited(req)) { json(res,429,{error:'Muitas tentativas. Aguarde um minuto.'}); return true; }
  try {
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      const input=await readJson(req), username=String(input.username||'').trim().toLowerCase(), password=String(input.password||'');
      if(!/^[a-z0-9_]{3,16}$/.test(username)){json(res,400,{error:'Usuário: de 3 a 16 letras, números ou _'});return true}
      if(password.length<8||password.length>72){json(res,400,{error:'A senha precisa ter de 8 a 72 caracteres'});return true}
      const found=await supabase('users',{query:`?select=id&username=eq.${encodeURIComponent(username)}&limit=1`});
      if(found.length){json(res,409,{error:'Esse usuário já existe'});return true}
      const password_hash=await hashPassword(password);
      let rows;
      try { rows=await supabase('users',{method:'POST',body:{username,password_hash},prefer:'return=representation'}); }
      catch(e){if(e.status===409){json(res,409,{error:'Esse usuário já existe'});return true}throw e}
      const session=await createSession(rows[0].id);
      json(res,201,{user:{id:rows[0].id,name:username,key:username},...session});return true;
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const input=await readJson(req), username=String(input.username||'').trim().toLowerCase(), password=String(input.password||'');
      if(!username||!password){json(res,400,{error:'Digite o usuário e a senha'});return true}
      const rows=await supabase('users',{query:`?select=id,username,password_hash&username=eq.${encodeURIComponent(username)}&limit=1`});
      const user=rows[0];
      if(!user||!(await verifyPassword(password,user.password_hash))){json(res,401,{error:'Usuário ou senha incorretos'});return true}
      const update={last_login:new Date().toISOString()};
      if(/^\$2[aby]\$/.test(user.password_hash))update.password_hash=await hashPassword(password);
      await supabase('users',{method:'PATCH',query:`?id=eq.${encodeURIComponent(user.id)}`,body:update,prefer:'return=minimal'});
      const session=await createSession(user.id);
      json(res,200,{user:{id:user.id,name:user.username,key:user.username},...session});return true;
    }
    if (pathname === '/api/auth/session' && req.method === 'GET') {
      const user=await resolveUser(req);
      if(!user){json(res,401,{error:'Sessão expirada'});return true}
      json(res,200,{user:{id:user.id,name:user.username,key:user.username},expiresAt:user.expiresAt});return true;
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const token=bearer(req);if(token)await supabase('sessions',{method:'DELETE',query:`?token=eq.${tokenHash(token)}`,prefer:'return=minimal'});
      json(res,200,{ok:true});return true;
    }
    json(res,405,{error:'Método não permitido'});return true;
  } catch (err) {
    console.error('auth_error', err.message, err.status || '', err.detail || '');
    if (!res.headersSent) json(res,err.message==='SUPABASE_NOT_CONFIGURED'?503:500,{error:err.message==='SUPABASE_NOT_CONFIGURED'?'Login online ainda não configurado no servidor.':'Não foi possível concluir. Tente novamente.'});
    return true;
  }
}

const CHAR_ID_RE = /^\/api\/characters\/([0-9a-fA-F-]{8,36})$/;

async function handleCharacters(req, res, pathname) {
  if (!pathname.startsWith('/api/characters')) return false;
  try {
    const user = await resolveUser(req);
    if (!user) { json(res,401,{error:'Sessão ausente ou expirada'}); return true; }

    if (pathname === '/api/characters' && req.method === 'GET') {
      const rows = await supabase('characters', {query:`?select=id,slot,name,cls,lvl,map,save,updated_at&user_id=eq.${user.id}&order=slot.asc`});
      json(res,200,{characters: rows}); return true;
    }

    if (pathname === '/api/characters' && req.method === 'POST') {
      const input = await readJson(req);
      const slot = Number(input.slot);
      const name = cleanText(input.name, 14);
      const cls = ALLOWED_CLASS.has(input.cls) ? input.cls : 'guerreiro';
      if (!Number.isInteger(slot) || slot < 0 || slot > 3) { json(res,400,{error:'Espaço inválido'}); return true; }
      if (name.length < 2) { json(res,400,{error:'Nome do personagem inválido'}); return true; }
      let rows;
      try {
        rows = await supabase('characters', {method:'POST', body:{user_id:user.id, slot, name, cls, lvl:1, map:'vila', save:startingSave(cls, name)}, prefer:'return=representation'});
      } catch (e) {
        if (e.status === 409) { json(res,409,{error:'Espaço ou nome já em uso'}); return true; }
        throw e;
      }
      json(res,201,{character: rows[0]}); return true;
    }

    const idMatch = CHAR_ID_RE.exec(pathname);
    if (idMatch && req.method === 'PUT') {
      const id = idMatch[1];
      const input = await readJson(req);
      const result = await withCharLock(id, async () => {
        const rows0 = await supabase('characters', {query:`?select=lvl,save&id=eq.${encodeURIComponent(id)}&user_id=eq.${user.id}&limit=1`});
        const current = rows0[0];
        let lvl = Math.max(1, Math.min(99, Number(input.lvl) || 1));
        const save = sanitizeSave(input.save, lvl);
        // Fase 5.2: se o personagem ja existe no banco, o PUT generico deixa
        // de ser fonte de verdade pra QUALQUER campo com valor real --
        // nivel/xp/missao/contadores, itens (uid) e agora tambem ouro/gema/
        // consumiveis/chaves/portais/baus (ECONOMY_LOCK_FIELDS). Tudo isso so
        // muda pelos caminhos validados (handleShop/handleChest/handleQuest/
        // creditKillReward/dungeon). Sem excecao pro "primeiro PUT": o
        // personagem ja nasce com o save inicial completo gravado no POST
        // (ver startingSave()), entao nao ha mais "save vazio" que precise
        // confiar no cliente pra nascer com ouro/item. Isso tambem fecha,
        // de proposito, a promocao de personagem local antigo pra nuvem
        // (import de progresso local): o PUT que o fluxo de importacao
        // ainda dispara continua funcionando sem erro, mas so nome/classe
        // pegam -- ouro/itens/nivel locais nunca mais sao aceitos por essa
        // via. Documentado como decisao consciente (nao um recurso quebrado
        // por acidente), ver LEIA-PRIMEIRO.md "Fase 5.2".
        if (current) {
          const currentSave = sanitizeSave(current.save, current.lvl);
          lvl = current.lvl; save.lvl = lvl; save.xp = currentSave.xp; save.quest = currentSave.quest;
          for (const f of QUEST_GATE_FIELDS) save[f] = currentSave[f];
          for (const f of ECONOMY_LOCK_FIELDS) save[f] = currentSave[f];
          const locked = lockOwnedItems(save, currentSave);
          save.bag = locked.bag; save.eq = locked.eq;
        }
        const rows = await supabase('characters', {method:'PATCH', query:`?id=eq.${encodeURIComponent(id)}&user_id=eq.${user.id}`, body:{lvl, map: save.map, save}, prefer:'return=representation'});
        if (!rows.length) return {status:404, body:{error:'Personagem não encontrado'}};
        return {status:200, body:{character: rows[0]}};
      });
      json(res, result.status, result.body); return true;
    }

    if (idMatch && req.method === 'DELETE') {
      const id = idMatch[1];
      const rows = await supabase('characters', {method:'DELETE', query:`?id=eq.${encodeURIComponent(id)}&user_id=eq.${user.id}`, prefer:'return=representation'});
      if (!rows.length) { json(res,404,{error:'Personagem não encontrado'}); return true; }
      json(res,200,{ok:true}); return true;
    }

    json(res,405,{error:'Método não permitido'}); return true;
  } catch (err) {
    console.error('characters_error', err.message, err.status || '', err.detail || '');
    if (!res.headersSent) json(res, err.message==='SUPABASE_NOT_CONFIGURED'?503:500, {error: err.message==='SUPABASE_NOT_CONFIGURED'?'Salvamento online ainda não configurado no servidor.':'Não foi possível salvar. Tente novamente.'});
    return true;
  }
}

const SHOP_ID_RE = /^\/api\/characters\/([0-9a-fA-F-]{8,36})\/shop$/;
const QUEST_ID_RE = /^\/api\/characters\/([0-9a-fA-F-]{8,36})\/quest$/;
const CHEST_ID_RE = /^\/api\/characters\/([0-9a-fA-F-]{8,36})\/chest$/;

// Loja/economia server-autoritativa: le o save atual do personagem no banco,
// aplica a transacao contra as tabelas de preco de GEAR_DATA (nunca confia em
// preco, uid ou "eu tenho X moedas" que o cliente manda) e grava o resultado
// -- tudo dentro de withCharLock, serializando qualquer outra operacao
// concorrente do MESMO personagem. Fecha a brecha que a sanitizacao do save
// sozinha nao fecha: sanitizeItem garante que um item tem stats legitimos
// pro lv/rarity dele, mas nao garante que foi pago -- so uma transacao de
// verdade (ou lockOwnedItems, pro PUT generico) garante isso.
async function handleShop(req, res, pathname) {
  const m = SHOP_ID_RE.exec(pathname);
  if (!m) return false;
  if (req.method !== 'POST') { json(res,405,{error:'Método não permitido'}); return true; }
  const charId = m[1];
  try {
    const user = await resolveUser(req);
    if (!user) { json(res,401,{error:'Sessão ausente ou expirada'}); return true; }
    const input = await readJson(req);
    const result = await withCharLock(charId, async () => {
      const rows0 = await supabase('characters', {query:`?select=lvl,save&id=eq.${encodeURIComponent(charId)}&user_id=eq.${user.id}&limit=1`});
      const row = rows0[0];
      if (!row) return {status:404, body:{error:'Personagem não encontrado'}};
      const lvl = row.lvl;
      const save = sanitizeSave(row.save, lvl);
      const action = String(input.action || '');
      let error = null;

      if (action === 'buy_gear') {
        const type = String(input.type || ''), gearLv = Math.round(Number(input.lv));
        const price = GEAR_DATA.priceFor(type, gearLv);
        const item = price ? createGear(type, gearLv, 'basic') : null;
        if (!item) error = 'Item inválido';
        else if (!(CLASS_ITEM_TYPES[save.cls] || []).includes(type)) error = 'Item incompatível com a classe';
        else if (save.gold < price) error = 'Moedas insuficientes';
        else {
          const slot = typeSlot(type), canEquip = !save.eq[slot] && (!item.req || lvl >= item.req);
          if (!canEquip && save.bag.length >= SHOP_BAG_MAX) error = 'Mochila cheia';
          else { save.gold -= price; if (canEquip) save.eq[slot] = item; else save.bag.push(item); }
        }
      } else if (action === 'buy_stack') {
        const key = String(input.key || ''), qty = Math.max(1, Math.min(99, Math.round(Number(input.qty) || 1)));
        const unit = ['pv','pa','ap','scr'].includes(key) ? STK_PRICES[key] : null;
        if (!unit) error = 'Item inválido';
        else if (save.gold < unit * qty) error = 'Moedas insuficientes';
        else if ((save[key] || 0) + qty > 99) error = 'Você não consegue carregar tanto assim';
        else { save.gold -= unit * qty; save[key] = (save[key] || 0) + qty; }
      } else if (action === 'sell_item') {
        const uid = cleanText(input.uid, 40);
        const idx = uid ? save.bag.findIndex(it => it.uid === uid) : Math.round(Number(input.bagIndex));
        if (!Number.isInteger(idx) || idx < 0 || idx >= save.bag.length) error = 'Item não encontrado';
        else {
          // Fase 5.3: preco de venda considera raridade (sellPriceForItem =
          // sellPriceFor(lv) * multiplicador por rarity) -- nunca so pelo
          // nivel sozinho, senao Raro/Epico/Lendario venderiam pelo mesmo
          // preco que um Basic do mesmo nivel.
          const it = save.bag[idx], price = GEAR_DATA.sellPriceForItem(it);
          save.bag.splice(idx, 1); save.gold += price;
          const list = shopSoldByChar.get(charId) || [];
          list.unshift({it, price: Math.ceil(price * 1.5)}); list.length = Math.min(list.length, 10);
          shopSoldByChar.set(charId, list);
        }
      } else if (action === 'sell_common') {
        // Fase 5.3: "comum" pra venda em massa agora significa rarity ===
        // 'basic' (de QUALQUER nivel), nunca mais lv===1 -- a checagem antiga
        // por nivel venderia por engano um Raro/Epico/Lendario Nv1 (existe
        // desde que virou possivel dropar raridade alta em nivel baixo,
        // Fase 5.3) como se fosse lixo comum. Ponto critico, ver
        // LEIA-PRIMEIRO.md "Fase 5.3".
        let total = 0; const kept = []; const list = shopSoldByChar.get(charId) || [];
        for (const it of save.bag) {
          if (it.rarity === 'basic') { const price = GEAR_DATA.sellPriceForItem(it); total += price; list.unshift({it, price: Math.ceil(price * 1.5)}); }
          else kept.push(it);
        }
        save.bag = kept; save.gold += total; list.length = Math.min(list.length, 10);
        shopSoldByChar.set(charId, list);
      } else if (action === 'sell_gem') {
        const qty = Math.round(Number(input.qty) || 1);
        if (!Number.isInteger(qty) || qty < 1 || qty > save.gem) error = 'Sem gemas suficientes';
        else { save.gem -= qty; save.gold += qty * GEM_SELL_PRICE; }
      } else if (action === 'buyback') {
        const idx = Math.round(Number(input.index));
        const list = shopSoldByChar.get(charId) || [];
        if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) error = 'Item não encontrado';
        else {
          const entry = list[idx];
          if (save.gold < entry.price) error = 'Moedas insuficientes';
          else {
            const slot = typeSlot(entry.it.type), canEquip = !save.eq[slot] && (!entry.it.req || lvl >= entry.it.req);
            if (!canEquip && save.bag.length >= SHOP_BAG_MAX) error = 'Mochila cheia';
            // buyback devolve exatamente o mesmo objeto (mesmo uid) que foi vendido -- nunca gera um novo.
            else { list.splice(idx, 1); shopSoldByChar.set(charId, list); save.gold -= entry.price; if (canEquip) save.eq[slot] = entry.it; else save.bag.push(entry.it); }
          }
        }
      } else if (action === 'equip_item') {
        const uid = cleanText(input.uid, 40);
        const idx = save.bag.findIndex(it => it.uid === uid);
        if (idx < 0) error = 'Item não encontrado';
        else {
          const it = save.bag[idx];
          if (it.req && lvl < it.req) error = 'Nível insuficiente';
          else if (!(CLASS_ITEM_TYPES[save.cls] || []).includes(it.type)) error = 'Item incompatível com a classe';
          else {
            const slot = typeSlot(it.type), old = save.eq[slot];
            save.bag.splice(idx, 1); save.eq[slot] = it;
            if (old) save.bag.push(old);
          }
        }
      } else if (action === 'unequip_item') {
        const slot = String(input.slot || '');
        if (!EQ_SLOTS.includes(slot) || !save.eq[slot]) error = 'Nada equipado nesse espaço';
        else if (save.bag.length >= SHOP_BAG_MAX) error = 'Mochila cheia';
        else { save.bag.push(save.eq[slot]); save.eq[slot] = null; }
      } else if (action === 'skill_reset') {
        if (save.gold < SKILL_RESET_PRICE) error = 'Moedas insuficientes';
        else { save.gold -= SKILL_RESET_PRICE; for (const k of Object.keys(save.sk)) save.sk[k] = 1; }
      } else if (action === 'buy_portal') {
        const dest = String(input.dest || ''), price = PORTAL_PRICES[dest];
        if (!price) error = 'Destino inválido';
        else if (save.gunlock[dest]) error = 'Já liberado';
        else if (save.gold < price) error = 'Moedas insuficientes';
        else { save.gold -= price; save.gunlock[dest] = true; }
      } else if (action === 'use_item') {
        // Fase 5.2, Parte 4: consumir pv/pa/ap/scr vira intencao server-side
        // pra personagem online -- o PUT generico nao aceita mais decremento
        // direto (pv/pa/ap/scr estao em ECONOMY_LOCK_FIELDS). O efeito em si
        // (curar HP/MP, teleportar pra vila) continua calculado no cliente
        // (mesma limitacao ja documentada pro HP do jogador, ver Fase 5.2 em
        // LEIA-PRIMEIRO.md) -- aqui so garante que a CONTAGEM do item nunca
        // fica negativa nem "usa" um item que nao existe.
        const key = String(input.key || '');
        if (!['pv', 'pa', 'ap', 'scr'].includes(key)) error = 'Item inválido';
        else if ((save[key] || 0) < 1) error = 'Você não tem esse item';
        else save[key] -= 1;
      } else {
        error = 'Ação inválida';
      }

      if (error) return {status:400, body:{error}};
      const rows = await supabase('characters', {method:'PATCH', query:`?id=eq.${encodeURIComponent(charId)}&user_id=eq.${user.id}`, body:{save}, prefer:'return=representation'});
      if (!rows.length) return {status:404, body:{error:'Personagem não encontrado'}};
      return {status:200, body:{character: rows[0], shopSold: shopSoldByChar.get(charId) || []}};
    });
    json(res, result.status, result.body); return true;
  } catch (err) {
    console.error('shop_error', err.message, err.status || '', err.detail || '');
    if (!res.headersSent) json(res, err.message==='SUPABASE_NOT_CONFIGURED'?503:500, {error: err.message==='SUPABASE_NOT_CONFIGURED'?'Loja online ainda não configurada no servidor.':'Não foi possível concluir. Tente novamente.'});
    return true;
  }
}

async function handleQuest(req, res, pathname) {
  const m = QUEST_ID_RE.exec(pathname);
  if (!m) return false;
  if (req.method !== 'POST') { json(res,405,{error:'Método não permitido'}); return true; }
  const charId = m[1];
  try {
    const user = await resolveUser(req);
    if (!user) { json(res,401,{error:'Sessão ausente ou expirada'}); return true; }
    const rows0 = await supabase('characters', {query:`?select=lvl,save&id=eq.${encodeURIComponent(charId)}&user_id=eq.${user.id}&limit=1`});
    const row = rows0[0];
    if (!row) { json(res,404,{error:'Personagem não encontrado'}); return true; }
    let lvl = row.lvl;
    const save = sanitizeSave(row.save, lvl);
    const input = await readJson(req);
    const from = Math.round(Number(input.from));
    const reward = QUEST_REWARDS[from];

    if (!reward || save.quest !== from) { json(res,400,{error:'Missão inválida ou já concluída'}); return true; }

    save.gold = Math.min(500000, save.gold + reward.gold);
    save.gem = Math.min(5000, save.gem + reward.gem);
    if (reward.pv) save.pv = Math.min(999, save.pv + reward.pv);
    const leveled = applyXpGain(save, lvl, reward.xp);
    save.xp = leveled.xp; lvl = leveled.lvl;
    save.quest = reward.next;
    save.lvl = lvl;

    const rows = await supabase('characters', {method:'PATCH', query:`?id=eq.${encodeURIComponent(charId)}&user_id=eq.${user.id}`, body:{lvl, save}, prefer:'return=representation'});
    if (!rows.length) { json(res,404,{error:'Personagem não encontrado'}); return true; }
    json(res,200,{character: rows[0]}); return true;
  } catch (err) {
    console.error('quest_error', err.message, err.status || '', err.detail || '');
    if (!res.headersSent) json(res, err.message==='SUPABASE_NOT_CONFIGURED'?503:500, {error: err.message==='SUPABASE_NOT_CONFIGURED'?'Missões online ainda não configuradas no servidor.':'Não foi possível concluir. Tente novamente.'});
    return true;
  }
}

async function handleChest(req, res, pathname) {
  const m = CHEST_ID_RE.exec(pathname);
  if (!m) return false;
  if (req.method !== 'POST') { json(res,405,{error:'Método não permitido'}); return true; }
  const charId = m[1];
  try {
    const user = await resolveUser(req);
    if (!user) { json(res,401,{error:'Sessão ausente ou expirada'}); return true; }
    const input = await readJson(req);
    const result = await withCharLock(charId, async () => {
      const rows0 = await supabase('characters', {query:`?select=lvl,save&id=eq.${encodeURIComponent(charId)}&user_id=eq.${user.id}&limit=1`});
      const row = rows0[0];
      if (!row) return {status:404, body:{error:'Personagem não encontrado'}};
      const lvl = row.lvl;
      const save = sanitizeSave(row.save, lvl);
      const reward = CHEST_REWARDS[String(input.flag || '')];

      if (!reward) return {status:400, body:{error:'Baú inválido'}};
      if (save[reward.field]) return {status:400, body:{error:'Esse baú já foi aberto'}};
      if (save.key < 1) return {status:400, body:{error:'Sem chave'}};

      save.key -= 1;
      save[reward.field] = true;
      save.gold = Math.min(500000, save.gold + reward.gold);
      const item = rollChestItem(save, lvl, reward.tier);

      const rows = await supabase('characters', {method:'PATCH', query:`?id=eq.${encodeURIComponent(charId)}&user_id=eq.${user.id}`, body:{save}, prefer:'return=representation'});
      if (!rows.length) return {status:404, body:{error:'Personagem não encontrado'}};
      return {status:200, body:{character: rows[0], item}};
    });
    json(res, result.status, result.body); return true;
  } catch (err) {
    console.error('chest_error', err.message, err.status || '', err.detail || '');
    if (!res.headersSent) json(res, err.message==='SUPABASE_NOT_CONFIGURED'?503:500, {error: err.message==='SUPABASE_NOT_CONFIGURED'?'Baús online ainda não configurados no servidor.':'Não foi possível concluir. Tente novamente.'});
    return true;
  }
}

// Fase 5.3: aplica uma lista de itens dropados (0..N, hoje sempre 0 ou 1 na
// pratica) contra o save real via grantItem, sem nunca perder um item raro/
// epico/lendario silenciosamente -- se a mochila estiver cheia e nao puder
// auto-equipar, grantItem devolve null e o item e descartado (nunca
// persistido, nunca duplicado, nunca sobrescreve outro slot); aqui isso vira
// `lost` explicito pro cliente poder avisar o jogador (ver kill_reward/
// dungeon_reward abaixo). `granted` guarda o ULTIMO item concedido com
// sucesso (hoje so importa pra toast -- nunca mais de 1 item especial por
// abate, ver rollGearDrop/GEAR_DROP_RATES).
function applyGearDrops(save, lvl, items) {
  let granted = null, lost = null;
  for (const item of items) {
    const result = grantItem(save, lvl, item);
    if (result) granted = result; else lost = item;
  }
  return { granted, lost };
}
// Credita XP + contador de abate real (mob.hp<=0 confirmado em mob_damage)
// direto no personagem no Supabase -- mesma leitura-altera-grava usada em
// handleQuest/handleChest, so que disparada de dentro do WS em vez de uma
// rota HTTP. So roda se a conexao tem charId (personagem) e userId (dono),
// senao nao ha onde persistir (offline ou sem conta) e o calculo local de
// sempre no cliente e o unico que existe, como antes desta fase.
// `drop` (Fase 5.3, opcional): resultado de rollGearDrop ({rarity,type,lv,item})
// pra mob de CAMPO -- null se nao dropou nada.
async function creditKillReward(ws, p, xpGain, fields, loot, bossChestField, questInfo, drop) {
  if (!p.charId || !p.userId) return;
  try {
    await withCharLock(p.charId, async () => {
      const rows0 = await supabase('characters', {query:`?select=lvl,save&id=eq.${encodeURIComponent(p.charId)}&user_id=eq.${encodeURIComponent(p.userId)}&limit=1`});
      const row = rows0[0]; if (!row) return;
      let lvl = row.lvl;
      const save = sanitizeSave(row.save, lvl);
      const leveled = applyXpGain(save, lvl, xpGain);
      save.xp = leveled.xp; lvl = leveled.lvl; save.lvl = lvl;
      for (const f of fields) save[f] = Math.min(999, (save[f] || 0) + 1);
      const pushed = {};
      if (loot) {
        save.gold = Math.min(500000, save.gold + loot.gold);
        save.gem = Math.min(5000, save.gem + loot.gem);
        save.pv = Math.min(999, save.pv + loot.pv);
        save.ap = Math.min(999, save.ap + loot.ap);
        save.scr = Math.min(999, save.scr + loot.scr);
        Object.assign(pushed, { gold: save.gold, gem: save.gem, pv: save.pv, ap: save.ap, scr: save.scr });
      }
      if (bossChestField && !save[bossChestField]) { save.key = Math.min(999, (save.key || 0) + 1); pushed.key = save.key; }
      if (questInfo) Object.assign(pushed, advanceQuestOnKill(save, questInfo.type, questInfo.boss, questInfo.lvl));
      const { granted, lost } = drop ? applyGearDrops(save, lvl, [drop.item]) : { granted: null, lost: null };
      await supabase('characters', {method:'PATCH', query:`?id=eq.${encodeURIComponent(p.charId)}&user_id=eq.${encodeURIComponent(p.userId)}`, body:{lvl, save}, prefer:'return=minimal'});
      const msg = {type:'kill_reward', xp: save.xp, lvl, fields: Object.assign(Object.fromEntries(fields.map(f => [f, save[f]])), pushed)};
      // bag/eq so vao junto quando um item de fato mudou o save (a maioria
      // dos abates nao dropa nada -- nao vale mandar o inventario inteiro
      // toda hora por isso).
      if (granted) { msg.drop = {rarity: granted.rarity, n: granted.n}; msg.bag = save.bag; msg.eq = save.eq; }
      if (lost) msg.dropLost = {rarity: lost.rarity, n: lost.n};
      send(ws, msg);
    });
  } catch (err) {
    console.error('kill_reward_error', err.message, err.status || '', err.detail || '');
  }
}
// Fase 5.2: recompensa de mob/chefe de MASMORRA -- mesmo padrao de leitura-
// altera-grava serializado por personagem, mas separado de
// creditKillReward porque a masmorra (diferente de mapa de campo) concede
// EQUIPAMENTO direto (grantItem) e nunca concede XP (preserva o
// comportamento real de killMob(s.dun) no cliente hoje: só ouro/gema/
// poção/itens, nunca gainXp -- não é uma omissão desta fase, é assim que o
// jogo já funciona). Manda bag/eq inteiros de volta (não só um delta) pro
// cliente poder aplicar igual a applyShopResult. Fase 5.3: `items` agora
// vem de rollGearDrop (rare/epic no trash, legendary no chefe) em vez do
// Basic garantido antigo -- 0 ou 1 item na pratica, ver
// rollDungeonTrashLoot/rollDungeonBossLoot.
async function creditDungeonReward(ws, p, { gold = 0, gem = 0, pv = 0, ap = 0, scr = 0, items = [] } = {}) {
  if (!p.charId || !p.userId) return;
  try {
    await withCharLock(p.charId, async () => {
      const rows0 = await supabase('characters', {query:`?select=lvl,save&id=eq.${encodeURIComponent(p.charId)}&user_id=eq.${encodeURIComponent(p.userId)}&limit=1`});
      const row = rows0[0]; if (!row) return;
      const lvl = row.lvl;
      const save = sanitizeSave(row.save, lvl);
      save.gold = Math.min(500000, save.gold + gold);
      save.gem = Math.min(5000, save.gem + gem);
      save.pv = Math.min(999, save.pv + pv);
      save.ap = Math.min(999, save.ap + ap);
      save.scr = Math.min(999, save.scr + scr);
      const { granted, lost } = applyGearDrops(save, lvl, items);
      await supabase('characters', {method:'PATCH', query:`?id=eq.${encodeURIComponent(p.charId)}&user_id=eq.${encodeURIComponent(p.userId)}`, body:{save}, prefer:'return=minimal'});
      const msg = {type:'dungeon_reward', gold: save.gold, gem: save.gem, pv: save.pv, ap: save.ap, scr: save.scr, bag: save.bag, eq: save.eq};
      if (granted) msg.drop = {rarity: granted.rarity, n: granted.n};
      if (lost) msg.dropLost = {rarity: lost.rarity, n: lost.n};
      send(ws, msg);
    });
  } catch (err) {
    console.error('dungeon_reward_error', err.message, err.status || '', err.detail || '');
  }
}

// accountSockets: userId -> Set<ws> conectados agora (qualquer mapa), para
// status online real de amigos/grupo. Populado no 'join' do WS quando o
// cliente manda um userId de conta online.
const accountSockets = new Map();
function isAccountOnline(userId) { const s = accountSockets.get(userId); return !!s && s.size > 0; }

async function handleFriends(req, res, pathname) {
  if (!pathname.startsWith('/api/friends')) return false;
  try {
    const user = await resolveUser(req);
    if (!user) { json(res,401,{error:'Sessão ausente ou expirada'}); return true; }

    if (pathname === '/api/friends' && req.method === 'GET') {
      const rows = await supabase('friends', {query:`?select=friend_id,users!friend_id(username)&user_id=eq.${user.id}&order=created_at.asc`});
      const friends = rows.map(r => {const u = Array.isArray(r.users) ? r.users[0] : r.users; return {id:r.friend_id, username:u?u.username:'?', online:isAccountOnline(r.friend_id)}});
      json(res,200,{friends}); return true;
    }

    if (pathname === '/api/friends' && req.method === 'POST') {
      const input = await readJson(req);
      const username = String(input.username || '').trim().toLowerCase();
      if (!/^[a-z0-9_]{3,16}$/.test(username)) { json(res,400,{error:'Usuário inválido'}); return true; }
      if (username === user.username) { json(res,400,{error:'Esse é você'}); return true; }
      const found = await supabase('users', {query:`?select=id&username=eq.${encodeURIComponent(username)}&limit=1`});
      if (!found.length) { json(res,404,{error:'Esse usuário não existe'}); return true; }
      const count = await supabase('friends', {query:`?select=friend_id&user_id=eq.${user.id}`});
      if (count.length >= 20) { json(res,400,{error:'Lista cheia (20 amigos)'}); return true; }
      try { await supabase('friends', {method:'POST', body:{user_id:user.id, friend_id:found[0].id}, prefer:'return=minimal'}); }
      catch (e) { if (e.status !== 409) throw e; }
      const rows = await supabase('friends', {query:`?select=friend_id,users!friend_id(username)&user_id=eq.${user.id}&order=created_at.asc`});
      const friends = rows.map(r => {const u = Array.isArray(r.users) ? r.users[0] : r.users; return {id:r.friend_id, username:u?u.username:'?', online:isAccountOnline(r.friend_id)}});
      json(res,201,{friends}); return true;
    }

    const delMatch = /^\/api\/friends\/([a-z0-9_]{3,16})$/i.exec(pathname);
    if (delMatch && req.method === 'DELETE') {
      const username = delMatch[1].toLowerCase();
      const found = await supabase('users', {query:`?select=id&username=eq.${encodeURIComponent(username)}&limit=1`});
      if (found.length) await supabase('friends', {method:'DELETE', query:`?user_id=eq.${user.id}&friend_id=eq.${found[0].id}`, prefer:'return=minimal'});
      const rows = await supabase('friends', {query:`?select=friend_id,users!friend_id(username)&user_id=eq.${user.id}&order=created_at.asc`});
      const friends = rows.map(r => {const u = Array.isArray(r.users) ? r.users[0] : r.users; return {id:r.friend_id, username:u?u.username:'?', online:isAccountOnline(r.friend_id)}});
      json(res,200,{friends}); return true;
    }

    json(res,405,{error:'Método não permitido'}); return true;
  } catch (err) {
    console.error('friends_error', err.message, err.status || '', err.detail || '');
    if (!res.headersSent) json(res, err.message==='SUPABASE_NOT_CONFIGURED'?503:500, {error: err.message==='SUPABASE_NOT_CONFIGURED'?'Amigos online ainda não configurado no servidor.':'Não foi possível concluir. Tente novamente.'});
    return true;
  }
}

// Grupos sao efemeros (nao sobrevivem a um restart do servidor), como a
// autoridade de monstros por mapa - por isso ficam so em memoria, sem tabela.
const parties = new Map(); // code -> {ownerId, members: Map<userId, username>}
const memberParty = new Map(); // userId -> code
const PARTY_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genPartyCode() { let c = ''; for (let i = 0; i < 6; i++) c += PARTY_CODE_CHARS[Math.floor(Math.random() * PARTY_CODE_CHARS.length)]; return c; }
function partyView(code) {
  const p = parties.get(code); if (!p) return null;
  return {code, ownerId: p.ownerId, members: [...p.members.entries()].map(([id, username]) => ({id, username, online: isAccountOnline(id)}))};
}
function leaveParty(userId) {
  const code = memberParty.get(userId); if (!code) return;
  const p = parties.get(code);
  if (p) { p.members.delete(userId); if (!p.members.size) parties.delete(code); else if (p.ownerId === userId) p.ownerId = [...p.members.keys()][0]; }
  memberParty.delete(userId);
}

async function handleParty(req, res, pathname) {
  if (!pathname.startsWith('/api/party')) return false;
  try {
    const user = await resolveUser(req);
    if (!user) { json(res,401,{error:'Sessão ausente ou expirada'}); return true; }

    if (pathname === '/api/party' && req.method === 'GET') {
      const code = memberParty.get(user.id);
      json(res,200,{party: code ? partyView(code) : null}); return true;
    }
    if (pathname === '/api/party' && req.method === 'POST') {
      leaveParty(user.id);
      let code; do { code = genPartyCode(); } while (parties.has(code));
      parties.set(code, {ownerId: user.id, members: new Map([[user.id, user.username]])});
      memberParty.set(user.id, code);
      json(res,201,{party: partyView(code)}); return true;
    }
    if (pathname === '/api/party/join' && req.method === 'POST') {
      const input = await readJson(req);
      const code = cleanText(input.code, 8).toUpperCase();
      const p = parties.get(code);
      if (!p) { json(res,404,{error:'Código inválido'}); return true; }
      if (p.members.size >= 4 && !p.members.has(user.id)) { json(res,400,{error:'Grupo cheio'}); return true; }
      leaveParty(user.id);
      p.members.set(user.id, user.username); memberParty.set(user.id, code);
      json(res,200,{party: partyView(code)}); return true;
    }
    if (pathname === '/api/party/leave' && req.method === 'POST') {
      leaveParty(user.id);
      json(res,200,{ok:true}); return true;
    }
    json(res,405,{error:'Método não permitido'}); return true;
  } catch (err) {
    console.error('party_error', err.message);
    if (!res.headersSent) json(res,500,{error:'Não foi possível concluir. Tente novamente.'});
    return true;
  }
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload, except) {
  const data = JSON.stringify(payload);
  for (const ws of clients.keys()) if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(data);
}

function playersOnMap(map) {
  return [...clients.entries()].filter(([,p]) => p.map === map);
}

function broadcastMap(map, payload) {
  const data=JSON.stringify(payload);
  for(const [ws,p] of clients) if(p.map===map&&ws.readyState===WebSocket.OPEN) ws.send(data);
}

function mapState(id) {
  let state=maps.get(id);
  if(!state){state={id,mobs:new Map(),hitGuard:new Map(),pvpGuard:new Map()};maps.set(id,state)}
  return state;
}

// ===== Fase 5.2: instancia de masmorra server-side =====
// Timeout de limpeza: 30min sem nenhum jogador presente OU 2h de vida
// total, o que vier primeiro (ver dungeonCleanupTick). Numeros escolhidos
// pra sobrar folga de reconexao (queda de internet, F5 sem querer) sem
// deixar instancia abandonada consumindo memoria indefinidamente.
const DUNGEON_IDLE_MS = 30 * 60 * 1000, DUNGEON_MAX_LIFE_MS = 2 * 60 * 60 * 1000;
// Cria uma instancia NOVA e isolada (mapa proprio, so o dono ve) -- hoje a
// masmorra e solo (nenhum fluxo real de party dentro dela existia antes
// desta fase, so o roster global compartilhado por engano, ver
// LEIA-PRIMEIRO.md), entao so o personagem que entrou fica em `members`.
// O campo existe assim (Set, nao um unico id) de proposito pra nao
// precisar mudar a forma de novo quando a masmorra em grupo for
// implementada numa fase futura.
function createDungeonInstance(zone, ownerCharId, ownerUserId) {
  const cfg = DUNGEON_CFG[zone];
  if (!cfg) return null;
  const seed = crypto.randomInt(1, 2147483647); // servidor escolhe -- cliente nunca influencia o layout/loot
  const layout = DUNGEON_GEN.dungeonLayout(seed);
  const instanceId = crypto.randomBytes(4).toString('hex');
  const mapId = zone + '_d#' + instanceId;
  const state = mapState(mapId);
  Object.assign(state, {
    isDungeon: true, zone, seed, layout, ownerCharId, ownerUserId,
    members: new Set([ownerCharId]), bossDefeated: false, bossId: null,
    createdAt: Date.now(), lastActiveAt: Date.now(),
  });
  const rnd = DUNGEON_GEN.mulberry(seed + 1); // stream de RNG proprio do roster, independente da forma do labirinto
  const { mz, ox, oy, cols, rows } = layout;
  let idx = 0;
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    if ((cx === mz.sx && cy === mz.sy) || (cx === mz.bx && cy === mz.by)) continue;
    if (rnd() >= .72) continue;
    const n = 1 + (rnd() < .4 ? 1 : 0);
    const center = DUNGEON_GEN.cellCenter(cx, cy, ox, oy);
    for (let k = 0; k < n; k++) {
      const pick = cfg.trash(rnd);
      const stats = mobStats(pick.type, pick.lvl, false, pick.k);
      if (!stats) continue;
      const jx = center.x + (rnd() - .5) * 70, jy = center.y + (rnd() - .5) * 70;
      const id = mapId + ':' + (idx++);
      state.mobs.set(id, {id,maxhp:stats.hp,hp:stats.hp,dead:false,x:jx,y:jy,sx:jx,sy:jy,state:'idle',respawnAt:0,boss:false,type:pick.type,lvl:pick.lvl,k:pick.k,dun:true,wallRects:layout.rects});
    }
  }
  const bp = cfg.boss, bstats = mobStats(bp.type, bp.lvl, true, bp.k), bossHp = bstats ? Math.round(bstats.hp * 3) : 1000;
  const bossId = mapId + ':boss', bc = layout.boss;
  state.mobs.set(bossId, {id:bossId,maxhp:bossHp,hp:bossHp,dead:false,x:bc.x,y:bc.y,sx:bc.x,sy:bc.y,state:'idle',respawnAt:0,boss:true,type:bp.type,lvl:bp.lvl,k:bp.k,dun:true,wallRects:layout.rects});
  state.bossId = bossId;
  return state;
}
// Instancias que o personagem (charId) ja possui, por zona -- pra
// reconexao/revisita reusar a MESMA instancia (mob morto continua morto)
// em vez de gerar uma nova toda hora que o WS cai e volta.
const dungeonByOwner = new Map(); // charId -> Map<zone, mapId>
function ownedDungeonInstance(charId, zone) {
  const mapId = dungeonByOwner.get(charId)?.get(zone);
  if (!mapId) return null;
  const state = maps.get(mapId);
  return state && state.isDungeon ? state : null;
}
function rememberDungeonInstance(charId, zone, mapId) {
  if (!dungeonByOwner.has(charId)) dungeonByOwner.set(charId, new Map());
  dungeonByOwner.get(charId).set(zone, mapId);
}
// Remove instancias sem ninguem presente ha muito tempo, ou velhas demais
// mesmo com gente dentro (nao deixa uma instancia viver pra sempre so
// porque alguem ficou parado la). Roda junto do resto da limpeza
// periodica do servidor (ver setInterval no fim do arquivo).
function dungeonCleanupTick() {
  const now = Date.now();
  for (const [mapId, state] of maps) {
    if (!state.isDungeon) continue;
    const present = playersOnMap(mapId).length;
    if (present > 0) { state.lastActiveAt = now; continue; }
    const idleFor = now - state.lastActiveAt, ageFor = now - state.createdAt;
    if (idleFor > DUNGEON_IDLE_MS || ageFor > DUNGEON_MAX_LIFE_MS) {
      maps.delete(mapId);
      const owned = dungeonByOwner.get(state.ownerCharId);
      if (owned && owned.get(state.zone) === mapId) owned.delete(state.zone);
    }
  }
}

function publicPlayer(player) {
  return {id:player.id,name:player.name,cls:player.cls,map:player.map,x:player.x,y:player.y,dir:player.dir,moving:player.moving,lvl:player.lvl,atkT:player.atkT||0,atkAng:player.atkAng||0};
}

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (await handleAuth(req, res, pathname)) return;
  if (await handleShop(req, res, pathname)) return;
  if (await handleQuest(req, res, pathname)) return;
  if (await handleChest(req, res, pathname)) return;
  if (await handleCharacters(req, res, pathname)) return;
  if (await handleFriends(req, res, pathname)) return;
  if (await handleParty(req, res, pathname)) return;
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type':MIME[path.extname(file).toLowerCase()] || 'application/octet-stream','Cache-Control':'no-cache'});
    fs.createReadStream(file).pipe(res);
  });
});

const wss = new WebSocketServer({ server, path: '/game' });
// Busca o personagem real (cls/lvl) direto no Supabase pra autenticar o
// 'join' do WebSocket (Fase 5.2) -- so retorna linha se o charId realmente
// pertence ao userId ja autenticado por token (mesmo filtro id+user_id que
// handleCharacters usa). Nunca confia em cls/lvl que o cliente reivindica.
async function resolveCharacterForWs(userId, charId) {
  if (!userId || !charId) return null;
  try {
    const rows = await supabase('characters', {query:`?select=id,cls,lvl&id=eq.${encodeURIComponent(charId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`});
    return rows[0] || null;
  } catch { return null; }
}
// Conexoes com um 'join' em andamento (aguardando resolveUserByToken/
// resolveCharacterForWs) -- evita que duas mensagens 'join' na mesma
// conexao (antes da primeira terminar) disparem autenticacao concorrente
// e criem dois `p` diferentes pro mesmo socket.
const joining = new Set();
// Autentica o 'join': com token de sessao valido, userId vem do banco
// (nunca do que o cliente manda); com token+charId validos E o charId
// pertencendo de fato aquele userId, cls/lvl tambem vem do banco --
// fecha a brecha historica de userId/charId/cls/lvl serem "autoridade
// do cliente" (Fase 5.2, Parte 1). Sem token (visita anonima/offline),
// mantem o comportamento de sempre: presenca multiplayer efemera, sem
// nenhuma operacao economica possivel (todas exigem p.userId+p.charId
// reais, ver creditKillReward/handleShop/etc).
async function handleWsJoin(ws, msg) {
  if (clients.get(ws) || joining.has(ws)) return;
  joining.add(ws);
  try {
    const token = typeof msg.token === 'string' ? msg.token.slice(0, 512) : '';
    let userId = null, charRow = null;
    if (token) {
      // Supabase fora do ar/nao configurado nunca pode derrubar a conexao
      // WS inteira -- degrada pra visita anonima (mesmo comportamento de
      // "sem token"), do mesmo jeito que o resto do jogo ja faz sem conta
      // online configurada.
      try {
        const user = await resolveUserByToken(token);
        if (user) {
          userId = user.id;
          const claimedCharId = typeof msg.charId === 'string' && /^[0-9a-fA-F-]{8,36}$/.test(msg.charId) ? msg.charId : null;
          if (claimedCharId) charRow = await resolveCharacterForWs(userId, claimedCharId);
        }
      } catch (err) { console.error('ws_join_auth_error', err.message); userId = null; charRow = null; }
    }
    if (clients.get(ws)) return; // ja tratado por outra mensagem enquanto este join aguardava o Supabase
    const p = {
      id: crypto.randomUUID(), userId, charId: charRow ? charRow.id : null,
      name: cleanText(msg.name, 14) || 'Herói',
      cls: charRow ? (ALLOWED_CLASS.has(charRow.cls) ? charRow.cls : 'guerreiro') : (ALLOWED_CLASS.has(msg.cls) ? msg.cls : 'guerreiro'),
      lvl: charRow ? Math.max(1, Math.min(99, Number(charRow.lvl) || 1)) : Math.max(1, Math.min(99, Number(msg.lvl) || 1)),
      authed: !!charRow, map: 'vila', x: 720, y: 1258, dir: 0, moving: false, atkT: 0, atkAng: 0,
    };
    clients.set(ws, p);
    if (userId) { if (!accountSockets.has(userId)) accountSockets.set(userId, new Set()); accountSockets.get(userId).add(ws); }
    send(ws, {type:'welcome', id:p.id, players:[...clients.values()].filter(x=>x!==p).map(publicPlayer)});
    broadcast({type:'player_join', player:publicPlayer(p)}, ws);
  } finally { joining.delete(ws); }
}
// Mesmo limiar de desbloqueio de PORTAL_DESTS[].ok() no cliente
// (P.quest>=N || P.gunlock[zona]) -- espelhado aqui pra validar a entrada
// na masmorra no servidor, nunca so pelo botao do cliente estar habilitado.
const DUNGEON_UNLOCK_QUEST = { floresta: 3, cripta: 7, serra: 11, pantano: 15, torre: 19, ilhas: 23, vulcao: 27 };
// Fase 5.2, Parte "MAPA/ENTRADA/SAIDA": entrada em masmorra agora e um
// pedido explicito ao servidor, nunca so o cliente chamando travel('X_d')
// local. Valida sessao (p.authed), confere o requisito real (quest OU
// portal comprado, lido do banco -- nunca do que o cliente reivindica) e
// so entao cria/reusa a instancia e muda p.map pra ela.
async function handleDungeonEnter(ws, p, msg) {
  const zone = cleanText(msg.zone, 16);
  const cfg = DUNGEON_CFG[zone];
  if (!cfg) { send(ws, {type:'dungeon_error', error:'Masmorra inválida'}); return; }
  if (!p.authed || !p.userId || !p.charId) { send(ws, {type:'dungeon_error', error:'Entre com uma conta online para acessar masmorras'}); return; }
  try {
    const rows = await supabase('characters', {query:`?select=save&id=eq.${encodeURIComponent(p.charId)}&user_id=eq.${encodeURIComponent(p.userId)}&limit=1`});
    const row = rows[0];
    if (!row) { send(ws, {type:'dungeon_error', error:'Personagem não encontrado'}); return; }
    const save = sanitizeSave(row.save, p.lvl);
    const unlocked = save.quest >= (DUNGEON_UNLOCK_QUEST[zone] || 999) || !!save.gunlock[zone];
    if (!unlocked) { send(ws, {type:'dungeon_error', error:'Região ainda não liberada'}); return; }
    let state = ownedDungeonInstance(p.charId, zone);
    if (!state) {
      state = createDungeonInstance(zone, p.charId, p.userId);
      rememberDungeonInstance(p.charId, zone, state.id);
    }
    state.lastActiveAt = Date.now();
    p.map = state.id;
    const roster = [...state.mobs.values()].map(m => ({id:m.id, type:m.type, lvl:m.lvl, k:m.k, boss:!!m.boss, x:Math.round(m.x), y:Math.round(m.y), maxhp:m.maxhp, hp:m.hp, dead:!!m.dead}));
    send(ws, {type:'dungeon_state', map:state.id, zone, seed:state.seed, start:state.layout.start, roster, bossDefeated:state.bossDefeated});
  } catch (err) {
    console.error('dungeon_enter_error', err.message, err.status || '', err.detail || '');
    send(ws, {type:'dungeon_error', error:'Não foi possível entrar na masmorra. Tente novamente.'});
  }
}
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', async raw => {
    if (raw.length > 65536) return ws.close(1009, 'Mensagem grande demais');
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    let p = clients.get(ws);
    if (msg.type === 'join' && !p) { await handleWsJoin(ws, msg); return; }
    if (!p) return;
    if (msg.type === 'state') {
      const map = cleanText(msg.map,24);
      if (!ALLOWED_MAP.test(map)) return;
      // Instancia de masmorra (`_d#id`): so pode "continuar" na que o
      // proprio dungeon_enter ja colocou o personagem (p.map) -- nunca
      // trocar pra outra instancia, nem pra `_d` sem instancia, so
      // reportando a posicao. Isso fecha a brecha de mandar
      // map:"vulcao_d" (ou a instancia de outro personagem) direto por
      // uma mensagem 'state' sem passar pela validacao de requisito em
      // handleDungeonEnter.
      if (DUNGEON_MAP_RE.test(map) && map !== p.map) return;
      const x = Number(msg.x), y = Number(msg.y);
      if (!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>2880||y>2112) return;
      const atkT=Math.max(0,Math.min(.4,Number(msg.atkT)||0)),atkAng=Number(msg.atkAng)||0;
      // Personagem autenticado (charId real, ver handleWsJoin): nivel so
      // muda pelo que o proprio servidor ja sabe (kill_reward/quest/PUT),
      // nunca pelo que essa mensagem periodica reivindica -- sem isso um
      // cliente adulterado podia inflar p.lvl e, por tabela, o dano
      // calculado em resolveAttackDamage (baseDmgOf usa p.lvl).
      const lvl = p.authed ? p.lvl : Math.max(1,Math.min(99,Number(msg.lvl)||1));
      Object.assign(p,{map,x,y,dir:Math.max(0,Math.min(3,Number(msg.dir)|0)),moving:!!msg.moving,lvl,atkT,atkAng:Math.max(-Math.PI*2,Math.min(Math.PI*2,atkAng))});
      broadcast({type:'state',player:publicPlayer(p)},ws);
    } else if (msg.type === 'dungeon_enter') {
      await handleDungeonEnter(ws, p, msg);
    } else if (msg.type === 'map_join') {
      const map=cleanText(msg.map,24);if(!ALLOWED_MAP.test(map)||map!==p.map)return;
      const state=mapState(map),defs=Array.isArray(msg.mobs)?msg.mobs.slice(0,120):[];
      const manifest=MOB_MANIFEST[map];
      // Masmorra (state.isDungeon): roster ja foi gerado inteiro pelo
      // servidor em handleDungeonEnter/createDungeonInstance no momento da
      // entrada -- nunca aceita nada de `defs` aqui, so devolve o que ja
      // existe (map_join de masmorra so serve pra reconciliar apos
      // reconexao).
      if(!state.mobs.size&&!state.isDungeon){
        if(manifest){
          // roster autoritativo: tipo/nivel/contagem vem do manifesto real
          // do mapa (espelha os packs literais de buildFloresta/buildCripta/...
          // em index.html), nunca do que o cliente reivindica -- so id/x/y
          // (cosmeticos, nunca usados pra conceder nada) vem do def do
          // cliente, casado por posicao com o manifesto (mesma ordem de
          // insercao em MOBS: pacotes primeiro, chefe, depois sequitos).
          manifest.forEach((entry,i)=>{
            const d=defs[i]||{};
            const id=cleanText(d.id,48)||(map+':'+i);
            const stats=mobStats(entry.type,entry.lvl,entry.boss,entry.k);
            if(!stats)return;
            const maxhp=entry.type==='cinza'?cinzaSpawnHp(entry.lvl):stats.hp;
            const ex=Number(d.x)||0,ey=Number(d.y)||0;
            state.mobs.set(id,{id,maxhp,hp:maxhp,dead:!!entry.temp,x:ex,y:ey,sx:ex,sy:ey,state:'idle',respawnAt:0,boss:!!entry.boss,type:entry.type,lvl:entry.lvl,k:entry.k,temp:!!entry.temp});
          });
        } else if(map==='vila'){
          // vila (slime): sem array literal pra espelhar sem portar o
          // tilemap inteiro (posicao/nivel vem de amostragem por rejeicao
          // contra blocked()) -- valida so contagem (<=15) e nivel (1..3),
          // hp sempre recalculado a partir do nivel real, nunca aceito do
          // cliente.
          for(const d of defs.slice(0,15)){
            const id=cleanText(d.id,48);if(!id)continue;
            const lvl=Math.max(1,Math.min(3,Math.round(Number(d.lvl))||1));
            const stats=mobStats('slime',lvl,false);
            if(!stats)continue;
            const sx=Number(d.x)||0,sy=Number(d.y)||0;
            state.mobs.set(id,{id,maxhp:stats.hp,hp:stats.hp,dead:false,x:sx,y:sy,sx,sy,state:'idle',respawnAt:0,boss:false,type:'slime',lvl});
          }
        }
      }
      send(ws,{type:'map_state',map,mobs:[...state.mobs.values()]});
    } else if (msg.type === 'cast_skill') {
      const map=cleanText(msg.map,24);if(map!==p.map)return;
      const id=cleanText(msg.id,16),sk=Math.max(1,Math.min(3,Math.round(Number(msg.sk))||1)),atk=clampAtk(msg.atk);
      if(!(CLASS_SKILLS[p.cls]||[]).includes(id))return;
      const now=Date.now();
      p.skillCd=p.skillCd||{};
      if(now<(p.skillCd[id]||0))return;
      p.skillCd[id]=now+(SKILL_CD_MS[id]||1000);
      if(id==='warcry'){p.buffUntil=now+(6+2*(sk-1))*1000;p.buffAtk=.3+.1*(sk-1)}
      if(DAMAGE_SKILLS.has(id)){
        p.pendingSkill=p.pendingSkill||{};
        p.pendingSkill[id]={dmg:Math.round(skBaseOf(p,atk)*skillDamageMul(id,sk)),expiresAt:now+(id==='thorns'?4000:2000)};
      }
    } else if (msg.type === 'mob_damage') {
      const map=cleanText(msg.map,24),state=maps.get(map);if(!state||map!==p.map)return;
      const mobId=cleanText(msg.id,48),mob=state.mobs.get(mobId);
      if(!mob||mob.dead)return;
      // alcance plausivel: usa a posicao real do jogador (rastreada via
      // 'state') e a posicao do monstro simulada pelo servidor para rejeitar
      // um golpe em algo longe demais pra
      // qualquer ataque do jogo (o maior caso real e a Flecha Perfurante,
      // que viaja ate ~476; roots/thorns podem mirar ate 320 de distancia
      // + 90 de raio).
      if(Math.hypot(mob.x-p.x,mob.y-p.y)>550)return;
      // anti-spam por (jogador,monstro): bloqueia macro/cliente adulterado
      // batendo no mesmo alvo rapido demais.
      const now=Date.now(),guard=state.hitGuard.get(mobId);
      if(guard&&guard.playerId===p.id&&now-guard.at<80)return;
      const dmg=resolveAttackDamage(p,msg,now);
      if(!dmg)return;
      state.hitGuard.set(mobId,{playerId:p.id,at:now});
      mob.hp=Math.max(0,mob.hp-dmg);
      if(mob.hp<=0){
        mob.dead=true;
        // Mob de masmorra nunca respawna dentro da instancia (mesmo
        // comportamento de s.respawn=1e9 no cliente) -- so os de mapa de
        // campo usam o setInterval de respawn (respawnAt truthy).
        mob.respawnAt=state.isDungeon?0:Date.now()+(mob.boss?60000:30000);
        if(state.isDungeon){
          // Masmorra: nunca concede XP (preserva o comportamento real de
          // killMob(s.dun) hoje -- só ouro/gema/poção/item), chefe só
          // recompensa uma vez (mob.dead sincrono antes de qualquer await
          // ja evita reentrancia pro MESMO mob; state.bossDefeated é uma
          // segunda trava explicita, mais facil de auditar/testar).
          if(mob.boss&&!state.bossDefeated){
            state.bossDefeated=true;
            creditDungeonReward(ws,p,rollDungeonBossLoot(p.cls,mob.lvl));
          }else if(!mob.boss){
            creditDungeonReward(ws,p,rollDungeonTrashLoot(mob.lvl,p.cls));
          }
        }else if(mob.type){
          const stats=mobStats(mob.type,mob.lvl,mob.boss,mob.k);
          if(stats){
            const xpGain=mob.temp?Math.round(stats.xp*.5):stats.xp;
            const loot=mob.temp?null:rollMobLoot(mob.type,mob.boss,mob.lvl);
            const bossChestField=mob.boss?BOSS_CHEST_FIELD[mob.type]:null;
            const questInfo=mob.temp?null:{type:mob.type,boss:mob.boss,lvl:mob.lvl};
            // Fase 5.3: mob de CAMPO tambem participa da politica de raridade
            // (mesma rollGearDrop de masmorra) -- so segue nunca dropando
            // pra sequitos temporarios (mob.temp), igual o loot economico ja
            // fazia (loot fica null acima pelo mesmo motivo).
            const drop=mob.temp?null:rollGearDrop({mobLevel:mob.lvl,boss:!!mob.boss,cls:p.cls});
            creditKillReward(ws,p,xpGain,killCounterFields(mob.type,mob.lvl,mob.boss),loot,bossChestField,questInfo,drop);
          }
        }
      }
      broadcastMap(map,{type:'mob_state',map,mob,killerId:mob.dead?p.id:null});
    } else if (msg.type === 'player_damage') {
      // PvP: liberado fora da vila. O servidor nunca rastreia o HP do
      // defensor -- reaproveita a mesma validacao de dano/cooldown do PvE
      // (resolveAttackDamage) e manda o dano bruto pro alvo, que aplica a
      // propria mitigacao (defesa/bloqueio/escudo) localmente, exatamente
      // como ja faz contra ataques de monstro (hurtPlayer no cliente).
      const map=cleanText(msg.map,24);if(map!==p.map||map==='vila')return;
      const targetId=cleanText(msg.targetId,64);if(!targetId||targetId===p.id)return;
      let target=null;for(const other of clients.values())if(other.id===targetId&&other.map===map){target=other;break}
      if(!target)return;
      if(p.userId&&target.userId){const pc=memberParty.get(p.userId),tc=memberParty.get(target.userId);if(pc&&pc===tc)return}
      if(Math.hypot(target.x-p.x,target.y-p.y)>550)return;
      const state=mapState(map);
      const now=Date.now(),gk=p.id+'>'+targetId,lastHit=state.pvpGuard.get(gk);
      if(lastHit&&now-lastHit<80)return;
      const dmg=resolveAttackDamage(p,msg,now);
      if(!dmg)return;
      state.pvpGuard.set(gk,now);
      broadcastMap(map,{type:'player_hit',map,targetId,attackerId:p.id,attackerName:p.name,dmg});
    } else if (msg.type === 'projectile') {
      const map=cleanText(msg.map,24),id=cleanText(msg.id,64),kind=cleanText(msg.kind,12);
      if(map!==p.map||!ALLOWED_MAP.test(map)||!id||!['arrow','bolt','leaf','fire'].includes(kind))return;
      const x=Number(msg.x),y=Number(msg.y),vx=Number(msg.vx),vy=Number(msg.vy),life=Math.max(.05,Math.min(2,Number(msg.life)||.5));
      if(![x,y,vx,vy].every(Number.isFinite)||Math.hypot(vx,vy)>900)return;
      broadcastMap(map,{type:'projectile',map,ownerId:p.id,projectile:{id,kind,x,y,vx,vy,life,r:Math.max(3,Math.min(14,Number(msg.r)||7)),pierce:!!msg.pierce}});
    } else if (msg.type === 'projectile_end') {
      const map=cleanText(msg.map,24),id=cleanText(msg.id,64);if(map!==p.map||!id)return;
      broadcastMap(map,{type:'projectile_end',map,ownerId:p.id,id,x:Number(msg.x)||0,y:Number(msg.y)||0,boom:!!msg.boom});
    } else if (msg.type === 'chat') {
      const text=cleanText(msg.text,160);if(text)broadcast({type:'chat',from:p.name,text,at:Date.now()});
    }
  });
  ws.on('close', () => { const p=clients.get(ws);if(p){clients.delete(ws);if(p.userId){const s=accountSockets.get(p.userId);if(s){s.delete(ws);if(!s.size)accountSockets.delete(p.userId)}}broadcast({type:'player_leave',id:p.id})} });
});

// .unref() nos 3 setInterval deste arquivo (aqui, tickMobAI e o ping de WS
// mais abaixo): nao muda nada rodando como servidor de verdade (o processo
// continua vivo pelos listeners HTTP/WS reais) -- so permite que `require
// ('./server.js')` num teste unitario puro (sem nunca chamar server.listen,
// ver o guard require.main===module no fim do arquivo) saia sozinho quando
// os testes terminam, em vez de ficar pendurado por causa desses timers.
setInterval(()=>{
  const now=Date.now();
  for(const state of maps.values())for(const mob of state.mobs.values())if(mob.dead&&mob.respawnAt&&now>=mob.respawnAt){mob.dead=false;mob.hp=mob.maxhp;mob.respawnAt=0;mob.x=Number.isFinite(mob.sx)?mob.sx:(Number(mob.x)||0);mob.y=Number.isFinite(mob.sy)?mob.sy:(Number(mob.y)||0);mob.state='idle';mob.tgt=null;mob.cd=0;mob.ret=0;mob.t=0;mob.hit=false;broadcastMap(state.id,{type:'mob_state',map:state.id,mob,killerId:null})}
  dungeonCleanupTick();
},1000).unref();

// ===== Fase 2 (unidade 1): IA de slime no servidor =====
// Espelha updSlime() do cliente (index.html) -- unico tipo sem maquina de
// estado (so perseguicao direta + dano por contato), escolhido como
// primeira unidade por ser o mais simples dos 12 tipos. So roda pra mapas
// nao-masmorra (fora do escopo do roster, ver Fase 1). Sem dado de colisao
// de terreno no servidor -- movimento nao respeita parede ainda (limite
// documentado em LEIA-PRIMEIRO.md, nao escondido).
const SLIME_TILE = 48; // = T no cliente (index.html)
// Acha o jogador vivo (na pratica: presente no mapa -- servidor nao rastreia
// morte de jogador) mais proximo de um monstro, dentre os presentes no mapa.
function nearestPlayer(mob, present) {
  let best = null, bd = Infinity;
  for (const pair of present) { const d = Math.hypot(pair[1].x - mob.x, pair[1].y - mob.y); if (d < bd) { bd = d; best = pair; } }
  return best ? { ws: best[0], p: best[1], d: bd } : null;
}
const MOB_TARGET_LOCK_STATES = new Set(['wind','wind2','dash','slam','pounce','swoop','spit','blink','cast','gust','heal','leap','charge','meteor','recover']);
function targetPlayer(mob, present) {
  const locked = mob.tgt ? present.find(pair => pair[1].id === mob.tgt) : null;
  if (locked) return locked;
  if (mob.tgt && MOB_TARGET_LOCK_STATES.has(mob.state)) return null;
  mob.tgt = null;
  const near = nearestPlayer(mob, present), target = near ? [near.ws, near.p] : null;
  if (target && mob.state === 'chase') mob.tgt = target[1].id;
  return target;
}
const MOB_WORLD_W = 2880, MOB_WORLD_H = 2112, MOB_MAX_STEP = 32, MOB_HALF_W = 14, MOB_HALF_H = 10;
// So usado por mob de masmorra (mob.wallRects, atribuido na criacao da
// instancia -- ver createDungeonInstance): AABB contra as paredes reais do
// labirinto (mesma geometria que o cliente desenha, derivada do mesmo
// seed via dungeonLayout). Mob de mapa de campo nunca tem wallRects, entao
// o comportamento de sempre (sem colisao de terreno, limitação já
// documentada) continua intacto.
function rectsBlock(rects, x, y, hw, hh) {
  for (const r of rects) if (x - hw < r.x + r.w && x + hw > r.x && y - hh < r.y + r.h && y + hh > r.y) return true;
  return false;
}
function moveMob(mob, dx, dy) {
  dx = Number(dx); dy = Number(dy);
  if (!Number.isFinite(mob.x) || !Number.isFinite(mob.y) || !Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  const len = Math.hypot(dx, dy), scale = len > MOB_MAX_STEP ? MOB_MAX_STEP / len : 1;
  dx *= scale; dy *= scale;
  // Camada minima server-side pra mapa de campo: limites do mundo e
  // aplicacao separada por eixo. A geometria de paredes de mapa de campo
  // ainda vive so no cliente (fora do escopo desta fase, ver
  // LEIA-PRIMEIRO.md) -- so masmorra (mob.wallRects) tem colisao real.
  const nx = Math.max(0, Math.min(MOB_WORLD_W, mob.x + dx));
  const ny = Math.max(0, Math.min(MOB_WORLD_H, mob.y + dy));
  if (mob.wallRects) {
    if (!rectsBlock(mob.wallRects, nx, ny, MOB_HALF_W, MOB_HALF_H)) { mob.x = nx; mob.y = ny; return true; }
    // desliza pelos eixos separadamente em vez de travar total contra a parede
    if (!rectsBlock(mob.wallRects, nx, mob.y, MOB_HALF_W, MOB_HALF_H)) mob.x = nx;
    if (!rectsBlock(mob.wallRects, mob.x, ny, MOB_HALF_W, MOB_HALF_H)) mob.y = ny;
    return true;
  }
  mob.x = nx; mob.y = ny;
  return true;
}
function settleAtSpawn(mob) {
  if (!Number.isFinite(mob.sx) || !Number.isFinite(mob.sy)) return false;
  mob.x = mob.sx; mob.y = mob.sy; mob.state = 'idle'; mob.tgt = null; mob.hp = mob.maxhp;
  return true;
}
// Cada steperX(mob,dt,present) atualiza um monstro por tick e devolve
// {x,y,state} pra broadcast; espelha exatamente a updX() correspondente do
// cliente (index.html). Dispatcher/loop principal fica em tickMobAI().
function stepSlime(mob, dt, present) {
  if (!Number.isFinite(mob.sx)) return null;
  const near = nearestPlayer(mob, present);
  mob.cd = Math.max(0, (mob.cd || 0) - dt);
  mob.anim = (mob.anim || 0) + dt;
  const home = Math.hypot(mob.x - mob.sx, mob.y - mob.sy);
  let tx, ty, spd;
  if (near && near.d < 140 && home < 300 && mob.x > 29 * SLIME_TILE) { tx = near.p.x; ty = near.p.y; spd = 62; mob.state = 'chase'; }
  else {
    mob.wt = (mob.wt || 0) - dt;
    if (home > 150) { tx = mob.sx; ty = mob.sy; spd = 40; mob.state = 'return'; }
    else {
      if (mob.wt <= 0) { mob.wt = 2 + Math.random() * 3; const a = Math.random() * 6.28, r = Math.random() * 90; mob.tx = mob.sx + Math.cos(a) * r; mob.ty = mob.sy + Math.sin(a) * r; }
      tx = mob.tx; ty = mob.ty; spd = 28; mob.state = 'idle';
    }
  }
  const ddx = (tx ?? mob.x) - mob.x, ddy = (ty ?? mob.y) - mob.y, dd = Math.hypot(ddx, ddy);
  if (dd > 6) {
    const hop = Math.max(0, Math.sin(mob.anim * 7)) * spd * dt * 1.7;
    const dx = ddx / dd * hop, dy = ddy / dd * hop;
    moveMob(mob, mob.x + dx > 29.4 * SLIME_TILE ? dx : 0, dy);
  }
  if (near && near.d < 30 && mob.cd <= 0) {
    mob.cd = 1.1;
    const stats = mobStats('slime', mob.lvl, false);
    if (stats) send(near.ws, { type: 'mob_hit', map: mob.map, mobId: mob.id, dmg: stats.dmg });
  }
  return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state };
}
// Espelha updGoblin() -- o padrao "canonico" idle/chase/wind(telegraph)/
// resolve(dash ou slam em area, chefe)/recover/return que a maioria dos
// outros 11 tipos reusa com pequenas variacoes numericas. mob.tgt guarda o
// id do jogador travado como alvo ao entrar em chase/wind/dash, pra nao
// trocar de alvo no meio de um ataque ja telegrafado.
function stepGoblin(mob, dt, present) {
  if (!Number.isFinite(mob.sx)) return null;
  mob.cd = Math.max(0, (mob.cd || 0) - dt);
  mob.ret = Math.max(0, (mob.ret || 0) - dt);
  const st = mobStats('goblin', mob.lvl, mob.boss);
  if (!st) return null;
  const target = targetPlayer(mob, present);
  const tp = target ? target[1] : null;
  const dx = tp ? tp.x - mob.x : 0, dy = tp ? tp.y - mob.y : 0, d = tp ? (Math.hypot(dx, dy) || 1) : Infinity;
  const home = Math.hypot(mob.x - mob.sx, mob.y - mob.sy);
  const step = (tx, ty, spd) => {
    const ddx = tx - mob.x, ddy = ty - mob.y, dd = Math.hypot(ddx, ddy);
    if (dd < 4) return;
    moveMob(mob, ddx / dd * spd * dt, ddy / dd * spd * dt);
  };
  switch (mob.state) {
    case 'idle': default: {
      if (tp && mob.ret <= 0 && d < (mob.boss ? 210 : 150) && home < 460) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; break; }
      mob.wt = (mob.wt || 0) - dt;
      if (mob.wt <= 0) { mob.wt = 2 + Math.random() * 3; const a = Math.random() * 6.28, r = Math.random() * 70; mob.tx = mob.sx + Math.cos(a) * r; mob.ty = mob.sy + Math.sin(a) * r; }
      step(mob.tx ?? mob.sx, mob.ty ?? mob.sy, 24);
      break;
    }
    case 'chase':
      if (!tp || d > 320 || home > 500) { mob.state = 'return'; mob.ret = 3; mob.tgt = null; break; }
      if (d < (mob.boss ? 92 : 72) && mob.cd <= 0) {
        mob.lx = dx / d; mob.ly = dy / d;
        mob.atk = (mob.boss && Math.random() < .5) ? 'slam' : 'dash';
        mob.t = mob.atk === 'slam' ? .95 : (mob.boss ? .55 : .65);
        mob.state = 'wind'; mob.hit = false;
        break;
      }
      if (d < 52) step(mob.x - dx, mob.y - dy, 42); else if (d >= (mob.boss ? 92 : 72)) step(tp.x, tp.y, mob.boss ? 60 : 78);
      break;
    case 'wind':
      mob.t -= dt;
      if (mob.t <= 0) {
        if (mob.atk === 'dash') { mob.state = 'dash'; mob.t = mob.boss ? .3 : .24; }
        else {
          if (target && Math.hypot(target[1].x - mob.x, (target[1].y - mob.y) * 1.15) < 80) send(target[0], { type: 'mob_hit', map: mob.map, mobId: mob.id, dmg: Math.round(st.dmg * 1.15) });
          mob.state = 'recover'; mob.t = 1.1; mob.cd = 1.6;
        }
      }
      break;
    case 'dash': {
      mob.t -= dt;
      moveMob(mob, mob.lx * 470 * dt, mob.ly * 470 * dt);
      if (target && !mob.hit && Math.hypot(target[1].x - mob.x, target[1].y - mob.y) < 34) { mob.hit = true; send(target[0], { type: 'mob_hit', map: mob.map, mobId: mob.id, dmg: st.dmg }); }
      if (mob.t <= 0) { mob.state = 'recover'; mob.t = mob.boss ? .75 : 1; mob.cd = 1.3; }
      break;
    }
    case 'recover':
      mob.t -= dt; if (mob.t <= 0) mob.state = 'chase';
      break;
    case 'return':
      step(mob.sx, mob.sy, 92); mob.hp = Math.min(mob.maxhp, mob.hp + dt * 40);
      if (home < 14) settleAtSpawn(mob);
      if (tp && mob.ret <= 0 && d < 110) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
      break;
  }
  return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state };
}
// Helper compartilhado: manda o dano bruto pro alvo (o cliente aplica
// mitigacao via hurtPlayer(), igual PvP). delayedHit imita o tempo de voo
// de um projetil (enemyShot no cliente) sem replicar visualmente o projetil
// em si -- so preserva a janela de esquiva por tempo, nao a trajetoria.
function hitTarget(target, mob, dmg) { if (target) send(target[0], { type: 'mob_hit', map: mob.map, mobId: mob.id, dmg: Math.round(dmg) }); }
function delayedHit(target, mob, dmg, delayMs) { if (target) setTimeout(() => send(target[0], { type: 'mob_hit', map: mob.map, mobId: mob.id, dmg: Math.round(dmg) }), delayMs); }

// ===== Fase 2, unidades 3-12: os 10 tipos restantes =====
// Todas seguem o mesmo padrao de stepGoblin (mob.tgt trava o alvo ao entrar
// em chase/wind). Escopo desta rodada, documentado em LEIA-PRIMEIRO.md:
// porta posicao/estado/agressao/ataque PRIMARIO de cada tipo (o que fecha a
// exposicao real a dano, o achado central da auditoria da Fase 2). Fica
// deliberadamente de fora -- mesmo padrao ja aceito pra raiz/lentidao desde
// a Fase 1/PvP: efeitos de status (sangramento/veneno/queimadura como dano
// continuo), cura de aliado, teleporte/blink, empurrao de nocaute, revivencia
// de sequitos de chefe (mesma limitacao ja documentada), poca/tornado
// persistente (HAZ), e o "uivo" de matilha do lobo. Nenhum desses e
// simulado localmente quando NET esta conectado (client-side so anima).

function stepSkeleton(mob, dt, present) {
  if (!Number.isFinite(mob.sx)) return null;
  mob.cd = Math.max(0, (mob.cd || 0) - dt); mob.ret = Math.max(0, (mob.ret || 0) - dt);
  const st = mobStats('skeleton', mob.lvl, mob.boss); if (!st) return null;
  const target = targetPlayer(mob, present);
  const tp = target ? target[1] : null;
  const dx = tp ? tp.x - mob.x : 0, dy = tp ? tp.y - mob.y : 0, d = tp ? (Math.hypot(dx, dy) || 1) : Infinity, toP = Math.atan2(dy, dx);
  const home = Math.hypot(mob.x - mob.sx, mob.y - mob.sy);
  const step = (tx, ty, spd) => { const ddx = tx - mob.x, ddy = ty - mob.y, dd = Math.hypot(ddx, ddy); if (dd < 4) return; moveMob(mob, ddx / dd * spd * dt, ddy / dd * spd * dt); };
  switch (mob.state) {
    case 'idle': default:
      if (tp && mob.ret <= 0 && d < (mob.boss ? 230 : 160) && home < 480) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; break; }
      mob.wt = (mob.wt || 0) - dt;
      if (mob.wt <= 0) { mob.wt = 2 + Math.random() * 3; const a = Math.random() * 6.28, r = Math.random() * 70; mob.tx = mob.sx + Math.cos(a) * r; mob.ty = mob.sy + Math.sin(a) * r; }
      step(mob.tx ?? mob.sx, mob.ty ?? mob.sy, 20);
      break;
    case 'chase':
      if (!tp || d > 340 || home > 520) { mob.state = 'return'; mob.ret = 3; mob.tgt = null; break; }
      if (d < 66 && mob.cd <= 0) { mob.la = toP; mob.cmb = (mob.boss || mob.lvl >= 13) ? 2 : 1; mob.state = 'wind'; mob.t = mob.boss ? .6 : .65; break; }
      if (d >= 56) step(tp.x, tp.y, mob.boss ? 56 : 62);
      break;
    case 'wind':
      mob.t -= dt;
      if (mob.t <= 0) {
        if (target && d < 84) { let da = Math.abs(toP - mob.la); if (da > Math.PI) da = 2 * Math.PI - da; if (da < .95) hitTarget(target, mob, st.dmg); }
        mob.cmb--;
        if (mob.cmb > 0) { mob.state = 'wind'; mob.t = .42; mob.la = toP; }
        else { mob.state = 'recover'; mob.t = .75; mob.cd = 1.1; }
      }
      break;
    case 'guard':
      mob.t -= dt; if (!tp || mob.t <= 0) mob.state = 'chase';
      break;
    case 'recover':
      mob.t -= dt; if (mob.t <= 0) mob.state = Math.random() < .55 ? 'guard' : 'chase'; if (mob.state === 'guard') mob.t = mob.boss ? 1.1 : 1.4;
      break;
    case 'return':
      step(mob.sx, mob.sy, 90); mob.hp = Math.min(mob.maxhp, mob.hp + dt * 45);
      if (home < 14) settleAtSpawn(mob);
      if (tp && mob.ret <= 0 && d < 110) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
      break;
  }
  return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state };
}

function stepWolf(mob, dt, present) {
  if (!Number.isFinite(mob.sx)) return null;
  mob.cd = Math.max(0, (mob.cd || 0) - dt); mob.ret = Math.max(0, (mob.ret || 0) - dt);
  if (mob.boss && !mob.enr && mob.hp < mob.maxhp * .4) mob.enr = true;
  const st = mobStats('wolf', mob.lvl, mob.boss); if (!st) return null;
  const sm = mob.enr ? 1.2 : 1;
  const target = targetPlayer(mob, present);
  const tp = target ? target[1] : null;
  const dx = tp ? tp.x - mob.x : 0, dy = tp ? tp.y - mob.y : 0, d = tp ? (Math.hypot(dx, dy) || 1) : Infinity;
  const home = Math.hypot(mob.x - mob.sx, mob.y - mob.sy);
  const step = (tx, ty, spd) => { const ddx = tx - mob.x, ddy = ty - mob.y, dd = Math.hypot(ddx, ddy); if (dd < 4) return; moveMob(mob, ddx / dd * spd * dt * sm, ddy / dd * spd * dt * sm); };
  switch (mob.state) {
    case 'idle': default:
      if (tp && mob.ret <= 0 && d < (mob.boss ? 260 : 190) && home < 520) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; break; }
      mob.wt = (mob.wt || 0) - dt;
      if (mob.wt <= 0) { mob.wt = 2 + Math.random() * 3; const a = Math.random() * 6.28, r = Math.random() * 80; mob.tx = mob.sx + Math.cos(a) * r; mob.ty = mob.sy + Math.sin(a) * r; }
      step(mob.tx ?? mob.sx, mob.ty ?? mob.sy, 30);
      break;
    case 'chase':
      if (!tp || d > 400 || home > 580) { mob.state = 'return'; mob.ret = 3; mob.tgt = null; break; }
      if (mob.cd <= 0 && d < 185) { mob.lx = dx / d; mob.ly = dy / d; mob.hit = false; mob.cmb = mob.enr ? 2 : 1; mob.state = 'wind'; mob.t = mob.boss ? .45 : .55; break; }
      step(tp.x, tp.y, mob.cd > 0 && d < 210 ? 118 : 108);
      break;
    case 'wind':
      mob.t -= dt; if (mob.t <= 0) { mob.state = 'pounce'; mob.t = .28; }
      break;
    case 'pounce': {
      mob.t -= dt; const sp = mob.boss ? 600 : 540; moveMob(mob, mob.lx * sp * dt, mob.ly * sp * dt);
      if (target && !mob.hit && Math.hypot(target[1].x - mob.x, target[1].y - mob.y) < 38) { mob.hit = true; hitTarget(target, mob, st.dmg); }
      if (mob.t <= 0) {
        mob.cmb--;
        if (mob.cmb > 0 && tp) { mob.state = 'wind'; mob.t = .35; mob.lx = dx / d; mob.ly = dy / d; mob.hit = false; }
        else { mob.state = 'recover'; mob.t = mob.boss ? .7 : 1; mob.cd = mob.boss ? .9 : 1.5 + Math.random() * .8; }
      }
      break;
    }
    case 'recover':
      mob.t -= dt; if (mob.t <= 0) mob.state = 'chase';
      break;
    case 'return':
      step(mob.sx, mob.sy, 110); mob.hp = Math.min(mob.maxhp, mob.hp + dt * 50);
      if (home < 14) settleAtSpawn(mob);
      if (tp && mob.ret <= 0 && d < 120) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
      break;
  }
  return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state };
}

// stepBat/stepCinza compartilham o padrao "voador" (flyTo direto, sem
// esquiva senoidal -- simplificacao visual documentada). dmgFn(st,lvl)
// calcula o dano de contato (cinza usa a formula de sala*.7, nao a propria).
function stepFlyer(mob, dt, present, type, statsFor, dmgOf, leech) {
  if (!Number.isFinite(mob.sx)) return null;
  mob.cd = Math.max(0, (mob.cd || 0) - dt);
  mob.ret = Math.max(0, (mob.ret || 0) - dt);
  const st = statsFor(mob); if (!st) return null;
  const target = targetPlayer(mob, present);
  const tp = target ? target[1] : null;
  const dx = tp ? tp.x - mob.x : 0, dy = tp ? tp.y - mob.y : 0, d = tp ? (Math.hypot(dx, dy) || 1) : Infinity;
  const home = Math.hypot(mob.x - mob.sx, mob.y - mob.sy);
  const fly = (tx, ty, spd) => { const ddx = tx - mob.x, ddy = ty - mob.y, dd = Math.hypot(ddx, ddy); if (dd < 3) return; moveMob(mob, ddx / dd * spd * dt, ddy / dd * spd * dt); };
  switch (mob.state) {
    case 'idle': default:
      if (tp && mob.ret <= 0 && d < 200 && home < 520) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; break; }
      mob.wt = (mob.wt || 0) - dt;
      if (mob.wt <= 0) { mob.wt = 2 + Math.random() * 3; const a = Math.random() * 6.28, r = Math.random() * 60; mob.tx = mob.sx + Math.cos(a) * r; mob.ty = mob.sy + Math.sin(a) * r; }
      fly(mob.tx ?? mob.sx, mob.ty ?? mob.sy, 36);
      break;
    case 'chase':
      if (!tp || d > 430 || home > 640) { mob.state = 'return'; mob.ret = 3; mob.tgt = null; break; }
      fly(tp.x, tp.y, d > 170 ? 150 : 115);
      if (mob.cd <= 0 && d < 240 && d > 50) { mob.lx = dx / d; mob.ly = dy / d; mob.hit = false; mob.state = 'wind'; mob.t = .45; }
      break;
    case 'wind':
      mob.t -= dt; if (mob.t <= 0) { mob.state = 'swoop'; mob.t = .3; }
      break;
    case 'swoop': {
      mob.t -= dt; moveMob(mob, mob.lx * 440 * dt, mob.ly * 440 * dt);
      if (target && !mob.hit && Math.hypot(target[1].x - mob.x, target[1].y - mob.y) < 38) {
        mob.hit = true; const dmg = dmgOf(st, mob.lvl); hitTarget(target, mob, dmg);
        if (leech) mob.hp = Math.min(mob.maxhp, mob.hp + Math.round(dmg * .5));
      }
      if (mob.t <= 0) { mob.state = 'recover'; mob.t = 1.1; mob.cd = 1.4 + Math.random() * .8; }
      break;
    }
    case 'recover':
      mob.t -= dt; if (mob.t <= 0) mob.state = 'chase';
      break;
    case 'return':
      fly(mob.sx, mob.sy, 120); mob.hp = Math.min(mob.maxhp, mob.hp + dt * 50);
      if (home < 14) settleAtSpawn(mob);
      if (tp && mob.ret <= 0 && d < 130) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
      break;
  }
  return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state };
}
function stepBat(mob, dt, present) { return stepFlyer(mob, dt, present, 'bat', m => mobStats('bat', m.lvl, false), st => st.dmg, true); }
function stepCinza(mob, dt, present) { return stepFlyer(mob, dt, present, 'cinza', m => mobStats('sala', m.lvl, false), (st, lvl) => st.dmg * .7, false); }

function stepToxic(mob, dt, present) {
  if (!Number.isFinite(mob.sx)) return null;
  mob.cd = Math.max(0, (mob.cd || 0) - dt); mob.ret = Math.max(0, (mob.ret || 0) - dt);
  const st = mobStats('toxic', mob.lvl, mob.boss); if (!st) return null;
  const target = targetPlayer(mob, present);
  const tp = target ? target[1] : null;
  const dx = tp ? tp.x - mob.x : 0, dy = tp ? tp.y - mob.y : 0, d = tp ? (Math.hypot(dx, dy) || 1) : Infinity;
  const home = Math.hypot(mob.x - mob.sx, mob.y - mob.sy);
  const step = (tx, ty, spd) => { const ddx = tx - mob.x, ddy = ty - mob.y, dd = Math.hypot(ddx, ddy); if (dd < 6) return; moveMob(mob, ddx / dd * spd * dt, ddy / dd * spd * dt); };
  if (!mob.boss) {
    if (tp && d < 230 && home < 420) step(tp.x, tp.y, 52);
    else {
      mob.wt = (mob.wt || 0) - dt;
      if (home > 150) step(mob.sx, mob.sy, 40);
      else { if (mob.wt <= 0) { mob.wt = 2 + Math.random() * 3; const a = Math.random() * 6.28, r = Math.random() * 90; mob.tx = mob.sx + Math.cos(a) * r; mob.ty = mob.sy + Math.sin(a) * r; } step(mob.tx ?? mob.sx, mob.ty ?? mob.sy, 28); }
    }
    if (target && d < 24 && mob.cd <= 0) { mob.cd = 1.3; hitTarget(target, mob, st.dmg); }
    return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: tp && d < 230 ? 'chase' : 'idle' };
  }
  switch (mob.state) {
    case 'idle': default:
      if (tp && mob.ret <= 0 && d < 280 && home < 520) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
      break;
    case 'chase':
      if (!tp || d > 440 || home > 600) { mob.state = 'return'; mob.ret = 3; mob.tgt = null; break; }
      if (mob.cd <= 0 && d < 270) { mob.tx = tp.x; mob.ty = tp.y; mob.state = 'wind'; mob.t = .95; break; }
      step(tp.x, tp.y, 46);
      break;
    case 'wind':
      mob.t -= dt; if (mob.t <= 0) { mob.state = 'leap'; mob.t = .5; mob.lx = ((mob.tx ?? mob.x) - mob.x) / .5; mob.ly = ((mob.ty ?? mob.y) - mob.y) / .5; }
      break;
    case 'leap':
      mob.t -= dt; moveMob(mob, mob.lx * dt, mob.ly * dt);
      if (mob.t <= 0) {
        if (target && Math.hypot(target[1].x - mob.x, (target[1].y - mob.y) * 1.3) < 105) hitTarget(target, mob, st.dmg);
        mob.state = 'recover'; mob.t = 1.2; mob.cd = 2;
      }
      break;
    case 'recover':
      mob.t -= dt; if (mob.t <= 0) mob.state = 'chase';
      break;
    case 'return':
      step(mob.sx, mob.sy, 80); mob.hp = Math.min(mob.maxhp, mob.hp + dt * 80);
      if (home < 16) settleAtSpawn(mob);
      if (tp && mob.ret <= 0 && d < 130) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
      break;
  }
  return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state };
}

// Caster (regular e chefe "Feiticeiro Sombrio"): so o ataque a distancia
// basico (wind->bolt com atraso simulando tempo de voo) pros dois. O chefe
// fica sem barreira/absorcao, chuva de area, blink e invocacao de acolitos
// nesta rodada -- boss caster ainda ataca de verdade (fecha o "modo deus"),
// mas com um moveset reduzido ao golpe basico, nao o completo.
function stepCaster(mob, dt, present) {
  if (!Number.isFinite(mob.sx)) return null;
  mob.cd = Math.max(0, (mob.cd || 0) - dt); mob.ret = Math.max(0, (mob.ret || 0) - dt);
  const st = mobStats('caster', mob.lvl, mob.boss); if (!st) return null;
  const target = targetPlayer(mob, present);
  const tp = target ? target[1] : null;
  const dx = tp ? tp.x - mob.x : 0, dy = tp ? tp.y - mob.y : 0, d = tp ? (Math.hypot(dx, dy) || 1) : Infinity;
  const home = Math.hypot(mob.x - mob.sx, mob.y - mob.sy);
  const aggroR = mob.boss ? 320 : 260, giveD = mob.boss ? 520 : 470, giveH = mob.boss ? 640 : 650, atkR = mob.boss ? 430 : 320, spd = mob.boss ? 80 : 72;
  const step = (tx, ty, sp) => { const ddx = tx - mob.x, ddy = ty - mob.y, dd = Math.hypot(ddx, ddy); if (dd < 4) return; moveMob(mob, ddx / dd * sp * dt, ddy / dd * sp * dt); };
  switch (mob.state) {
    case 'idle': default:
      if (tp && mob.ret <= 0 && d < aggroR && home < 520) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; break; }
      mob.wt = (mob.wt || 0) - dt;
      if (mob.wt <= 0) { mob.wt = 2 + Math.random() * 3; const a = Math.random() * 6.28, r = Math.random() * 70; mob.tx = mob.sx + Math.cos(a) * r; mob.ty = mob.sy + Math.sin(a) * r; }
      step(mob.tx ?? mob.sx, mob.ty ?? mob.sy, 22);
      break;
    case 'chase':
      if (!tp || d > giveD || home > giveH) { mob.state = 'return'; mob.ret = 3; mob.tgt = null; break; }
      if (mob.cd <= 0 && d < atkR && d > 60) { mob.la = Math.atan2(dy, dx); mob.state = 'wind'; mob.t = mob.boss ? .6 : .5; break; }
      if (d < 150) step(mob.x - dx / d * 100, mob.y - dy / d * 100, spd); else if (d > 250) step(tp.x, tp.y, spd);
      break;
    case 'wind':
      mob.t -= dt;
      if (mob.t <= 0) {
        const dist = target ? Math.hypot(target[1].x - mob.x, target[1].y - mob.y) : 400;
        delayedHit(target, mob, st.dmg, Math.min(1500, dist / 300 * 1000));
        mob.state = 'recover'; mob.t = .5; mob.cd = mob.boss ? .8 : 1.5 + Math.random() * .7;
      }
      break;
    case 'recover':
      mob.t -= dt; if (mob.t <= 0) mob.state = 'chase';
      break;
    case 'return':
      step(mob.sx, mob.sy, mob.boss ? 110 : 90); mob.hp = Math.min(mob.maxhp, mob.hp + dt * (mob.boss ? 90 : 60));
      if (home < (mob.boss ? 16 : 14)) settleAtSpawn(mob);
      if (tp && mob.ret <= 0 && d < (mob.boss ? 140 : 130)) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
      break;
  }
  return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state };
}

// Sky: 4 subtipos (k). h=cacador (ranged), s=xama (gust em area, cura de
// aliado fora de escopo), g=guardiao (investida), b=chefe "Senhora das
// Tempestades" (gust + "chuva" simplificada num unico ponto -- tornado
// persistente fora de escopo).
function stepSky(mob, dt, present) {
  if (!Number.isFinite(mob.sx)) return null;
  mob.cd = Math.max(0, (mob.cd || 0) - dt); mob.ret = Math.max(0, (mob.ret || 0) - dt);
  const st = mobStats('sky', mob.lvl, mob.boss, mob.k); if (!st) return null;
  const target = targetPlayer(mob, present);
  const tp = target ? target[1] : null;
  const dx = tp ? tp.x - mob.x : 0, dy = tp ? tp.y - mob.y : 0, d = tp ? (Math.hypot(dx, dy) || 1) : Infinity, toP = Math.atan2(dy, dx);
  const home = Math.hypot(mob.x - mob.sx, mob.y - mob.sy);
  const step = (tx, ty, spd) => { const ddx = tx - mob.x, ddy = ty - mob.y, dd = Math.hypot(ddx, ddy); if (dd < 4) return; moveMob(mob, ddx / dd * spd * dt, ddy / dd * spd * dt); };
  if (mob.state === 'idle' || !mob.state) {
    if (tp && mob.ret <= 0 && d < (mob.boss ? 340 : 280) && home < 560) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
    else {
      mob.wt = (mob.wt || 0) - dt;
      if (mob.wt <= 0) { mob.wt = 2 + Math.random() * 3; const a = Math.random() * 6.28, r = Math.random() * 70; mob.tx = mob.sx + Math.cos(a) * r; mob.ty = mob.sy + Math.sin(a) * r; }
      step(mob.tx ?? mob.sx, mob.ty ?? mob.sy, 22);
    }
    return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state || 'idle' };
  }
  if (mob.state === 'return') {
    step(mob.sx, mob.sy, 100); mob.hp = Math.min(mob.maxhp, mob.hp + dt * (mob.boss ? 120 : 70));
    if (home < 14) settleAtSpawn(mob);
    if (tp && mob.ret <= 0 && d < 130) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
    return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state };
  }
  if (!tp || d > 540 || home > 700) { mob.state = 'return'; mob.ret = 3; mob.tgt = null; return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state }; }
  const away = spd => step(mob.x - dx / d * 100, mob.y - dy / d * 100, spd), toward = spd => step(tp.x, tp.y, spd);
  if (mob.k === 'h') {
    switch (mob.state) {
      case 'chase':
        if (mob.cd <= 0 && d < 390 && d > 70) { mob.la = toP; mob.state = 'wind'; mob.t = .5; break; }
        if (d < 170) away(90); else if (d > 310) toward(80);
        break;
      case 'wind':
        mob.t -= dt; if (mob.t <= 0) { delayedHit(target, mob, st.dmg, Math.min(1400, d / 430 * 1000)); mob.state = 'recover'; mob.t = .5; mob.cd = 1.7 + Math.random() * .6; }
        break;
      case 'recover': default: mob.t -= dt; if (mob.t <= 0) mob.state = 'chase'; break;
    }
  } else if (mob.k === 's') {
    switch (mob.state) {
      case 'chase':
        if (mob.tGust === undefined) mob.tGust = 0; mob.tGust -= dt;
        if (mob.tGust <= 0 && d < 210) { mob.la = toP; mob.state = 'gust'; mob.t = .7; mob.tGust = 6; break; }
        if (d < 170) away(75); else if (d > 270) toward(75);
        break;
      case 'gust':
        mob.t -= dt;
        if (mob.t <= 0) { let da = Math.abs(toP - mob.la); if (da > Math.PI) da = 2 * Math.PI - da; if (d < 210 && da < .65) hitTarget(target, mob, st.dmg * .6); mob.state = 'recover'; mob.t = .6; }
        break;
      case 'recover': default: mob.t -= dt; if (mob.t <= 0) mob.state = 'chase'; break;
    }
  } else if (mob.k === 'g') {
    switch (mob.state) {
      case 'chase':
        if (mob.cd <= 0 && d < 230 && d > 50) { mob.lx = dx / d; mob.ly = dy / d; mob.hit = false; mob.state = 'wind'; mob.t = .75; break; }
        if (d > 60) toward(72);
        break;
      case 'wind':
        mob.t -= dt; if (mob.t <= 0) { mob.state = 'charge'; mob.t = .42; }
        break;
      case 'charge':
        mob.t -= dt; moveMob(mob, mob.lx * 520 * dt, mob.ly * 520 * dt);
        if (target && !mob.hit && Math.hypot(target[1].x - mob.x, target[1].y - mob.y) < 42) { mob.hit = true; hitTarget(target, mob, st.dmg); }
        if (mob.t <= 0) { mob.state = 'recover'; mob.t = 1; mob.cd = 2.2; }
        break;
      case 'recover': default: mob.t -= dt; if (mob.t <= 0) mob.state = 'chase'; break;
    }
  } else {
    switch (mob.state) {
      case 'chase':
        if (mob.tRain === undefined) mob.tRain = 0; if (mob.tGust === undefined) mob.tGust = 3;
        mob.tRain -= dt; mob.tGust -= dt;
        if (mob.tRain <= 0) { mob.state = 'rain'; mob.t = 1.1; mob.tRain = 10; delayedHit(target, mob, st.dmg * .9, 950); break; }
        if (mob.tGust <= 0 && d < 240) { mob.la = toP; mob.state = 'gust'; mob.t = .8; mob.tGust = 9; break; }
        if (d < 200) away(80); else if (d > 300) toward(80);
        break;
      case 'gust':
        mob.t -= dt;
        if (mob.t <= 0) { let da = Math.abs(toP - mob.la); if (da > Math.PI) da = 2 * Math.PI - da; if (d < 260 && da < .75) hitTarget(target, mob, st.dmg * .7); mob.state = 'recover'; mob.t = .6; }
        break;
      case 'rain': case 'recover': default: mob.t -= dt; if (mob.t <= 0) mob.state = 'chase'; break;
    }
  }
  return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state };
}

function stepSala(mob, dt, present) {
  if (!Number.isFinite(mob.sx)) return null;
  mob.cd = Math.max(0, (mob.cd || 0) - dt); mob.ret = Math.max(0, (mob.ret || 0) - dt);
  if (!mob.enr && mob.hp < mob.maxhp * .4) mob.enr = true;
  const st = mobStats('sala', mob.lvl, false); if (!st) return null;
  const target = targetPlayer(mob, present);
  const tp = target ? target[1] : null;
  const dx = tp ? tp.x - mob.x : 0, dy = tp ? tp.y - mob.y : 0, d = tp ? (Math.hypot(dx, dy) || 1) : Infinity, toP = Math.atan2(dy, dx);
  const home = Math.hypot(mob.x - mob.sx, mob.y - mob.sy);
  const step = (tx, ty, spd) => { const ddx = tx - mob.x, ddy = ty - mob.y, dd = Math.hypot(ddx, ddy); if (dd < 4) return; moveMob(mob, ddx / dd * spd * dt, ddy / dd * spd * dt); };
  switch (mob.state) {
    case 'idle': default:
      if (tp && mob.ret <= 0 && d < 190 && home < 480) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; break; }
      mob.wt = (mob.wt || 0) - dt;
      if (mob.wt <= 0) { mob.wt = 2 + Math.random() * 3; const a = Math.random() * 6.28, r = Math.random() * 70; mob.tx = mob.sx + Math.cos(a) * r; mob.ty = mob.sy + Math.sin(a) * r; }
      step(mob.tx ?? mob.sx, mob.ty ?? mob.sy, 26);
      break;
    case 'chase':
      if (!tp || d > 420 || home > 560) { mob.state = 'return'; mob.ret = 3; mob.tgt = null; break; }
      if (mob.cd <= 0 && d < 62) { mob.hit = false; mob.state = 'wind'; mob.t = .4; break; }
      if (mob.cd <= 0 && d < 220 && d > 110 && Math.random() < .4) { mob.la = toP; mob.state = 'breath'; mob.t = .75; mob.cd = 3; break; }
      step(tp.x, tp.y, mob.enr ? 150 : 98);
      break;
    case 'wind':
      mob.t -= dt;
      if (mob.t <= 0) { if (target && !mob.hit && Math.hypot(target[1].x - mob.x, target[1].y - mob.y) < 74) { mob.hit = true; hitTarget(target, mob, st.dmg); } mob.state = 'recover'; mob.t = .5; mob.cd = 1.1 + Math.random() * .6; }
      break;
    case 'breath':
      mob.t -= dt;
      if (mob.t <= 0) {
        if (target && d < 190) { let da = Math.abs(toP - mob.la); if (da > Math.PI) da = 2 * Math.PI - da; if (da < .5) hitTarget(target, mob, st.dmg * .7); }
        mob.state = 'recover'; mob.t = .5; mob.cd = 1.4;
      }
      break;
    case 'recover':
      mob.t -= dt; if (mob.t <= 0) mob.state = 'chase';
      break;
    case 'return':
      step(mob.sx, mob.sy, 110); mob.hp = Math.min(mob.maxhp, mob.hp + dt * 50);
      if (home < 14) { settleAtSpawn(mob); mob.enr = false; }
      if (tp && mob.ret <= 0 && d < 120) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
      break;
  }
  return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state };
}

function stepElem(mob, dt, present) {
  if (!Number.isFinite(mob.sx)) return null;
  mob.cd = Math.max(0, (mob.cd || 0) - dt); mob.ret = Math.max(0, (mob.ret || 0) - dt);
  const st = mobStats('elem', mob.lvl, false); if (!st) return null;
  const target = targetPlayer(mob, present);
  const tp = target ? target[1] : null;
  const dx = tp ? tp.x - mob.x : 0, dy = tp ? tp.y - mob.y : 0, d = tp ? (Math.hypot(dx, dy) || 1) : Infinity;
  const home = Math.hypot(mob.x - mob.sx, mob.y - mob.sy);
  const step = (tx, ty, spd) => { const ddx = tx - mob.x, ddy = ty - mob.y, dd = Math.hypot(ddx, ddy); if (dd < 4) return; moveMob(mob, ddx / dd * spd * dt, ddy / dd * spd * dt); };
  switch (mob.state) {
    case 'idle': default:
      if (tp && mob.ret <= 0 && d < 170 && home < 440) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
      break;
    case 'chase':
      if (!tp || d > 380 || home > 520) { mob.state = 'return'; mob.ret = 3; mob.tgt = null; break; }
      if (mob.cd <= 0 && d < 66) { mob.state = 'wind'; mob.t = .9; break; }
      step(tp.x, tp.y, 44);
      break;
    case 'wind':
      mob.t -= dt; if (mob.t <= 0) { mob.state = 'slam'; mob.t = .2; }
      break;
    case 'slam':
      mob.t -= dt;
      if (mob.t <= 0) {
        if (target && Math.hypot(target[1].x - mob.x, (target[1].y - mob.y) * 1.2) < 66) hitTarget(target, mob, st.dmg);
        mob.state = 'recover'; mob.t = 1.3; mob.cd = 2.2;
      }
      break;
    case 'recover':
      mob.t -= dt; if (mob.t <= 0) mob.state = 'chase';
      break;
    case 'return':
      step(mob.sx, mob.sy, 70); mob.hp = Math.min(mob.maxhp, mob.hp + dt * 70);
      if (home < 14) settleAtSpawn(mob);
      if (tp && mob.ret <= 0 && d < 120) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
      break;
  }
  return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state };
}

function stepCalc(mob, dt, present) {
  if (!Number.isFinite(mob.sx)) return null;
  mob.cd = Math.max(0, (mob.cd || 0) - dt); mob.ret = Math.max(0, (mob.ret || 0) - dt);
  const st = mobStats('calc', mob.lvl, false); if (!st) return null;
  const target = targetPlayer(mob, present);
  const tp = target ? target[1] : null;
  const dx = tp ? tp.x - mob.x : 0, dy = tp ? tp.y - mob.y : 0, d = tp ? (Math.hypot(dx, dy) || 1) : Infinity, toP = Math.atan2(dy, dx);
  const home = Math.hypot(mob.x - mob.sx, mob.y - mob.sy);
  const step = (tx, ty, spd) => { const ddx = tx - mob.x, ddy = ty - mob.y, dd = Math.hypot(ddx, ddy); if (dd < 4) return; moveMob(mob, ddx / dd * spd * dt, ddy / dd * spd * dt); };
  switch (mob.state) {
    case 'idle': default:
      if (tp && mob.ret <= 0 && d < 170 && home < 480) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; break; }
      mob.wt = (mob.wt || 0) - dt;
      if (mob.wt <= 0) { mob.wt = 2 + Math.random() * 3; const a = Math.random() * 6.28, r = Math.random() * 70; mob.tx = mob.sx + Math.cos(a) * r; mob.ty = mob.sy + Math.sin(a) * r; }
      step(mob.tx ?? mob.sx, mob.ty ?? mob.sy, 20);
      break;
    case 'chase':
      if (!tp || d > 340 || home > 520) { mob.state = 'return'; mob.ret = 3; mob.tgt = null; break; }
      if (d < 66 && mob.cd <= 0) { mob.la = toP; mob.cmb = 1; mob.state = 'wind'; mob.t = .65; break; }
      if (d >= 56) step(tp.x, tp.y, 62);
      break;
    case 'wind':
      mob.t -= dt;
      if (mob.t <= 0) {
        if (target && d < 84) { let da = Math.abs(toP - mob.la); if (da > Math.PI) da = 2 * Math.PI - da; if (da < .95) hitTarget(target, mob, st.dmg); }
        mob.cmb--;
        if (mob.cmb > 0) { mob.state = 'wind'; mob.t = .42; mob.la = toP; }
        else { mob.state = 'recover'; mob.t = .75; mob.cd = 1.1; }
      }
      break;
    case 'guard':
      mob.t -= dt; if (!tp || mob.t <= 0) mob.state = 'chase';
      break;
    case 'recover':
      mob.t -= dt; if (mob.t <= 0) { mob.state = Math.random() < .55 ? 'guard' : 'chase'; if (mob.state === 'guard') mob.t = 1.4; }
      break;
    case 'return':
      step(mob.sx, mob.sy, 90); mob.hp = Math.min(mob.maxhp, mob.hp + dt * 45);
      if (home < 14) settleAtSpawn(mob);
      if (tp && mob.ret <= 0 && d < 110) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
      break;
  }
  return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state };
}

// Lorde (Senhor das Chamas, chefe final): nunca reaparece (respawnAt fica
// 0, mesma regra do cliente -- s.dead nunca reverte). Invocacao de
// salamandras fora de escopo (revivencia de sequito).
function stepLorde(mob, dt, present) {
  if (!Number.isFinite(mob.sx)) return null;
  mob.cd = Math.max(0, (mob.cd || 0) - dt); mob.ret = Math.max(0, (mob.ret || 0) - dt);
  const st = mobStats('lorde', mob.lvl, true); if (!st) return null;
  if (!mob.enr && mob.hp < mob.maxhp * .25) mob.enr = true;
  mob.tMet = (mob.tMet === undefined ? 0 : mob.tMet) - dt;
  mob.tSlam = (mob.tSlam === undefined ? 3 : mob.tSlam) - dt;
  const target = targetPlayer(mob, present);
  const tp = target ? target[1] : null;
  const dx = tp ? tp.x - mob.x : 0, dy = tp ? tp.y - mob.y : 0, d = tp ? (Math.hypot(dx, dy) || 1) : Infinity;
  const home = Math.hypot(mob.x - mob.sx, mob.y - mob.sy);
  const step = (tx, ty, spd) => { const ddx = tx - mob.x, ddy = ty - mob.y, dd = Math.hypot(ddx, ddy); if (dd < 4) return; moveMob(mob, ddx / dd * spd * dt, ddy / dd * spd * dt); };
  switch (mob.state) {
    case 'idle': default:
      if (tp && mob.ret <= 0 && d < 300 && home < 520) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
      break;
    case 'chase':
      if (!tp || d > 520 || home > 640) { mob.state = 'return'; mob.ret = 3; mob.tgt = null; break; }
      if (mob.tMet <= 0) { mob.state = 'meteor'; mob.t = 1.2; mob.tMet = mob.enr ? 6 : 9; delayedHit(target, mob, st.dmg * .9, 950); break; }
      if (mob.tSlam <= 0 && d < 230) { mob.state = 'wind'; mob.t = .65; mob.la = Math.atan2(dy, dx); mob.tSlam = mob.enr ? 6 : 9; break; }
      if (mob.cd <= 0 && d < 90) { mob.hit = false; mob.la = Math.atan2(dy, dx); mob.state = 'wind2'; mob.t = .55; break; }
      step(tp.x, tp.y, mob.enr ? 128 : 96);
      break;
    case 'wind':
      mob.t -= dt;
      if (mob.t <= 0) { if (target && d < 250) hitTarget(target, mob, st.dmg); mob.state = 'recover'; mob.t = 1; mob.cd = 1.6; }
      break;
    case 'wind2':
      mob.t -= dt;
      if (mob.t <= 0) { if (target && !mob.hit && d < 96) { mob.hit = true; hitTarget(target, mob, st.dmg); } mob.state = 'recover'; mob.t = .6; mob.cd = 1.2; }
      break;
    case 'meteor': case 'recover':
      mob.t -= dt; if (mob.t <= 0) mob.state = 'chase';
      break;
    case 'return':
      step(mob.sx, mob.sy, 120); mob.hp = Math.min(mob.maxhp, mob.hp + dt * 130);
      if (home < 16) settleAtSpawn(mob);
      if (tp && mob.ret <= 0 && d < 150) { mob.state = 'chase'; mob.ret = 0; mob.tgt = tp.id; }
      break;
  }
  return { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state };
}

const MOB_AI_STEP = {
  slime: stepSlime, goblin: stepGoblin, skeleton: stepSkeleton, wolf: stepWolf,
  bat: stepBat, cinza: stepCinza, toxic: stepToxic, caster: stepCaster,
  sky: stepSky, sala: stepSala, elem: stepElem, calc: stepCalc, lorde: stepLorde,
};
const MOB_VISUAL_FIELDS = ['t', 't0', 'la', 'lx', 'ly', 'tx', 'ty', 'atk', 'k', 'heavy', 'bx', 'by', 'enr', 'face', 'cmb', 'guard', 'al'];
function mobPositionPayload(mob, moving) {
  const out = { id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), state: mob.state, moving };
  for (const key of MOB_VISUAL_FIELDS) {
    const value = mob[key];
    if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}
let mobAiLastTick = performance.now();
function tickMobAI() {
  const now = performance.now();
  const elapsed = Math.max(0, Math.min(.2, (now - mobAiLastTick) / 1000));
  mobAiLastTick = now;
  const slices = Math.max(1, Math.ceil(elapsed / .05)), dt = elapsed / slices;
  for (const state of maps.values()) {
    const present = playersOnMap(state.id);
    if (!present.length) continue;
    const moved = [];
    for (const mob of state.mobs.values()) {
      if (mob.dead) continue;
      const stepFn = MOB_AI_STEP[mob.type];
      if (!stepFn) continue;
      mob.map = state.id;
      const startX = mob.x, startY = mob.y;
      let upd = null;
      for (let i = 0; i < slices; i++) {
        const previousState = mob.state;
        upd = stepFn(mob, dt, present) || upd;
        if (mob.state !== previousState && Number.isFinite(mob.t) && mob.t > 0) mob.t0 = mob.t;
      }
      if (upd && Number.isFinite(mob.x) && Number.isFinite(mob.y)) {
        const moving = Math.hypot(mob.x - startX, mob.y - startY) > .01;
        if (Math.abs(mob.x - startX) > .01) mob.face = mob.x < startX ? -1 : 1;
        moved.push(mobPositionPayload(mob, moving));
      }
    }
    if (moved.length) broadcastMap(state.id, { type: 'mob_positions', map: state.id, mobs: moved });
  }
}
setInterval(tickMobAI, 150).unref();

setInterval(() => {
  for (const ws of clients.keys()) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive=false;ws.ping();
  }
}, 30000).unref();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`MMORPG Online em http://localhost:${PORT}`));
}
// Exportado so pra teste unitario puro (sem HTTP/Supabase) das funcoes de
// item/posse da Fase 5.1 -- nao muda nada em como `node server.js` roda
// (continua chamando server.listen normalmente via o guard acima).
module.exports = {
  sanitizeItem, sanitizeSave, lockOwnedItems, createGear, dedupeByUid, typeSlot, CLASS_ITEM_TYPES, EQ_SLOTS, GEAR_DATA,
  // Fase 5.2 -- exportado so pra teste unitario puro (sem HTTP/WS/Supabase):
  startingSave, ECONOMY_LOCK_FIELDS, createDungeonInstance, dungeonCleanupTick,
  moveMob, rectsBlock, maps, mapState, mobStats, DUNGEON_CFG, DUNGEON_UNLOCK_QUEST,
  pickTier, rollDungeonTrashLoot, rollDungeonBossLoot, clampAtk, DUNGEON_GEN,
  // Fase 5.3 -- exportado so pra teste unitario puro (sem HTTP/WS/Supabase):
  grantItem, gearLevelForMob, rollGearDrop, applyGearDrops, GEAR_DROP_RATES, DROP_TYPES_BY_CLASS,
};
