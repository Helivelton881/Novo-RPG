#!/usr/bin/env node
// Fase 5.17 — simulador de balanceamento (reprodutivel, deterministico).
//
//   node tools/balance-sim.js            -> relatorio completo
//   node tools/balance-sim.js --derive   -> propoe XP_TO_NEXT a partir das
//                                          horas-alvo (colar em balance-data.js)
//
// Tudo aqui e ESTIMATIVA baseada em premissas explicitas (PROFILES e
// comentarios abaixo) -- nunca garantia. Os dados de jogo vem das fontes
// reais: mobStats()/MOB_MANIFEST/rollMobLoot (server.js), CLASS_BASE
// (game-data/world-boss.js), stats/precos (game-data/gear-data.js) e toda a
// economia da fase (game-data/balance-data.js). Math.random e substituido
// por um PRNG com seed fixa pra saida ser identica a cada execucao.
'use strict';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(517);

const B = require('../game-data/balance-data.js');
const GEAR = require('../game-data/gear-data.js');
const WB = require('../game-data/world-boss.js');
const S = require('../server.js');

const CLASSES = ['guerreiro', 'druida', 'mago', 'arqueiro'];
const WEAPON = { guerreiro: 'sword', druida: 'staffd', mago: 'staffm', arqueiro: 'bow' };
const GEAR_MUL = { guerreiro: 1.3, arqueiro: 1.2, druida: 1.15, mago: 1.15 };
// Espelha SKILL_REQ/SKILL_CD_MS/skillDamageMul de server.js. `hits` =
// acertos efetivos em alvo unico (thorns pulsa ~5x; multi ~1.5 flechas no
// mesmo alvo).
const DMG_SKILLS = {
  guerreiro: [{ id: 'spin', req: 2, cd: 5, mul: r => 1.4 + .3 * (r - 1), hits: 1 }, { id: 'dash', req: 3, cd: 4, mul: r => 1.2 + .25 * (r - 1), hits: 1 }],
  druida: [{ id: 'roots', req: 3, cd: 9, mul: r => .8 + .2 * (r - 1), hits: 1 }, { id: 'thorns', req: 5, cd: 10, mul: r => .45 + .1 * (r - 1), hits: 5 }],
  mago: [{ id: 'fireball', req: 2, cd: 4, mul: r => 1.8 + .4 * (r - 1), hits: 1 }, { id: 'frost', req: 3, cd: 7, mul: r => 1 + .25 * (r - 1), hits: 1 }],
  arqueiro: [{ id: 'multi', req: 2, cd: 4, mul: r => .75 + .05 * (r - 1), hits: 1.5 }, { id: 'pierce', req: 5, cd: 8, mul: r => 2.2 + .4 * (r - 1), hits: 1 }],
};

// ===== Premissas por perfil =====
// overheadS: segundos por abate alem do TTK (andar ate o proximo mob,
//   aggro, coletar drop, regenerar). fieldEff: fracao do tempo de campo
//   realmente em combate (cidade, loja, AFK curto). dungeonPerHour: clears
//   de masmorra tentados por hora de jogo (~15min cada). wbPerDay/tvtPerDay:
//   participacoes por dia (eventos a cada 4h cada). fieldBossPerHour:
//   chefes de campo abatidos por hora. fieldBossGemDays: chefes distintos
//   com gema por dia. hoursPerDay: horas jogadas por dia.
const PROFILES = {
  efficient: { label: 'Muito eficiente', overheadS: 4.5, fieldEff: .92, hoursPerDay: 5, dungeonPerHour: .5, wbPerDay: 2, tvtPerDay: 2, fieldBossPerHour: .6, fieldBossGemPerDay: 2 },
  active: { label: 'Ativo normal', overheadS: 7, fieldEff: .85, hoursPerDay: 3, dungeonPerHour: .35, wbPerDay: 1, tvtPerDay: 1, fieldBossPerHour: .4, fieldBossGemPerDay: 1 },
  casual: { label: 'Casual/solo', overheadS: 9.5, fieldEff: .78, hoursPerDay: 1.5, dungeonPerHour: .2, wbPerDay: .2, tvtPerDay: .3, fieldBossPerHour: .25, fieldBossGemPerDay: .7 },
};
const DUNGEON_CLEAR_H = .25, EVENT_H = 1 / 6;
const TVT_OUTCOME_MIX = { win: .45, loss: .45, draw: .10 };

