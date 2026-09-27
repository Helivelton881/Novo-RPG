'use strict';
const {test,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const S=require('../server.js');

const defaults=()=>S.applyLivingWorldConfig(S.LIVING_WORLD_DEFAULTS);
afterEach(()=>{S.aiEntities.clear();defaults();delete process.env.AI_ENABLED;});

test('RBAC Living World: support/moderator somente view; admin/owner view + manage',()=>{
  for(const role of ['support','moderator']){assert.equal(S.adminHasPerm(role,'view_living_world'),true);assert.equal(S.adminHasPerm(role,'manage_living_world'),false);}
  for(const role of ['admin','owner']){assert.equal(S.adminHasPerm(role,'view_living_world'),true);assert.equal(S.adminHasPerm(role,'manage_living_world'),true);}
});

test('defaults persistentes sao conservadores e hard limits nunca aceitam 999999',()=>{
  assert.deepEqual(S.normalizeLivingWorldSettings({}),S.LIVING_WORLD_DEFAULTS);
  assert.equal(S.normalizeLivingWorldSettings({fieldWorldCap:999999}).fieldWorldCap,S.LIVING_WORLD_DEFAULTS.fieldWorldCap);
  assert.equal(S.normalizeLivingWorldSettings({perMapCap:999999}).perMapCap,S.LIVING_WORLD_DEFAULTS.perMapCap);
  assert.equal(S.FIELD_AI_HARD_MAX,40);assert.equal(S.PER_MAP_HARD_MAX,10);
});

test('migration aditiva persiste singleton, habilita RLS e nao cria policy publica',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260925104225_add_living_world_settings.sql'),'utf8');
  assert.match(sql,/create table if not exists public\.living_world_settings/i);
  assert.match(sql,/enable row level security/i);assert.match(sql,/revoke all .* anon, authenticated/i);
  assert.doesNotMatch(sql,/^\s*(drop|delete)\b|create\s+policy/im);
});

test('pause/resume: pause bloqueia somente population tick de campo',()=>{
  process.env.AI_ENABLED='1';S.applyLivingWorldConfig({fieldSpawnEnabled:false,dungeonFillEnabled:true,tvtFillEnabled:true,fieldWorldCap:10,perMapCap:4});
  S.aiPopulationTick();assert.equal(S.fieldAiEntities().length,0);
  assert.equal(S.dungeonAiFillEnabled(),true);assert.ok(S.tvtAiFillTargetSize(1)>1);
  S.applyLivingWorldConfig({...S.livingWorldConfig,fieldSpawnEnabled:true});S.aiPopulationTick();assert.equal(S.fieldAiEntities().length,1);
});

test('aiPopulationTick respeita world cap e per-map cap',()=>{
  process.env.AI_ENABLED='1';S.applyLivingWorldConfig({fieldWorldCap:3,perMapCap:1});
  for(let i=0;i<10;i++)S.aiPopulationTick();
  assert.equal(S.fieldAiEntities().length,3);assert.ok(Object.values(S.fieldAiCounts()).every(n=>n<=1));
});

test('redução de per-map cap faz retirada gradual somente de FIELD seguro',()=>{
  process.env.AI_ENABLED='1';S.applyLivingWorldConfig({fieldWorldCap:10,perMapCap:10});
  S.aiSpawnEntity('floresta');S.aiSpawnEntity('floresta');S.aiSpawnEntity('floresta');
  S.applyLivingWorldConfig({...S.livingWorldConfig,fieldSpawnEnabled:false,perMapCap:1});
  S.aiPopulationTick();assert.equal(S.fieldAiCounts().floresta,2);
  S.aiPopulationTick();assert.equal(S.fieldAiCounts().floresta,1);
});

test('toggles de Dungeon/TvT sao independentes do pause e um do outro',()=>{
  S.applyLivingWorldConfig({fieldSpawnEnabled:false,dungeonFillEnabled:false,tvtFillEnabled:true,fieldWorldCap:10,perMapCap:4});
  assert.equal(S.dungeonAiFillEnabled(),false);assert.ok(S.tvtAiFillTargetSize(1)>1);
  S.applyLivingWorldConfig({...S.livingWorldConfig,dungeonFillEnabled:true,tvtFillEnabled:false});
  assert.equal(S.dungeonAiFillEnabled(),true);assert.equal(S.tvtAiFillTargetSize(1),1);
});

