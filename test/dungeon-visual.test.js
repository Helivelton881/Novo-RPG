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
