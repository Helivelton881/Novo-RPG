'use strict';

// Fase 5.7 -- Team vs Team. Modulo puro (sem HTTP/WS/Supabase), testavel
// isoladamente, no mesmo espirito de game-data/world-boss.js (Fase 5.6).
// Reaproveita o que já é genérico de lá (combatSnapshot/equipmentTotals via
// combatSnapshot, CLASS_BASE, BASIC_CD_MS, CLASS_SKILLS, DAMAGE_SKILLS) em
// vez de duplicar -- world-boss.js nunca é modificado por este arquivo, ZERO
// risco de regressão no World Boss. O que o World Boss não precisava (heal
// em aliado, buffs/debuffs com timestamp, PvP com times/placar/respawn) é
// implementado aqui, de propósito, auditado contra o comportamento real dos
// skills no cliente (index.html: SKILL_FX/healAmt/barrierAmt) antes de
// portar -- ver LEIA-PRIMEIRO.md "Fase 5.7" pra cada fórmula com sua origem.
const WORLD_BOSS = require('./world-boss.js');

// ===== Configuração =====
const TVT_MAP_RE = /^tvt#[0-9a-z]{6,10}$/;
const TVT_MAX_PLAYERS = 8;
const TVT_MIN_PLAYERS = 4;
const TVT_DURATION_MS = 10 * 60 * 1000;
const TVT_RESPAWN_MS = 5 * 1000;
const TVT_SPAWN_PROTECTION_MS = 3 * 1000;
const TVT_TEAM_IDS = Object.freeze(['red', 'blue']);
const TVT_TEAM_LABELS = Object.freeze({ red: 'Equipe Rubra', blue: 'Equipe Azul' });
// Arena fixa (2200x1400 logico): spawns bem afastados (~1500px, acima de
// qualquer alcance real de ataque/skill do jogo, o maior é ~550px em
// resolveAttackDamage/mob_damage) pra nunca virar spawn kill.
const TVT_ARENA = Object.freeze({ w: 2200, h: 1400 });
const TVT_SPAWN = Object.freeze({ red: { x: 350, y: 700 }, blue: { x: 1850, y: 700 } });
// Proposta inicial documentada em LEIA-PRIMEIRO.md (comparada contra World
// Boss/dungeon/quests antes de congelar): bem abaixo do World Boss (fonte
// mais forte, sem Legendary aqui de propósito), repetível a cada 4h.
const TVT_REWARD = Object.freeze({
  win: Object.freeze({ gold: 120, gem: 6, xp: 6000 }),
  loss: Object.freeze({ gold: 60, gem: 3, xp: 3000 }),
  draw: Object.freeze({ gold: 90, gem: 4, xp: 4500 }),
});
// Contribuição mínima pra elegibilidade de recompensa (não exige kill --
// dano OU cura contam; heal pesa mais pra não penalizar Druida puro-suporte).
const TVT_MIN_CONTRIBUTION = 30;
const TVT_ELIGIBLE_IDLE_MS = 90 * 1000; // ativo nos últimos 90s também conta, mesmo com pouca contribuição

function scoreLimitForTeamSize(size) {
  const n = Math.round(Number(size) || 0);
  if (n >= 4) return 20;
  if (n === 3) return 15;
  return 10; // 2
}

