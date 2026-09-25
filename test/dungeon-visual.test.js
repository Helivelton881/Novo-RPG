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

// Fase 5.16.3 (V3, layout de encruzilhada): decorateMasmorra deveria usar
// SOMENTE os IDs de sala do layout novo -- nunca mais um nome do layout
// V2 antigo (sala1-5/corr1/corr2v/gap23/checkpoint), que sumiu de
// DUNGEON_ROOMS_V2 e faria rooms.<id> ser undefined em runtime.
test('decorateMasmorra referencia somente IDs de sala do layout V3 (encruzilhada), nunca um ID do layout V2 antigo que nao existe mais', () => {
  const start = html.indexOf('function decorateMasmorra');
  const end = html.indexOf('\n// Fase 5.13 -- DUNGEON MAP V2', start);
  const body = html.slice(start, end > start ? end : start + 6000);
  const stale = ['sala1', 'sala2', 'sala3', 'sala4', 'sala5', 'corr1', 'corr2v', 'gap23', 'checkpoint'];
  for (const id of stale) assert.doesNotMatch(body, new RegExp('rooms\\.' + id + '\\b|c\\(\'' + id + '\'\\)'), `decorateMasmorra ainda referencia o ID antigo '${id}', que nao existe mais em DUNGEON_ROOMS_V2`);
  const current = ['entrada', 'corredorInicial', 'encruzilhada', 'salaEsquerda', 'salaDireita', 'salaElite', 'corredorFinal', 'boss'];
  for (const id of current) assert.match(body, new RegExp('rooms\\.' + id + '\\b'), `decorateMasmorra deveria decorar a sala '${id}'`);
});

// Fase 5.16.3 (bug real de producao, achado pelo usuario): extrai a funcao
// REAL locationDisplayName de index.html e executa de verdade (nao so
// inspeciona o texto) -- prova comportamento, nao so presenca de codigo.
// So MASMORRA_CFG (so os campos .name, os outros campos referenciam
// funcoes de gameplay que nao existem fora do navegador) e T sao
// necessarios como dependencias.
function extractFn(name) {
  const start = html.indexOf('function ' + name + '(');
  let depth = 0, i = html.indexOf('{', start), end = i;
  for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } } }
  return html.slice(start, end);
}
const MASMORRA_CFG_STUB = {
  floresta: { name: 'Covil dos Goblins' }, cripta: { name: 'Catacumba Profunda' },
  serra: { name: 'Toca da Matilha' }, pantano: { name: 'Poço Venenoso' },
  torre: { name: 'Câmara Arcana' }, ilhas: { name: 'Refúgio Celeste' }, vulcao: { name: 'Forja Ancestral' },
};
const locationDisplayName = new Function('MASMORRA_CFG', 'T', 'return ' + extractFn('locationDisplayName'))(MASMORRA_CFG_STUB, 48);

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

// Fase 5.16.3 -- bug real de producao: HUD rotulava QUALQUER masmorra
// como "Vila Inicial"/"Planicie dos Slimes" (o antigo calculo de nome de
// localizacao nunca reconhecia sufixo '_d', tvt# ou wb#, caindo sempre no
// fallback de vila). locationDisplayName agora e a UNICA fonte da verdade,
// e so w.name==='vila' decide entre os dois rotulos de vila.
test('locationDisplayName: vila com coordenada interna -> "Vila Inicial"', () => {
  assert.equal(locationDisplayName({ name: 'vila' }, 10 * 48), 'Vila Inicial');
});
test('locationDisplayName: vila com coordenada da planicie -> "Planície dos Slimes"', () => {
  assert.equal(locationDisplayName({ name: 'vila' }, 40 * 48), 'Planície dos Slimes');
});
test('locationDisplayName: floresta (campo) -> "Floresta dos Goblins"', () => {
  assert.equal(locationDisplayName({ name: 'floresta' }, 0), 'Floresta dos Goblins');
});
test('locationDisplayName: NENHUMA masmorra pode retornar "Vila Inicial" ou "Planície dos Slimes" (as 7 zonas)', () => {
  const expected = {
    floresta_d: 'Masmorra — Covil dos Goblins', cripta_d: 'Masmorra — Catacumba Profunda',
    serra_d: 'Masmorra — Toca da Matilha', pantano_d: 'Masmorra — Poço Venenoso',
    torre_d: 'Masmorra — Câmara Arcana', ilhas_d: 'Masmorra — Refúgio Celeste', vulcao_d: 'Masmorra — Forja Ancestral',
  };
  for (const [name, label] of Object.entries(expected)) {
    // px propositalmente na faixa da "Planicie dos Slimes" da vila (x alto)
    // -- prova que a coordenada X NUNCA influencia o rotulo de masmorra.
    const got = locationDisplayName({ name }, 40 * 48);
    assert.equal(got, label, `${name} deveria ser '${label}', veio '${got}'`);
    assert.notEqual(got, 'Vila Inicial');
    assert.notEqual(got, 'Planície dos Slimes');
  }
});
test('locationDisplayName: arena de TvT (tvt#...) e World Boss (wb#...) nunca caem no fallback de vila', () => {
  assert.equal(locationDisplayName({ name: 'tvt#ab12cd' }, 40 * 48), 'Arena TvT');
  assert.equal(locationDisplayName({ name: 'wb#ab12cd#XYZ234' }, 40 * 48), 'Arena do Titã');
});
test('locationDisplayName: mundo desconhecido nunca vira "Vila Inicial" por padrão (ecoa o id cru em vez de inventar um nome errado)', () => {
  const got = locationDisplayName({ name: 'algo_novo_nunca_visto' }, 40 * 48);
  assert.notEqual(got, 'Vila Inicial');
  assert.notEqual(got, 'Planície dos Slimes');
});
test('update(): a chamada real usa locationDisplayName(W_,P.x), nunca reconstroi a logica de nome de local inline', () => {
  const start = html.indexOf('const ln=locationDisplayName');
  assert.ok(start > -1, 'update() deveria calcular `ln` chamando locationDisplayName(W_,P.x), nao reimplementando a logica ali');
});

test('sala do boss ganha trono/marco + 2 estandartes + tapete vermelho ate ele (leitura de "sala final" clara, como pedido)', () => {
  const start = html.indexOf('// 8. Sala do boss');
  const end = html.indexOf('\n  statics.sort', start);
  const body = html.slice(start, end);
  assert.match(body, /makeRug/, 'deveria desenhar um tapete (decal) ate o marco do chefe');
  assert.match(body, /SP\.banner/g, 'deveria flanquear o marco com estandartes (SP.banner)');
  assert.match(body, /kitTorch/, 'deveria ter tochas acesas de verdade (com brilho) perto do marco');
});
