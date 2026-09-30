'use strict';

// Fase 6 - Endgame Lv40. Modulo puro; servidor continua autoridade.
const MASTERY_MAX_RANK = 100;
const MASTERY_XP_BASE = 1000;
const MASTERY_XP_GROWTH = 1.08;
const ENDGAME_CURRENCY_MAX = 999999;
const TALENT_CLASSES = ['guerreiro','arqueiro','mago','druida'];
const DIFFICULTIES = Object.freeze({
  normal:  { hp:1.00, damage:1.00, mastery:1.00, essence:1.00, minRank:0 },
  hard:    { hp:1.45, damage:1.25, mastery:1.35, essence:1.35, minRank:5 },
  heroic:  { hp:2.00, damage:1.55, mastery:1.75, essence:1.75, minRank:15 },
  mythic:  { hp:2.80, damage:1.90, mastery:2.40, essence:2.40, minRank:30 },
});
const ENDGAME_REWARDS = Object.freeze({
  DUNGEON: Object.freeze({ MASTERY_XP:250, ESSENCE:8, REWARDED_CLEARS_PER_DAY:3 }),
  WORLD_BOSS: Object.freeze({ MASTERY_XP:600, ESSENCE:25, REWARDED_EVENTS_PER_DAY:1, ESSENCE_EVENTS_PER_WEEK:3 }),
});
const TALENTS = Object.freeze({
  guerreiro: ['fortaleza','bloqueio','provocacao','furia','contra_ataque','bastiao'],
  arqueiro: ['precisao','agilidade','perfuracao','armadilha','rajada','olho_de_aguia'],
  mago: ['foco_arcano','mana','impacto','combustao','barreira','arquimago'],
  druida: ['vitalidade','cura','espinhos','regeneracao','natureza','guardiao'],
});
const REPUTATION_TIERS = Object.freeze([
  { id:'neutral', min:0 }, { id:'friendly', min:1000 }, { id:'honored', min:3000 },
  { id:'revered', min:7000 }, { id:'exalted', min:15000 },
]);

function masteryXpToNext(rank) {
  const r=Math.max(0,Math.min(MASTERY_MAX_RANK,Math.floor(Number(rank)||0)));
  return r>=MASTERY_MAX_RANK?0:Math.round(MASTERY_XP_BASE*Math.pow(MASTERY_XP_GROWTH,r));
}
function cleanInt(v,max=999999){return Math.max(0,Math.min(max,Math.floor(Number(v)||0)))}
function sanitizeTalentState(raw, cls) {
  const t=raw&&typeof raw==='object'?raw:{}, allowed=new Set(TALENTS[cls]||[]);
  const spent={};
  if(t.spent&&typeof t.spent==='object') for(const [id,v] of Object.entries(t.spent)) if(allowed.has(id)) spent[id]=Math.min(5,cleanInt(v,5));
  return { spent };
}
function talentPointsForRank(rank){return Math.floor(cleanInt(rank,MASTERY_MAX_RANK)/5)}
function spentTalentPoints(t){return Object.values((t&&t.spent)||{}).reduce((a,b)=>a+cleanInt(b,5),0)}
function allocateTalent(endgame,cls,id) {
  const e=sanitizeEndgame(endgame,cls), allowed=TALENTS[cls]||[];
  if(!allowed.includes(id)) return {error:'TALENT_NOT_FOUND',endgame:e};
  const used=spentTalentPoints(e.talents), available=talentPointsForRank(e.rank);
  if(used>=available) return {error:'NO_TALENT_POINTS',endgame:e};
  const current=e.talents.spent[id]||0;
  if(current>=5) return {error:'TALENT_MAX',endgame:e};
  e.talents.spent[id]=current+1; return {endgame:e};
}
function reputationTier(points) {
  const p=cleanInt(points); let tier=REPUTATION_TIERS[0];
  for(const t of REPUTATION_TIERS) if(p>=t.min) tier=t;
  return tier.id;
}
function sanitizeReputation(raw) {
  const r=raw&&typeof raw==='object'?raw:{}, out={};
  for(const id of ['vila','floresta','cripta','serra','pantano','torre','ilhas','vulcao']) out[id]=cleanInt(r[id],15000);
  return out;
}

function sanitizeEndgameRewardState(raw) {
  const r=raw&&typeof raw==='object'?raw:{};
  return {d:typeof r.d==='string'?r.d.slice(0,10):'',dungeon:cleanInt(r.dungeon,99),worldBoss:cleanInt(r.worldBoss,99),
    w:typeof r.w==='string'?r.w.slice(0,8):'',worldBossEssence:cleanInt(r.worldBossEssence,99)};
}
function sanitizeEndgame(raw,cls) {
  const e=raw&&typeof raw==='object'?raw:{};
  const rank=cleanInt(e.rank,MASTERY_MAX_RANK);
  let xp=cleanInt(e.xp);
  xp=rank>=MASTERY_MAX_RANK?0:Math.min(xp,masteryXpToNext(rank)-1);
  const out={rank,xp,essence:cleanInt(e.essence,ENDGAME_CURRENCY_MAX),
    rewards:sanitizeEndgameRewardState(e.rewards), reputation:sanitizeReputation(e.reputation)};
  out.talents=sanitizeTalentState(e.talents,cls);
  return out;
}
function applyMasteryXp(raw,gain,playerLevel,cls) {
  const e=sanitizeEndgame(raw,cls);
  if(Number(playerLevel)!==40||e.rank>=MASTERY_MAX_RANK)return Object.assign(e,{gained:0,ranksGained:0});
  const start=e.rank,g=cleanInt(gain); e.xp+=g;
  while(e.rank<MASTERY_MAX_RANK&&e.xp>=masteryXpToNext(e.rank)){e.xp-=masteryXpToNext(e.rank);e.rank++}
  if(e.rank>=MASTERY_MAX_RANK)e.xp=0;
  return Object.assign(e,{gained:g,ranksGained:e.rank-start});
}
function addEssence(raw,gain,cls){const e=sanitizeEndgame(raw,cls);e.essence=cleanInt(e.essence+cleanInt(gain),ENDGAME_CURRENCY_MAX);return e}
function difficultyFor(id,rank){const d=DIFFICULTIES[id]||DIFFICULTIES.normal;return cleanInt(rank,100)>=d.minRank?d:null}
function endgameSetBonus(pieceCount) {
  const n=cleanInt(pieceCount,6);
  return {two:n>=2?{hpPct:5}:null,four:n>=4?{atkPct:5,defPct:5}:null,six:n>=6?{hpPct:5,atkPct:5,defPct:5}:null};
}
function addReputation(raw,zone,gain,cls){const e=sanitizeEndgame(raw,cls);if(Object.hasOwn(e.reputation,zone))e.reputation[zone]=cleanInt(e.reputation[zone]+cleanInt(gain),15000);return e}

module.exports={MASTERY_MAX_RANK,MASTERY_XP_BASE,MASTERY_XP_GROWTH,ENDGAME_CURRENCY_MAX,ENDGAME_REWARDS,
  TALENTS,DIFFICULTIES,REPUTATION_TIERS,masteryXpToNext,sanitizeEndgame,applyMasteryXp,addEssence,
  sanitizeEndgameRewardState,talentPointsForRank,spentTalentPoints,allocateTalent,reputationTier,addReputation,
  difficultyFor,endgameSetBonus};
