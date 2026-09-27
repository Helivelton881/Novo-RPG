'use strict';
// Fase 5.17.3 -- Integridade, CI & Observabilidade. Testes que NAO precisam
// de Supabase real: regras puras, um PostgREST FALSO local (http) pra
// provar o que o servidor pede/devolve, o /health, as migrations e as
// travas que impedem a suite de rodar contra producao.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const B = require('../game-data/balance-data.js');
const S = require('../server.js');
const H = require('./helpers');

const ROOT = path.join(__dirname, '..');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');

// ===================== LEVEL CAP =====================
test('CAP: Lv39 + XP suficiente vai pra 40 (e para ai)', () => {
  const r = B.applyXp(39, 0, B.xpToNext(39) + 12345);
  assert.deepEqual([r.lvl, r.xp], [40, 0]);
});

test('CAP: Lv40 + XP continua 40 com XP 0 (regra oficial da 5.17)', () => {
  const save = { xp: 0 };
  assert.deepEqual(S.applyXpGain(save, 40, 1e9), { xp: 0, lvl: 40 });
});

test('CAP: legado Lv41/xp193 normaliza para 40/0 (save e ranking)', () => {
  const s = S.sanitizeSave({ lvl: 41, xp: 193, gold: 5 }, 41);
  assert.deepEqual([s.lvl, s.xp, s.gold], [40, 0, 5]);
  assert.deepEqual(S.normalizeRankProgress(41, 193), { level: 40, xp: 0 });
});

test('CAP: Lv99 / save.lvl 99 forjados nunca persistem acima de 40', () => {
  const s = S.sanitizeSave({ lvl: 99, xp: 9e9 }, 99);
  assert.equal(s.lvl, 40);
  assert.equal(s.xp, 0);
  assert.deepEqual(S.normalizeRankProgress(99, 5000), { level: 40, xp: 0 });
  assert.deepEqual(S.normalizeRankProgress(0, -5), { level: 1, xp: 0 });
  assert.deepEqual(S.normalizeRankProgress(1, 0), { level: 1, xp: 0 });
});

test('CAP: save.lvl sempre igual ao nivel normalizado da coluna (A3)', () => {
  for (const [col, saveLvl] of [[41, 41], [40, 99], [12, 41], [1, 0]]) {
    const s = S.sanitizeSave({ lvl: saveLvl, xp: 10 }, col);
    assert.equal(s.lvl, B.clampLevel(col), `col ${col} save ${saveLvl}`);
  }
});

test('CAP: todo PATCH de personagem grava lvl junto com save (sem PATCH so-save)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/supabase\('characters',\s*\{method:'PATCH'[^}]*body:\{save\}/.test(src), 'PATCH so com {save} deixaria coluna lvl e save.lvl divergirem');
});

// ===================== MIGRATIONS =====================
const PRODUCTION_VERSIONS = ['20260922145956', '20260922150012', '20260922154406', '20260922193217', '20260922195538', '20260924214726', '20260924220401', '20260924221254', '20260924221408', '20260924222716', '20260924232253', '20260925034224', '20260925034318', '20260925080811', '20260925104225', '20260925104256'];
function migFiles() { return fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort(); }

test('MIGRATIONS: historico do repo = versoes aplicadas em producao + as novas da 5.17.3', () => {
  const versions = migFiles().map(f => f.slice(0, 14));
  assert.deepEqual(versions.slice(0, PRODUCTION_VERSIONS.length), PRODUCTION_VERSIONS);
  assert.deepEqual(versions.slice(PRODUCTION_VERSIONS.length), ['20260927010000', '20260927010100']);
  assert.equal(new Set(versions).size, versions.length, 'versoes unicas');
  for (const f of migFiles()) assert.match(f, /^\d{14}_[a-z0-9_]+\.sql$/);
});

