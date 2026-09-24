'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260924232253_harden_server_only_rpc_permissions.sql'), 'utf8');
const client = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const marketMigration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260924222716_add_market_tables_and_functions.sql'), 'utf8');

const privileged = [
  'bestiary_record_kill','guild_create','guild_accept_invite','guild_remove_member','guild_set_role','guild_transfer_leadership','guild_dissolve',
  'rank_stats_set_level_xp','rank_stats_bump','rank_stats_sync_bestiary_discovered',
  'market_list_item','market_cancel_listing','market_buy','market_expire_listings','market_claim_item','market_claim_gold',
];

test('migration revoga PUBLIC/anon/authenticated e concede somente service_role nas 16 RPCs', () => {
  for (const name of privileged) {
    assert.match(migration, new RegExp(`revoke execute on function public\\.${name}\\([^;]*from public, anon, authenticated`, 'i'), name);
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}\\([^;]*to service_role`, 'i'), name);
  }
});

test('wrappers de concorrencia usam advisory lock e operationId fica vinculado a buyer/listing', () => {
  assert.match(migration, /guild_accept_invite[\s\S]*pg_advisory_xact_lock/i);
  assert.match(migration, /guild_transfer_leadership[\s\S]*pg_advisory_xact_lock/i);
  assert.match(migration, /market_buy[\s\S]*pg_advisory_xact_lock/i);
  assert.match(migration, /v_existing\.listing_id <> p_listing_id/);
  assert.match(migration, /v_existing\.buyer_character_id <> p_buyer_character_id/);
  assert.match(migration, /OPERATION_ID_CONFLICT/);
});

test('migration adiciona os quatro indices de FK das fases novas sem remover indices recentes', () => {
  for (const index of ['idx_guild_invites_inviter_character','idx_guilds_leader_character','idx_market_listings_buyer_character','idx_market_transactions_listing']) assert.ok(migration.includes(index));
  assert.doesNotMatch(migration, /drop\s+index/i);
});

test('cliente possui Mercado utilizavel com cinco tabs e confirmacao; servidor nao expoe save no historico', () => {
  for (const text of ['Comprar','Meus anúncios','Anunciar','Itens a retirar','Histórico']) assert.ok(client.includes(text));
  assert.match(client, /data-a="marketbuy"/);
  assert.match(client, /confirm\(`Comprar/);
  const historyBlock = server.slice(server.indexOf("if (sub === '/history'"), server.indexOf("if (sub === '/claims'"));
  assert.doesNotMatch(historyBlock, /select=[^\n]*(user_id|save|token|email)/i);
});

test('mercado cobre filtros completos, expiracao e claims sem efeito duplo ou perda por overflow', () => {
  for (const id of ['mkType','mkLevelMin','mkLevelMax','mkRarity','mkEnchantMin','mkEnchantMax','mkPriceMin','mkPriceMax','mkSort']) assert.ok(client.includes(`id="${id}"`), id);
  assert.match(marketMigration, /where status = 'active' and expires_at <= now\(\)/i);
  assert.match(marketMigration, /for update[\s\S]*already_claimed/i);
  assert.match(marketMigration, /GOLD_CAP_WOULD_OVERFLOW/i);
  assert.match(marketMigration, /uq_market_listings_active_uid/i);
  assert.match(marketMigration, /jsonb_array_elements[\s\S]*elem->>'uid'/i);
});
