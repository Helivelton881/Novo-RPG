'use strict';
// Fase -- Dungeon Asset Pack (Covil dos Goblins), rework visual completo.
// Mesmo padrao de test/dungeon-visual.test.js: verificacao estrutural
// (leitura/execucao de codigo-fonte real extraido de index.html) pra tudo
// que NAO depende de canvas/Image (goblinDoorPositions e puro, roda de
// verdade aqui); pra tudo que desenha em canvas (paintGoblinDungeonTiles/
// decorateGoblinDungeon/dun2Sprite), verificacao estrutural + a
// verificacao VISUAL de verdade foi feita ao vivo no navegador (servidor
// local, window.__G.buildMasmorra('floresta',1,[]) + screenshots de
// todas as 8 salas nomeadas comparadas contra dungeon_map_reference.png,
// e checagem programatica de hitBlock nos 8 midpoints de porta) -- ver
// relatorio final desta fase.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const DUNGEON_GEN = require('../game-data/dungeon-generation.js');

function extractFn(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function ${name} nao encontrada em index.html`);
  let depth = 0, i = html.indexOf('{', start), end = i;
  for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } } }
  return html.slice(start, end);
}
function extractConst(name, closer) {
  const start = html.indexOf('const ' + name);
  assert.notEqual(start, -1, `const ${name} nao encontrada em index.html`);
  const end = html.indexOf(closer, start);
  return html.slice(start, end + closer.length);
}

// ===== DUN2_ATLAS_RECTS: fonte real dos sprites do atlas empacotado =====
const atlasBlock = extractConst('DUN2_ATLAS_RECTS', '};');
const DUN2_ATLAS_RECTS = new Function('return ' + atlasBlock.slice(atlasBlock.indexOf('{')))();

test('DUN2_ATLAS_RECTS: assets/dungeon-goblin-atlas.png existe e casa com o PNG real (dimensoes lidas do IHDR)', () => {
  const pngPath = path.join(__dirname, '../assets/dungeon-goblin-atlas.png');
  assert.ok(fs.existsSync(pngPath), 'assets/dungeon-goblin-atlas.png deveria existir (atlas empacotado do dungeon pack)');
  const buf = fs.readFileSync(pngPath);
  assert.equal(buf.readUInt32BE(0), 0x89504e47, 'assinatura PNG invalida');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20); // IHDR: width@16, height@20 (big-endian)
  for (const [name, r] of Object.entries(DUN2_ATLAS_RECTS)) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0, `${name}: rect invalido ${JSON.stringify(r)}`);
    assert.ok(r.x + r.w <= w && r.y + r.h <= h, `${name}: rect ${JSON.stringify(r)} sai dos limites do atlas (${w}x${h})`);
  }
});

test('DUN2_ATLAS_RECTS: assets/dungeon-goblin-atlas.json (registro do empacotamento) bate exatamente com os rects embutidos no index.html', () => {
  const jsonPath = path.join(__dirname, '../assets/dungeon-goblin-atlas.json');
  assert.ok(fs.existsSync(jsonPath), 'assets/dungeon-goblin-atlas.json deveria existir');
  const fromJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.deepEqual(Object.keys(fromJson).sort(), Object.keys(DUN2_ATLAS_RECTS).sort(), 'o atlas embutido no index.html divergiu do registro de empacotamento -- provavel edicao manual sem re-empacotar');
  for (const name of Object.keys(fromJson)) assert.deepEqual(DUN2_ATLAS_RECTS[name], fromJson[name], `rect de '${name}' diverge entre index.html e o registro de empacotamento`);
});

// Todo nome de sprite usado em paintGoblinDungeonTiles/decorateGoblinDungeon/
// goblinTorch precisa existir em DUN2_ATLAS_RECTS -- um typo aqui falha
// silenciosamente em runtime (dun2Sprite devolve null, addStatic nunca e
// chamado, o prop so nao aparece -- sem excecao, sem log). Varre TODAS as
// funcoes novas desta fase de uma vez.
test('Toda referencia a sprite (dun2Sprite/goblinProp/goblinTorch) usa um nome que existe de verdade em DUN2_ATLAS_RECTS -- nunca um typo silencioso', () => {
  const body = extractFn('dun2Sprite') + extractFn('goblinTorch') + extractFn('goblinProp')
    + extractFn('paintGoblinDungeonTiles') + extractFn('goblinDoorPositions') + extractFn('decorateGoblinDungeon');
  const names = new Set();
  for (const m of body.matchAll(/(?:dun2Sprite|goblinProp)\('([a-z0-9_]+)'/g)) names.add(m[1]);
  for (const m of body.matchAll(/GOBLIN_(?:FLOOR_\w+|WALLS)=\[([^\]]+)\]/g)) for (const s of m[1].matchAll(/'([a-z0-9_]+)'/g)) names.add(s[1]);
  assert.ok(names.size > 15, `esperava varias referencias de sprite, achou so ${names.size} -- extracao pode ter falhado`);
  for (const name of names) assert.ok(DUN2_ATLAS_RECTS[name], `sprite '${name}' referenciado no codigo mas nao existe em DUN2_ATLAS_RECTS`);
});

test('paintGoblinDungeonTiles/dun2Sprite: sempre checam DUN2_IMG antes de desenhar -- fallback gracioso se o atlas nao carregar (nunca uma tela quebrada)', () => {
  assert.match(extractFn('dun2Sprite'), /if\(!DUN2_IMG\)return null/);
  assert.match(extractFn('paintGoblinDungeonTiles'), /if\(!DUN2_IMG\)return/);
});

test('buildMasmorra: o rework visual so ativa pra zoneId==="floresta" (Covil dos Goblins) -- as outras 6 masmorras continuam chamando decorateMasmorra/paintGround de sempre, sem nenhuma mudanca', () => {
  const body = extractFn('buildMasmorra');
  assert.match(body, /isGoblinRework\s*=\s*zoneId==='floresta'&&!!DUN2_IMG/, 'o gate precisa ser exatamente zoneId==="floresta" -- nunca theme, nunca outro criterio que poderia acidentalmente pegar outra masmorra');
  assert.match(body, /if\(isGoblinRework\)paintGoblinDungeonTiles/);
  assert.match(body, /if\(isGoblinRework\)decorateGoblinDungeon\(w,rooms,pr\);\s*\n\s*else decorateMasmorra\(w,rooms,cfg\.theme,pr\)/, 'decorateMasmorra precisa continuar sendo chamada pras outras 6 masmorras (else), nunca substituida globalmente');
  // colisao continua exatamente a mesma pra TODAS as masmorras, goblin
  // inclusive -- addBlock(layout.rects) roda ANTES do branch novo, sem
  // nenhuma condicao nova em cima dela.
  assert.match(body, /for\(const r of layout\.rects\)addBlock\(r\.x,r\.y,r\.w,r\.h\);\s*\n\s*paintGround/);
});

// ===== goblinDoorPositions: PURA (sem canvas/DOM) -- executada de verdade =====
const goblinDoorPositions = new Function('DUNGEON_GEN', 'T', 'return ' + extractFn('goblinDoorPositions'))(DUNGEON_GEN, DUNGEON_GEN.T);

test('goblinDoorPositions: calcula um ponto pra cada uma das 8 conexoes de DUNGEON_CONNECTIONS_V2, nenhum bloqueado por parede', () => {
  const layout = DUNGEON_GEN.dungeonLayout(1);
  const doors = goblinDoorPositions(layout.rooms);
  assert.equal(doors.length, DUNGEON_GEN.DUNGEON_CONNECTIONS_V2.length, 'deveria ter exatamente 1 ponto por conexao, nem mais nem menos');
  const T = DUNGEON_GEN.T;
  for (const d of doors) {
    assert.ok(Number.isFinite(d.x) && Number.isFinite(d.y), `porta ${d.idA}->${d.idB} com posicao invalida`);
    const blocked = layout.rects.some(r => d.x >= r.x && d.x < r.x + r.w && d.y >= r.y && d.y < r.y + r.h);
    assert.ok(!blocked, `porta ${d.idA}->${d.idB} (${d.x},${d.y}) cai dentro de um rect de parede real -- visual e colisao divergiriam`);
  }
});

test('decorateGoblinDungeon: decora todas as 9 salas nomeadas do layout (as mesmas 8 usadas em combate + a propria logica de porta cobre a saida)', () => {
  const body = extractFn('decorateGoblinDungeon');
  for (const id of ['entrada', 'corredorInicial', 'encruzilhada', 'salaEsquerda', 'salaDireita', 'salaElite', 'corredorFinal', 'boss']) {
    assert.match(body, new RegExp('rooms\\.' + id + '\\b'), `decorateGoblinDungeon deveria decorar a sala '${id}'`);
  }
  assert.match(body, /statics\.sort/, 'precisa ordenar statics por sy no final, mesmo padrao de decorateMasmorra (senao o jogador nunca fica atras/na frente de props corretamente)');
});

test('decorateGoblinDungeon: nunca menciona credito de economia/loot/combate -- e 100% decoracao visual, igual toda decoracao de masmorra desde a Fase 5.13', () => {
  const body = extractFn('decorateGoblinDungeon');
  for (const bad of ['creditDungeonReward', 'creditKillReward', 'resolveAttackDamage', 'mob.hp']) assert.doesNotMatch(body, new RegExp(bad));
});
