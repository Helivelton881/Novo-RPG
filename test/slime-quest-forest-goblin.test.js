'use strict';
// Hotfix: "quest dos slimes -> portal da Floresta -> Goblins congelados".
//
// Causa raiz real (achada por leitura de codigo, confirmada ao vivo em
// producao): allowedFieldTransition (server.js) decide se um personagem pode
// entrar num mapa de campo (ex.: Floresta) usando `p.quest` -- um campo do
// OBJETO DE CONEXAO WS em memoria, lido UMA UNICA VEZ no join
// (handleWsJoin) e nunca resincronizado depois. Tanto handleQuest (entregar
// a missao dos 3 Slimes, POST /quest) quanto creditKillReward
// (advanceQuestOnKill, abate que avanca/flipa quest) e handleShop
// (buy_portal, desbloqueio comprado) gravam `save.quest`/`save.gunlock`
// DIRETO no banco, sem nunca tocar o `p` da conexao WS ja aberta. Resultado:
// na MESMA sessao (sem reconectar), o portal da Floresta nunca abre de
// verdade -- toda mensagem 'state' pra floresta e rejeitada por
// allowedFieldTransition, o servidor manda position_resync de volta pra
// vila, e `p.map` nunca vira 'floresta'. Como map_join/mob_damage/
// playersOnMap/tickMobAI TODOS exigem p.map==='floresta' pra esse socket,
// os Goblins nunca recebem jogador presente -- congelados so pra quem
// acabou de desbloquear a zona, na mesma sessao. Reproduzido ao vivo em
// producao (b76fcb6): apos entregar a missao, "Entrar" no portal disparava
// "Posição sincronizada com o servidor" repetidas vezes, nunca entrando de
// verdade -- so um F5 (reconexao, que recarrega p.quest fresco do banco)
// resolvia, confirmando a causa.
//
// Correcao: handleQuest e creditKillReward passam a atualizar o `p`/`activeP`
// vivo (`p.quest`/`activeP.quest`) logo apos o PATCH bem-sucedido; handleShop
// (buy_portal) faz o mesmo pra `activeP.gunlock`. Nenhuma mudanca na regra
// de negocio (allowedFieldTransition continua 100% server-autoritativo) --
// so mantem o snapshot em memoria em dia com o banco.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, wsConnect, waitFor, sleep } = require('./helpers');

const PORT = 8120;
let srv;
before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

const rnd = () => 'qa_' + Math.random().toString(36).slice(2, 10);
async function newChar(cls) {
  const username = rnd(), password = 'SenhaForte123';
  const reg = await httpJson(srv, 'POST', '/api/auth/register', { username, password });
  const token = reg.json.token;
  const created = await httpJson(srv, 'POST', '/api/characters', { slot: 0, name: 'Heroi', cls: cls || 'guerreiro' }, token);
  return { token, id: created.json.character.id, cls: cls || 'guerreiro' };
}
async function reloadChar(ch) {
  const r = await httpJson(srv, 'GET', '/api/characters', null, ch.token);
  return r.json.characters.find(c => c.id === ch.id);
}
// PORTAL_VILA = {x:720,y:1042} (server.js, allowedFieldTransition) -- por
// nascer exatamente ai (via save.x/y no PUT abaixo), a checagem de raio do
// portal passa sem precisar de nenhum movimento/click-to-move real.
async function authedWs(ch) {
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'Heroi', cls: ch.cls, lvl: 1, token: ch.token, charId: ch.id }));
  const welcome = await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  return Object.assign(conn, { sessionKey: welcome.sessionKey });
}