// ===== PowerScore (só pra matchmaking -- NUNCA dano, NUNCA HP) =====
const RARITY_QUALITY = Object.freeze({ basic: 1, rare: 1.15, epic: 1.3, legendary: 1.5 });
// Qualidade média do equipamento (rarity+enchant) -- combatSnapshot já soma
// atk/def/hp dos itens (rarity/enchant já influenciam esses totais), mas o
// design pede rarity/enchant considerados EXPLICITAMENTE também (peça rara
// alta mas com atk parecido a uma comum ainda deveria pesar mais na
// dificuldade de vencer o dono dela).
function gearQualityFactor(eq) {
  const items = Object.values(eq || {}).filter(Boolean);
  if (!items.length) return 1;
  let sum = 0;
  for (const it of items) sum += (RARITY_QUALITY[it.rarity] || 1) * (1 + Math.max(0, Math.min(10, Number(it.enchant) || 0)) * 0.02);
  return sum / items.length;
}
// snapshot: saída de WORLD_BOSS.combatSnapshot (reaproveitada, não duplicada).
// eq: save.eq real (pra extrair rarity/enchant, que o snapshot não carrega).
function powerScore(snapshot, eq) {
  if (!snapshot) return 0;
  const skillTotal = Object.values(snapshot.skills || {}).reduce((a, b) => a + b, 0);
  const base = snapshot.lvl * 10 + snapshot.atk * 2.2 + snapshot.def * 3 + snapshot.maxHp * 0.35 + snapshot.block * 400 + skillTotal * 8;
  return Math.max(1, Math.round(base * gearQualityFactor(eq)));
}

// ===== Balanceamento (enumeração exata, não greedy) =====
function combinationsContainingFirst(n, k) {
  // todas as combinações de tamanho k dos índices 0..n-1 que contêm o
  // índice 0 -- evita enumerar o par complementar (A,B) e (B,A) duas vezes.
  const out = [];
  function rec(start, combo) {
    if (combo.length === k) { out.push(combo.slice()); return; }
    for (let i = start; i < n; i++) { combo.push(i); rec(i + 1, combo); combo.pop(); }
  }
  rec(1, [0]);
  return out;
}
const TVT_CLASSES = Object.freeze(['guerreiro', 'druida', 'mago', 'arqueiro']);
// Penalidade pequena de composição -- só pesa quando a diferença de UMA
// classe entre os times é >=2 (ex.: 3 Druidas vs 0), nunca sobrepõe uma
// diferença real de powerScore (critério secundário, não regra rígida).
function classComposePenalty(teamA, teamB) {
  let penalty = 0;
  for (const cls of TVT_CLASSES) {
    const a = teamA.filter(p => p.cls === cls).length, b = teamB.filter(p => p.cls === cls).length;
    const diff = Math.abs(a - b);
    if (diff >= 2) penalty += diff;
  }
  return penalty;
}
// players: [{charId, cls, powerScore, ...}], SEM reserva (tamanho já par).
// Retorna {red:[charId...], blue:[charId...], diff, penalty} ou null se
// não der pra dividir (tamanho <2 ou ímpar -- quem chama já tratou reserva).
function balanceTvtTeams(players) {
  const n = players.length;
  if (n < 2 || n % 2 !== 0) return null;
  const half = n / 2;
  let best = null;
  for (const combo of combinationsContainingFirst(n, half)) {
    const setA = new Set(combo);
    const teamA = combo.map(i => players[i]);
    const teamB = players.filter((_, i) => !setA.has(i));
    const sumA = teamA.reduce((s, p) => s + p.powerScore, 0), sumB = teamB.reduce((s, p) => s + p.powerScore, 0);
    const diff = Math.abs(sumA - sumB), penalty = classComposePenalty(teamA, teamB);
    // diff de powerScore sempre domina (peso 10x) -- composição só desempata
    // combinações muito próximas em powerScore, nunca sacrifica o
    // balanceamento por causa da classe.
    const score = diff * 10 + penalty;
    if (!best || score < best.score) best = { score, teamA, teamB, diff, penalty };
  }
  return { red: best.teamA.map(p => p.charId), blue: best.teamB.map(p => p.charId), diff: best.diff, penalty: best.penalty };
}

