'use strict';
// Fase 5.16.7 -- persistencia confiavel de quest. Causa raiz real: os
// estagios de dialogo SEM premio (aceitar a missao inicial, e os 6 "portal
// liberado" logo apos cada chefe regional) faziam so `P.quest=N+1;saveGame()`
// no cliente -- o PUT generico de personagem SEMPRE ignora save.quest pra
// personagem ja rastreado, entao esse avanco nunca persistia (reload/logout
// devolvia o estagio anterior, e advanceQuestOnKill nunca progredia porque
// exige save.quest===o estagio exato da caça seguinte). server.js agora
// espelha essas 7 transicoes em QUEST_REWARDS (premio zerado) e o cliente
// passa a chama-las via claimQuestReward/POST /quest, o MESMO caminho
// server-autoritativo que os 8 estagios pagos ja usavam.
//
// Parte 1 (pura, sem Supabase/WS -- sempre roda): forma da tabela
// QUEST_REWARDS e fidelidade de advanceQuestOnKill (ja existia antes desta
// fase, mas nunca tinha teste formal).
// Parte 2 (HTTP+WS reais, precisa de Supabase): fluxo ponta-a-ponta --
// aceitar/progredir/concluir missao sobrevive a "reload" (nova leitura via
// GET /api/characters), reivindicacao dupla rejeitada, cliente adulterado
// nao consegue pular estagio.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hasSupabase, startServer, stopServer, httpJson, wsConnect, waitFor, sleep } = require('./helpers');
const S = require('../server.js');

// ===== Parte 1: nucleo puro =====

test('QUEST_REWARDS: os 7 estagios sem premio (aceitar + 6 desbloqueios de regiao) existem e tem premio zerado', () => {
  for (const from of [0, 6, 10, 14, 18, 22, 26]) {
    const r = S.QUEST_REWARDS[from];
    assert.ok(r, `QUEST_REWARDS[${from}] deveria existir`);
    assert.equal(r.gold, 0); assert.equal(r.gem, 0); assert.equal(r.xp, 0);
    assert.equal(r.next, from + 1);
  }
});

test('QUEST_REWARDS: os 8 estagios pagos continuam com premio real e next correto (regressao)', () => {
  const paid = { 2: 30, 4: 60, 8: 150, 12: 250, 16: 400, 20: 600, 24: 800, 28: 1000 };
  for (const [from, gold] of Object.entries(paid)) {
    const r = S.QUEST_REWARDS[from];
    assert.equal(r.gold, gold);
    assert.equal(r.next, Number(from) + 1);
  }
});

// QUEST_REWARDS so cobre os estagios PARES (avanco por dialogo/handleQuest
// -- aceitar, entregar caça, "portal liberado"); os IMPARES so avancam por
// advanceQuestOnKill (contador de abate OU chefe direto). A cadeia real do
// jogo intercala os dois mecanismos -- este teste anda pela cadeia INTEIRA
// (0 a 30) simulando o abate/chefe minimo exigido em cada estagio impar,
// checando que nunca falta um elo nem repete estagio (buraco/ciclo).
const CHAIN_KILL_INPUT = {
  1: { type: 'slime', boss: false, lvl: 1, times: 3 },
  3: { type: 'goblin', boss: false, lvl: 1, times: 5 },
  5: { type: 'goblin', boss: true, lvl: 1, times: 1 },
  7: { type: 'skeleton', boss: false, lvl: 1, times: 8 },
  9: { type: 'skeleton', boss: true, lvl: 1, times: 1 },
  11: { type: 'wolf', boss: false, lvl: 1, times: 10 },
  13: { type: 'wolf', boss: true, lvl: 1, times: 1 },
  15: { type: 'bat', boss: false, lvl: 1, times: 12 },
  17: { type: 'toxic', boss: true, lvl: 1, times: 1 },
  19: { type: 'caster', boss: false, lvl: 1, times: 12 },
  21: { type: 'caster', boss: true, lvl: 1, times: 1 },
  23: { type: 'sky', boss: false, lvl: 1, times: 14 },
  25: { type: 'sky', boss: true, lvl: 1, times: 1 },
  27: { type: 'sala', boss: false, lvl: 1, times: 16 },
  29: { type: 'lorde', boss: false, lvl: 1, times: 1 },
};

