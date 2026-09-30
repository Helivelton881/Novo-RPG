'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const E=require('../game-data/endgame-data.js');

test('6.1 Maestria so existe no Lv40 e nunca cria Lv41',()=>{
  assert.equal(E.applyMasteryXp({},5000,39,'guerreiro').gained,0);
  const r=E.applyMasteryXp({},E.masteryXpToNext(0)+25,40,'guerreiro');
  assert.equal(r.rank,1); assert.equal(r.xp,25);
});
test('6.1 sanitiza moeda, rank e contadores',()=>{
  const r=E.sanitizeEndgame({rank:999,xp:9e9,essence:9e9,rewards:{dungeon:999}},'mago');
  assert.equal(r.rank,100); assert.equal(r.xp,0); assert.equal(r.essence,E.ENDGAME_CURRENCY_MAX);
  assert.equal(r.rewards.dungeon,99);
});
test('6.2 talentos sao por classe, limitados por Maestria e 5 pontos por talento',()=>{
  let e=E.sanitizeEndgame({rank:25},'arqueiro');
  assert.equal(E.talentPointsForRank(e.rank),5);
  for(let i=0;i<5;i++) e=E.allocateTalent(e,'arqueiro','precisao').endgame;
  assert.equal(e.talents.spent.precisao,5);
  assert.equal(E.allocateTalent(e,'arqueiro','precisao').error,'NO_TALENT_POINTS');
  assert.equal(E.allocateTalent(e,'arqueiro','fortaleza').error,'TALENT_NOT_FOUND');
});
test('6.3 bonus de set endgame ativa em 2 4 e 6 pecas',()=>{
  assert.equal(E.endgameSetBonus(1).two,null);
  assert.equal(E.endgameSetBonus(2).two.hpPct,5);
  assert.equal(E.endgameSetBonus(4).four.atkPct,5);
  assert.equal(E.endgameSetBonus(6).six.defPct,5);
});

test('6.4 dificuldades possuem gates e multiplicadores crescentes',()=>{
  assert.ok(E.difficultyFor('normal',0));
  assert.equal(E.difficultyFor('hard',4),null);
  assert.equal(E.difficultyFor('mythic',29),null);
  assert.equal(E.difficultyFor('mythic',30).hp,2.8);
});
test('6.5 World Boss tem recompensa endgame limitada separadamente',()=>{
  assert.equal(E.ENDGAME_REWARDS.WORLD_BOSS.MASTERY_XP,600);
  assert.equal(E.ENDGAME_REWARDS.WORLD_BOSS.ESSENCE_EVENTS_PER_WEEK,3);
});
test('6.6 reputacao tem cinco patamares e teto por regiao',()=>{
  let e=E.addReputation({reputation:{vulcao:14990}},'vulcao',100,'druida');
  assert.equal(e.reputation.vulcao,15000);
  assert.equal(E.reputationTier(15000),'exalted');
  assert.equal(E.reputationTier(2999),'friendly');
});
test('6.7 contrato completo preserva quatro classes e quatro dificuldades',()=>{
  assert.deepEqual(Object.keys(E.TALENTS).sort(),['arqueiro','druida','guerreiro','mago']);
  assert.deepEqual(Object.keys(E.DIFFICULTIES),['normal','hard','heroic','mythic']);
});