function gearLevelFor(L) { let best = GEAR.GEAR_LEVELS[0]; for (const l of GEAR.GEAR_LEVELS) { if (l <= L) best = l; else break; } return best; }
function classDps(cls, L) {
  const b = WB.CLASS_BASE[cls], gl = gearLevelFor(L);
  const atk = Math.round(((GEAR.statsFor(WEAPON[cls], gl, 'basic').atk || 0) + (GEAR.statsFor('jewel', gl, 'basic').atk || 0)) * GEAR_MUL[cls]);
  const base = b.dmg0 + b.dmgL * (L - 1);
  const basic = (base + atk + 1.5) / (WB.BASIC_CD_MS[cls] / 1000);
  const r = L >= 7 ? 3 : L >= 4 ? 2 : 1;
  let skills = 0;
  for (const s of DMG_SKILLS[cls]) if (L >= s.req) skills += (base + atk + 2) * s.mul(r) * s.hits / s.cd;
  // skill tira tempo de ataque basico; .85 = erros/reposicionamento
  return (basic * .8 + skills) * .85;
}
function avgDps(L) { return CLASSES.reduce((s, c) => s + classDps(c, L), 0) / CLASSES.length; }

// Mobs que um jogador de nivel L enfrenta na regiao adequada (mesmos
// tipos/faixas de MOB_MANIFEST).
function fieldMobsFor(L) {
  if (L <= 3) return [{ type: 'slime', lvl: L }];
  if (L === 4) return [{ type: 'slime', lvl: 3 }];
  if (L < 10) return [{ type: 'goblin', lvl: L }];
  if (L < 15) return [{ type: 'skeleton', lvl: L }];
  if (L < 20) return [{ type: 'wolf', lvl: L }];
  if (L < 25) return [{ type: 'bat', lvl: L }, { type: 'toxic', lvl: L }];
  if (L < 30) return [{ type: 'skeleton', lvl: L }, { type: 'caster', lvl: L }];
  if (L < 35) return [{ type: 'sky', lvl: L, k: 'h' }, { type: 'sky', lvl: L, k: 's' }, { type: 'sky', lvl: L, k: 'g' }, { type: 'bat', lvl: L }];
  return [{ type: 'sala', lvl: L }, { type: 'elem', lvl: L }, { type: 'calc', lvl: L }];
}
const REGION_BOSS = [[5, 'goblin', 10], [10, 'skeleton', 15], [15, 'wolf', 20], [20, 'toxic', 25], [25, 'caster', 30], [30, 'sky', 35, 'b'], [35, 'lorde', 40]];
function regionBossFor(L) { let r = null; for (const b of REGION_BOSS) if (L >= b[0]) r = b; return r && { type: r[1], lvl: r[2], k: r[3] }; }

