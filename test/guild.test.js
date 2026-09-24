'use strict';
// Fase 5.8 -- Guildas / Cla. Parte 1: logica pura de game-data/guild.js
// (sempre roda, sem Supabase). Parte 2: fluxo real via HTTP contra o
// servidor + Supabase de teste (mesmo projeto oficial, ver LEIA-PRIMEIRO.md)
// -- so roda com credenciais configuradas (hasSupabase()).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson } = require('./helpers');
const GUILD = require('../game-data/guild.js');

// ===== Parte 1: logica pura =====
test('GUILD_MAX_MEMBERS e 20', () => { assert.equal(GUILD.GUILD_MAX_MEMBERS, 20); });

test('validateGuildName: aceita nomes de 3 a 24 caracteres', () => {
  assert.equal(GUILD.validateGuildName('Abc').ok, true);
  assert.equal(GUILD.validateGuildName('A'.repeat(24)).ok, true);
});
test('validateGuildName: rejeita curto demais e longo demais', () => {
  assert.equal(GUILD.validateGuildName('Ab').ok, false);
  assert.equal(GUILD.validateGuildName('A'.repeat(25)).ok, false);
});
test('validateGuildName: normaliza espacos duplicados e das pontas', () => {
  const r = GUILD.validateGuildName('  Cavaleiros   da   Luz  ');
  assert.equal(r.ok, true); assert.equal(r.value, 'Cavaleiros da Luz');
});
test('validateGuildName: <>/controle sao removidos, nao viram bypass de charset', () => {
  // '<' e '>' sao descartados na normalizacao (mesma convencao de
  // cleanText no servidor); o que sobra ainda precisa ser um nome valido.
  assert.equal(GUILD.validateGuildName('<script>ab').value, 'scriptab');
});
test('validateGuildName: simbolos que nao sao letra/numero/espaco continuam invalidos', () => {
  assert.equal(GUILD.validateGuildName('!!!@@@###').ok, false);
});
test('validateGuildTag: aceita 2 a 5 letras/numeros, normaliza maiuscula', () => {
  const r = GUILD.validateGuildTag('ab1');
  assert.equal(r.ok, true); assert.equal(r.value, 'AB1');
});
test('validateGuildTag: rejeita curta/longa demais e com simbolo', () => {
  assert.equal(GUILD.validateGuildTag('A').ok, false);
  assert.equal(GUILD.validateGuildTag('ABCDEF').ok, false);
  assert.equal(GUILD.validateGuildTag('A-B').ok, false);
  assert.equal(GUILD.validateGuildTag('A@B').ok, false);
});
test('validateGuildTag: espaco interno e removido na normalizacao (nao vira bypass)', () => {
  assert.equal(GUILD.validateGuildTag('A B').value, 'AB');
});

test('permissoes: leader convida, remove, promove, rebaixa, transfere, dissolve', () => {
  assert.equal(GUILD.canInvite('leader'), true);
  assert.equal(GUILD.canRemoveMember('leader', 'officer'), true);
  assert.equal(GUILD.canRemoveMember('leader', 'member'), true);
  assert.equal(GUILD.canPromote('leader', 'member'), true);
  assert.equal(GUILD.canDemote('leader', 'officer'), true);
  assert.equal(GUILD.canTransferLeadership('leader'), true);
});
test('permissoes: leader nunca remove outro leader (via essa funcao)', () => {
  assert.equal(GUILD.canRemoveMember('leader', 'leader'), false);
});
test('permissoes: officer convida e remove member comum, nunca officer/leader', () => {
  assert.equal(GUILD.canInvite('officer'), true);
  assert.equal(GUILD.canRemoveMember('officer', 'member'), true);
  assert.equal(GUILD.canRemoveMember('officer', 'officer'), false);
  assert.equal(GUILD.canRemoveMember('officer', 'leader'), false);
});
test('permissoes: officer nunca promove, rebaixa, transfere ou dissolve', () => {
  assert.equal(GUILD.canPromote('officer', 'member'), false);
  assert.equal(GUILD.canDemote('officer', 'officer'), false);
  assert.equal(GUILD.canTransferLeadership('officer'), false);
  assert.equal(GUILD.canDissolve('officer'), false);
});
test('permissoes: member comum nunca convida, remove, promove, rebaixa ou dissolve', () => {
  assert.equal(GUILD.canInvite('member'), false);
  assert.equal(GUILD.canRemoveMember('member', 'member'), false);
  assert.equal(GUILD.canPromote('member', 'member'), false);
  assert.equal(GUILD.canDissolve('member'), false);
});
test('canLeaveDirectly: member/officer sempre podem sair', () => {
  assert.equal(GUILD.canLeaveDirectly('member', 10), true);
  assert.equal(GUILD.canLeaveDirectly('officer', 10), true);
});
test('canLeaveDirectly: leader so sai direto se for o unico membro', () => {
  assert.equal(GUILD.canLeaveDirectly('leader', 1), true);
  assert.equal(GUILD.canLeaveDirectly('leader', 2), false);
});
test('isInviteExpired: verdadeiro apos expires_at, falso antes', () => {
  const now = Date.now();
  assert.equal(GUILD.isInviteExpired({expires_at:new Date(now-1000).toISOString()}, now), true);
  assert.equal(GUILD.isInviteExpired({expires_at:new Date(now+1000).toISOString()}, now), false);
});

