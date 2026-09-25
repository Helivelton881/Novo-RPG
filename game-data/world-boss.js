'use strict';

const WORLD_BOSS_MAP_RE=/^wb#[0-9a-z]{6,10}#[A-Z2-9]{6}$/;
const WORLD_BOSS_DURATION_MS=10*60*1000;
const WORLD_BOSS_RESPAWN_MS=10*1000;
const WORLD_BOSS_TARGET_TTK_SECONDS=300;
const WORLD_BOSS_MIN_CONTRIBUTION=.01;
const WORLD_BOSS_REWARD=Object.freeze({gold:360,gem:18,xp:18000});
const BOSS_ATTACKS=Object.freeze({normal:Object.freeze({name:'Golpe do Titã',telegraphMs:500,range:95,hpRatio:.18}),heavy:Object.freeze({name:'Impacto Ancestral',telegraphMs:1200,range:150,hpRatio:.32}),aoe:Object.freeze({name:'Onda Sísmica',telegraphMs:1500,range:280,hpRatio:.30})});
const CLASS_BASE=Object.freeze({
  guerreiro:{dmg0:11,dmgL:3.2,hp0:130,hpL:20,def0:4,block:0},
  druida:{dmg0:9,dmgL:2.8,hp0:112,hpL:17,def0:3,block:0},
  mago:{dmg0:13,dmgL:3.7,hp0:90,hpL:13,def0:2,block:0},
  arqueiro:{dmg0:10,dmgL:3,hp0:104,hpL:15,def0:3,block:0},
});
const BASIC_CD_MS=Object.freeze({guerreiro:420,druida:500,mago:620,arqueiro:400});
const CLASS_SKILLS=Object.freeze({guerreiro:['spin','dash','warcry'],druida:['heal','roots','thorns'],mago:['fireball','frost','barrier'],arqueiro:['multi','evade','pierce']});
const DAMAGE_SKILLS=new Set(['spin','dash','roots','thorns','fireball','frost','multi','pierce']);
const SKILL_CD_MS=Object.freeze({spin:5000,dash:4000,roots:9000,thorns:10000,fireball:4000,frost:7000,multi:4000,pierce:8000});
function skillMul(id,r){return({spin:1.4+.3*(r-1),dash:1.2+.25*(r-1),roots:.8+.2*(r-1),thorns:.45+.1*(r-1),fireball:1.8+.4*(r-1),frost:1+.25*(r-1),multi:.75+.05*(r-1),pierce:2.2+.4*(r-1)})[id]||0}
function finite(v,fallback=0){v=Number(v);return Number.isFinite(v)?v:fallback}
function equipmentTotals(eq={}){let atk=0,def=0,hp=0,block=0,speed=0;for(const it of Object.values(eq||{})){if(!it)continue;atk+=finite(it.atk);def+=finite(it.def);hp+=finite(it.hp);block+=finite(it.blk);speed+=finite(it.spd)}return{atk,def,hp,block,speed}}
function combatSnapshot({userId,charId,name,cls,lvl,save}){
  cls=CLASS_BASE[cls]?cls:'guerreiro';lvl=Math.max(1,Math.min(99,Math.round(finite(lvl,1))));const base=CLASS_BASE[cls],gear=equipmentTotals(save&&save.eq);
  const skills={};for(const id of CLASS_SKILLS[cls])skills[id]=Math.max(1,Math.min(3,Math.round(finite(save&&save.sk&&save.sk[id],1))));
  const weaponMul=cls==='guerreiro'?1.3:cls==='arqueiro'?1.2:1.15;
  return Object.freeze({userId,charId,name:String(name||'Herói').slice(0,14),cls,lvl,skills,atk:Math.round(gear.atk*weaponMul),def:Math.round(base.def0+gear.def),maxHp:Math.max(50,Math.round(base.hp0+base.hpL*(lvl-1)+gear.hp)),block:Math.max(0,Math.min(.5,gear.block)),speed:Math.max(0,Math.min(.8,gear.speed)),basicCdMs:BASIC_CD_MS[cls]});
}
function estimateWorldBossDps(p){
  const base=CLASS_BASE[p.cls]||CLASS_BASE.guerreiro,basic=Math.max(1,base.dmg0+base.dmgL*(p.lvl-1)+p.atk),basicDps=basic/(p.basicCdMs/1000);
  let skillDps=0;for(const [id,rank]of Object.entries(p.skills||{}))if(DAMAGE_SKILLS.has(id))skillDps+=((basic+2)*skillMul(id,rank))/(SKILL_CD_MS[id]/1000);
  return Math.max(1,Math.min(25000,basicDps+skillDps*.72));
}
function calculateWorldBossHp(party){const dps=(party||[]).reduce((n,p)=>n+estimateWorldBossDps(p),0);return Math.max(1000,Math.min(50000000,Math.round(dps*WORLD_BOSS_TARGET_TTK_SECONDS)))}
function validatePartyRegistration({party,requesterUserId,activeByUser,bagHasSpace}){
  if(!party)return{ok:false,error:'Entre em um grupo com 4 jogadores.'};if(party.ownerId!==requesterUserId)return{ok:false,error:'Apenas o líder pode inscrever o grupo.'};
  const ids=[...party.members.keys()];if(ids.length!==4)return{ok:false,error:`Grupo incompleto: ${ids.length}/4.`};const members=[];const chars=new Set();
  for(const userId of ids){const active=activeByUser(userId);if(!active)return{ok:false,error:'Todos os 4 jogadores precisam estar online com um personagem ativo.'};if(chars.has(active.charId))return{ok:false,error:'Personagens duplicados no grupo.'};chars.add(active.charId);if(bagHasSpace&&!bagHasSpace(active))return{ok:false,error:'Libere pelo menos 1 espaço na mochila antes de entrar no World Boss.'};members.push({...active,userId})}
  return{ok:true,members};
}
function shortEventId(eventId){return Number(String(eventId).split(':').pop()).toString(36).slice(-8).padStart(6,'0')}
function worldBossMapId(eventId,partyCode){return`wb#${shortEventId(eventId)}#${partyCode}`}
function createWorldBossInstance({eventId,partyCode,members,now=Date.now()}){
  const maxHp=calculateWorldBossHp(members),mapId=worldBossMapId(eventId,partyCode),players=new Map();
  for(const m of members)players.set(m.charId,{...m,hp:m.maxHp,dead:false,respawnAt:0,online:true,x:720,y:1280,lastAttackAt:0,skillCd:{},rewarded:false});
  return{id:`${eventId}#${partyCode}`,eventId,partyCode,mapId,members:players,boss:{id:'ancient_titan',type:'ancient_titan',name:'Titã Ancestral',x:1440,y:900,hp:maxHp,maxHp,state:'idle',attack:'normal',telegraphUntil:0,nextAttackAt:now+2500,targetCharId:null},startedAt:now,expiresAt:now+WORLD_BOSS_DURATION_MS,previousLocations:new Map(),damageByChar:new Map(),defeated:false,rewardGranted:false,state:'active'};
}
function resolveWorldBossDamage(instance,charId,intent={},now=Date.now(),rng=Math.random){
  if(!instance||instance.state!=='active'||instance.defeated)return{ok:false,error:'INSTANCE_INACTIVE'};const p=instance.members.get(charId);if(!p||p.dead||!p.online)return{ok:false,error:'PLAYER_UNAVAILABLE'};
  if(Math.hypot(instance.boss.x-p.x,instance.boss.y-p.y)>550)return{ok:false,error:'OUT_OF_RANGE'};const skill=String(intent.skill||'basic').slice(0,16);let dmg;
  const baseCfg=CLASS_BASE[p.cls]||CLASS_BASE.guerreiro,base=baseCfg.dmg0+baseCfg.dmgL*(p.lvl-1)+p.atk;
  if(skill==='basic'){if(now-p.lastAttackAt<p.basicCdMs)return{ok:false,error:'COOLDOWN'};p.lastAttackAt=now;dmg=Math.round(base)+Math.floor(rng()*4)}
  else{if(!(CLASS_SKILLS[p.cls]||[]).includes(skill)||!DAMAGE_SKILLS.has(skill))return{ok:false,error:'INVALID_SKILL'};if(now<(p.skillCd[skill]||0))return{ok:false,error:'COOLDOWN'};p.skillCd[skill]=now+(SKILL_CD_MS[skill]||1000);dmg=Math.round((base+2)*skillMul(skill,p.skills[skill]||1)*(intent.splash?.6:1))}
  dmg=Math.max(1,Math.min(6500,dmg));const applied=Math.min(instance.boss.hp,dmg);instance.boss.hp-=applied;instance.damageByChar.set(charId,(instance.damageByChar.get(charId)||0)+applied);if(instance.boss.hp<=0){instance.boss.hp=0;instance.defeated=true;instance.state='defeated'}return{ok:true,damage:applied,defeated:instance.defeated};
}
function applyBossDamage(instance,charId,rawDamage,now=Date.now(),rng=Math.random){const p=instance.members.get(charId);if(!p||p.dead||!p.online)return null;let dmg=Math.max(1,Math.round(finite(rawDamage)-p.def*.45));if(p.block>0&&rng()<p.block)dmg=Math.max(1,Math.round(dmg*.5));dmg=Math.min(dmg,Math.max(1,Math.floor(p.maxHp*.35)));p.hp=Math.max(0,p.hp-dmg);if(!p.hp){p.dead=true;p.respawnAt=now+WORLD_BOSS_RESPAWN_MS}return{charId,hp:p.hp,maxHp:p.maxHp,dead:p.dead,respawnAt:p.respawnAt,damage:dmg}}
function eligibleMembers(instance){const min=Math.max(1,Math.ceil(instance.boss.maxHp*WORLD_BOSS_MIN_CONTRIBUTION));return[...instance.members.values()].filter(p=>(instance.damageByChar.get(p.charId)||0)>=min)}
function bossAttackSpec(type){return BOSS_ATTACKS[type]||BOSS_ATTACKS.normal}
function chooseLegendaryRecipient(eligible,canReceive=()=>true,rng=Math.random){const list=[...(eligible||[])];if(!list.length)return null;const start=Math.min(list.length-1,Math.floor(Math.max(0,Math.min(.999999,Number(rng())||0))*list.length));for(let i=0;i<list.length;i++){const candidate=list[(start+i)%list.length];if(canReceive(candidate))return candidate}return null}
function publicWorldBossState(instance,now=Date.now()){return{type:'world_boss_state',serverNow:now,mapId:instance.mapId,state:instance.state,expiresAt:instance.expiresAt,boss:{...instance.boss},party:[...instance.members.values()].map(p=>({charId:p.charId,name:p.name,cls:p.cls,hp:p.hp,maxHp:p.maxHp,dead:p.dead,respawnAt:p.respawnAt,online:p.online}))}}

module.exports={WORLD_BOSS_MAP_RE,WORLD_BOSS_DURATION_MS,WORLD_BOSS_RESPAWN_MS,WORLD_BOSS_TARGET_TTK_SECONDS,WORLD_BOSS_MIN_CONTRIBUTION,WORLD_BOSS_REWARD,BOSS_ATTACKS,CLASS_BASE,BASIC_CD_MS,CLASS_SKILLS,DAMAGE_SKILLS,combatSnapshot,estimateWorldBossDps,calculateWorldBossHp,validatePartyRegistration,worldBossMapId,createWorldBossInstance,resolveWorldBossDamage,applyBossDamage,eligibleMembers,bossAttackSpec,chooseLegendaryRecipient,publicWorldBossState};