test('despawn-field remove somente FIELD seguro, nunca Dungeon/TvT',()=>{
  S.applyLivingWorldConfig({fieldWorldCap:10,perMapCap:10});
  const field=S.aiSpawnEntity('floresta'),dungeon=S.aiSpawnEntity('cripta'),tvt=S.aiSpawnEntity('serra');
  dungeon.slot={kind:'dungeon',instanceId:'d1'};dungeon.map='dungeon_d1';dungeon.fsm='dungeon';
  tvt.slot={kind:'tvt',instanceId:'t1'};tvt.map='tvt_t1';tvt.fsm='tvt';
  assert.equal(S.despawnFieldAi({all:true}),1);assert.equal(S.aiEntities.has(field.id),false);
  assert.equal(S.aiEntities.has(dungeon.id),true);assert.equal(S.aiEntities.has(tvt.id),true);
});

test('rebalance redistribui somente FIELD idle e nao toca instancia ativa',()=>{
  S.applyLivingWorldConfig({fieldWorldCap:10,perMapCap:10});
  S.aiSpawnEntity('floresta');S.aiSpawnEntity('floresta');S.aiSpawnEntity('floresta');
  const instance=S.aiSpawnEntity('cripta');instance.slot={kind:'dungeon',instanceId:'d1'};instance.map='dungeon_d1';instance.fsm='dungeon';
  const beforeId=instance.id;assert.ok(S.rebalanceFieldAi()>0);assert.equal(S.aiEntities.has(beforeId),true);
  assert.equal(S.aiEntities.get(beforeId).map,'dungeon_d1');
});

test('status separa campo/instancias/total e expõe FSM sem misturar humano',()=>{
  S.applyLivingWorldConfig({fieldWorldCap:10,perMapCap:10});const field=S.aiSpawnEntity('floresta');
  const dungeon=S.aiSpawnEntity('cripta');dungeon.slot={kind:'dungeon',instanceId:'d1'};dungeon.map='dungeon_d1';dungeon.fsm='dungeon';
  const d=S.livingWorldStatus();assert.equal(d.field.count,1);assert.equal(d.instances.dungeon,1);assert.equal(d.totalAi,2);
  assert.equal(d.entities.find(x=>x.runtimeId===field.id).type,'FIELD');assert.equal(d.entities.find(x=>x.runtimeId===dungeon.id).type,'DUNGEON');
});

test('Fase 5.16.2 -- status expõe a população social da vila separada do campo, com type VILLAGE e x/y no diagnóstico de cada entidade',()=>{
  S.applyLivingWorldConfig({fieldWorldCap:10,perMapCap:10});
  const field=S.aiSpawnEntity('floresta'),village=S.aiSpawnEntity('vila');
  const d=S.livingWorldStatus();
  assert.equal(d.village.count,1);assert.equal(d.village.cap,S.VILLAGE_SOCIAL_CAP);
  assert.equal(d.totalAi,2,'totalAi deveria contar a IA da vila tambem, nao so campo/instancia');
  const villageRow=d.entities.find(x=>x.runtimeId===village.id);
  assert.equal(villageRow.type,'VILLAGE');assert.equal(villageRow.map,'vila');
  for(const row of d.entities){assert.equal(typeof row.x,'number');assert.equal(typeof row.y,'number');}
  assert.equal(d.entities.find(x=>x.runtimeId===field.id).type,'FIELD');
});

test('Fase 5.16.2 -- pause bloqueia tambem a reposição social da vila (mesmo toggle fieldSpawnEnabled do painel)',()=>{
  process.env.AI_ENABLED='1';S.applyLivingWorldConfig({fieldSpawnEnabled:false,dungeonFillEnabled:true,tvtFillEnabled:true,fieldWorldCap:10,perMapCap:4});
  S.aiPopulationTick();assert.equal(S.villageAiEntities().length,0);
  S.applyLivingWorldConfig({...S.livingWorldConfig,fieldSpawnEnabled:true});S.aiPopulationTick();assert.equal(S.villageAiEntities().length,1);
});

test('audit sanitiza segredos e rotas mutaveis nao contêm caminhos de economia',()=>{
  const safe=S.sanitizeAuditMetadata({oldCap:20,newCap:10,runtimeId:'ai_x',token:'nope',session:'nope'});
  assert.deepEqual(safe,{oldCap:20,newCap:10,runtimeId:'ai_x'});
  const src=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const block=src.slice(src.indexOf("pathname === '/api/admin/living-world/pause'"),src.indexOf("pathname === '/api/admin/players'"));
  for(const forbidden of ['grantItem','creditKillReward','market_list_item','creditDungeonReward'])assert.equal(block.includes(forbidden),false,forbidden);
  for(const action of ['living_world_pause','living_world_resume','living_world_set_limits','living_world_rebalance','living_world_despawn_field','living_world_despawn_ai'])assert.ok(block.includes(action),action);
});
