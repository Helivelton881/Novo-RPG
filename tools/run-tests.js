#!/usr/bin/env node
// Fase 5.17.3 -- runner das suites de teste com resultado HONESTO.
//
//   node tools/run-tests.js unit         -> sem Supabase. Testes que dependem
//                                          de Supabase aparecem como SKIPPED
//                                          (e o relatorio diz isso).
//   node tools/run-tests.js integration  -> EXIGE o Supabase de CI:
//                                          credencial ausente, alvo errado
//                                          ou QUALQUER teste pulado = FALHA.
//
// Nunca trata SKIPPED como PASS.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const mode = process.argv[2] || 'unit';
if (!['unit', 'integration'].includes(mode)) { console.error('uso: node tools/run-tests.js <unit|integration>'); process.exit(2); }

const ROOT = path.join(__dirname, '..');
const CI_SUPABASE_REF = 'crtyqlwrsvesbtqglipp';
const PRODUCTION_SUPABASE_REF = 'depdbddsbszhyeiuxhtd';
const env = { ...process.env };

if (mode === 'unit') {
  // unit nunca toca banco nenhum, mesmo que a maquina tenha credenciais.
  delete env.SUPABASE_URL; delete env.SUPABASE_SECRET_KEY; delete env.SUPABASE_SERVICE_ROLE_KEY;
  delete env.REQUIRE_SUPABASE;
} else {
  const url = String(env.SUPABASE_URL || '');
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) { console.error('FALHA: integration exige SUPABASE_URL e SUPABASE_SECRET_KEY do projeto Novo-RPG CI (secrets CI_SUPABASE_URL / CI_SUPABASE_SECRET_KEY).'); process.exit(1); }
  let host = '';
  try { host = new URL(url).host; } catch { console.error('FALHA: SUPABASE_URL invalida.'); process.exit(1); }
  if (host.startsWith(PRODUCTION_SUPABASE_REF) || url.includes(PRODUCTION_SUPABASE_REF)) { console.error('FALHA: SUPABASE_URL aponta para PRODUCAO. Testes so rodam no projeto de CI.'); process.exit(1); }
  if (!host.startsWith(CI_SUPABASE_REF + '.')) { console.error(`FALHA: SUPABASE_URL nao e o projeto Novo-RPG CI (${CI_SUPABASE_REF}).`); process.exit(1); }
  env.REQUIRE_SUPABASE = '1';
  env.SUPABASE_TEST_SAFE = '1'; // banco de CI e descartavel: libera os testes de concorrencia real do Mercado
}

const files = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join('test', f));
const child = spawn(process.execPath, ['--test', ...files], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
let tail = '';
child.stdout.on('data', chunk => { process.stdout.write(chunk); tail = (tail + chunk.toString()).slice(-4000); });
child.on('close', code => {
  const num = k => { const m = new RegExp('^# ' + k + ' (\\d+)$', 'm').exec(tail); return m ? Number(m[1]) : NaN; };
  const r = { tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped'), cancelled: num('cancelled') };
  console.log(`\n==== ${mode.toUpperCase()} SUMMARY: tests ${r.tests} | PASS ${r.pass} | FAIL ${r.fail} | SKIPPED ${r.skipped} | CANCELLED ${r.cancelled} ====`);
  if (mode === 'unit' && r.skipped > 0) console.log(`(${r.skipped} teste(s) SKIPPED dependem de Supabase e so contam no job de integracao -- NAO sao PASS)`);
  if (code !== 0) process.exit(code);
  if ([r.pass, r.fail, r.skipped].some(Number.isNaN)) { console.error('FALHA: nao foi possivel ler o resumo do node --test.'); process.exit(1); }
  if (r.fail > 0 || r.cancelled > 0) process.exit(1);
  if (mode === 'integration' && r.skipped > 0) { console.error(`FALHA: ${r.skipped} teste(s) SKIPPED no job de integracao -- nenhum SKIP e aceito aqui.`); process.exit(1); }
  process.exit(0);
});