// ===== Parte 2: fluxo real (HTTP + Supabase de teste) =====
const PORT = 8140;
let srv;
before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'gq_' + Math.random().toString(36).slice(2, 10);
async function newChar(namePrefix) {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const name = (namePrefix || 'H') + Math.random().toString(36).slice(2, 6);
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name, cls: 'guerreiro' }, token);
  return { token, charId: created.json.character.id, name };
}
async function createGuild(leader, name, tag) {
  return httpJson(srv, 'POST', `/api/guild/${leader.charId}`, { name, tag }, leader.token);
}
async function inviteAndAccept(actor, guildLeaderOrOfficer, target) {
  const inv = await httpJson(srv, 'POST', `/api/guild/${guildLeaderOrOfficer.charId}/invite`, { targetCharacterId: target.charId }, guildLeaderOrOfficer.token);
  assert.equal(inv.status, 201, 'convite deveria ser criado: ' + JSON.stringify(inv.json));
  const invites = await httpJson(srv, 'GET', `/api/guild/${target.charId}/invites`, null, target.token);
  const found = invites.json.incoming.find(i => i.guildTag);
  return httpJson(srv, 'POST', `/api/guild/${target.charId}/invites/${found.id}/accept`, null, target.token);
}

test('criacao: guilda valida retorna 201 e vira lider automaticamente', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('Lid');
  const r = await createGuild(leader, 'Guilda ' + rnd(), 'TG' + rnd().slice(0, 2));
  assert.equal(r.status, 201);
  assert.equal(r.json.guild.myRole, 'leader');
  assert.equal(r.json.guild.members.length, 1);
});

test('criacao: nome duplicado (case-insensitive) e rejeitado', { skip: !hasSupabase() }, async () => {
  const a = await newChar('A'), b = await newChar('B');
  const name = 'Duplicada ' + rnd();
  const first = await createGuild(a, name, 'DP1');
  assert.equal(first.status, 201);
  const second = await createGuild(b, name.toUpperCase(), 'DP2');
  assert.equal(second.status, 400);
});

test('criacao: tag duplicada (case-insensitive) e rejeitada', { skip: !hasSupabase() }, async () => {
  const a = await newChar('A'), b = await newChar('B');
  const tag = 'TAG' + rnd().slice(0, 1);
  const first = await createGuild(a, 'Guilda ' + rnd(), tag);
  assert.equal(first.status, 201);
  const second = await createGuild(b, 'Guilda ' + rnd(), tag.toLowerCase());
  assert.equal(second.status, 400);
});

test('criacao: personagem ja em guilda nao pode criar outra', { skip: !hasSupabase() }, async () => {
  const a = await newChar('A');
  const first = await createGuild(a, 'Primeira ' + rnd(), 'PR1');
  assert.equal(first.status, 201);
  const second = await createGuild(a, 'Segunda ' + rnd(), 'SG2');
  assert.equal(second.status, 400);
});

