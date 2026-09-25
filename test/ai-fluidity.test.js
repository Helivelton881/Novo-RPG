'use strict';
// Fase 5.16.4 -- Living World: movimento natural + combate fluido + QA
// visual real. Cobre:
// 1) o bug real de producao "IA congela pra sempre em wander" (ja
//    coberto tambem em test/ai.test.js, junto do resto do FSM);
// 2) interpolacao de posicao client-side (serverX/serverY vs x/y de
//    render, mesmo padrao ja usado pra mobs em netLockMobs);
// 3) evento ai_attack (animacao de ataque nunca depende so do snapshot
//    periodico de posicao);
// 4) contador simplificado ("N online", sem "jogador"/"IA"/"humano");
// 5) rotulo do nome sem "[IA]" (kind:'ai' continua interno);
// 6) AI_NAME_POOL sem o padrao "Nome+numero" obvio quando ha nomes livres.
//
// Verificacao AO VIVO (nao substituivel por teste unitario): congelamento
// de IA foi reproduzido e confirmado corrigido rodando o setInterval REAL
// de producao (1000ms) por 4 minutos com 40 IA -- 22/40 travadas antes da
// correcao, 0/40 travadas depois, em todos os checkpoints (60/120/180/
// 240s). Ver relatorio final da Fase 5.16.4 pros detalhes completos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../server.js');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function extractFn(name) {
  const start = html.indexOf('function ' + name + '(');
  let depth = 0, i = html.indexOf('{', start), end = i;
  for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } } }
  return html.slice(start, end);
}

// ===== 2) Interpolacao client-side (aplicaRemoteUpdate/netLockRemote) =====

test('applyRemoteUpdate: entidade NOVA (nunca vista) sempre SNAPA direto pra posicao do servidor, nunca interpola do zero/origem', () => {
  const REMOTE = new Map();
  const applyRemoteUpdate = new Function('REMOTE', extractFn('applyRemoteUpdate') + '\nreturn applyRemoteUpdate;')(REMOTE);
  applyRemoteUpdate({ id: 'a1', x: 500, y: 600, kind: 'ai', name: 'Kael', map: 'floresta' });
  const p = REMOTE.get('a1');
  assert.equal(p.x, 500); assert.equal(p.y, 600);
  assert.equal(p.serverX, 500); assert.equal(p.serverY, 600);
});

test('applyRemoteUpdate: movimento normal (passo pequeno) NUNCA snapa -- mantem a posicao de render atual pra netLockRemote interpolar suavemente ate o novo serverX/serverY', () => {
  const REMOTE = new Map();
  const applyRemoteUpdate = new Function('REMOTE', extractFn('applyRemoteUpdate') + '\nreturn applyRemoteUpdate;')(REMOTE);
  applyRemoteUpdate({ id: 'a1', x: 500, y: 600, kind: 'ai', name: 'Kael', map: 'floresta' });
  applyRemoteUpdate({ id: 'a1', x: 560, y: 620, kind: 'ai', name: 'Kael', map: 'floresta' }); // ~64px, passo normal (AI_MOVE_SPEED=85)
  const p = REMOTE.get('a1');
  assert.equal(p.x, 500, 'x de render nao deveria pular direto -- so netLockRemote (interpolacao por frame) deveria mover');
  assert.equal(p.y, 600);
  assert.equal(p.serverX, 560, 'serverX deveria ja refletir a posicao autoritativa nova');
  assert.equal(p.serverY, 620);
});

test('applyRemoteUpdate: salto grande (map change/respawn/teleport/reconnect) sempre SNAPA direto, nunca desliza a tela inteira', () => {
  const REMOTE = new Map();
  const applyRemoteUpdate = new Function('REMOTE', extractFn('applyRemoteUpdate') + '\nreturn applyRemoteUpdate;')(REMOTE);
  applyRemoteUpdate({ id: 'a1', x: 500, y: 600, kind: 'ai', name: 'Kael', map: 'floresta' });
  applyRemoteUpdate({ id: 'a1', x: 2000, y: 1800, kind: 'ai', name: 'Kael', map: 'cripta' }); // salto de ~1780px, bem acima do threshold
  const p = REMOTE.get('a1');
  assert.equal(p.x, 2000, 'salto grande deveria snapar a posicao de render direto, nunca deslizar visualmente pelo mapa inteiro');
  assert.equal(p.y, 1800);
});