test('QUEST_REWARDS + advanceQuestOnKill: cadeia completa 0..30 nunca tem buraco nem ciclo', () => {
  const save = { quest: 0 };
  const seen = new Set();
  for (let steps = 0; save.quest < 30 && steps < 40; steps++) {
    const q = save.quest;
    assert.ok(!seen.has(q), `estagio ${q} visitado duas vezes -- ciclo na cadeia`);
    seen.add(q);
    if (q % 2 === 0) {
      const r = S.QUEST_REWARDS[q];
      assert.ok(r, `faltou entrada QUEST_REWARDS pro estagio par ${q}`);
      assert.equal(r.next, q + 1, `QUEST_REWARDS[${q}].next deveria ser ${q + 1}`);
      save.quest = r.next;
    } else {
      const cfg = CHAIN_KILL_INPUT[q];
      assert.ok(cfg, `faltou configuracao de abate pro estagio impar ${q}`);
      for (let i = 0; i < cfg.times; i++) S.advanceQuestOnKill(save, cfg.type, cfg.boss, cfg.lvl);
      assert.equal(save.quest, q + 1, `abate/chefe minimo do estagio ${q} deveria ter avançado a quest pra ${q + 1}`);
    }
  }
  assert.equal(save.quest, 30, 'cadeia completa deveria terminar exatamente no chefe final (30), chegou em ' + save.quest);
});

test('advanceQuestOnKill: slime avulso nao conta pra missao (quest!==1) -- so quando a missao esta ativa', () => {
  const save = { quest: 0, kills: 0 };
  const changed = S.advanceQuestOnKill(save, 'slime', false, 1);
  assert.deepEqual(changed, {});
  assert.equal(save.kills, 0);
});

test('advanceQuestOnKill: progresso de caça (1/3, 2/3) nunca avança quest antes do threshold', () => {
  const save = { quest: 1, kills: 0 };
  S.advanceQuestOnKill(save, 'slime', false, 1);
  assert.equal(save.kills, 1); assert.equal(save.quest, 1);
  S.advanceQuestOnKill(save, 'slime', false, 1);
  assert.equal(save.kills, 2); assert.equal(save.quest, 1);
});

test('advanceQuestOnKill: 3o slime bate o threshold e avanca quest 1->2', () => {
  const save = { quest: 1, kills: 2 };
  const changed = S.advanceQuestOnKill(save, 'slime', false, 1);
  assert.equal(save.kills, 3);
  assert.equal(save.quest, 2);
  assert.equal(changed.quest, 2);
});

test('advanceQuestOnKill: goblin chefe avança quest 5->6 direto, sem contador', () => {
  const save = { quest: 5 };
  const changed = S.advanceQuestOnKill(save, 'goblin', true, 10);
  assert.equal(save.quest, 6);
  assert.equal(changed.quest, 6);
});

test('advanceQuestOnKill: campo kt tem DUAS fontes (skeleton lvl>=25 em quest 19, e caster em quest 19) -- ambas incrementam o MESMO contador', () => {
  const save = { quest: 19, kt: 0 };
  S.advanceQuestOnKill(save, 'skeleton', false, 26); // lvl>=25
  assert.equal(save.kt, 1);
  S.advanceQuestOnKill(save, 'caster', false, 10); // caster nao precisa de lvl minimo
  assert.equal(save.kt, 2);
  assert.equal(save.quest, 19, 'ainda nao bateu o threshold (12)');
});

test('advanceQuestOnKill: skeleton COM nivel baixo em quest 19 nao conta pro kt (precisa lvl>=25)', () => {
  const save = { quest: 19, kt: 0 };
  S.advanceQuestOnKill(save, 'skeleton', false, 10);
  assert.equal(save.kt, 0, 'esqueleto de nivel baixo na Torre nao deveria contar (so os fortes, lvl>=25)');
});

test('advanceQuestOnKill: campo ki tambem tem duas fontes (bat lvl>=30 em quest 23, sky em quest 23)', () => {
  const save = { quest: 23, ki: 0 };
  S.advanceQuestOnKill(save, 'bat', false, 35);
  assert.equal(save.ki, 1);
  S.advanceQuestOnKill(save, 'sky', false, 20);
  assert.equal(save.ki, 2);
});

test('advanceQuestOnKill: lorde (chefe final) avanca 29->30 mesmo sem nenhum gate anterior (unico chefe sem contador)', () => {
  const save = { quest: 29 };
  const changed = S.advanceQuestOnKill(save, 'lorde', false, 40);
  assert.equal(save.quest, 30);
  assert.equal(changed.quest, 30);
});