test('convite: convidar, listar, aceitar entra o personagem como member', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('L'), joiner = await newChar('J');
  await createGuild(leader, 'Convite ' + rnd(), 'CV' + rnd().slice(0, 2));
  const accept = await inviteAndAccept(leader, leader, joiner);
  assert.equal(accept.status, 200);
  assert.equal(accept.json.guild.members.length, 2);
  const joinerMembership = accept.json.guild.members.find(m => m.charId === joiner.charId);
  assert.equal(joinerMembership.role, 'member');
});

test('convite: recusar marca o convite como respondido (nao aceitavel de novo)', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('L'), target = await newChar('T');
  await createGuild(leader, 'Recusa ' + rnd(), 'RC' + rnd().slice(0, 2));
  await httpJson(srv, 'POST', `/api/guild/${leader.charId}/invite`, { targetCharacterId: target.charId }, leader.token);
  const invites = await httpJson(srv, 'GET', `/api/guild/${target.charId}/invites`, null, target.token);
  const id = invites.json.incoming[0].id;
  const decline = await httpJson(srv, 'POST', `/api/guild/${target.charId}/invites/${id}/decline`, null, target.token);
  assert.equal(decline.status, 200);
  const acceptAfter = await httpJson(srv, 'POST', `/api/guild/${target.charId}/invites/${id}/accept`, null, target.token);
  assert.equal(acceptAfter.status, 400);
});

test('convite: personagem que ja pertence a guilda nao pode ser convidado de novo', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('L'), joiner = await newChar('J'), other = await newChar('O');
  await createGuild(leader, 'Ocupado ' + rnd(), 'OC' + rnd().slice(0, 2));
  await inviteAndAccept(leader, leader, joiner);
  await createGuild(other, 'Outra ' + rnd(), 'OT' + rnd().slice(0, 2));
  const invalidInvite = await httpJson(srv, 'POST', `/api/guild/${other.charId}/invite`, { targetCharacterId: joiner.charId }, other.token);
  assert.equal(invalidInvite.status, 400);
});

test('permissao real: member comum nao pode convidar (403)', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('L'), member = await newChar('M'), target = await newChar('T');
  await createGuild(leader, 'Hierarquia ' + rnd(), 'HR' + rnd().slice(0, 2));
  await inviteAndAccept(leader, leader, member);
  const r = await httpJson(srv, 'POST', `/api/guild/${member.charId}/invite`, { targetCharacterId: target.charId }, member.token);
  assert.equal(r.status, 403);
});

test('permissao real: officer nao pode promover nem rebaixar ninguem', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('L'), officer = await newChar('O'), member = await newChar('M');
  await createGuild(leader, 'Cargo ' + rnd(), 'CG' + rnd().slice(0, 2));
  await inviteAndAccept(leader, leader, officer);
  await inviteAndAccept(leader, leader, member);
  await httpJson(srv, 'POST', `/api/guild/${leader.charId}/promote`, { targetCharacterId: officer.charId }, leader.token);
  const r = await httpJson(srv, 'POST', `/api/guild/${officer.charId}/promote`, { targetCharacterId: member.charId }, officer.token);
  assert.equal(r.status, 400); // guild_set_role: INSUFFICIENT_ROLE
});

test('permissao real: officer nao pode remover outro officer nem o leader', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('L'), officerA = await newChar('OA'), officerB = await newChar('OB');
  await createGuild(leader, 'Officers ' + rnd(), 'OF' + rnd().slice(0, 2));
  await inviteAndAccept(leader, leader, officerA);
  await inviteAndAccept(leader, leader, officerB);
  await httpJson(srv, 'POST', `/api/guild/${leader.charId}/promote`, { targetCharacterId: officerA.charId }, leader.token);
  await httpJson(srv, 'POST', `/api/guild/${leader.charId}/promote`, { targetCharacterId: officerB.charId }, leader.token);
  const kickOfficer = await httpJson(srv, 'POST', `/api/guild/${officerA.charId}/kick`, { targetCharacterId: officerB.charId }, officerA.token);
  assert.equal(kickOfficer.status, 400);
  const kickLeader = await httpJson(srv, 'POST', `/api/guild/${officerA.charId}/kick`, { targetCharacterId: leader.charId }, officerA.token);
  assert.equal(kickLeader.status, 400);
});

