'use strict';
// Fase 5.16.4 (hotfix real de producao): 'no-cache' sozinho (sem ETag/
// Last-Modified pra revalidar contra) e uma diretiva fraca -- confirmado
// ao vivo que um proxy transparente de operadora movel (rede 5G) servia
// uma copia em cache do index.html MINUTOS depois de um deploy, enquanto
// o mesmo servidor, acessado de outro lugar no mesmo instante, ja
// mostrava a versao nova. 'no-store' e a unica diretiva forte o
// suficiente pra garantir isso nunca mais acontecer -- nenhum cache
// (navegador, proxy de operadora, CDN) pode guardar copia nenhuma.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer } = require('./helpers');

const PORT = 8199;
let srv;
before(async () => { srv = await startServer(PORT); });
after(() => stopServer(srv));

test('GET / (index.html) responde Cache-Control: no-store -- nunca cacheavel por proxy de operadora/navegador', async () => {
  const r = await fetch(srv.base + '/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store', 'index.html deveria sempre ser buscado fresco, nunca servido de um cache antigo apos deploy');
});
test('GET /admin (admin.html) responde Cache-Control: no-store', async () => {
  const r = await fetch(srv.base + '/admin');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});
test('GET /portal (portal.html) responde Cache-Control: no-store', async () => {
  const r = await fetch(srv.base + '/portal');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});