function playerLevelRates(L, prof, dps) {
  dps = dps || avgDps(L);
  const mobs = fieldMobsFor(L).map(m => ({ ...m, st: S.mobStats(m.type, m.lvl, false, m.k) }));
  const hp = mobs.reduce((s, m) => s + m.st.hp, 0) / mobs.length;
  const xpPerKill = mobs.reduce((s, m) => s + m.st.xp * B.xpGapMultiplier(m.lvl - L), 0) / mobs.length;
  const killS = hp / dps + prof.overheadS;
  const canDungeon = L >= 6, canEvents = L >= 10;
  const dunPerH = canDungeon ? Math.min(prof.dungeonPerHour, B.DUNGEON.XP_CLEARS_PER_DAY / prof.hoursPerDay) : 0;
  const wbPerH = canEvents ? Math.min(prof.wbPerDay, B.WORLD_BOSS.XP_EVENTS_PER_DAY) / prof.hoursPerDay : 0;
  const tvtPerH = canEvents ? Math.min(prof.tvtPerDay, B.TVT.XP_EVENTS_PER_DAY) / prof.hoursPerDay : 0;
  const boss = regionBossFor(L);
  const bossSt = boss && S.mobStats(boss.type, boss.lvl, true, boss.k);
  const bossPerH = boss ? prof.fieldBossPerHour : 0;
  const bossTimeFrac = boss ? bossPerH * (bossSt.hp / dps + 20) / 3600 : 0;
  const fieldFrac = Math.max(0, 1 - dunPerH * DUNGEON_CLEAR_H - (wbPerH + tvtPerH) * EVENT_H - bossTimeFrac);
  const killsPerH = 3600 / killS * fieldFrac * prof.fieldEff;
  const mobXph = killsPerH * xpPerKill;
  const bossXph = boss ? bossPerH * bossSt.xp * B.xpGapMultiplier(boss.lvl - L) : 0;
  const dunGap = boss ? B.xpGapMultiplier(boss.lvl - L) : 1;
  const tvtRatio = Object.entries(TVT_OUTCOME_MIX).reduce((s, [o, p]) => s + p * B.TVT.XP_RATIO[o], 0);
  // fracoes da XP_TO_NEXT(L) por hora
  const k = { dungeon: dunPerH * B.DUNGEON.CLEAR_XP_RATIO * dunGap, worldBoss: wbPerH * B.WORLD_BOSS.XP_RATIO, events: tvtPerH * tvtRatio };
  return { hp, xpPerKill, killS, killsPerH, mobXph, bossXph, k, dps };
}
function questRatioAt(L) {
  let q = 0;
  for (const [stage, s] of Object.entries(B.QUEST_STAGE_XP)) if (s.lvl === L) q += B.QUEST_XP_RATIO[s.kind] || 0;
  return q;
}

// Horas-alvo por nivel (perfil ativo): ponto medio da regiao, distribuido
// com peso crescente dentro dela (primeiro nivel da regiao mais rapido).
function targetHoursByLevel() {
  const out = {};
  for (const r of B.REGIONS) {
    const n = r.to - r.from, total = (r.hours[0] + r.hours[1]) / 2;
    const w = Array.from({ length: n }, (_, i) => 1 + .12 * i), ws = w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) out[r.from + i] = total * w[i] / ws;
  }
  return out;
}
function sig3(v) { const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(v)) - 2)); return Math.round(v / p) * p; }

function derive() {
  // 1) need "bruto" por nivel que bate as horas-alvo (quest fica de fora
  //    de proposito: vira bonus no nivel dela, nunca infla a curva);
  // 2) suavizacao em escala log (media movel de 5 niveis) pra tirar os
  //    degraus de troca de mob/regiao; 3) monotonia estrita (+4% minimo).
  const T = targetHoursByLevel(), prof = PROFILES.active, raw = [0];
  for (let L = 1; L < B.LEVEL_CAP; L++) {
    const r = playerLevelRates(L, prof), ksum = r.k.dungeon + r.k.worldBoss + r.k.events;
    raw.push(T[L] * (r.mobXph + r.bossXph) / Math.max(.35, 1 - T[L] * ksum));
  }
  if (process.argv.includes('--raw')) for (let L = 1; L < B.LEVEL_CAP; L++) console.log(`raw L${L} target ${T[L].toFixed(2)}h need ${Math.round(raw[L])}`);
  const table = [0];
  for (let L = 1; L < B.LEVEL_CAP; L++) {
    let s = 0, n = 0;
    for (let j = Math.max(1, L - 2); j <= Math.min(B.LEVEL_CAP - 1, L + 2); j++) { s += Math.log(raw[j]); n++; }
    // Vila (Lv1-4) fica no valor bruto: e o tutorial, precisa ser rapido e
    // nao pode herdar o peso da Floresta pela media movel.
    let need = sig3(L <= 4 ? raw[L] : Math.exp(s / n));
    if (need <= table[L - 1] * 1.04) need = sig3(table[L - 1] * 1.04 + 1);
    table.push(need);
  }
  const rows = [];
  for (let i = 1; i < table.length; i += 10) rows.push(table.slice(i, i + 10).join(', '));
  console.log('// XP_TO_NEXT derivado (perfil ativo) -- colar em game-data/balance-data.js');
  console.log(rows.map(r => '  ' + r + ',').join('\n'));
}