test('MIGRATIONS: integridade -- backfill, RPC com clamp, trigger de nascimento, constraints e idempotencia', () => {
  const sql = fs.readFileSync(path.join(MIG_DIR, '20260927010000_enforce_level_cap_and_rank_stats_integrity.sql'), 'utf8');
  for (const needle of [
    'set lvl = least(greatest(lvl, 1), 40)',
    "jsonb_set(save, '{xp}', '0'::jsonb, true)",
    'insert into public.character_rank_stats (character_id, level, xp)',
    'on conflict (character_id) do nothing',
    'create or replace function public.rank_stats_set_level_xp',
    'after insert on public.characters',
    'drop trigger if exists trg_characters_create_rank_stats',
    'check (lvl between 1 and 40)',
    'check (level between 1 and 40)',
    'drop constraint if exists characters_lvl_range',
  ]) assert.ok(sql.includes(needle), needle);
  assert.ok(!/living_world/i.test(sql.replace(/--[^\n]*/g, '')), 'nao toca Living World');
  assert.ok(!/\bdrop\s+index\b/i.test(sql), 'nao remove indice');
  assert.ok(!/grant\s+[^;]*\bto\s+(anon|authenticated)\b/i.test(sql), 'nunca da GRANT a anon/authenticated (RLS server-only)');
  assert.ok(!/disable\s+row\s+level\s+security/i.test(sql));
});

test('MIGRATIONS: indice friends(friend_id) e nenhum indice removido', () => {
  const sql = fs.readFileSync(path.join(MIG_DIR, '20260927010100_add_friends_friend_id_index.sql'), 'utf8');
  assert.match(sql, /create index if not exists idx_friends_friend_id on public\.friends\(friend_id\)/);
  for (const f of migFiles()) assert.ok(!/\bdrop\s+index\b/i.test(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/--[^\n]*/g, '')), f);
});

test('LIVING WORLD: unica migration que cria/semeia living_world_settings e a original (sem migration nova sobre ela)', () => {
  const touching = migFiles().filter(f => /living_world_settings/i.test(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/--[^\n]*/g, '')));
  assert.deepEqual(touching, ['20260925104225_add_living_world_settings.sql', '20260925104256_add_living_world_settings_updated_by_index.sql']);
});

// ===================== TRAVAS DE CI =====================
test('CI: helpers recusam Supabase de PRODUCAO e exigem credencial quando REQUIRE_SUPABASE=1', () => {
  const saved = { ...process.env };
  try {
    process.env.SUPABASE_URL = `https://${H.PRODUCTION_SUPABASE_REF}.supabase.co`;
    process.env.SUPABASE_SECRET_KEY = 'x';
    assert.throws(() => H.hasSupabase(), /REFUSING_PRODUCTION_SUPABASE/);
    delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SECRET_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.REQUIRE_SUPABASE = '1';
    assert.throws(() => H.hasSupabase(), /INTEGRATION_REQUIRES_SUPABASE/);
    delete process.env.REQUIRE_SUPABASE;
    assert.equal(H.hasSupabase(), false);
  } finally { for (const k of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'REQUIRE_SUPABASE']) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; } }
});

test('CI: tools/run-tests.js integration FALHA sem secrets, com URL de producao ou de outro projeto (nunca SKIP verde)', () => {
  const run = extra => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'run-tests.js'), 'integration'], { cwd: ROOT, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...extra }, encoding: 'utf8', timeout: 20000 });
  const missing = run({});
  assert.equal(missing.status, 1); assert.match(missing.stderr, /exige SUPABASE_URL/);
  const prod = run({ SUPABASE_URL: `https://${H.PRODUCTION_SUPABASE_REF}.supabase.co`, SUPABASE_SECRET_KEY: 'x' });
  assert.equal(prod.status, 1); assert.match(prod.stderr, /PRODUCAO/);
  const other = run({ SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_SECRET_KEY: 'x' });
  assert.equal(other.status, 1); assert.match(other.stderr, /nao e o projeto Novo-RPG CI/);
});

test('CI: workflow separa unit/integration, usa npm ci e secrets CI_* (nunca os de producao)', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
  assert.match(yml, /\n  unit:/); assert.match(yml, /\n  integration:/);
  assert.match(yml, /npm ci/); assert.match(yml, /npm run test:unit/); assert.match(yml, /npm run test:integration/);
  assert.match(yml, /secrets\.CI_SUPABASE_URL/); assert.match(yml, /secrets\.CI_SUPABASE_SECRET_KEY/);
  assert.ok(!yml.includes(H.PRODUCTION_SUPABASE_REF));
  assert.ok(!/sb_secret_/.test(yml), 'nenhum segredo literal');
});