// ===== Skills (as 4 classes reais, 12 skills, auditados contra o cliente) =====
// Cooldowns reais (index.html CLASSES[cls].skills[].cd, em segundos ->ms) --
// espelha exatamente server.js SKILL_CD_MS (fonte global de PvE/PvP de
// campo), repetido aqui só porque game-data/*.js não importa server.js
// (mesmo padrão que world-boss.js já usa pra CLASS_BASE/BASIC_CD_MS).
const TVT_SKILL_CD_MS = Object.freeze({
  spin: 5000, dash: 4000, warcry: 18000,
  heal: 7000, roots: 9000, thorns: 10000,
  fireball: 4000, frost: 7000, barrier: 16000,
  multi: 4000, evade: 5000, pierce: 8000,
});
const TVT_CLASS_SKILLS = WORLD_BOSS.CLASS_SKILLS; // mesmo objeto, reaproveitado
const TVT_DAMAGE_SKILLS = WORLD_BOSS.DAMAGE_SKILLS; // spin/dash/roots/thorns/fireball/frost/multi/pierce
const TVT_BUFF_SKILLS = new Set(['warcry', 'barrier', 'evade']); // self-only
// Multiplicador de dano por skill+rank -- espelha skillDamageMul() do
// cliente E o skillMul() interno de world-boss.js (não exportado de lá,
// reimplementado aqui como dado puro, sem risco -- são só números).
function tvtSkillMul(id, r) {
  return ({ spin: 1.4 + .3 * (r - 1), dash: 1.2 + .25 * (r - 1), roots: .8 + .2 * (r - 1), thorns: .45 + .1 * (r - 1), fireball: 1.8 + .4 * (r - 1), frost: 1 + .25 * (r - 1), multi: .75 + .05 * (r - 1), pierce: 2.2 + .4 * (r - 1) })[id] || 0;
}
function tvtHealAmt(lvl, r) { return 45 + 5 * lvl + 18 * (r - 1); }
function tvtBarrierAmt(lvl, r) { return 40 + 6 * lvl + 20 * (r - 1); }
function tvtWarcry(r) { return { atkMul: .3 + .1 * (r - 1), defBonus: 4 + 2 * (r - 1), durationMs: (6 + 2 * (r - 1)) * 1000 }; }
function tvtRootMs(r) { return (2 + .5 * (r - 1)) * 1000; }
function tvtSlowMs(r) { return (3 + (r - 1)) * 1000; }
const TVT_EVADE_MS = 500;
const TVT_BARRIER_MS = 8000;
const TVT_THORNS_LIFE_MS = 3000, TVT_THORNS_TICK_MS = 600;

// ===== Instância =====
function shortTvtId(eventId) { return Number(String(eventId).split(':').pop()).toString(36).slice(-8).padStart(6, '0'); }
function tvtMapId(eventId) { return `tvt#${shortTvtId(eventId)}`; }
function freshStatuses() {
  return { rootUntil: 0, slowUntil: 0, barrierUntil: 0, barrierAmt: 0, evadeUntil: 0, warcryUntil: 0, warcryAtkMul: 0, warcryDefBonus: 0, thornsUntil: 0, thornsTickAt: 0, thornsMul: 0, thornsOwner: null };
}
// members: [{userId,charId,name,cls,lvl,team,snapshot,eq}] -- snapshot e eq
// já resolvidos por quem chama (server.js, a partir do Supabase real).
function createTvtInstance({ eventId, members, now = Date.now() }) {
  const mapId = tvtMapId(eventId), players = new Map();
  const redCount = members.filter(m => m.team === 'red').length, blueCount = members.filter(m => m.team === 'blue').length;
  for (const m of members) {
    const spawn = TVT_SPAWN[m.team];
    players.set(m.charId, {
      userId: m.userId, charId: m.charId, name: m.name, cls: m.cls, lvl: m.lvl, team: m.team, snapshot: m.snapshot,
      hp: m.snapshot.maxHp, maxHp: m.snapshot.maxHp, dead: false, respawnAt: 0, protectedUntil: now + TVT_SPAWN_PROTECTION_MS,
      online: true, x: spawn.x, y: spawn.y, lastAttackAt: 0, skillCd: {}, statuses: freshStatuses(),
      kills: 0, legitKills: 0, deaths: 0, damageDone: 0, healDone: 0, lastActivityAt: now, respawnGrantedAt: now, rewarded: false,
    });
  }
  return {
    id: `${eventId}#tvt`, eventId, mapId, players,
    score: { red: 0, blue: 0 }, scoreLimit: scoreLimitForTeamSize(Math.max(redCount, blueCount)),
    startedAt: now, expiresAt: now + TVT_DURATION_MS, previousLocations: new Map(),
    finished: false, rewardsGranted: false, state: 'active', endedReason: null, winner: null,
  };
}

