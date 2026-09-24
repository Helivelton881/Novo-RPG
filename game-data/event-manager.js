'use strict';

// Fase 5.5: agenda e lifecycle server-authoritative. Este modulo nao conhece
// mapas, combate, economia ou Supabase; handlers futuros plugam gameplay.
const EVENT_CONFIG = Object.freeze({
  timezone: 'America/Sao_Paulo',
  intervalHours: 2,
  registrationLeadMs: 15 * 60 * 1000,
  announcementMinutes: Object.freeze([15, 5, 1]),
  scheduleSlots: 6,
  types: Object.freeze({
    world_boss: Object.freeze({label:'World Boss', registrationMode:'party4', playable:true}),
    // Fase 5.7: Team vs Team joga-vel. registrationMode:'individual' ja
    // existia desde a Fase 5.5 (preparado pra isso) -- inscricao nunca usa
    // Party pra decidir time (matchmaking e independente, ver
    // game-data/tvt.js balanceTvtTeams).
    team_vs_team: Object.freeze({label:'Team vs Team', registrationMode:'individual', playable:true}),
  }),
});

const formatterCache = new Map();
function formatter(timezone) {
  if (!formatterCache.has(timezone)) formatterCache.set(timezone, new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'
  }));
  return formatterCache.get(timezone);
}
function zonedParts(epochMs, timezone=EVENT_CONFIG.timezone) {
  const out={};
  for(const p of formatter(timezone).formatToParts(new Date(epochMs))) if(p.type!=='literal') out[p.type]=Number(p.value);
  return {year:out.year,month:out.month,day:out.day,hour:out.hour,minute:out.minute,second:out.second};
}
function localEpoch(parts, timezone=EVENT_CONFIG.timezone) {
  const target=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour||0,parts.minute||0,parts.second||0,parts.ms||0);
  let candidate=target;
  for(let i=0;i<3;i++){
    const seen=zonedParts(candidate,timezone);
    const observed=Date.UTC(seen.year,seen.month-1,seen.day,seen.hour,seen.minute,seen.second,parts.ms||0);
    candidate+=target-observed;
  }
  return candidate;
}
function addLocalDays(parts, days) {
  const d=new Date(Date.UTC(parts.year,parts.month-1,parts.day+days));
  return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate()};
}
function eventTypeForSlot(hour) { return Math.floor(hour / EVENT_CONFIG.intervalHours) % 2 === 0 ? 'world_boss' : 'team_vs_team'; }
function eventScheduleAt(startAt, config=EVENT_CONFIG) {
  const local=zonedParts(startAt,config.timezone),type=eventTypeForSlot(local.hour),meta=config.types[type];
  return {id:`${type}:${startAt}`,type,label:meta.label,startAt,registrationOpensAt:startAt-config.registrationLeadMs,registrationMode:meta.registrationMode,playable:!!meta.playable};
}
function nextEventAfter(now, inclusive=true, config=EVENT_CONFIG) {
  const p=zonedParts(now,config.timezone), step=config.intervalHours;
  let hour=Math.ceil((p.hour+(p.minute||p.second||!inclusive?1:0))/step)*step, date={year:p.year,month:p.month,day:p.day};
  if(hour>=24){hour-=24;date=addLocalDays(date,1)}
  let startAt=localEpoch({...date,hour},config.timezone);
  if(startAt<now||(!inclusive&&startAt===now)){hour+=step;if(hour>=24){hour-=24;date=addLocalDays(date,1)}startAt=localEpoch({...date,hour},config.timezone)}
  return eventScheduleAt(startAt,config);
}
function scheduleAfter(now,count=EVENT_CONFIG.scheduleSlots,config=EVENT_CONFIG){
  const out=[];let cursor=nextEventAfter(now,true,config);
  for(let i=0;i<count;i++){out.push(cursor);cursor=nextEventAfter(cursor.startAt,false,config)}
  return out;
}
function eventPhaseAt(event,now,playable=event.playable,endAt=event.endAt){
  if(now<event.registrationOpensAt)return'upcoming';
  if(now<event.startAt)return playable?'registration':'unavailable';
  if(!playable)return'unavailable';
  return !endAt||now<endAt?'active':'ended';
}