// ===== Simulacao de progressao com a tabela ATUAL de balance-data =====
function simulate(prof, dpsFn) {
  const perLevel = [], src = { mobs: 0, bosses: 0, quests: 0, dungeons: 0, worldBoss: 0, events: 0 };
  for (let L = 1; L < B.LEVEL_CAP; L++) {
    const r = playerLevelRates(L, prof, dpsFn ? dpsFn(L) : null), need = B.xpToNext(L);
    let questXp = 0;
    for (const [stage, s] of Object.entries(B.QUEST_STAGE_XP)) if (s.lvl === L) questXp += B.questXpFor(Number(stage));
    questXp = Math.min(need, questXp);
    const rateXph = r.mobXph + r.bossXph + need * (r.k.dungeon + r.k.worldBoss + r.k.events);
    const h = (need - questXp) / rateXph;
    src.mobs += r.mobXph * h; src.bosses += r.bossXph * h; src.quests += questXp;
    src.dungeons += need * r.k.dungeon * h; src.worldBoss += need * r.k.worldBoss * h; src.events += need * r.k.events * h;
    perLevel.push({ L, need, h, kills: r.killsPerH * h, killsPerLevel: need / Math.max(1, r.xpPerKill), xph: rateXph, killS: r.killS });
  }
  return { perLevel, src, total: perLevel.reduce((s, x) => s + x.h, 0) };
}
function regionHours(sim) {
  return B.REGIONS.map(r => ({ r, h: sim.perLevel.filter(x => x.L >= r.from && x.L < r.to).reduce((s, x) => s + x.h, 0) }));
}

const fmt = (n, d = 0) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const pad = (s, n) => String(s).padStart(n);
const padR = (s, n) => String(s).padEnd(n);
function header(t) { console.log('\n=============================='); console.log(t); console.log('=============================='); }

