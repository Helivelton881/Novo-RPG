'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const G=require('../game-data/dungeon-generation.js');
const S=require('../server.js');

test('KayKit: somente vulcao usa layout dedicado; floresta e demais preservam layout legado',()=>{
  const legacy=G.dungeonLayout(1);
  assert.equal(G.dungeonLayoutForZone('floresta',1),legacy);
  assert.equal(G.dungeonLayoutForZone('cripta',1),legacy);
  const k=G.dungeonLayoutForZone('vulcao',1);
  assert.equal(k.kaykit,true);
  assert.notEqual(k,legacy);
  assert.ok(k.rooms.armadilhas&&k.rooms.cripta&&k.rooms.prisao&&k.rooms.arsenal&&k.rooms.secreta);
});

test('KayKit: start, boss, saida e spawns ficam fora das paredes',()=>{
  const k=G.kaykitDungeonLayout();
  const block=p=>k.rects.some(r=>p.x>=r.x&&p.x<=r.x+r.w&&p.y>=r.y&&p.y<=r.y+r.h);
  assert.equal(block(k.start),false);assert.equal(block(k.boss),false);assert.equal(block(k.exitPoint),false);
  const st=S.buildDungeonInstance('vulcao',['u:c'],123);
  assert.ok(st);
  for(const m of st.mobs.values()) assert.equal(block({x:m.x,y:m.y}),false, m.id);
});

test('KayKit: mobs da Forja carregam colisao do layout dedicado sem alterar floresta',()=>{
  const v=S.buildDungeonInstance('vulcao',['u:c'],123);
  const f=S.buildDungeonInstance('floresta',['u:c'],124);
  assert.equal(v.layout.kaykit,true);
  assert.equal(Boolean(f.layout.kaykit),false);
  for(const m of v.mobs.values()) assert.equal(m.wallRects,v.layout.rects);
  for(const m of f.mobs.values()) assert.equal(m.wallRects,f.layout.rects);
});