// ===== Combate (server-authoritative, target-based) =====
// Simplificação documentada: todo skill (mesmo os que no mapa de campo são
// AoE, como spin/frost/roots) age sobre UM alvo declarado (targetId) dentro
// do TvT -- protocolo de intenção do cliente já manda targetId pra
// ataque/skill (ver spec), e resolver múltiplos alvos simultâneos com a
// mesma garantia de anti-forjamento aumentaria muito o escopo desta fase
// sem mudar nenhuma das garantias de autoridade pedidas. Ver LEIA-PRIMEIRO.md.
function baseDamageOf(p) {
  const cfg = WORLD_BOSS.CLASS_BASE[p.cls] || WORLD_BOSS.CLASS_BASE.guerreiro;
  return cfg.dmg0 + cfg.dmgL * (p.lvl - 1) + p.snapshot.atk;
}
function clearProtectionOnAction(p, now) { if (p.protectedUntil > now) p.protectedUntil = 0; }

function resolveTvtIntent(instance, attackerCharId, intent = {}, now = Date.now(), rng = Math.random) {
  if (!instance || instance.state !== 'active') return { ok: false, error: 'INSTANCE_INACTIVE' };
  const attacker = instance.players.get(attackerCharId);
  if (!attacker || attacker.dead || !attacker.online) return { ok: false, error: 'PLAYER_UNAVAILABLE' };
  const skillId = String(intent.skill || 'basic').slice(0, 16);
  const targetIdRaw = typeof intent.targetId === 'string' ? intent.targetId.slice(0, 64) : '';

  // ---- buffs self-only (warcry/barrier/evade) ----
  if (TVT_BUFF_SKILLS.has(skillId)) {
    if (!(TVT_CLASS_SKILLS[attacker.cls] || []).includes(skillId)) return { ok: false, error: 'INVALID_SKILL' };
    if (now < (attacker.skillCd[skillId] || 0)) return { ok: false, error: 'COOLDOWN' };
    attacker.skillCd[skillId] = now + TVT_SKILL_CD_MS[skillId];
    attacker.lastActivityAt = now; clearProtectionOnAction(attacker, now);
    const rank = (attacker.snapshot.skills || {})[skillId] || 1;
    if (skillId === 'warcry') { const w = tvtWarcry(rank); attacker.statuses.warcryUntil = now + w.durationMs; attacker.statuses.warcryAtkMul = w.atkMul; attacker.statuses.warcryDefBonus = w.defBonus; }
    else if (skillId === 'barrier') { attacker.statuses.barrierUntil = now + TVT_BARRIER_MS; attacker.statuses.barrierAmt = tvtBarrierAmt(attacker.lvl, rank); }
    else if (skillId === 'evade') { attacker.statuses.evadeUntil = now + TVT_EVADE_MS; }
    return { ok: true, kind: 'buff', skill: skillId, charId: attackerCharId };
  }

  // ---- heal: aliado (ou self) valido, server-side, nunca ultrapassa maxHp ----
  if (skillId === 'heal') {
    if (attacker.cls !== 'druida') return { ok: false, error: 'INVALID_SKILL' };
    if (now < (attacker.skillCd.heal || 0)) return { ok: false, error: 'COOLDOWN' };
    const target = targetIdRaw ? instance.players.get(targetIdRaw) : attacker;
    if (!target || target.dead || !target.online) return { ok: false, error: 'TARGET_INVALID' };
    if (target.team !== attacker.team) return { ok: false, error: 'INVALID_TARGET' };
    if (Math.hypot(target.x - attacker.x, target.y - attacker.y) > 400) return { ok: false, error: 'OUT_OF_RANGE' };
    attacker.skillCd.heal = now + TVT_SKILL_CD_MS.heal;
    attacker.lastActivityAt = now; clearProtectionOnAction(attacker, now);
    const rank = (attacker.snapshot.skills || {}).heal || 1, amount = tvtHealAmt(attacker.lvl, rank);
    const healed = Math.max(0, Math.min(amount, target.maxHp - target.hp));
    target.hp = Math.min(target.maxHp, target.hp + amount);
    attacker.healDone += healed;
    return { ok: true, kind: 'heal', charId: attackerCharId, targetId: target.charId, amount: healed, hp: target.hp, maxHp: target.maxHp };
  }

  // ---- basic / skills de dano: alvo inimigo obrigatorio ----
  if (!targetIdRaw || targetIdRaw === attackerCharId) return { ok: false, error: 'INVALID_TARGET' };
  const target = instance.players.get(targetIdRaw);
  if (!target || target.dead || !target.online) return { ok: false, error: 'TARGET_UNAVAILABLE' };
  if (target.team === attacker.team) return { ok: false, error: 'FRIENDLY_FIRE' };
  if (Math.hypot(target.x - attacker.x, target.y - attacker.y) > 550) return { ok: false, error: 'OUT_OF_RANGE' };

  const base = baseDamageOf(attacker);
  let dmg, rank = 1;
  if (skillId === 'basic') {
    if (now - attacker.lastAttackAt < (attacker.snapshot.basicCdMs || 420)) return { ok: false, error: 'COOLDOWN' };
    attacker.lastAttackAt = now;
    dmg = Math.round(base) + Math.floor(rng() * 4);
  } else {
    if (!TVT_DAMAGE_SKILLS.has(skillId) || !(TVT_CLASS_SKILLS[attacker.cls] || []).includes(skillId)) return { ok: false, error: 'INVALID_SKILL' };
    if (now < (attacker.skillCd[skillId] || 0)) return { ok: false, error: 'COOLDOWN' };
    attacker.skillCd[skillId] = now + TVT_SKILL_CD_MS[skillId];
    rank = (attacker.snapshot.skills || {})[skillId] || 1;
    dmg = Math.round((base + 2) * tvtSkillMul(skillId, rank));
  }
  if (attacker.statuses.warcryUntil > now) dmg = Math.round(dmg * (1 + attacker.statuses.warcryAtkMul));
  dmg = Math.max(1, Math.min(6500, dmg));
  attacker.lastActivityAt = now; clearProtectionOnAction(attacker, now);

  // ---- lado do alvo: evasão/protecao de spawn negam antes da mitigacao ----
  if (target.statuses.evadeUntil > now) return { ok: true, kind: 'damage', evaded: true, charId: attackerCharId, targetId: targetIdRaw, damage: 0, skill: skillId };
  if (target.protectedUntil > now) return { ok: true, kind: 'damage', blocked: 'protection', charId: attackerCharId, targetId: targetIdRaw, damage: 0, skill: skillId };

  let mitigated = Math.max(1, Math.round(dmg - (target.snapshot.def + (target.statuses.warcryUntil > now ? target.statuses.warcryDefBonus : 0)) * .45));
  if (target.statuses.barrierUntil > now && target.statuses.barrierAmt > 0) {
    const absorbed = Math.min(target.statuses.barrierAmt, mitigated);
    target.statuses.barrierAmt -= absorbed; mitigated -= absorbed;
    if (target.statuses.barrierAmt <= 0) { target.statuses.barrierUntil = 0; target.statuses.barrierAmt = 0; }
  }
  if (mitigated > 0 && target.snapshot.block > 0 && rng() < target.snapshot.block) mitigated = Math.max(0, Math.round(mitigated * .5));

  attacker.damageDone += mitigated;
  target.hp = Math.max(0, target.hp - mitigated);
  if (skillId === 'roots') target.statuses.rootUntil = now + tvtRootMs(rank);
  else if (skillId === 'frost') target.statuses.slowUntil = now + tvtSlowMs(rank);
  else if (skillId === 'thorns') { target.statuses.thornsUntil = now + TVT_THORNS_LIFE_MS; target.statuses.thornsMul = .45 + .1 * (rank - 1); target.statuses.thornsOwner = attackerCharId; target.statuses.thornsTickAt = now; }

  let killed = false, scoreTeam = null;
  if (target.hp <= 0 && !target.dead) {
    // Detecção leve de "farm" (documentada, não bloqueia conta -- só afeta
    // elegibilidade de recompensa): vítima nunca agiu desde o último
    // respawn/entrada E morreu dentro da janela de proteção+curta margem ->
    // o bônus de kill NÃO entra na contribuição do atacante (o dano em si
    // continua contando normalmente).
    const neverActedSinceSpawn = target.lastActivityAt <= target.respawnGrantedAt;
    const farmed = neverActedSinceSpawn && (now - target.respawnGrantedAt) < (TVT_SPAWN_PROTECTION_MS + 1500);
    target.dead = true; target.respawnAt = now + TVT_RESPAWN_MS; target.deaths += 1;
    attacker.kills += 1; if (!farmed) attacker.legitKills += 1;
    instance.score[attacker.team] += 1; scoreTeam = attacker.team; killed = true;
  }
  return { ok: true, kind: 'damage', charId: attackerCharId, targetId: targetIdRaw, damage: mitigated, targetHp: target.hp, targetMaxHp: target.maxHp, killed, scoreTeam, skill: skillId };
}