test('leader promove e rebaixa oficial normalmente', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('L'), member = await newChar('M');
  await createGuild(leader, 'Promocao ' + rnd(), 'PM' + rnd().slice(0, 2));
  await inviteAndAccept(leader, leader, member);
  const promote = await httpJson(srv, 'POST', `/api/guild/${leader.charId}/promote`, { targetCharacterId: member.charId }, leader.token);
  assert.equal(promote.status, 200);
  const demote = await httpJson(srv, 'POST', `/api/guild/${leader.charId}/demote`, { targetCharacterId: member.charId }, leader.token);
  assert.equal(demote.status, 200);
  const view = await httpJson(srv, 'GET', `/api/guild/${leader.charId}`, null, leader.token);
  assert.equal(view.json.guild.members.find(m => m.charId === member.charId).role, 'member');
});

test('transferencia de lideranca: novo lider vira leader, antigo vira officer, nunca 0 ou 2 lideres', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('L'), member = await newChar('M');
  await createGuild(leader, 'Transferencia ' + rnd(), 'TR' + rnd().slice(0, 2));
  await inviteAndAccept(leader, leader, member);
  const transfer = await httpJson(srv, 'POST', `/api/guild/${leader.charId}/transfer`, { targetCharacterId: member.charId }, leader.token);
  assert.equal(transfer.status, 200);
  const view = await httpJson(srv, 'GET', `/api/guild/${member.charId}`, null, member.token);
  const roles = view.json.guild.members.map(m => m.role).sort();
  assert.deepEqual(roles, ['leader', 'officer']);
  assert.equal(view.json.guild.leaderCharacterId, member.charId);
  assert.equal(view.json.guild.members.find(m => m.charId === leader.charId).role, 'officer');
});

test('sair: member/officer saem livremente', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('L'), member = await newChar('M');
  await createGuild(leader, 'Saida ' + rnd(), 'SD' + rnd().slice(0, 2));
  await inviteAndAccept(leader, leader, member);
  const leave = await httpJson(srv, 'POST', `/api/guild/${member.charId}/leave`, null, member.token);
  assert.equal(leave.status, 200);
  const view = await httpJson(srv, 'GET', `/api/guild/${member.charId}`, null, member.token);
  assert.equal(view.json.guild, null);
});

test('sair: leader com outros membros nao pode sair direto (precisa transferir ou dissolver)', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('L'), member = await newChar('M');
  await createGuild(leader, 'BloqueioSaida ' + rnd(), 'BS' + rnd().slice(0, 2));
  await inviteAndAccept(leader, leader, member);
  const leave = await httpJson(srv, 'POST', `/api/guild/${leader.charId}/leave`, null, leader.token);
  assert.equal(leave.status, 400);
});

test('sair: leader unico membro pode sair (equivale a dissolver)', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('L');
  await createGuild(leader, 'SoLider ' + rnd(), 'SL' + rnd().slice(0, 2));
  const leave = await httpJson(srv, 'POST', `/api/guild/${leader.charId}/leave`, null, leader.token);
  assert.equal(leave.status, 200);
  const view = await httpJson(srv, 'GET', `/api/guild/${leader.charId}`, null, leader.token);
  assert.equal(view.json.guild, null);
});

test('dissolver: so o leader pode, remove membros e convites pendentes', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('L'), member = await newChar('M'), pendingTarget = await newChar('P');
  await createGuild(leader, 'Dissolver ' + rnd(), 'DS' + rnd().slice(0, 2));
  await inviteAndAccept(leader, leader, member);
  await httpJson(srv, 'POST', `/api/guild/${leader.charId}/invite`, { targetCharacterId: pendingTarget.charId }, leader.token);
  const notLeaderTry = await httpJson(srv, 'POST', `/api/guild/${member.charId}/dissolve`, null, member.token);
  assert.equal(notLeaderTry.status, 400);
  const dissolve = await httpJson(srv, 'POST', `/api/guild/${leader.charId}/dissolve`, null, leader.token);
  assert.equal(dissolve.status, 200);
  const viewLeader = await httpJson(srv, 'GET', `/api/guild/${leader.charId}`, null, leader.token);
  assert.equal(viewLeader.json.guild, null);
  const viewMember = await httpJson(srv, 'GET', `/api/guild/${member.charId}`, null, member.token);
  assert.equal(viewMember.json.guild, null);
  const invitesAfter = await httpJson(srv, 'GET', `/api/guild/${pendingTarget.charId}/invites`, null, pendingTarget.token);
  assert.equal(invitesAfter.json.incoming.length, 0);
});

