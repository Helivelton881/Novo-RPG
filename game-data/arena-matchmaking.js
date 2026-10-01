'use strict';

const COMPETITIVE = require('./competitive-data.js');

const QUEUE_MODES = Object.freeze(['duel', 'trio']);
const MAX_RATING_GAP = 450;
const MAX_POWER_GAP = 1800;

function queueSize(mode) {
  const cfg = COMPETITIVE.ARENA_MODES[mode];
  return cfg ? cfg.teamSize * 2 : 0;
}
function eligiblePair(a, b) {
  if (!a || !b || a.charId === b.charId) return false;
  if (Math.abs((a.rating||0)-(b.rating||0)) > MAX_RATING_GAP) return false;
  if (Math.abs((a.powerScore||0)-(b.powerScore||0)) > MAX_POWER_GAP) return false;
  return true;
}
function bestGroup(entries, mode) {
  const need = queueSize(mode);
  if (!QUEUE_MODES.includes(mode) || entries.length < need) return null;
  const pool = entries.slice().sort((a,b)=>(a.joinedAt||0)-(b.joinedAt||0));
  if (mode === 'duel') {
    let best=null;
    for(let i=0;i<pool.length;i++)for(let j=i+1;j<pool.length;j++){
      if(!eligiblePair(pool[i],pool[j]))continue;
      const score=COMPETITIVE.matchmakingScore(pool[i],pool[j]);
      if(!best||score<best.score)best={score,players:[pool[i],pool[j]]};
    }
    return best&&best.players;
  }
  const anchor=pool[0], candidates=pool.slice(1).filter(x=>eligiblePair(anchor,x));
  if(candidates.length<need-1)return null;
  candidates.sort((a,b)=>COMPETITIVE.matchmakingScore(anchor,a)-COMPETITIVE.matchmakingScore(anchor,b));
  return [anchor,...candidates.slice(0,need-1)];
}
function splitTeams(players, mode) {
  const size=COMPETITIVE.ARENA_MODES[mode]?.teamSize||1;
  const sorted=players.slice().sort((a,b)=>(b.rating+b.powerScore/25)-(a.rating+a.powerScore/25));
  const red=[],blue=[]; let rs=0,bs=0;
  for(const p of sorted){
    if(red.length>=size){blue.push(p);bs+=p.rating+p.powerScore/25;continue}
    if(blue.length>=size){red.push(p);rs+=p.rating+p.powerScore/25;continue}
    if(rs<=bs){red.push(p);rs+=p.rating+p.powerScore/25}else{blue.push(p);bs+=p.rating+p.powerScore/25}
  }
  return {red,blue};
}
module.exports={QUEUE_MODES,MAX_RATING_GAP,MAX_POWER_GAP,queueSize,eligiblePair,bestGroup,splitTeams};
