'use strict';
// Fase 5.7 -- Team vs Team via WS/HTTP real. A logica pura de combate/
// balanceamento/placar/inscricao-com-teto ja esta 100% coberta
// (deterministica, RNG e relogio injetados) em test/tvt.test.js -- aqui so
// confirmamos a exposicao real da config via HTTP e a rejeicao de
// identidade nao autenticada via WS (ambas independentes do horario real).
//
// NAO testamos aqui o fluxo completo de inscricao/partida via WS real
// (registrar 8 contas, aguardar o evento comecar, checar times) porque
// isso dependeria da janela de inscricao real (15min antes de cada um dos
// 6 horarios diarios) estar aberta no exato momento em que a suite roda --
// o processo do servidor usa Date.now() de verdade, sem hook de tempo
// injetavel, e forcar isso exigiria um endpoint de debug pra manipular o
// relogio (exatamente o tipo de atalho que esta fase proibe). Mesma
// lacuna ja aceita pela Fase 5.5/5.6 pra World Boss (ver o teste vazio
// "event_register autenticado via WS usa userId/charId reais" em
// test/event-ws.test.js) -- documentada, nao escondida.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, wsConnect, waitFor } = require('./helpers');

const PORT = 8114;
let srv;

before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

test('GET /api/events/status: team_vs_team aparece jogavel (playable:true) na agenda publica, World Boss continua tambem', async () => {
  const r = await httpJson(srv, 'GET', '/api/events/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.timezone, 'America/Sao_Paulo');
  assert.equal(r.json.schedule.length, 6);
  const tvt = r.json.schedule.find(x => x.type === 'team_vs_team');
  assert.ok(tvt, 'team_vs_team deveria aparecer na agenda de 6 slots');
  assert.equal(tvt.playable, true);
  const wb = r.json.schedule.find(x => x.type === 'world_boss');
  assert.equal(wb.playable, true, 'World Boss nao pode ter sido quebrado por esta fase');
  // API publica nunca vaza identidade -- mesma checagem que ja existia pra World Boss.
  assert.equal(JSON.stringify(r.json).includes('userId'), false);
});

test('event_register: identidade anonima e sempre rejeitada (AUTH_REQUIRED), independente do horario', { skip: !hasSupabase() }, async () => {
  const anon = await wsConnect(srv);
  anon.ws.send(JSON.stringify({ type: 'join', name: 'Anon', cls: 'guerreiro', lvl: 1 }));
  await waitFor(anon.msgs, m => m.type === 'welcome', 3000);
  const state = await waitFor(anon.msgs, m => m.type === 'event_state', 3000);
  const tvtEvent = state.schedule.find(x => x.type === 'team_vs_team');
  anon.ws.send(JSON.stringify({ type: 'event_register', eventId: tvtEvent.id, userId: 'forjado', charId: 'forjado' }));
  const result = await waitFor(anon.msgs, m => m.type === 'event_registration', 3000);
  // AUTH_REQUIRED e a PRIMEIRA checagem em EventManager.register/tvtRegistrationFull,
  // antes de olhar o status da janela de inscricao -- nunca depende do horario real.
  assert.equal(result.ok, false); assert.equal(result.error, 'AUTH_REQUIRED');
  anon.close();
});