test('isPersistentFieldMap: vila e as 7 zonas sao seguras; instancia de masmorra/TvT/World Boss nunca sao', () => {
  for (const m of ['vila','floresta','cripta','serra','pantano','torre','ilhas','vulcao']) assert.equal(S.isPersistentFieldMap(m), true, m);
  for (const m of ['floresta_d','floresta_d#a1b2c3d4','tvt#abc123','wb#xyz','']) assert.equal(S.isPersistentFieldMap(m), false, m);
});

test('markCharDirty: so marca sujo quem tem charId; nunca lanca em objeto vazio/nulo', () => {
  const p = { charId: 'c1' };
  S.markCharDirty(p);
  assert.equal(p._dirty, true);
  assert.doesNotThrow(() => S.markCharDirty(null));
  assert.doesNotThrow(() => S.markCharDirty({}));
});

// ===== Parte 2: fluxo real via HTTP/WS =====
// AUTOSAVE_SWEEP_MS baixo (ver server.js) so pra nao esperar os 5s reais de
// producao nos 2 testes de autosave de runtime abaixo -- sem essa env var,
// a cadencia real e exatamente 5000ms (inalterada).
const PORT = 8119;
let srv;
before(async () => { srv = await startServer(PORT, { AUTOSAVE_SWEEP_MS: '250' }); });
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
async function authedWs(ch) {
  const conn = await wsConnect(srv);
  conn.ws.send(JSON.stringify({ type: 'join', name: 'Heroi', cls: ch.cls, lvl: 1, token: ch.token, charId: ch.id }));
  await waitFor(conn.msgs, m => m.type === 'welcome', 3000);
  return conn;
}

test('quest 1: aceitar a missao inicial (from:0) sobrevive a "reload" (GET separado)', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  const r = await httpJson(srv, 'POST', '/api/characters/' + ch.id + '/quest', { from: 0 }, ch.token);
  assert.equal(r.status, 200);
  assert.equal(r.json.character.save.quest, 1);
  const reloaded = await reloadChar(ch);
  assert.equal(reloaded.save.quest, 1, 'quest deveria continuar 1 depois de reabrir o personagem (simula reload)');
});

test('quest 5: entregar a mesma recompensa duas vezes (estagio sem premio) e rejeitado -- nunca duplica', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  await httpJson(srv, 'PUT', '/api/characters/' + ch.id, { lvl: 10, save: { quest: 6 } }, ch.token);
  const first = await httpJson(srv, 'POST', '/api/characters/' + ch.id + '/quest', { from: 6 }, ch.token);
  assert.equal(first.status, 200);
  assert.equal(first.json.character.save.quest, 7);
  const second = await httpJson(srv, 'POST', '/api/characters/' + ch.id + '/quest', { from: 6 }, ch.token);
  assert.equal(second.status, 400, 'segunda tentativa no mesmo estagio deveria ser rejeitada');
});

test('quest 6: proxima missao (estagio de caça) so fica disponivel depois do avanco -- nunca pula', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  await httpJson(srv, 'PUT', '/api/characters/' + ch.id, { lvl: 10, save: { quest: 10 } }, ch.token);
  await httpJson(srv, 'POST', '/api/characters/' + ch.id + '/quest', { from: 10 }, ch.token);
  const reloaded = await reloadChar(ch);
  assert.equal(reloaded.save.quest, 11, 'depois do desbloqueio da Serra, quest deveria estar em 11 (caçando lobos)');
});

test('quest 8: cliente adulterado nao consegue aumentar quest pulando estagios (from nao bate com o banco)', { skip: !hasSupabase() }, async () => {
  const ch = await newChar(); // quest=0
  const r = await httpJson(srv, 'POST', '/api/characters/' + ch.id + '/quest', { from: 18 }, ch.token);
  assert.equal(r.status, 400);
  const reloaded = await reloadChar(ch);
  assert.equal(reloaded.save.quest, 0, 'quest nunca deveria ter avançado por uma tentativa adulterada');
});