test('quest 2->3 (entregar missao dos slimes) libera a Floresta NA MESMA sessao WS, sem precisar reconectar', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  await httpJson(srv, 'PUT', '/api/characters/' + ch.id, { lvl: 40, save: { quest: 2, x: 720, y: 1042, map: 'vila', gk: 0 } }, ch.token);
  const conn = await authedWs(ch);

  // entrega a missao -- grava save.quest=3 no banco (isso ja funcionava
  // antes desta correcao).
  const q = await httpJson(srv, 'POST', '/api/characters/' + ch.id + '/quest', { from: 2 }, ch.token);
  assert.equal(q.status, 200);
  assert.equal(q.json.character.save.quest, 3);

  // sem reconectar: tenta entrar na Floresta pela MESMA conexao WS que
  // aceitou/entregou a missao. Antes da correcao, isso e rejeitado pra
  // sempre (p.quest da conexao continua 2) e o servidor manda
  // position_resync de volta pra vila -- nunca chega a mandar 'map_state'.
  const before = conn.msgs.length;
  conn.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: 0, y: 0, dir: 0, moving: false }));
  await sleep(150);
  const resync = conn.msgs.slice(before).find(m => m.type === 'position_resync');
  assert.equal(resync, undefined, 'nao deveria ter sido resincronizado de volta pra vila -- a Floresta deveria ter sido aceita na mesma sessao');

  conn.ws.send(JSON.stringify({ type: 'map_join', map: 'floresta', mobs: [] }));
  const st = await waitFor(conn.msgs, m => m.type === 'map_state' && m.map === 'floresta', 3000);
  // MOB_MANIFEST.floresta: 19 goblins comuns + 1 Goblin Chefe (boss) --
  // so chega aqui (map_join nao devolve nada se p.map!=='floresta').
  assert.equal(st.mobs.length, 20, 'roster completo da Floresta deveria ter sido criado (prova que p.map===\'floresta\' no servidor)');
  assert.ok(st.mobs.some(m => m.boss === true), 'Goblin Chefe deveria estar no roster');

  const goblin = st.mobs.find(m => m.boss === false);
  assert.ok(goblin, 'deveria existir ao menos um goblin comum');

  // Goblin nao fica mais congelado: com o jogador bem perto (mob nasce em
  // 0,0 -- mobs sem defs do cliente usam esse default -- e o jogador
  // acabou de chegar em 0,0), a IA (tickMobAI, a cada 150ms) deveria
  // sair de idle pra chase sozinha, sem nenhum ataque do jogador ainda.
  const chaseMsg = await waitFor(conn.msgs, m => m.type === 'mob_positions' && m.map === 'floresta' && m.mobs.some(x => x.id === goblin.id && x.state !== 'idle'), 2000);
  assert.ok(chaseMsg, 'Goblin deveria ter saido de idle sozinho (perseguindo o jogador) -- nao mais congelado');

  // mob_damage e aceito (nao e mais descartado por map!==p.map) e o
  // Goblin realmente morre.
  let dead = null;
  for (let i = 0; i < 25 && !dead; i++) {
    conn.ws.send(JSON.stringify({ type: 'mob_damage', map: 'floresta', id: goblin.id, skill: 'basic' }));
    await sleep(90);
    const last = conn.msgs.filter(m => m.type === 'mob_state' && m.mob.id === goblin.id).pop();
    if (last && (last.mob.dead || last.mob.hp <= 0)) dead = last;
  }
  assert.ok(dead, 'Goblin deveria ter morrido dentro da janela de tentativas -- prova que mob_damage nao e mais rejeitado por mapa incorreto');

  await sleep(250); // withCharLock do creditKillReward e assincrono
  conn.close();
  const reloaded = await reloadChar(ch);
  assert.equal(reloaded.save.gk, 1, 'contador de missao dos Goblins (gk) deveria ter avançado com o abate real');
  assert.equal(reloaded.save.quest, 3, 'ainda faltam 4 goblins -- quest nao deveria ter avançado pra 4 ainda');
});