function report() {
  console.log('Novo-RPG — Fase 5.17 balance simulator (estimativas, nao garantia)');
  console.log('Premissas: ver PROFILES e comentarios em tools/balance-sim.js; seed PRNG fixa = saida reprodutivel.');

  header('XP TABLE');
  console.log(padR('Lv', 4) + pad('XP Next', 12) + pad('XP Cumulative', 16) + '  Region');
  for (let L = 1; L <= B.LEVEL_CAP; L++) console.log(padR(L, 4) + pad(L >= B.LEVEL_CAP ? 'MAX' : fmt(B.xpToNext(L)), 12) + pad(fmt(B.cumulativeXp(L)), 16) + '  ' + B.regionForLevel(L).name);

  const sims = Object.fromEntries(Object.entries(PROFILES).map(([k, p]) => [k, simulate(p)]));
  header('TIME ESTIMATE (horas)');
  console.log(padR('Regiao', 12) + pad('Alvo ativo', 12) + Object.values(PROFILES).map(p => pad(p.label, 18)).join(''));
  const rh = Object.fromEntries(Object.entries(sims).map(([k, s]) => [k, regionHours(s)]));
  B.REGIONS.forEach((r, i) => console.log(padR(r.name + ` ${r.from}-${r.to}`, 12) + pad(`${r.hours[0]}-${r.hours[1]}`, 12) + Object.keys(PROFILES).map(k => pad(fmt(rh[k][i].h, 1), 18)).join('')));
  console.log(padR('TOTAL 1→40', 12) + pad('140-180', 12) + Object.keys(PROFILES).map(k => pad(fmt(sims[k].total, 1), 18)).join(''));
  console.log('Alvos do design: eficiente ~110-130h, ativo ~140-180h (meta 150h), casual ~180-220h.');

  header('XP POR NIVEL (perfil ativo)');
  console.log(padR('Lv', 4) + pad('horas', 8) + pad('XP/h', 10) + pad('kills/lv*', 11) + pad('s/kill', 8));
  for (const x of sims.active.perLevel) console.log(padR(x.L, 4) + pad(fmt(x.h, 2), 8) + pad(fmt(x.xph), 10) + pad(fmt(x.killsPerLevel), 11) + pad(fmt(x.killS, 1), 8));
  console.log('* kills/lv = XP_TO_NEXT / XP por abate (so combate, sem outras fontes)');

  header('XP SHARE BY SOURCE (ciclo 1→40, perfil ativo)');
  const src = sims.active.src, tot = Object.values(src).reduce((a, b) => a + b, 0);
  const target = { mobs: '50% combate', bosses: '6% (bosses+WB)', quests: '20%', dungeons: '12%', worldBoss: '(em bosses)', events: '5%' };
  for (const [k, v] of Object.entries(src)) console.log(padR(k, 12) + pad(fmt(v / tot * 100, 1) + '%', 8) + '   meta: ' + target[k]);
  console.log(padR('bestiario', 12) + pad('0,0%', 8) + '   meta: 4% (sistema sem recompensa hoje -- hook futuro, ver docs)');

  header('CLASS QA — XP/h de combate (perfil ativo)');
  console.log(padR('Lv', 4) + CLASSES.map(c => pad(c, 12)).join('') + pad('max/min', 9));
  for (const L of [5, 10, 20, 30, 39]) {
    const v = CLASSES.map(c => playerLevelRates(L, PROFILES.active, classDps(c, L)).mobXph);
    console.log(padR(L, 4) + v.map(x => pad(fmt(x), 12)).join('') + pad(fmt(Math.max(...v) / Math.min(...v), 2) + 'x', 9));
  }
  const classTotals = CLASSES.map(c => [c, simulate(PROFILES.active, L => classDps(c, L)).total]);
  console.log('Tempo total 1→40 por classe (ativo): ' + classTotals.map(([c, t]) => `${c} ${fmt(t, 1)}h`).join(' | '));

  header('DROP EXPECTATION (itens esperados)');
  console.log(padR('Fonte', 28) + pad('Rare', 9) + pad('Epic', 9) + pad('Legendary', 11));
  const rows = [['common', 1000, '1.000 kills mob comum'], ['common', 10000, '10.000 kills mob comum'], ['elite', 1000, '1.000 kills elite/chefe campo'], ['dungeonBoss', 100, '100 chefes de masmorra'], ['worldBoss', 100, '100 World Boss (por jogador)']];
  for (const [tier, n, label] of rows) { const t = B.DROP_RATES[tier]; console.log(padR(label, 28) + pad(fmt(t.rare * n, 2), 9) + pad(fmt(t.epic * n, 2), 9) + pad(fmt(t.legendary * n, 2), 11)); }
  // verificacao empirica do roll exclusivo
  const rng = mulberry32(99), count = { rare: 0, epic: 0, legendary: 0 }, N = 1000000;
  for (let i = 0; i < N; i++) { const r = B.rollDropRarity('worldBoss', rng); if (r) count[r]++; }
  console.log(`Monte Carlo 1M rolls World Boss: rare ${fmt(count.rare / N * 100, 2)}% epic ${fmt(count.epic / N * 100, 2)}% legendary ${fmt(count.legendary / N * 100, 3)}% (roll unico, max 1 item)`);

  header('ENCHANT EXPECTATION');
  console.log('Custo em ouro +1..+3 = itemLv x rarityMul x alvo x 10 (arredondado a multiplos de 10):');
  console.log(padR('Item', 16) + pad('+1', 8) + pad('+2', 8) + pad('+3', 8) + pad('+0→+3', 9) + '   (bruto)');
  for (const [r, lv, label] of [['basic', 5, 'Basic Lv5'], ['rare', 20, 'Rare Lv20'], ['epic', 36, 'Epic Lv36'], ['legendary', 36, 'Legendary Lv36'], ['legendary', 40, 'Legendary Lv40']]) {
    const c = [1, 2, 3].map(t => B.enchantCostFor(lv, r, t).amount);
    const raw = [1, 2, 3].map(t => B.enchantGoldCostRaw(lv, r, t));
    console.log(padR(label, 16) + c.map(x => pad(fmt(x), 8)).join('') + pad(fmt(c[0] + c[1] + c[2]), 9) + '   (' + raw.map(x => fmt(x, 1)).join(' / ') + ')');
  }
  console.log('\n+4..+10 (gemas; falha consome gemas, item intacto):');
  console.log(padR('Alvo', 6) + pad('gemas', 7) + pad('chance', 8) + pad('tent. esp.', 11) + pad('gemas esp.', 11));
  let expGems = 0, expTries = 0;
  for (let t = 4; t <= 10; t++) {
    const g = B.ENCHANT_GEM_COST[t], p = B.ENCHANT_SUCCESS[t];
    expGems += g / p; expTries += 1 / p;
    console.log(padR('+' + t, 6) + pad(g, 7) + pad(fmt(p * 100) + '%', 8) + pad(fmt(1 / p, 2), 11) + pad(fmt(g / p, 1), 11));
  }
  console.log(`Esperado +3→+10: ${fmt(expTries, 1)} tentativas, ${fmt(expGems, 1)} gemas.`);
  const mc = mulberry32(1234), gemsRuns = [];
  for (let run = 0; run < 20000; run++) { let g = 0; for (let t = 4; t <= 10; t++) { for (;;) { g += B.ENCHANT_GEM_COST[t]; if (mc() < B.ENCHANT_SUCCESS[t]) break; } } gemsRuns.push(g); }
  gemsRuns.sort((a, b) => a - b);
  const pct = q => gemsRuns[Math.floor(q * (gemsRuns.length - 1))];
  console.log(`Monte Carlo 20k itens +3→+10 (gemas): p10 ${pct(.1)} | p25 ${pct(.25)} | mediana ${pct(.5)} | p75 ${pct(.75)} | p90 ${pct(.9)} | media ${fmt(gemsRuns.reduce((a, b) => a + b, 0) / gemsRuns.length, 1)}`);
  console.log('Poder acumulado: ' + Object.entries(B.ENCHANT_POWER).map(([e, v]) => `+${e}=${fmt(v * 100, 1)}%`).join(' '));
  const cmp = (r, lv, e) => Math.round(GEAR.GEAR_STATS.sword[lv].atk * GEAR.RARITY[r].mul * (1 + B.enchantPower(e)));
  console.log(`Exemplo arma Lv36 (ATK): Epic +8 = ${cmp('epic', 36, 8)} vs Legendary +3 = ${cmp('legendary', 36, 3)} vs Legendary +0 = ${cmp('legendary', 36, 0)} vs Epic +10 = ${cmp('epic', 36, 10)}`);

  header('GEM ECONOMY (gemas/semana — estimativa)');
  const gemWeek = {};
  for (const [k, p] of Object.entries(PROFILES)) {
    const dun = Math.min(p.dungeonPerHour * p.hoursPerDay, B.DUNGEON.GEM_CLEARS_PER_DAY) * 7 * B.DUNGEON.BOSS_GEMS;
    const fb = p.fieldBossGemPerDay * 7 * B.FIELD_BOSS.DAILY_GEMS;
    const wb = Math.min(p.wbPerDay * 7, B.WORLD_BOSS.GEM_EVENTS_PER_WEEK) * B.WORLD_BOSS.GEMS;
    const tvtAvg = Object.entries(TVT_OUTCOME_MIX).reduce((s, [o, pr]) => s + pr * B.TVT.GEMS[o], 0);
    const tvt = Math.min(p.tvtPerDay * 7, B.TVT.GEM_EVENTS_PER_WEEK) * tvtAvg;
    const total = dun + fb + wb + tvt;
    gemWeek[k] = total;
    console.log(`${padR(p.label, 16)} masmorra ${pad(fmt(dun, 1), 5)} | chefe campo ${pad(fmt(fb, 1), 5)} | World Boss ${pad(fmt(wb, 1), 5)} | TvT ${pad(fmt(tvt, 1), 4)} | TOTAL ${pad(fmt(total, 1), 5)}`);
  }
  console.log('Metas: casual 15-25 | ativo 25-40 | endgame 40-60. Mob comum = 0 gema. Missoes: +28 gemas UMA vez (onboarding).');
  console.log(`Um item +3→+10 custa em media ${fmt(expGems, 0)} gemas ≈ ${fmt(expGems / gemWeek.active, 1)} semanas de um jogador ativo (~${fmt(gemWeek.active, 0)}/sem) e 7 pecas encantaveis ≈ ${fmt(7 * expGems / gemWeek.active, 0)} semanas.`);

  header('GOLD ECONOMY (ouro/h de campo vs custos — perfil ativo)');
  console.log(padR('Regiao', 11) + pad('ouro/h', 9) + pad('arma basic', 12) + pad('+1..+3 Rare', 13) + pad('10 pocoes', 11) + pad('portal', 8) + '  h p/ arma');
  const PORTAL = { floresta: 400, cripta: 900, serra: 1600, pantano: 2500, torre: 3600, ilhas: 5000, vulcao: 7000 };
  for (const r of B.REGIONS) {
    const L = Math.min(39, r.from + 2), rates = playerLevelRates(L, PROFILES.active);
    const mobs = fieldMobsFor(L);
    let g = 0; const N = 4000;
    for (let i = 0; i < N; i++) { const m = mobs[i % mobs.length]; const loot = S.rollMobLoot(m.type, false, m.lvl); g += loot ? loot.gold : 0; }
    const goldPerKill = g / N, goldH = goldPerKill * rates.killsPerH;
    const gl = gearLevelFor(r.to - 1), weapon = GEAR.priceFor('sword', gl);
    const ench = [1, 2, 3].reduce((s, t) => s + B.enchantCostFor(gl, 'rare', t).amount, 0);
    console.log(padR(r.name, 11) + pad(fmt(goldH), 9) + pad(fmt(weapon), 12) + pad(fmt(ench), 13) + pad(100, 11) + pad(PORTAL[r.id] || '-', 8) + '  ' + fmt(weapon / goldH, 1));
  }
  console.log('Ouro de mob comum nao foi alterado nesta fase; ouro de World Boss/TvT/missoes preservado.');

  header('RELIC MERCHANT (Fase 5.17.2 — gem sink, sem alterar gem income)');
  const RS = require('../game-data/relic-shop.js');
  const wk = { casual: 18, active: 40, endgame: 47 }; // referencias oficiais da 5.17 (gemas/semana)
  console.log(padR('Tier', 6) + pad('Rare', 6) + pad('Epic', 6) + '   semanas (casual 18 / ativo 40 / endgame 47)');
  for (const lv of GEAR.GEAR_LEVELS) {
    const r = B.relicPrice(lv, 'rare'), e = B.relicPrice(lv, 'epic');
    const wks = g => [wk.casual, wk.active, wk.endgame].map(x => fmt(g / x, 1)).join(' / ');
    console.log(padR('Lv' + lv, 6) + pad(r, 6) + pad(e, 6) + `   Rare ${wks(r)}  |  Epic ${wks(e)}`);
  }
  const all6 = lv => 4 * B.relicPrice(lv, 'rare') + 2 * B.relicPrice(lv, 'epic');
  console.log(`Comprar as 6 ofertas de uma semana (tudo no tier Lv40): ${all6(40)} gemas ≈ ${fmt(all6(40) / wk.active, 1)} semanas de gema de um jogador ativo.`);
  console.log(`Comprar vs enchant: Epic Lv40 (65) ≈ ${fmt(65 / expGems * 100, 0)}% do custo medio de levar 1 item +3→+10 (${fmt(expGems, 0)} gemas).`);
  const atk = (r, e) => Math.round(GEAR.GEAR_STATS.sword[40].atk * GEAR.RARITY[r].mul * (1 + B.enchantPower(e)));
  console.log(`Arma Lv40 ATK: Rare+0 ${atk('rare', 0)} (30 gemas) | Epic+0 ${atk('epic', 0)} (65) | Rare+7 ${atk('rare', 7)} | Epic+7 ${atk('epic', 7)} | Legendary+0 ${atk('legendary', 0)} (so drop)`);
  // Arbitragem gema -> item -> ouro (venda ao Mercador comum, preco NAO alterado nesta fase)
  const gemSell = 25;
  for (const [r, lv] of [['rare', 40], ['epic', 40], ['rare', 20], ['epic', 20]]) {
    const price = B.relicPrice(lv, r), sell = GEAR.sellPriceForItem({ lv, rarity: r });
    console.log(`Arbitragem ${padR(r + ' Lv' + lv, 10)}: ${price} gemas (= ${price * gemSell} ouro vendendo gema) -> vende item por ${sell} ouro (${fmt(sell / (price * gemSell), 1)}x)`);
  }
  const weeklyGold = [0, 1, 2, 3].reduce((s, i) => s + GEAR.sellPriceForItem({ lv: 40, rarity: 'rare' }), 0) + 2 * GEAR.sellPriceForItem({ lv: 40, rarity: 'epic' });
  console.log(`Teto de conversao por personagem/semana (6 ofertas Lv40 vendidas): ${fmt(weeklyGold)} ouro por ${all6(40)} gemas ≈ ${fmt(weeklyGold / 3500, 1)}h de farm de ouro no Vulcao. Limitado a 6 ofertas/semana — documentado para revisao (sellPrice nao foi alterado).`);
  const sample = RS.relicStock({ weekId: RS.relicWeekInfo(Date.UTC(2026, 8, 24)).weekId, cls: 'guerreiro', lvl: 36, types: S.DROP_TYPES_BY_CLASS.guerreiro });
  console.log('Exemplo estoque 2026-W39 guerreiro Lv36: ' + sample.map(o => `${o.rarity[0].toUpperCase()}:${o.type}${o.lv}=${o.priceGem}`).join(' '));

  header('PARTY XP');
  for (let n = 1; n <= 4; n++) console.log(`${n} jogador(es): ${fmt(B.partyXpShare(n) * 100)}% cada, ${fmt(B.partyXpShare(n) * n * 100)}% total`);
  header('DEATH PENALTY (PvE)');
  for (const L of [5, 20, 39]) console.log(`Lv${L}: need ${fmt(B.xpToNext(L))} → perde ${fmt(B.deathXpLoss(L, B.xpToNext(L) - 1, 'pve'))} XP por morte PvE (PvP/TvT: 0)`);
}

if (process.argv.includes('--derive')) derive(); else report();
process.exit(0);