class EventManager {
  constructor({config=EVENT_CONFIG,now=()=>Date.now(),announce=()=>{},log=()=>{}}={}){
    this.config=config;this.now=now;this.announce=announce;this.log=log;
    this.handlers=new Map();this.registrations=new Map();this.announced=new Map();this.opened=new Set();this.started=new Set();this.ended=new Set();this.cancelled=new Set();
  }
  registerEventHandler(type,handler){if(!this.config.types[type])throw new Error('UNKNOWN_EVENT_TYPE');this.handlers.set(type,handler||{});return this}
  occurrence(raw){const handler=this.handlers.get(raw.type),playable=!!raw.playable&&!!handler,durationMs=Math.max(0,Number(handler&&handler.durationMs)||0);return{...raw,playable,endAt:durationMs?raw.startAt+durationMs:null}}
  publicEvent(raw,now=this.now()){
    if(!raw)return null;const event=this.occurrence(raw),registrations=this.registrations.get(event.id);
    return {...event,status:this.cancelled.has(event.id)?'cancelled':eventPhaseAt(event,now,event.playable,event.endAt),registrationCount:registrations?registrations.size:0};
  }
  snapshot(now=this.now()){
    const list=scheduleAfter(now,this.config.scheduleSlots+1,this.config).map(e=>this.publicEvent(e,now));
    return{serverNow:now,timezone:this.config.timezone,current:list[0]||null,next:list[1]||null,schedule:list.slice(0,this.config.scheduleSlots)};
  }
  register(player,eventId,now=this.now()){
    if(!player||!player.authed||!player.userId||!player.charId)return{ok:false,error:'AUTH_REQUIRED'};
    const event=this.publicEvent(scheduleAfter(now,2,this.config).find(e=>e.id===eventId),now);
    if(!event)return{ok:false,error:'EVENT_NOT_FOUND'};
    if(!event.playable)return{ok:false,error:'EVENT_UNAVAILABLE'};
    if(event.status!=='registration')return{ok:false,error:'REGISTRATION_CLOSED'};
    if(!this.registrations.has(event.id))this.registrations.set(event.id,new Map());
    const entries=this.registrations.get(event.id),existing=entries.get(player.charId);
    if(existing)return{ok:true,alreadyRegistered:true,event,registration:existing};
    const registration={userId:player.userId,charId:player.charId,name:player.name,registeredAt:now};entries.set(player.charId,registration);
    return{ok:true,alreadyRegistered:false,event,registration};
  }
  registerGroup(group,eventId,now=this.now()){
    if(!group||!group.groupId||!Array.isArray(group.members)||!group.members.length)return{ok:false,error:'INVALID_GROUP'};
    const event=this.publicEvent(scheduleAfter(now,2,this.config).find(e=>e.id===eventId),now);
    if(!event)return{ok:false,error:'EVENT_NOT_FOUND'};if(!event.playable)return{ok:false,error:'EVENT_UNAVAILABLE'};if(event.status!=='registration')return{ok:false,error:'REGISTRATION_CLOSED'};
    if(!this.registrations.has(event.id))this.registrations.set(event.id,new Map());const entries=this.registrations.get(event.id);
    const existing=[...entries.values()].find(r=>r.groupId===group.groupId);if(existing)return{ok:true,alreadyRegistered:true,event,registration:existing};
    for(const member of group.members)if(entries.has(member.charId))return{ok:false,error:'CHAR_ALREADY_REGISTERED'};
    const registration={...group,registeredAt:now};for(const member of group.members)entries.set(member.charId,registration);
    return{ok:true,alreadyRegistered:false,event,registration};
  }
  unregisterGroup(player,eventId,now=this.now()){
    if(!player||!player.authed||!player.userId)return{ok:false,error:'AUTH_REQUIRED'};const event=this.publicEvent(scheduleAfter(now,2,this.config).find(e=>e.id===eventId),now);
    if(!event)return{ok:false,error:'EVENT_NOT_FOUND'};if(event.status!=='registration')return{ok:false,error:'REGISTRATION_CLOSED'};const entries=this.registrations.get(event.id);
    if(!entries)return{ok:true,removed:false,event};const registration=[...entries.values()].find(r=>r.ownerUserId===player.userId);if(!registration)return{ok:false,error:'PARTY_LEADER_REQUIRED'};
    for(const member of registration.members)entries.delete(member.charId);return{ok:true,removed:true,event,groupId:registration.groupId,members:registration.members};
  }
  unregister(player,eventId,now=this.now()){
    if(!player||!player.authed||!player.userId||!player.charId)return{ok:false,error:'AUTH_REQUIRED'};
    const event=this.publicEvent(scheduleAfter(now,2,this.config).find(e=>e.id===eventId),now);
    if(!event)return{ok:false,error:'EVENT_NOT_FOUND'};
    if(event.status!=='registration')return{ok:false,error:'REGISTRATION_CLOSED'};
    const entries=this.registrations.get(event.id);return{ok:true,removed:!!entries&&entries.delete(player.charId),event};
  }
  cancel(eventId){if(this.cancelled.has(eventId))return false;this.cancelled.add(eventId);this.registrations.delete(eventId);this.log('event_cancelled',{id:eventId});return true}
  tick(now=this.now()){
    const candidates=scheduleAfter(now-this.config.registrationLeadMs,3,this.config);
    for(const raw of candidates){
      const event=this.occurrence(raw),status=eventPhaseAt(event,now,event.playable,event.endAt);
      if(event.playable&&!this.cancelled.has(event.id)){
        if(status==='registration'&&!this.opened.has(event.id)){this.opened.add(event.id);this.log('event_registration_open',event)}
        let sent=this.announced.get(event.id);if(!sent){sent=new Set();this.announced.set(event.id,sent)}
        const remaining=event.startAt-now;
        for(const mins of this.config.announcementMinutes)if(remaining>0&&remaining<=mins*60000&&!sent.has(mins)){sent.add(mins);this.announce({type:'event_announcement',eventId:event.id,eventType:event.type,label:event.label,minutes:mins,startAt:event.startAt,serverNow:now,message:`${event.label.toUpperCase()} em ${mins} minuto${mins===1?'':'s'}.`})}
        if(status==='active'&&!this.started.has(event.id)){this.started.add(event.id);this.log('event_start',event);if(this.handlers.get(event.type)?.onStart)this.handlers.get(event.type).onStart(event,this.registrations.get(event.id)||new Map())}
        if(status==='ended'&&!this.ended.has(event.id)){this.ended.add(event.id);this.log('event_end',event);if(this.handlers.get(event.type)?.onEnd)this.handlers.get(event.type).onEnd(event)}
      }
    }
    this.cleanup(now);return this.snapshot(now);
  }
  cleanup(now=this.now()){
    const keepAfter=now-4*60*60*1000;
    for(const map of [this.registrations,this.announced])for(const id of map.keys()){const at=Number(id.slice(id.lastIndexOf(':')+1));if(Number.isFinite(at)&&at<keepAfter)map.delete(id)}
    for(const set of [this.opened,this.started,this.ended,this.cancelled])for(const id of set){const at=Number(id.slice(id.lastIndexOf(':')+1));if(Number.isFinite(at)&&at<keepAfter)set.delete(id)}
  }
}

const DATA={EVENT_CONFIG,zonedParts,localEpoch,eventTypeForSlot,eventScheduleAt,nextEventAfter,scheduleAfter,eventPhaseAt,EventManager};
if(typeof module!=='undefined'&&module.exports)module.exports=DATA;
