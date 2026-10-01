'use strict';
const TVT=require('./tvt.js'),COMP=require('./competitive-data.js');
function createArenaInstance({id,mode,teams,members,now=Date.now()}){
 const cfg=COMP.ARENA_MODES[mode];if(!cfg)throw new Error('invalid arena mode');
 const tvtMembers=[];for(const team of ['red','blue'])for(const e of teams[team]){const m=members.get(e.charId);if(!m)throw new Error('missing member');tvtMembers.push({...m,team})}
 const inst=TVT.createTvtInstance({eventId:id,members:tvtMembers,now});
 for(const [charId,p] of inst.players){const src=members.get(charId);p.rating=src.rating;p.competitive=COMP.sanitizeCompetitive(src.competitive)}
 inst.id=id;inst.mapId='tvt#arena_'+id;inst.mode=mode;inst.scoreLimit=cfg.scoreLimit;inst.expiresAt=now+cfg.durationMs;inst.isCompetitive=true;inst.previousLocations=new Map();
 return inst;
}
function avgOpponentRating(instance,team){const a=[...instance.players.values()].filter(p=>p.team!==team);return Math.round(a.reduce((s,p)=>s+(p.rating||1000),0)/Math.max(1,a.length))}
function resultFor(instance,member){return instance.winner==null?'draw':instance.winner===member.team?'win':'loss'}
function applyGuildWarMeta(raw,outcome,now=Date.now()){
 const c=COMP.sanitizeCompetitive(raw),d=new Date(now),week=d.getUTCFullYear()+'-W'+String(Math.ceil((((d-new Date(Date.UTC(d.getUTCFullYear(),0,1)))/86400000)+new Date(Date.UTC(d.getUTCFullYear(),0,1)).getUTCDay()+1)/7)).padStart(2,'0');
 if(c.week!==week){c.week=week;c.weeklyWars=0}c.weeklyWars=Math.min(99,c.weeklyWars+1);if(outcome==='win')c.guildWins++;else if(outcome==='loss')c.guildLosses++;else c.guildDraws++;return c;
}
module.exports={createArenaInstance,avgOpponentRating,resultFor,applyGuildWarMeta};
