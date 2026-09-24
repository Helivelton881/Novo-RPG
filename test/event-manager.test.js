'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('../game-data/event-manager.js');

const at=s=>Date.parse(s);
function playableConfig(){return{...E.EVENT_CONFIG,types:{world_boss:{...E.EVENT_CONFIG.types.world_boss,playable:true},team_vs_team:{...E.EVENT_CONFIG.types.team_vs_team,playable:true}}}}

test('agenda oficial America/Sao_Paulo alterna os 12 slots exatos',()=>{
  const list=E.scheduleAfter(at('2026-09-24T03:00:00Z'),12); // 00:00 em Sao Paulo
  assert.deepEqual(list.map(x=>[E.zonedParts(x.startAt).hour,x.type]),[
    [0,'world_boss'],[2,'team_vs_team'],[4,'world_boss'],[6,'team_vs_team'],[8,'world_boss'],[10,'team_vs_team'],
    [12,'world_boss'],[14,'team_vs_team'],[16,'world_boss'],[18,'team_vs_team'],[20,'world_boss'],[22,'team_vs_team']]);
});

test('virada do dia: 22:00 TvT aponta para 00:00 World Boss no dia seguinte',()=>{
  const first=E.nextEventAfter(at('2026-09-25T01:00:00Z'),true),next=E.nextEventAfter(first.startAt,false);
  assert.equal(first.type,'team_vs_team');assert.equal(E.zonedParts(first.startAt).hour,22);
  assert.equal(next.type,'world_boss');assert.deepEqual(E.zonedParts(next.startAt),{year:2026,month:9,day:25,hour:0,minute:0,second:0});
});

test('ID da ocorrencia e deterministico pelo tipo e timestamp do slot',()=>{
  const a=E.nextEventAfter(at('2026-09-24T20:11:00-03:00')),b=E.nextEventAfter(at('2026-09-24T20:12:00-03:00'));
  assert.equal(a.id,b.id);assert.equal(a.id,`${a.type}:${a.startAt}`);
});

test('registration abre exatamente 15 minutos antes',()=>{
  const event=E.eventScheduleAt(at('2026-09-24T20:00:00-03:00'),playableConfig());
  assert.equal(E.eventPhaseAt(event,at('2026-09-24T19:44:59-03:00'),true),'upcoming');
  assert.equal(E.eventPhaseAt(event,at('2026-09-24T19:45:00-03:00'),true),'registration');
  assert.equal(E.eventPhaseAt(event,at('2026-09-24T19:59:59-03:00'),true),'registration');
  assert.equal(E.eventPhaseAt(event,at('2026-09-24T20:00:00-03:00'),false),'unavailable');
});

test('restart simulado dentro da janela reconstrui a mesma ocorrencia e registration',()=>{
  const now=at('2026-09-24T19:52:00-03:00'),cfg=playableConfig();
  const a=new E.EventManager({config:cfg,now:()=>now}).registerEventHandler('world_boss',{});
  const b=new E.EventManager({config:cfg,now:()=>now}).registerEventHandler('world_boss',{});
  assert.equal(a.snapshot().current.id,b.snapshot().current.id);assert.equal(a.snapshot().current.status,'registration');
});

test('anuncios 15/5/1 saem uma vez mesmo com centenas de ticks',()=>{
  let now=at('2026-09-24T19:45:00-03:00');const messages=[];
  const m=new E.EventManager({config:playableConfig(),now:()=>now,announce:x=>messages.push(x)}).registerEventHandler('world_boss',{durationMs:60000});
  for(const minute of [15,5,1]){now=at(`2026-09-24T19:${60-minute}:00-03:00`);for(let i=0;i<200;i++)m.tick(now+i)}
  assert.deepEqual(messages.map(x=>x.minutes),[15,5,1]);
});

test('evento nao implementado nao aceita inscricao nem anuncia',()=>{
  const now=at('2026-09-24T19:50:00-03:00'),messages=[];
  const m=new E.EventManager({now:()=>now,announce:x=>messages.push(x)}),event=m.snapshot().current;
  const before=JSON.stringify({gold:10,map:'vila'}),player={authed:true,userId:'u',charId:'c',name:'Heroi'};
  assert.deepEqual(m.register(player,event.id),{ok:false,error:'EVENT_UNAVAILABLE'});m.tick();
  assert.equal(messages.length,0);assert.equal(JSON.stringify({gold:10,map:'vila'}),before);
});

test('handler fake: autenticado registra idempotente, anonimo falha e unregister remove',()=>{
  const now=at('2026-09-24T19:50:00-03:00'),m=new E.EventManager({config:playableConfig(),now:()=>now}).registerEventHandler('world_boss',{}),event=m.snapshot().current;
  assert.equal(m.register({authed:false},event.id).error,'AUTH_REQUIRED');
  const p={authed:true,userId:'u1',charId:'c1',name:'Heroi'},one=m.register(p,event.id),two=m.register(p,event.id);
  assert.equal(one.ok,true);assert.equal(two.alreadyRegistered,true);assert.equal(m.registrations.get(event.id).size,1);
  assert.equal(m.unregister(p,event.id).removed,true);assert.equal(m.registrations.get(event.id).size,0);
});

test('registro fora da janela e rejeitado',()=>{
  const now=at('2026-09-24T19:40:00-03:00'),m=new E.EventManager({config:playableConfig(),now:()=>now}).registerEventHandler('world_boss',{}),event=m.snapshot().current;
  assert.equal(m.register({authed:true,userId:'u',charId:'c'},event.id).error,'REGISTRATION_CLOSED');
});

test('cleanup remove estado antigo e nao deixa Maps crescerem para sempre',()=>{
  const now=at('2026-09-24T20:00:00-03:00'),m=new E.EventManager({now:()=>now}),old=`world_boss:${now-5*60*60*1000}`;
  m.registrations.set(old,new Map());m.announced.set(old,new Set([15]));m.started.add(old);m.ended.add(old);m.cleanup(now);
  assert.equal(m.registrations.size,0);assert.equal(m.announced.size,0);assert.equal(m.started.size,0);assert.equal(m.ended.size,0);
});

test('snapshot publico inclui serverNow/timezone e nunca expõe participantes',()=>{
  const now=at('2026-09-24T19:50:00-03:00'),snapshot=new E.EventManager({now:()=>now}).snapshot();
  assert.equal(snapshot.serverNow,now);assert.equal(snapshot.timezone,'America/Sao_Paulo');assert.equal(snapshot.schedule.length,6);
  assert.equal(JSON.stringify(snapshot).includes('userId'),false);assert.equal(JSON.stringify(snapshot).includes('charId'),false);
});