// ===== Tick: respawn + expiração de status + DoT do campo de espinhos =====
function tickTvtRespawns(instance, now = Date.now()) {
  const out = [];
  for (const p of instance.players.values()) {
    if (p.dead && now >= p.respawnAt) {
      p.dead = false; p.hp = p.maxHp; p.respawnAt = 0; p.protectedUntil = now + TVT_SPAWN_PROTECTION_MS; p.respawnGrantedAt = now;
      const spawn = TVT_SPAWN[p.team]; p.x = spawn.x; p.y = spawn.y;
      out.push(p.charId);
    }
  }
  return out;
}
// Expira status vencidos (limpeza -- nunca deixa um Until no passado
// "vazando" pra sempre true por engano numa checagem futura).
function tickTvtStatusExpiry(instance, now = Date.now()) {
  for (const p of instance.players.values()) {
    const s = p.statuses;
    if (s.rootUntil && now >= s.rootUntil) s.rootUntil = 0;
    if (s.slowUntil && now >= s.slowUntil) s.slowUntil = 0;
    if (s.evadeUntil && now >= s.evadeUntil) s.evadeUntil = 0;
    if (s.warcryUntil && now >= s.warcryUntil) { s.warcryUntil = 0; s.warcryAtkMul = 0; s.warcryDefBonus = 0; }
    if (s.barrierUntil && (now >= s.barrierUntil || s.barrierAmt <= 0)) { s.barrierUntil = 0; s.barrierAmt = 0; }
    if (s.thornsUntil && now >= s.thornsUntil) { s.thornsUntil = 0; s.thornsMul = 0; s.thornsOwner = null; }
  }
}
// Campo de espinhos: dano periódico enquanto thornsUntil > now, sobre a
// própria vítima marcada (ver resolveTvtIntent) -- adaptação single-target
// da zona de área do cliente (mesma simplificação documentada acima).
function tickTvtThorns(instance, now = Date.now(), rng = Math.random) {
  const events = [];
  for (const p of instance.players.values()) {
    if (p.dead || !(p.statuses.thornsUntil > now)) continue;
    if (now - (p.statuses.thornsTickAt || 0) < TVT_THORNS_TICK_MS) continue;
    p.statuses.thornsTickAt = now;
    const owner = instance.players.get(p.statuses.thornsOwner);
    if (!owner || owner.team === p.team) continue;
    const dmg = Math.max(1, Math.round((baseDamageOf(owner) + 2) * p.statuses.thornsMul));
    const mitigated = Math.max(1, Math.round(dmg - p.snapshot.def * .45));
    owner.damageDone += mitigated;
    p.hp = Math.max(0, p.hp - mitigated);
    let killed = false;
    if (p.hp <= 0 && !p.dead) {
      const neverActedSinceSpawn = p.lastActivityAt <= p.respawnGrantedAt;
      const farmed = neverActedSinceSpawn && (now - p.respawnGrantedAt) < (TVT_SPAWN_PROTECTION_MS + 1500);
      p.dead = true; p.respawnAt = now + TVT_RESPAWN_MS; p.deaths += 1;
      owner.kills += 1; if (!farmed) owner.legitKills += 1;
      instance.score[owner.team] += 1; killed = true;
    }
    events.push({ charId: owner.charId, targetId: p.charId, damage: mitigated, targetHp: p.hp, killed, scoreTeam: killed ? owner.team : null, skill: 'thorns' });
  }
  return events;
}

