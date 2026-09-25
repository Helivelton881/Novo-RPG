'use strict';
// Fase 5.16.3 -- verificacao estrutural (leitura de codigo-fonte, sem
// DOM/canvas) do redesenho visual da masmorra. A verificacao VISUAL de
// verdade (decoracao rendering sem erro nas 7 zonas, nenhuma porta
// bloqueada, spawn sempre livre, mobile jogavel) foi feita ao vivo no
// navegador contra um servidor local (window.__G.buildMasmorra por
// tema + checagem programatica de blockers contra os 12 midpoints de
// porta de DUNGEON_CONNECTIONS_V2, em index.html/game-data/
// dungeon-generation.js) -- ver relatorio final da Fase 5.16.3. Este
// arquivo so garante que a estrutura de dados no codigo-fonte continua
// consistente (nunca falta tema, nunca diverge de MASMORRA_CFG).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const ZONES = ['floresta', 'cripta', 'serra', 'pantano', 'torre', 'ilhas', 'vulcao'];

test('DUNGEON_THEME_KIT cobre exatamente as 7 zonas de masmorra (mesmas de MASMORRA_CFG, nenhuma faltando)', () => {
  const start = html.indexOf('const DUNGEON_THEME_KIT');
  const end = html.indexOf('\n};', start);
  const body = html.slice(start, end);
  for (const zone of ZONES) assert.match(body, new RegExp(zone + ':\\s*\\{'), `DUNGEON_THEME_KIT deveria ter uma entrada para '${zone}'`);
});

test('kitProp nunca lanca excecao pra cima (sempre protegido por try/catch) -- decoracao nunca pode travar o carregamento da masmorra', () => {
  const start = html.indexOf('function kitProp');
  const end = html.indexOf('\n}', start);
  const body = html.slice(start, end);
  assert.match(body, /try\s*\{[\s\S]*?\}\s*catch/, 'kitProp deveria envolver a chamada do gerador de sprite em try/catch');
});

test('ensureFieldSprites e chamado no inicio de decorateMasmorra (garante SP.* do tema antes de qualquer addStatic)', () => {
  const start = html.indexOf('function decorateMasmorra');
  const firstLines = html.slice(start, start + 300);
  assert.match(firstLines, /ensureFieldSprites\(theme\)/, 'decorateMasmorra deveria chamar ensureFieldSprites(theme) antes de desenhar qualquer prop');
});

test('todo tema listado em MASMORRA_CFG tambem tem entrada em DUNGEON_THEME_KIT (nunca diverge)', () => {
  const cfgStart = html.indexOf('const MASMORRA_CFG');
  const cfgEnd = html.indexOf('\nfunction scrMasmorra', cfgStart);
  const cfgBody = html.slice(cfgStart, cfgEnd);
  const cfgZones = [...cfgBody.matchAll(/^\s*(\w+):\{name:/gm)].map(m => m[1]);
  assert.deepEqual(new Set(cfgZones), new Set(ZONES), 'lista de zonas de MASMORRA_CFG mudou -- atualizar DUNGEON_THEME_KIT junto');
});

// Fase 5.16.3 (redesign visual, parte 2): iluminacao quente de verdade
// (glow) e paredes com leitura de pedra grossa -- antes a masmorra nunca
// tinha nem o tint ambiente nem a camada de brilho aditivo que os mapas
// de campo ja usavam (comparacao de nome nunca batia com 'tema_d').
const GL_KINDS = ['fire', 'brazier', 'crystal', 'lantern', 'cauldron', 'mushroom', 'arcane', 'candle', 'skylight', 'fcrystal', 'ember', 'geyser'];

test('todo tema de DUNGEON_THEME_KIT tem fx valido (uma das kinds que a tabela GL de brilho aditivo reconhece) -- senao a tocha nunca brilharia', () => {
  const start = html.indexOf('const DUNGEON_THEME_KIT');
  const end = html.indexOf('\n};', start);
  const body = html.slice(start, end);
  for (const zone of ZONES) {
    const m = body.match(new RegExp(zone + ':\\s*\\{[^}]*fx:\\s*\'(\\w+)\''));
    assert.ok(m, `${zone} deveria ter um campo fx: '<kind>'`);
    assert.ok(GL_KINDS.includes(m[1]), `${zone}.fx='${m[1]}' nao e uma kind reconhecida pela tabela GL (${GL_KINDS.join(',')})`);
  }
});

test('kitTorch registra em FX (senao a tocha e so um sprite "apagado", sem brilho nem chama animada)', () => {
  const start = html.indexOf('function kitTorch');
  const end = html.indexOf('\n}', start);
  const body = html.slice(start, end);
  assert.match(body, /FX\.push\(\{kind:kit\.fx/, 'kitTorch deveria empurrar {kind:kit.fx,x,y} pra FX, igual todo torch/brazier/etc de campo ja faz');
});

test('a camada de tint ambiente + brilho aditivo (GL) agora tambem cobre mundos de masmorra (sufixo _d), nao so o nome exato da zona de campo', () => {
  const start = html.indexOf('drawWaves();drawEfx();');
  const body = html.slice(start, start + 900);
  assert.match(body, /endsWith\('_d'\)/, 'o bloco de tint/GL deveria reconhecer o sufixo _d como masmorra da mesma zona tematica');
  assert.match(body, /ambientZone/, 'deveria existir uma variavel de zona ambiente derivada (tema base, com ou sem masmorra)');
});

test('paintGround(theme,dungeonWalls): k===4 vira blocos de pedra com argamassa SO quando dungeonWalls e verdadeiro (nunca muda a beira de lago/rocha natural dos mapas de campo)', () => {
  const start = html.indexOf('function paintGround');
  const kIdx = html.indexOf('else if(k===4)', start);
  const block = html.slice(kIdx, kIdx + 400);
  assert.match(block, /if\(dungeonWalls\)/, 'k===4 deveria ramificar em dungeonWalls -- textura de parede grossa so na masmorra, textura de rocha original em todo o resto (ex.: beira de lago em paintWater)');
  assert.match(html, /paintGround\(cfg\.theme,true\)/, 'buildMasmorra deveria ser o unico lugar passando dungeonWalls=true pro paintGround');
});

test('sala do boss ganha trono/marco + 2 estandartes + tapete vermelho ate ele (leitura de "sala final" clara, como pedido)', () => {
  const start = html.indexOf('// 8. Sala do boss');
  const end = html.indexOf('\n  statics.sort', start);
  const body = html.slice(start, end);
  assert.match(body, /makeRug/, 'deveria desenhar um tapete (decal) ate o marco do chefe');
  assert.match(body, /SP\.banner/g, 'deveria flanquear o marco com estandartes (SP.banner)');
  assert.match(body, /kitTorch/, 'deveria ter tochas acesas de verdade (com brilho) perto do marco');
});
