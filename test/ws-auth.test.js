'use strict';
// Fase 5.2, Parte 1: autenticacao do 'join' do WebSocket. cls/lvl forjados
// so sao aceitos quando a conexao NAO tem token valido (visita anonima,
// sem nenhuma operacao economica possivel -- comportamento preservado de
// proposito). Com token+charId validos, cls/lvl reais vem do banco e
// qualquer valor forjado na mensagem 'join' e ignorado. Observamos isso
// indiretamente via publicPlayer() (cls/lvl) no player_join broadcast pra
// um segundo socket, ja que 'welcome' nao ecoa esses campos de volta pra
// quem entrou. Precisa de Supabase.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, wsConnect, waitFor, sleep } = require('./helpers');

const PORT = 8110;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'qa_' + Math.random().toString(36).slice(2, 10);
async function newCharAccount(cls = 'mago', lvl = 7) {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Autenticado', cls }, token);
  const id = created.json.character.id;
  await httpJson(srv, 'PUT', '/api/characters/' + id, { lvl, save: {} }, token);
  return { token, id, cls };
}

// Conecta um socket-observador na vila pra ver o player_join de quem entra depois.
async function newObserver() {
  const obs = await wsConnect(srv);
  obs.ws.send(JSON.stringify({ type: 'join', name: 'Observador', cls: 'guerreiro', lvl: 1 }));
  await waitFor(obs.msgs, m => m.type === 'welcome', 3000);
  return obs;
}

test('sem token: join anonimo funciona, cls/lvl forjados na mensagem sao aceitos (visita efemera, sem economia)', { skip: !hasSupabase() }, async () => {
  const obs = await newObserver();
  const before = obs.msgs.length;
  const anon = await wsConnect(srv);
  anon.ws.send(JSON.stringify({ type: 'join', name: 'Anonimo', cls: 'arqueiro', lvl: 33 }));
  await waitFor(anon.msgs, m => m.type === 'welcome', 3000);
  const join = await waitFor(obs.msgs, m => m.type === 'player_join' && m.player.name === 'Anonimo', 2000, before);
  assert.equal(join.player.cls, 'arqueiro');
  assert.equal(join.player.lvl, 33);
  obs.close(); anon.close();
});

test('token invalido: degrada pra anonimo (mesmo comportamento de sem token, nao derruba a conexao)', { skip: !hasSupabase() }, async () => {
  const obs = await newObserver();
  const before = obs.msgs.length;
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'TokenFalso', cls: 'druida', lvl: 9, token: 'token-que-nao-existe-em-lugar-nenhum' }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  const join = await waitFor(obs.msgs, m => m.type === 'player_join' && m.player.name === 'TokenFalso', 2000, before);
  assert.equal(join.player.cls, 'druida', 'com token invalido, degrada pra anonimo e aceita o cls da mensagem');
  obs.close(); conn.close();
});

test('charId inexistente: token valido mas charId nao existe -> degrada pra anonimo (cls/lvl da mensagem)', { skip: !hasSupabase() }, async () => {
  const acc = await newCharAccount();
  const obs = await newObserver();
  const before = obs.msgs.length;
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'CharFalso', cls: 'guerreiro', lvl: 55, token: acc.token, charId: '99999999-9999-9999-9999-999999999999' }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  const join = await waitFor(obs.msgs, m => m.type === 'player_join' && m.player.name === 'CharFalso', 2000, before);
  assert.equal(join.player.lvl, 55, 'charId inexistente nao deveria autenticar -- cls/lvl da mensagem sao usados (visita anonima)');
  obs.close(); conn.close();
});

test('charId de outra conta: token valido de A + charId de B -> nao autentica com o personagem de B', { skip: !hasSupabase() }, async () => {
  const a = await newCharAccount('guerreiro', 1);
  const b = await newCharAccount('mago', 20);
  const obs = await newObserver();
  const before = obs.msgs.length;
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'RoubandoConta', cls: 'arqueiro', lvl: 44, token: a.token, charId: b.id }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  const join = await waitFor(obs.msgs, m => m.type === 'player_join' && m.player.name === 'RoubandoConta', 2000, before);
  assert.notEqual(join.player.cls, 'mago', 'nao deveria ter autenticado com o personagem (mago) que pertence a outra conta');
  assert.equal(join.player.lvl, 44, 'sem autenticacao real, cai pro fallback anonimo (lvl da mensagem)');
  obs.close(); conn.close();
});

test('token + charId validos e da propria conta: cls/lvl reais do banco, forjados na mensagem sao ignorados', { skip: !hasSupabase() }, async () => {
  const acc = await newCharAccount('mago', 7);
  const obs = await newObserver();
  const before = obs.msgs.length;
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'Legitimo', cls: 'guerreiro', lvl: 99, token: acc.token, charId: acc.id }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  const join = await waitFor(obs.msgs, m => m.type === 'player_join' && m.player.name === 'Legitimo', 2000, before);
  assert.equal(join.player.cls, 'mago', 'cls real do personagem deveria prevalecer sobre o forjado (guerreiro)');
  assert.equal(join.player.lvl, 7, 'lvl real do personagem deveria prevalecer sobre o forjado (99)');
  obs.close(); conn.close();
});

test('userId forjado nao existe como campo controlavel pelo cliente -- join nunca aceita userId na mensagem', { skip: !hasSupabase() }, async () => {
  const acc = await newCharAccount('arqueiro', 3);
  const obs = await newObserver();
  const before = obs.msgs.length;
  const conn = await wsConnect(srv);
  // manda um userId arbitrario junto -- servidor so deve derivar userId do token, nunca da mensagem
  conn.ws.send(JSON.stringify({ type: 'join', name: 'ComUserIdForjado', cls: 'guerreiro', lvl: 1, token: acc.token, charId: acc.id, userId: 'id-forjado-qualquer' }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  const join = await waitFor(obs.msgs, m => m.type === 'player_join' && m.player.name === 'ComUserIdForjado', 2000, before);
  assert.equal(join.player.cls, 'arqueiro', 'autenticacao real via token deveria ter funcionado normalmente, ignorando o userId da mensagem');
  obs.close(); conn.close();
});

test('reconexao: nova conexao com o mesmo token reautentica do zero (nao reusa identidade nao validada)', { skip: !hasSupabase() }, async () => {
  const acc = await newCharAccount('druida', 11);
  const obs = await newObserver();

  const conn1 = await wsConnect(srv);
  conn1.ws.send(JSON.stringify({ type: 'join', name: 'Reconectando', cls: 'guerreiro', lvl: 1, token: acc.token, charId: acc.id }));
  await waitFor(conn1.msgs, m => m.type === 'welcome', 3000);
  conn1.close();
  await sleep(150);

  const before = obs.msgs.length;
  const conn2 = await wsConnect(srv);
  conn2.ws.send(JSON.stringify({ type: 'join', name: 'Reconectando', cls: 'guerreiro', lvl: 1, token: acc.token, charId: acc.id }));
  await waitFor(conn2.msgs, m => m.type === 'welcome', 3000);
  const join = await waitFor(obs.msgs, m => m.type === 'player_join' && m.player.name === 'Reconectando', 2000, before);
  assert.equal(join.player.cls, 'druida', 'reconexao deveria reautenticar e trazer o cls real de novo');
  assert.equal(join.player.lvl, 11);
  obs.close(); conn2.close();
});
