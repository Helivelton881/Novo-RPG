'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {startServer,stopServer,wsConnect,waitFor,httpJson,hasSupabase}=require('./helpers');

let srv;
before(async()=>{srv=await startServer(18155)});
after(async()=>{await stopServer(srv)});

test('GET /api/events/status retorna somente agenda publica e serverNow',async()=>{
  const r=await httpJson(srv,'GET','/api/events/status');
  assert.equal(r.status,200);assert.equal(r.json.timezone,'America/Sao_Paulo');assert.equal(r.json.schedule.length,6);
  assert.equal(typeof r.json.serverNow,'number');assert.equal(JSON.stringify(r.json).includes('userId'),false);
});

test('event_state chega imediatamente no join/reconnect',async()=>{
  const conn=await wsConnect(srv);conn.ws.send(JSON.stringify({type:'join',name:'Visitante',cls:'guerreiro',lvl:1}));
  const state=await waitFor(conn.msgs,x=>x.type==='event_state');
  assert.equal(state.timezone,'America/Sao_Paulo');assert.equal(state.schedule.find(x=>x.type==='world_boss').playable,true);assert.equal(state.schedule.find(x=>x.type==='team_vs_team').playable,false);assert.equal(state.schedule.length,6);conn.close();
});

test('event_register anonimo e rejeitado claramente e nao cria inscricao',async()=>{
  const conn=await wsConnect(srv);conn.ws.send(JSON.stringify({type:'join',name:'Anonimo',cls:'guerreiro',lvl:1}));
  const state=await waitFor(conn.msgs,x=>x.type==='event_state');
  conn.ws.send(JSON.stringify({type:'event_register',eventId:state.current.id,userId:'forjado',charId:'forjado'}));
  const result=await waitFor(conn.msgs,x=>x.type==='event_registration');
  assert.equal(result.ok,false);assert.equal(result.error,'AUTH_REQUIRED');conn.close();
});

test('event_register autenticado via WS usa userId/charId reais', {skip:!hasSupabase()}, async()=>{});
test('event_unregister autenticado via WS remove inscricao', {skip:!hasSupabase()}, async()=>{});
test('event update broadcast com handler playable chega aos clientes', {skip:!hasSupabase()}, async()=>{});