test('quest 2/3: progresso de caça por abate real persiste imediatamente (1/3 sobrevive a um GET separado)', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  await httpJson(srv, 'PUT', '/api/characters/' + ch.id, { lvl: 20, save: { quest: 1, kills: 0 } }, ch.token);
  const conn = await authedWs(ch);
  // personagem novo sem x/y no save nasce no spawn padrao da vila (720,1258
  // -- ver initX/initY em handleWsJoin). Posiciona o slime de teste NO
  // MESMO ponto (sem nenhuma mensagem 'state' de "salto" antes disso), pra
  // nao esbarrar no anti-teleport real de validateMovement (que so libera
  // ~187px de distancia na primeira mensagem de um personagem autenticado
  // -- um jogador anonimo, como em monsters.test.js, nao passa por essa
  // checagem, mas o nosso authedWs passa).
  const mobId = 'qa_slime_' + rnd();
  conn.ws.send(JSON.stringify({ type: 'map_join', map: 'vila', mobs: [{ id: mobId, x: 720, y: 1258, lvl: 1 }] }));
  const st = await waitFor(conn.msgs, m => m.type === 'map_state', 3000);
  const slime = st.mobs.find(m => m.id === mobId);
  assert.ok(slime, 'slime de teste deveria ter sido criado no roster de vila');
  let dead = null;
  for (let i = 0; i < 20 && !dead; i++) {
    conn.ws.send(JSON.stringify({ type: 'mob_damage', map: 'vila', id: mobId, skill: 'basic' }));
    await sleep(90);
    const last = conn.msgs.filter(m => m.type === 'mob_state' && m.mob.id === mobId).pop();
    if (last && (last.mob.dead || last.mob.hp <= 0)) dead = last;
  }
  assert.ok(dead, 'slime de teste deveria ter morrido dentro da janela de tentativas');
  await sleep(200); // withCharLock do creditKillReward e assincrono -- da tempo do PATCH terminar
  conn.close();
  const reloaded = await reloadChar(ch);
  assert.equal(reloaded.save.kills, 1, 'progresso de caça (1/3) deveria ter persistido no banco depois de matar 1 slime de verdade');
  assert.equal(reloaded.save.quest, 1, 'ainda faltam 2 -- quest nao deveria ter avançado ainda');
});

test('posicao/mapa: autosave de runtime (dirty flag) persiste map/x/y depois de um movimento real, sem esperar o cliente', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  const conn = await authedWs(ch);
  // personagem novo nasce no spawn padrao da vila (720,1258 -- ver
  // initX/initY em handleWsJoin). Um pequeno passo (dentro do raio que
  // validateMovement libera pra primeira mensagem de uma conexao
  // autenticada) marca o personagem sujo; NAO chamamos
  // runtimeAutosaveSweep localmente (esse require('../server.js') em
  // processo deste arquivo de teste e um MODULO SEPARADO, com `clients`
  // vazio -- a conexao WS real vive no processo filho que startServer
  // aqui sobe). Em vez disso deixamos o loop global de verdade do
  // processo filho (AUTOSAVE_SWEEP_MS=250 nesta suite, ver `before`
  // acima) fazer o proprio trabalho, exatamente como em producao.
  conn.ws.send(JSON.stringify({ type: 'state', map: 'vila', x: 760, y: 1290, dir: 0, moving: true, lvl: 1 }));
  await sleep(600);
  conn.close();
  const reloaded = await reloadChar(ch);
  assert.equal(reloaded.save.map, 'vila');
  assert.ok(Math.abs(reloaded.save.x - 760) < 5, 'x deveria ter persistido aproximadamente igual ao reportado, veio ' + reloaded.save.x);
  assert.ok(Math.abs(reloaded.save.y - 1290) < 5, 'y deveria ter persistido aproximadamente igual ao reportado, veio ' + reloaded.save.y);
});

test('autosave sem mudança nenhuma (personagem parado, nunca marcado sujo) nunca escreve no banco', { skip: !hasSupabase() }, async () => {
  const ch = await newChar();
  await httpJson(srv, 'PUT', '/api/characters/' + ch.id, { lvl: 1, save: { x: 111, y: 222, map: 'vila' } }, ch.token);
  const conn = await authedWs(ch);
  // nenhuma mensagem 'state' enviada -- p._dirty deveria continuar false;
  // so espera o loop real (250ms nesta suite) rodar algumas vezes.
  await sleep(600);
  conn.close();
  const reloaded = await reloadChar(ch);
  assert.equal(reloaded.save.x, 111, 'sem nenhum movimento real, o autosave nunca deveria ter tocado x/y');
  assert.equal(reloaded.save.y, 222);
});