// ===== Fim de partida =====
function checkTvtEnd(instance, now = Date.now()) {
  if (instance.finished) return null;
  if (instance.score.red >= instance.scoreLimit) return { reason: 'score', winner: 'red' };
  if (instance.score.blue >= instance.scoreLimit) return { reason: 'score', winner: 'blue' };
  if (now >= instance.expiresAt) {
    if (instance.score.red === instance.score.blue) return { reason: 'timeout', winner: null };
    return { reason: 'timeout', winner: instance.score.red > instance.score.blue ? 'red' : 'blue' };
  }
  return null;
}

// ===== Contribuição / elegibilidade de recompensa =====
function tvtContributionScore(p) { return (p.damageDone || 0) + (p.healDone || 0) * 1.5 + (p.legitKills || 0) * 50; }
function isTvtEligible(p, instance, now = Date.now()) {
  if (!p) return false;
  if (tvtContributionScore(p) >= TVT_MIN_CONTRIBUTION) return true;
  return (now - (p.lastActivityAt || instance.startedAt)) < TVT_ELIGIBLE_IDLE_MS;
}
function outcomeForTeam(team, winner) { return winner === null ? 'draw' : (winner === team ? 'win' : 'loss'); }
function tvtRewardFor(outcome) { return TVT_REWARD[outcome] || TVT_REWARD.draw; }