test('tampering: role arbitraria enviada pelo cliente nunca e persistida (servidor sempre le a role real)', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('L'), member = await newChar('M');
  await createGuild(leader, 'Tampering ' + rnd(), 'TP' + rnd().slice(0, 2));
  await inviteAndAccept(leader, leader, member);
  // 'member' tenta se autopromover mandando role=leader direto no kick/promote --
  // a rota nem aceita esse campo; so existe targetCharacterId+charId da URL
  // (a role de quem age vem sempre de guild_members no banco).
  const r = await httpJson(srv, 'POST', `/api/guild/${member.charId}/promote`, { targetCharacterId: member.charId, role: 'leader' }, member.token);
  assert.equal(r.status, 400);
  const view = await httpJson(srv, 'GET', `/api/guild/${leader.charId}`, null, leader.token);
  assert.equal(view.json.guild.members.find(m => m.charId === member.charId).role, 'member');
});

test('concorrencia: dois personagens criando guilda com o mesmo nome ao mesmo tempo -- so um sucede', { skip: !hasSupabase() }, async () => {
  const a = await newChar('CA'), b = await newChar('CB');
  const name = 'Corrida ' + rnd();
  const [ra, rb] = await Promise.all([createGuild(a, name, 'RA' + rnd().slice(0,1)), createGuild(b, name, 'RB' + rnd().slice(0,1))]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, [201, 400]);
});

test('chat de guilda: mensagem so chega a membros reais da mesma guilda', { skip: !hasSupabase() }, async () => {
  const { wsConnect, waitFor } = require('./helpers');
  const leader = await newChar('L'), member = await newChar('M'), outsider = await newChar('O');
  await createGuild(leader, 'Chat ' + rnd(), 'CH' + rnd().slice(0, 2));
  await inviteAndAccept(leader, leader, member);
  await createGuild(outsider, 'Fora ' + rnd(), 'FR' + rnd().slice(0, 2));

  const connLeader = await wsConnect(srv);
  connLeader.ws.send(JSON.stringify({ type: 'join', token: leader.token, charId: leader.charId }));
  await waitFor(connLeader.msgs, m => m.type === 'welcome', 3000);

  const connMember = await wsConnect(srv);
  connMember.ws.send(JSON.stringify({ type: 'join', token: member.token, charId: member.charId }));
  await waitFor(connMember.msgs, m => m.type === 'welcome', 3000);

  const connOutsider = await wsConnect(srv);
  connOutsider.ws.send(JSON.stringify({ type: 'join', token: outsider.token, charId: outsider.charId }));
  await waitFor(connOutsider.msgs, m => m.type === 'welcome', 3000);

  connLeader.ws.send(JSON.stringify({ type: 'guild_chat', text: 'Ola guilda' }));
  const received = await waitFor(connMember.msgs, m => m.type === 'guild_chat' && m.text === 'Ola guilda', 3000);
  assert.equal(received.from, leader.name);

  await new Promise(r => setTimeout(r, 300));
  const leaked = connOutsider.msgs.find(m => m.type === 'guild_chat');
  assert.equal(leaked, undefined);

  connLeader.close(); connMember.close(); connOutsider.close();
});

test('limite 20: guilda cheia rejeita o 21o convite', { skip: !hasSupabase() }, async () => {
  const leader = await newChar('CapL');
  await createGuild(leader, 'Lotada ' + rnd(), 'LT' + rnd().slice(0, 2));
  for (let i = 0; i < 19; i++) {
    const joiner = await newChar('Cap' + i);
    const accept = await inviteAndAccept(leader, leader, joiner);
    assert.equal(accept.status, 200, `join ${i} deveria funcionar`);
  }
  const view = await httpJson(srv, 'GET', `/api/guild/${leader.charId}`, null, leader.token);
  assert.equal(view.json.guild.members.length, 20);
  const extra = await newChar('CapExtra');
  const invite21 = await httpJson(srv, 'POST', `/api/guild/${leader.charId}/invite`, { targetCharacterId: extra.charId }, leader.token);
  assert.equal(invite21.status, 400);
});