test('applyRemoteUpdate: nunca corta uma animacao de ataque em andamento -- um sync de posicao comum (atkT:0, como toda IA manda) preserva o atkT/atkAng antigo se ainda positivo', () => {
  const REMOTE = new Map();
  const applyRemoteUpdate = new Function('REMOTE', extractFn('applyRemoteUpdate') + '\nreturn applyRemoteUpdate;')(REMOTE);
  applyRemoteUpdate({ id: 'a1', x: 500, y: 600, kind: 'ai', name: 'Kael', map: 'floresta', atkT: 0 });
  REMOTE.get('a1').atkT = .18; REMOTE.get('a1').atkAng = 1.2; // simula ai_attack tendo disparado e o cronometro ja decaindo
  applyRemoteUpdate({ id: 'a1', x: 505, y: 604, kind: 'ai', name: 'Kael', map: 'floresta', atkT: 0 }); // sync de posicao comum, sempre atkT:0 pra IA
  const p = REMOTE.get('a1');
  assert.equal(p.atkT, .18, 'sync de posicao comum nao deveria zerar uma animacao de ataque ainda tocando');
  assert.equal(p.atkAng, 1.2);
});

test('netLockRemote: interpola x/y em direcao a serverX/serverY de forma dependente de dt (nunca uma constante fixa por frame) e decai atkT localmente', () => {
  const REMOTE = new Map();
  REMOTE.set('a1', { id: 'a1', x: 0, y: 0, serverX: 100, serverY: 0, atkT: .3 });
  const netLockRemote = new Function('REMOTE', extractFn('netLockRemote') + '\nreturn netLockRemote;')(REMOTE);
  netLockRemote(0.1);
  const p = REMOTE.get('a1');
  assert.ok(p.x > 0 && p.x < 100, `deveria ter avancado parcialmente em direcao a serverX, nunca pulado direto (achado x=${p.x})`);
  assert.ok(p.atkT < .3 && p.atkT >= 0, 'atkT deveria decair localmente a cada frame, nunca ficar parado esperando o proximo pacote de rede');
});

// ===== 3) Evento ai_attack no cliente =====

test('cliente trata ai_attack: seta atkT/atkAng na entrada de REMOTE correspondente, escopado ao mapa atual (nunca vaza pra outro mapa)', () => {
  const start = html.indexOf("m.type==='ai_attack'");
  const chunk = html.slice(start - 20, start + 300);
  assert.match(chunk, /m\.map===netMapId\(\)/, 'ai_attack deveria ser filtrado pelo mapa atual, igual mob_state/mob_positions ja fazem');
  assert.match(chunk, /rp\.atkT\s*=\s*\.3/, 'deveria setar um atkT positivo (dispara a animacao local)');
  assert.match(chunk, /rp\.atkAng\s*=/, 'deveria setar o angulo vindo do evento');
});

// ===== 4) Contador simplificado =====

test('netCountsLabel: mostra somente "N online" -- nunca "jogador"/"IA"/"humano"/"fake"/"Living World" na interface publica', () => {
  const REMOTE = new Map();
  for (let i = 0; i < 12; i++) REMOTE.set('r' + i, { id: 'r' + i, kind: i < 9 ? 'ai' : undefined });
  const netCountsLabel = new Function('REMOTE', extractFn('netCountsLabel') + '\nreturn netCountsLabel;')(REMOTE);
  const label = netCountsLabel();
  assert.equal(label, '13 online', '1 jogador local + 12 REMOTE (9 IA + 3 humanos) deveria dar 13 online, sem separar');
  for (const forbidden of ['jogador', 'IA', 'humano', 'fake', 'Living World', 'bot', 'NPC']) {
    assert.equal(label.toLowerCase().includes(forbidden.toLowerCase()), false, `rotulo publico nao deveria conter '${forbidden}'`);
  }
});

