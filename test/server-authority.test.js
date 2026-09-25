'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {
  resolveAttackDamage,applyGlobalPlayerDamage,consumeRuntimePotion,
  validateMovement,allowPacket,attackRangeFor,isAuthoritativeSocket,activeCharacterSockets,
}=require('../server');

function player(overrides={}){return{charId:'char-a',id:'socket-a',cls:'guerreiro',lvl:10,x:100,y:100,map:'floresta',hp:200,maxHp:200,dead:false,combat:{atk:30,def:10,block:0,speed:0,basicCdMs:420,skills:{spin:1,dash:1,warcry:1}},...overrides}}

test('FORGED_ATK: atk do payload nao altera dano autoritativo',()=>{
  const a=player(),b=player();
  assert.equal(resolveAttackDamage(a,{skill:'basic',atk:1},1000,()=>0),resolveAttackDamage(b,{skill:'basic',atk:999999999},1000,()=>0));
});

test('FORGED_HP e FORGED_DAMAGE: HP muda apenas pelo dano calculado no servidor',()=>{
  const p=player({hp:100});
  const result=applyGlobalPlayerDamage(p,30,1000,()=>1);
  assert.equal(result.hp,74);assert.equal(p.hp,74);assert.equal(result.damage,26);
});

test('skill de outra classe nao possui alcance/registro utilizavel',()=>{
  const p=player();
  assert.equal(p.combat.skills.fireball,undefined);
  assert.equal(attackRangeFor(p,'spin'),150);
});

test('cooldown basico usa timestamp server-side',()=>{
  const p=player();
  assert.ok(resolveAttackDamage(p,{skill:'basic'},1000,()=>0));
  assert.equal(resolveAttackDamage(p,{skill:'basic'},1100,()=>0),null);
  assert.ok(resolveAttackDamage(p,{skill:'basic'},1420,()=>0));
});

test('range melee e estritamente menor que range de projeteis',()=>{
  const p=player();assert.ok(attackRangeFor(p,'basic')<attackRangeFor({...p,cls:'arqueiro'},'basic'));
});

test('HP e morte sao aplicados uma unica vez',()=>{
  const p=player({hp:5});const first=applyGlobalPlayerDamage(p,50,1000,()=>1);const second=applyGlobalPlayerDamage(p,50,1001,()=>1);
  assert.equal(first.killed,true);assert.equal(first.hp,0);assert.equal(second,null);
});

test('movimento rejeita NaN, Infinity, bounds e salto; aceita passo normal e dash',()=>{
  const p=player({lastMoveAt:1000});
  assert.equal(validateMovement(p,NaN,100,1100).ok,false);
  assert.equal(validateMovement(p,Infinity,100,1100).ok,false);
  assert.equal(validateMovement(p,-1,100,1100).ok,false);
  assert.equal(validateMovement(p,130,100,1100).ok,true);
  assert.equal(validateMovement(p,1000,100,1100).ok,false);
  assert.equal(validateMovement({...p,dashUntil:2000},600,100,1100).ok,true);
});

test('ultima sessao registrada e a unica autoridade',()=>{
  const a={},b={};activeCharacterSockets.set('char-session',a);assert.equal(isAuthoritativeSocket('char-session',a),true);
  activeCharacterSockets.set('char-session',b);assert.equal(isAuthoritativeSocket('char-session',a),false);assert.equal(isAuthoritativeSocket('char-session',b),true);activeCharacterSockets.delete('char-session');
});

test('pocao respeita overheal e morto nao revive',()=>{
  assert.equal(consumeRuntimePotion(player({hp:200}),'pv'),null);
  assert.equal(consumeRuntimePotion(player({hp:1,dead:true}),'pv'),null);
  const p=player({hp:180});assert.deepEqual(consumeRuntimePotion(p,'pv'),{amount:20,hp:200,maxHp:200});
});

test('rate limit rejeita excesso sem banir',()=>{
  const p=player();assert.equal(allowPacket(p,'state',2,1000,100),true);assert.equal(allowPacket(p,'state',2,1000,101),true);assert.equal(allowPacket(p,'state',2,1000,102),false);
});

test('corrida de morte de mob marca dead antes do primeiro await/recompensa',()=>{
  const src=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  const block=src.slice(src.indexOf("if(mob.hp<=0){"),src.indexOf("broadcastMap(map,{type:'mob_state'"));
  assert.ok(block.indexOf('mob.dead=true')>=0);assert.ok(block.indexOf('mob.dead=true')<block.indexOf('creditKillReward'));
});

test('consumo concorrente continua serializado pelo lock do personagem',()=>{
  const src=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  const shop=src.slice(src.indexOf('async function handleShop'),src.indexOf('async function handleQuest'));
  assert.match(shop,/withCharLock\(charId/);assert.match(shop,/save\[key\]-=1/);assert.match(shop,/Jogador morto não pode usar consumível/);
});
