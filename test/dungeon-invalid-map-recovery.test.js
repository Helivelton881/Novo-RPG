'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const src=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');

test('state com map invalido nao deixa membro preso fora da dungeon autoritativa',()=>{
  const i=src.indexOf("if (!isAllowedMap(map))");
  assert.ok(i>0);
  const body=src.slice(i,i+900);
  assert.match(body,/securityReject\(p,'INVALID_MAP'\)/);
  assert.match(body,/DUNGEON_MAP_RE\.test\(p\.map\)/);
  assert.match(body,/maps\.get\(p\.map\)/);
  assert.match(body,/dm\.userId === p\.userId/);
  assert.match(body,/dm\.inside !== false/);
  assert.match(body,/sendDungeonStateTo\(ws, ds, \{resync:true\}\)/);
  assert.match(body,/position_resync/);
});