// ===== 5) Rotulo do nome sem "[IA]" =====

test('drawRemote: nunca mais escreve "[IA]"/"BOT"/"NPC"/"FAKE" no rotulo do nome -- so "Nome · Lv N"', () => {
  const body = extractFn('drawRemote');
  for (const forbidden of ['[IA]', 'BOT', 'NPC', 'FAKE']) assert.equal(body.includes(forbidden), false, `drawRemote nao deveria mais conter '${forbidden}'`);
  assert.match(body, /p\.name\+' · Lv '\+p\.lvl/, 'rotulo deveria continuar exatamente "Nome · Lv N"');
});

test('drawRemote: a cor sutil por kind continua existindo (nao e texto, nunca foi pedido pra remover -- so o rotulo "[IA]" saiu)', () => {
  const body = extractFn('drawRemote');
  assert.match(body, /p\.kind===['"]ai['"]/, 'a distincao de cor por kind deveria continuar existindo em drawRemote');
});

// ===== 6) kind:'ai' continua interno (protocolo/runtime/Admin) =====

test('kind:\'ai\' continua existindo internamente em aiPublicPlayer -- a mudanca de UI e so visual, nunca removeu do protocolo', () => {
  S.aiEntities.clear();
  const ai = S.aiSpawnEntity('floresta');
  assert.equal(S.aiPublicPlayer(ai).kind, 'ai');
  S.aiEntities.clear();
});

test('Admin continua distinguindo IA de humano -- livingWorldStatus() e o payload de /api/admin/ai nunca perderam o campo kind/type', () => {
  S.aiEntities.clear();
  const ai = S.aiSpawnEntity('floresta');
  const status = S.livingWorldStatus();
  const row = status.entities.find(e => e.runtimeId === ai.id);
  assert.equal(row.kind, 'ai');
  assert.ok(row.type, 'entidade deveria continuar tendo um type (FIELD/DUNGEON/TVT/VILLAGE) pro Admin distinguir');
  S.aiEntities.clear();
});

// ===== 7) AI_NAME_POOL sem padrao "Nome+numero" obvio =====

test('aiPickName: com nomes livres no pool, nunca acrescenta sufixo numerico (nome natural, sem denunciar geracao)', () => {
  S.aiEntities.clear();
  for (let i = 0; i < 10; i++) {
    const name = S.aiPickName();
    assert.doesNotMatch(name, /\d/, `nome '${name}' nao deveria ter numero enquanto o pool tem nomes livres`);
    S.aiEntities.set('probe' + i, { name }); // ocupa o nome pra proxima chamada evitar duplicidade
  }
  S.aiEntities.clear();
});
test('aiPickName: nunca repete um nome simultaneamente em uso enquanto houver nomes livres no pool', () => {
  S.aiEntities.clear();
  const used = new Set();
  for (let i = 0; i < S.AI_NAME_POOL.length; i++) {
    const name = S.aiPickName();
    assert.equal(used.has(name), false, `nome '${name}' repetido enquanto ainda havia nomes livres`);
    used.add(name);
    S.aiEntities.set('probe' + i, { name });
  }
  S.aiEntities.clear();
});
test('aiPickName: pool ampliado inclui os nomes sugeridos (Thoran, Elyra, Valen, Seraph, etc.), nunca so os 20 originais', () => {
  for (const n of ['Thoran', 'Elyra', 'Valen', 'Seraph', 'Draven', 'Lyanna', 'Nyra', 'Theron', 'Mirella']) {
    assert.ok(S.AI_NAME_POOL.includes(n), `AI_NAME_POOL deveria incluir '${n}'`);
  }
  assert.ok(S.AI_NAME_POOL.length >= 30, `pool deveria ter sido ampliado significativamente (achado ${S.AI_NAME_POOL.length})`);
});