// ===== Estado público (pro cliente) =====
function publicTvtState(instance, now = Date.now()) {
  return {
    type: 'tvt_state', serverNow: now, mapId: instance.mapId, state: instance.state,
    score: { ...instance.score }, scoreLimit: instance.scoreLimit, expiresAt: instance.expiresAt,
    winner: instance.winner, endedReason: instance.endedReason,
    players: [...instance.players.values()].map(p => ({
      charId: p.charId, name: p.name, cls: p.cls, team: p.team, hp: p.hp, maxHp: p.maxHp,
      dead: p.dead, respawnAt: p.respawnAt, online: p.online, kills: p.kills, deaths: p.deaths,
      protected: p.protectedUntil > now,
    })),
  };
}

module.exports = {
  TVT_MAP_RE, TVT_MAX_PLAYERS, TVT_MIN_PLAYERS, TVT_DURATION_MS, TVT_RESPAWN_MS, TVT_SPAWN_PROTECTION_MS,
  TVT_TEAM_IDS, TVT_TEAM_LABELS, TVT_ARENA, TVT_SPAWN, TVT_REWARD, TVT_MIN_CONTRIBUTION,
  TVT_SKILL_CD_MS, TVT_CLASS_SKILLS, TVT_DAMAGE_SKILLS, TVT_BUFF_SKILLS,
  scoreLimitForTeamSize, powerScore, gearQualityFactor, balanceTvtTeams,
  tvtSkillMul, tvtHealAmt, tvtBarrierAmt, tvtWarcry, tvtRootMs, tvtSlowMs,
  tvtMapId, shortTvtId, createTvtInstance, resolveTvtIntent,
  tickTvtRespawns, tickTvtStatusExpiry, tickTvtThorns, checkTvtEnd,
  tvtContributionScore, isTvtEligible, outcomeForTeam, tvtRewardFor, publicTvtState,
};