// ===================== SERVIDOR CONTRA POSTGREST FALSO =====================
// Um PostgREST minimo em memoria: registra cada requisicao e devolve
// ranking legado (level 41) -- prova normalizacao/sem vazamento sem banco real.
let fake, fakeUrl, srv;
const calls = [];
before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/rest/v1/character_rank_stats')) {
        return res.end(JSON.stringify([
          { character_id: '11111111-1111-1111-1111-111111111111', level: 41, xp: 193, pvp_kills: 0, pvp_deaths: 0, tvt_wins: 0, tvt_losses: 0, tvt_draws: 0, tvt_kills: 0, tvt_deaths: 0, world_boss_kills: 0, world_boss_participations: 0, bestiary_discovered: 0, characters: { name: 'Legado', cls: 'mago', lvl: 41 } },
          { character_id: '22222222-2222-2222-2222-222222222222', level: 12, xp: 50, pvp_kills: 0, pvp_deaths: 0, tvt_wins: 0, tvt_losses: 0, tvt_draws: 0, tvt_kills: 0, tvt_deaths: 0, world_boss_kills: 0, world_boss_participations: 0, bestiary_discovered: 0, characters: { name: 'Normal', cls: 'guerreiro', lvl: 12 } },
        ]));
      }
      if (req.url.startsWith('/rest/v1/guild_members')) return res.end('[]');
      if (req.url.startsWith('/rest/v1/rpc/')) { res.statusCode = 204; return res.end(); }
      if (req.url.startsWith('/rest/v1/living_world_settings')) return res.end('[]');
      res.end('[]');
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  srv = await H.startServer(8231, { SUPABASE_URL: fakeUrl, SUPABASE_SECRET_KEY: 'sb_secret_FAKE_FOR_TEST_ONLY_9f3c' });
});
after(() => { if (srv) H.stopServer(srv); if (fake) fake.close(); });

test('RANKING: GET /api/rankings nunca devolve level > 40 (dado legado 41 vira 40/0)', async () => {
  const r = await H.httpJson(srv, 'GET', '/api/rankings?type=level');
  assert.equal(r.status, 200);
  assert.ok(r.json.items.length >= 2);
  for (const it of r.json.items) assert.ok(it.level <= B.LEVEL_CAP, JSON.stringify(it));
  const legacy = r.json.items.find(i => i.name === 'Legado');
  assert.deepEqual([legacy.level, legacy.xp], [40, 0]);
  const ids = r.json.items.map(i => i.name);
  assert.equal(new Set(ids).size, ids.length, 'sem duplicatas');
  for (const type of ['pvp', 'tvt', 'world_boss', 'bestiary']) {
    const t = await H.httpJson(srv, 'GET', '/api/rankings?type=' + type);
    for (const it of t.json.items) assert.ok(it.level <= B.LEVEL_CAP, type);
  }
});

test('HEALTH: GET /health 200, rapido, sem segredos, sem tocar no banco', async () => {
  const before = calls.length, t0 = Date.now();
  const res = await fetch(srv.base + '/health');
  const text = await res.text(), ms = Date.now() - t0;
  assert.equal(res.status, 200);
  const j = JSON.parse(text);
  assert.equal(j.ok, true); assert.equal(j.service, 'novo-rpg');
  assert.deepEqual(Object.keys(j).sort(), ['commit', 'ok', 'service', 'uptimeSeconds']);
  assert.ok(Number.isInteger(j.uptimeSeconds) && j.uptimeSeconds >= 0);
  for (const secret of ['sb_secret', 'FAKE_FOR_TEST', fakeUrl, '127.0.0.1', 'SUPABASE']) assert.ok(!text.includes(secret), secret);
  assert.ok(ms < 1000, `lento: ${ms}ms`);
  assert.equal(calls.length, before, 'health nunca consulta Supabase');
  assert.equal((await fetch(srv.base + '/health', { method: 'POST' })).status, 405, 'nunca muta nada');
});

test('HEALTH: payload puro nao carrega nada alem de ok/service/commit/uptime', () => {
  const p = S.healthPayload();
  assert.deepEqual(Object.keys(p).sort(), ['commit', 'ok', 'service', 'uptimeSeconds']);
});
