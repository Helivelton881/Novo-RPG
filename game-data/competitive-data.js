'use strict';
// Fase 7 - PvP competitivo / Guild Wars. Nucleo puro e server-authoritative.
const SEASON_DAYS=28, RATING_MIN=0, RATING_MAX=3000, PLACEMENT_MATCHES=5;
const DIVISIONS=Object.freeze([
 {id:'bronze',min:0},{id:'silver',min:900},{id:'gold',min:1200},
 {id:'platinum',min:1500},{id:'diamond',min:1800},{id:'master',min:2100}
]);
const ARENA_MODES=Object.freeze({
 duel:{teamSize:1,durationMs:5*60*1000,scoreLimit:3},
 trio:{teamSize:3,durationMs:8*60*1000,scoreLimit:10},
 guild_war:{teamSize:5,durationMs:15*60*1000,scoreLimit:30}
});
const GUILD_WAR=Object.freeze({minMembers:3,maxMembers:5,challengeTtlMs:10*60*1000,weeklyRewardedWars:5});
function int(v,min=0,max=999999){return Math.max(min,Math.min(max,Math.floor(Number(v)||0)))}
function divisionFor(rating){const r=int(rating,RATING_MIN,RATING_MAX);let d=DIVISIONS[0];for(const x of DIVISIONS)if(r>=x.min)d=x;return d.id}
function expected(a,b){return 1/(1+Math.pow(10,(b-a)/400))}
function ratingDelta(a,b,score,k=32){return Math.round(k*(score-expected(a,b)))}
function applyRating(a,b,outcome,k=32){
 const score=outcome==='win'?1:outcome==='loss'?0:.5;
 const delta=ratingDelta(int(a),int(b),score,k);
 return {rating:int(int(a)+delta,RATING_MIN,RATING_MAX),delta};
}
function seasonId(now=Date.now()){const d=Math.floor(Number(now)/(SEASON_DAYS*86400000));return 's'+d.toString(36)}
function sanitizeCompetitive(raw){
 const r=raw&&typeof raw==='object'?raw:{},rating=int(r.rating,0,RATING_MAX);
 return {season:typeof r.season==='string'?r.season.slice(0,16):seasonId(),rating,
 wins:int(r.wins),losses:int(r.losses),draws:int(r.draws),streak:int(r.streak,0,999),
 placements:int(r.placements,0,PLACEMENT_MATCHES),bestRating:int(r.bestRating||rating,0,RATING_MAX),
 guildWins:int(r.guildWins),guildLosses:int(r.guildLosses),guildDraws:int(r.guildDraws),
 weeklyWars:int(r.weeklyWars,0,99),week:typeof r.week==='string'?r.week.slice(0,10):''};
}
function recordMatch(raw,opponentRating,outcome,now=Date.now()){
 const c=sanitizeCompetitive(raw),sid=seasonId(now);
 if(c.season!==sid){c.season=sid;c.rating=1000;c.wins=0;c.losses=0;c.draws=0;c.streak=0;c.placements=0}
 const k=c.placements<PLACEMENT_MATCHES?48:32,r=applyRating(c.rating,opponentRating,outcome,k);
 c.rating=r.rating;c.bestRating=Math.max(c.bestRating,c.rating);c.placements=Math.min(PLACEMENT_MATCHES,c.placements+1);
 if(outcome==='win'){c.wins++;c.streak++}else if(outcome==='loss'){c.losses++;c.streak=0}else{c.draws++;c.streak=0}
 return {competitive:c,delta:r.delta,division:divisionFor(c.rating)};
}
function validateGuildWarRoster(roster){
 const a=Array.isArray(roster)?roster:[];if(a.length<GUILD_WAR.minMembers||a.length>GUILD_WAR.maxMembers)return false;
 return new Set(a.map(x=>String(x))).size===a.length;
}
function matchmakingScore(a,b){return Math.abs(int(a.rating)-int(b.rating))+Math.abs(int(a.powerScore)-int(b.powerScore))/25}
module.exports={SEASON_DAYS,RATING_MIN,RATING_MAX,PLACEMENT_MATCHES,DIVISIONS,ARENA_MODES,GUILD_WAR,
 divisionFor,expected,ratingDelta,applyRating,seasonId,sanitizeCompetitive,recordMatch,validateGuildWarRoster,matchmakingScore};