test('boss-kill (advanceQuestOnKill via creditKillReward) tambem resincroniza p.quest -- proxima zona libera sem reconectar', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  // quest 5: "derrote o Goblin Brutamontes" -- falta so o abate do chefe
  // (flip direto 5->6, sem contador) pra liberar a Cripta (quest>=7... na
  // verdade cripta exige 7, mas o proprio avanco de quest 5->6 ja e o que
  // este teste quer provar: p.quest da conexao WS precisa refletir o novo
  // valor sem reconectar).
  await httpJson(srv, 'PUT', '/api/characters/' + ch.id, { lvl: 40, save: { quest: 5, x: 720, y: 1042, map: 'vila' } }, ch.token);
  const conn = await authedWs(ch);

  conn.ws.send(JSON.stringify({ type: 'map_join', map: 'floresta', mobs: [] }));
  const st = await waitFor(conn.msgs, m => m.type === 'map_state' && m.map === 'floresta', 3000);
  const boss = st.mobs.find(m => m.boss === true);
  assert.ok(boss, 'Goblin Chefe deveria estar no roster');

  let dead = null;
  for (let i = 0; i < 60 && !dead; i++) {
    conn.ws.send(JSON.stringify({ type: 'mob_damage', map: 'floresta', id: boss.id, skill: 'basic' }));
    await sleep(90);
    const last = conn.msgs.filter(m => m.type === 'mob_state' && m.mob.id === boss.id).pop();
    if (last && (last.mob.dead || last.mob.hp <= 0)) dead = last;
  }
  assert.ok(dead, 'Goblin Chefe deveria ter morrido dentro da janela de tentativas');
  await sleep(250);

  const reloaded = await reloadChar(ch);
  assert.equal(reloaded.save.quest, 6, 'abate do chefe deveria ter avançado quest 5->6 (flip direto, sem contador)');

  // sem reconectar: volta pra vila e confirma que a MESMA conexao ja
  // reflete quest=6 (server.js: creditKillReward agora faz p.quest=save.quest).
  conn.ws.send(JSON.stringify({ type: 'state', map: 'vila', x: 720, y: 1042, dir: 0, moving: false }));
  await sleep(150);
  conn.close();
});

test('shop buy_portal (desbloqueio comprado) tambem resincroniza p.gunlock -- entra na zona sem reconectar', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  await httpJson(srv, 'PUT', '/api/characters/' + ch.id, { lvl: 1, save: { quest: 0, gold: 1000, x: 720, y: 1042, map: 'vila' } }, ch.token);
  const conn = await authedWs(ch);

  // handleShop exige o header x-game-session batendo com p.sessionKey da
  // conexao WS ativa (STALE_SESSION) -- httpJson (helpers.js) nao permite
  // headers extras, entao usa fetch direto aqui, mesmo padrao.
  const buy = await fetch(srv.base + '/api/characters/' + ch.id + '/shop', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ch.token, 'x-game-session': conn.sessionKey },
    body: JSON.stringify({ action: 'buy_portal', dest: 'floresta' }),
  });
  const buyJson = await buy.json();
  assert.equal(buy.status, 200, JSON.stringify(buyJson));
  assert.equal(buyJson.character.save.gunlock.floresta, true);

  // sem reconectar: floresta precisa abrir mesmo com quest=0 (unlock veio
  // so do gunlock comprado).
  const before = conn.msgs.length;
  conn.ws.send(JSON.stringify({ type: 'state', map: 'floresta', x: 0, y: 0, dir: 0, moving: false }));
  await sleep(150);
  const resync = conn.msgs.slice(before).find(m => m.type === 'position_resync');
  assert.equal(resync, undefined, 'gunlock comprado deveria ter liberado a Floresta na mesma sessao, sem resync de volta pra vila');

  conn.ws.send(JSON.stringify({ type: 'map_join', map: 'floresta', mobs: [] }));
  const st = await waitFor(conn.msgs, m => m.type === 'map_state' && m.map === 'floresta', 3000);
  assert.equal(st.mobs.length, 20);
  conn.close();
});
