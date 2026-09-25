'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../server.js');

const serverSrc = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const clientSrc = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

test('Dungeon spawn: helper alinha mapa, posicao e relogio autoritativos ao start caminhavel', () => {
  const state = S.createDungeonInstance('floresta', 'spawn-char', 'spawn-user');
  const p = {map:'vila',x:720,y:1258,lastMoveAt:1,moving:true,atkT:.3};
  assert.equal(S.placePlayerAtDungeonStart(p,state,12345),true);
  assert.deepEqual({map:p.map,x:p.x,y:p.y,lastMoveAt:p.lastMoveAt}, {map:state.id,x:state.layout.start.x,y:state.layout.start.y,lastMoveAt:12345});
  assert.equal(S.rectsBlock(state.layout.rects,p.x,p.y,14,10),false);
  assert.equal(p.moving,false); assert.equal(p.atkT,0);
});

test('Dungeon spawn: primeiro state no start nao e rejeitado como teleporte', () => {
  const state=S.createDungeonInstance('cripta','move-char','move-user');
  const p={x:10,y:10,lastMoveAt:1,combat:{speed:0}};
  S.placePlayerAtDungeonStart(p,state,1000);
  const result=S.validateMovement(p,state.layout.start.x,state.layout.start.y,1050);
  assert.equal(result.ok,true); assert.equal(result.x,state.layout.start.x); assert.equal(result.y,state.layout.start.y);
});

test('Dungeon spawn: helper rejeita estado incompleto sem corromper o jogador', () => {
  const p={map:'vila',x:1,y:2};
  assert.equal(S.placePlayerAtDungeonStart(p,{id:'broken',layout:{}},10),false);
  assert.deepEqual(p,{map:'vila',x:1,y:2});
});

test('Dungeon runtime: entrada nova, reentrada, reconexao e matchmaking usam o helper antes do payload', () => {
  const uses=serverSrc.match(/placePlayerAtDungeonStart\(/g)||[];
  assert.ok(uses.length>=5, 'deve haver definicao + quatro caminhos de entrada');
  assert.match(serverSrc,/placePlayerAtDungeonStart\(p,dState\);sendDungeonStateTo\(ws,dState/);
  assert.match(serverSrc,/placePlayerAtDungeonStart\(p, existing\);\s*sendDungeonStateTo\(ws, existing/);
  assert.match(serverSrc,/placePlayerAtDungeonStart\(memberP, state\); sendDungeonStateTo\(memberWs, state/);
  assert.match(serverSrc,/placePlayerAtDungeonStart\(memberP, state\);\s*send\(memberWs, \{type:'dungeon_queue_matched'/);
});

test('Dungeon mapState: mobs pertencem ao mesmo mapId instanciado do jogador', () => {
  const state=S.createDungeonInstance('serra','map-char','map-user'),p={};
  S.placePlayerAtDungeonStart(p,state);
  assert.equal(p.map,state.id); assert.equal(S.maps.get(p.map),state);
  for(const mob of state.mobs.values())assert.ok(mob.id.startsWith(state.id+':'));
});

test('Dungeon tick: percorre todos os maps, usa playersOnMap(state.id) e transmite mob_positions no id completo', () => {
  const body=serverSrc.slice(serverSrc.indexOf('function tickMobAI'),serverSrc.indexOf('setInterval(tickMobAI'));
  assert.match(body,/for \(const state of maps\.values\(\)\)/);
  assert.match(body,/playersOnMap\(state\.id\)/);
  assert.match(body,/mob\.map = state\.id/);
  assert.match(body,/type: 'mob_positions', map: state\.id/);
});

test('Dungeon mob: movimento respeita wallRects sem congelar em area livre', () => {
  const state=S.createDungeonInstance('pantano','mob-char','mob-user');
  const mob=[...state.mobs.values()].find(m=>!m.boss),before={x:mob.x,y:mob.y};
  assert.equal(S.moveMob(mob,2,0),true);
  assert.ok(Number.isFinite(mob.x)&&Number.isFinite(mob.y));
  assert.ok(mob.x!==before.x||mob.y!==before.y,'mob em area caminhavel deveria aceitar um passo pequeno');
});

test('Dungeon mob_hit: alvo humano exige o mesmo mapId e recebe HP autoritativo', () => {
  const body=serverSrc.slice(serverSrc.indexOf('function hitTarget'),serverSrc.indexOf('function delayedHit'));
  assert.match(body,/p\.map!==mob\.map/);
  assert.match(body,/applyGlobalPlayerDamage/);
  assert.match(body,/type:'mob_hit',map:mob\.map/);
});

test('Dungeon mob_damage: valida map, mob, alcance, reduz HP e transmite mob_state', () => {
  const body=serverSrc.slice(serverSrc.indexOf("msg.type === 'mob_damage'"),serverSrc.indexOf("msg.type === 'player_damage'"));
  assert.match(body,/maps\.get\(map\).*map!==p\.map/);
  assert.match(body,/state\.mobs\.get\(mobId\)/);
  assert.match(body,/attackRangeFor/);
  assert.match(body,/mob\.hp=Math\.max\(0,mob\.hp-dmg\)/);
  assert.match(body,/type:'mob_state',map,mob/);
});

test('Dungeon morte: caminho server-side chama recompensa e nao agenda respawn da instancia', () => {
  const body=serverSrc.slice(serverSrc.indexOf("msg.type === 'mob_damage'"),serverSrc.indexOf("msg.type === 'player_damage'"));
  assert.match(body,/mob\.respawnAt=state\.isDungeon\?0:/);
  assert.match(body,/dungeonHandleMobDeath\(state,mob,now,p\.charId\)/);
});

test('Dungeon client: netMap completo governa map_state, mob_positions, mob_hit e mob_state', () => {
  for(const type of ['map_state','mob_positions','mob_hit','mob_state'])assert.match(clientSrc,new RegExp("m\\.type==='"+type+"'.*m\\.map===netMapId\\(\\)"));
});

test('Dungeon client: roster preserva o id autoritativo como netId', () => {
  const body=clientSrc.slice(clientSrc.indexOf('function spawnDungeonMob'),clientSrc.indexOf('function travelToDungeon'));
  assert.match(body,/m\.netId=entry\.id/);
});

test('Dungeon skills: cast_skill usa netMapId completo em vez de W_.name', () => {
  const line=clientSrc.match(/function netCastSkill[^\n]+/)[0];
  assert.match(line,/map:netMapId\(\)/); assert.doesNotMatch(line,/map:W_/);
});

test('Dungeon party: remotos e IA renderizam somente quando pertencem a mesma instancia', () => {
  assert.match(clientSrc,/function drawRemote\(p\)\{\s*if\(!p\|\|!W_\|\|p\.map!==netMapId\(\)\)return/);
  assert.equal((clientSrc.match(/p\.map===netMapId\(\)/g)||[]).length>=1,true);
  assert.equal((clientSrc.match(/rp\.map===netMapId\(\)/g)||[]).length>=1,true);
});
