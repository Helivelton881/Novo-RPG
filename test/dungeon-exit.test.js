'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyDungeonExit } = require('../server.js');

function fixture(overrides) {
  const member = { userId: 'user-1', online: true, inside: true, lastActivityAt: 0 };
  const state = {
    id: 'floresta_d#1234abcd', isDungeon: true, zone: 'floresta',
    layout: { exitPoint: { x: 2174, y: 317 } }, members: new Map([['char-1', member]]), lastActiveAt: 0,
  };
  const p = Object.assign({ charId: 'char-1', userId: 'user-1', map: state.id, x: 2174, y: 317, moving: true, atkT: .2 }, overrides || {});
  return { p, state, member };
}

test('saida valida da dungeon volta para a zona de origem e marca membro fora da instancia', () => {
  const { p, state, member } = fixture();
  assert.equal(applyDungeonExit(p, state, 'floresta', 12345), true);
  assert.deepEqual({ map:p.map, x:p.x, y:p.y, moving:p.moving, atkT:p.atkT }, { map:'floresta', x:480, y:1906, moving:false, atkT:0 });
  assert.equal(member.online, false);
  assert.equal(member.inside, false);
  assert.equal(member.lastActivityAt, 12345);
});

test('saida rejeita zona diferente, intruso e jogador longe do portal', () => {
  let f = fixture();
  assert.equal(applyDungeonExit(f.p, f.state, 'vila'), false);
  f = fixture({ charId: 'intruso' });
  assert.equal(applyDungeonExit(f.p, f.state, 'floresta'), false);
  f = fixture({ x: 100, y: 100 });
  assert.equal(applyDungeonExit(f.p, f.state, 'floresta'), false);
  assert.match(f.p.map, /^floresta_d#/);
});
