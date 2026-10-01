'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../game-data/arena-matchmaking.js');
function p(id,rating=1000,powerScore=1000,joinedAt=0){return{charId:id,rating,powerScore,joinedAt}}
test('7.8 duelo exige dois jogadores compatíveis',()=>{assert.equal(M.bestGroup([p('a')],'duel'),null);assert.deepEqual(M.bestGroup([p('a'),p('b',1010,1100,1)],'duel').map(x=>x.charId),['a','b'])});
test('7.8 matchmaking rejeita gaps extremos',()=>{assert.equal(M.eligiblePair(p('a',1000,1000),p('b',1600,1000)),false);assert.equal(M.eligiblePair(p('a',1000,1000),p('b',1000,4000)),false)});
test('7.8 trio exige seis jogadores e divide 3x3',()=>{const ps=Array.from({length:6},(_,i)=>p(String(i),1000+i*10,1000+i*20,i));const g=M.bestGroup(ps,'trio');assert.equal(g.length,6);const t=M.splitTeams(g,'trio');assert.equal(t.red.length,3);assert.equal(t.blue.length,3)});
test('7.8 fila competitiva não trata guild war como solo queue',()=>{assert.equal(M.bestGroup(Array.from({length:10},(_,i)=>p(String(i))),'guild_war'),null)});
