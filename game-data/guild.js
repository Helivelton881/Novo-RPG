'use strict';
// Fase 5.8 -- Guildas / Clas: nucleo puro (config, validacao, matriz de
// permissoes). Sem HTTP/WS/Supabase aqui -- testavel isoladamente, mesmo
// espirito de game-data/tvt.js e game-data/event-manager.js.

const GUILD_MAX_MEMBERS = 20;
const GUILD_NAME_MIN = 3, GUILD_NAME_MAX = 24;
const GUILD_TAG_MIN = 2, GUILD_TAG_MAX = 5;
const GUILD_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const GUILD_ROLES = Object.freeze(['leader', 'officer', 'member']);

// Letras (com acentos), numeros, espaco, apostrofo e hifen -- mesmo
// espirito de cleanText() no servidor (sem <>/controle), mas permissivo o
// bastante pra nomes reais de guilda em portugues.
const GUILD_NAME_RE = /^[\p{L}\p{N} '-]+$/u;
const GUILD_TAG_RE = /^[A-Z0-9]+$/;

function normalizeGuildName(raw) {
  return String(raw || '').replace(/[<>\u0000-\u001f]/g, '').trim().replace(/\s+/g, ' ');
}
function normalizeGuildTag(raw) {
  return String(raw || '').replace(/[<>\u0000-\u001f\s]/g, '').trim().toUpperCase();
}
function validateGuildName(raw) {
  const value = normalizeGuildName(raw);
  if (value.length < GUILD_NAME_MIN || value.length > GUILD_NAME_MAX) return { ok: false, error: `Nome da guilda: de ${GUILD_NAME_MIN} a ${GUILD_NAME_MAX} caracteres.` };
  if (!GUILD_NAME_RE.test(value)) return { ok: false, error: 'Nome da guilda contém caracteres inválidos.' };
  return { ok: true, value };
}
function validateGuildTag(raw) {
  const value = normalizeGuildTag(raw);
  if (value.length < GUILD_TAG_MIN || value.length > GUILD_TAG_MAX) return { ok: false, error: `Tag da guilda: de ${GUILD_TAG_MIN} a ${GUILD_TAG_MAX} caracteres.` };
  if (!GUILD_TAG_RE.test(value)) return { ok: false, error: 'Tag da guilda: apenas letras e números.' };
  return { ok: true, value };
}

// ===== Matriz de permissoes (nunca aceita role arbitraria do cliente -- o
// servidor sempre le a role real da linha de guild_members antes de checar
// qualquer uma destas funcoes). =====
function canInvite(role) { return role === 'leader' || role === 'officer'; }
// officer so remove member comum; leader remove officer ou member (nunca a
// si mesmo por aqui -- sair e uma acao separada, ver canLeaveDirectly).
function canRemoveMember(actorRole, targetRole) {
  if (actorRole === 'leader') return targetRole !== 'leader';
  if (actorRole === 'officer') return targetRole === 'member';
  return false;
}
function canPromote(actorRole, targetRole) { return actorRole === 'leader' && targetRole === 'member'; }
function canDemote(actorRole, targetRole) { return actorRole === 'leader' && targetRole === 'officer'; }
function canTransferLeadership(actorRole) { return actorRole === 'leader'; }
function canDissolve(actorRole) { return actorRole === 'leader'; }
// Leader so pode sair diretamente (sem transferir antes) se for o UNICO
// membro -- nesse caso sair == dissolver. Officer/member sempre podem sair.
function canLeaveDirectly(role, memberCount) { return role !== 'leader' || memberCount <= 1; }

function isInviteExpired(invite, now = Date.now()) {
  return new Date(invite.expires_at).getTime() <= now;
}

module.exports = {
  GUILD_MAX_MEMBERS, GUILD_NAME_MIN, GUILD_NAME_MAX, GUILD_TAG_MIN, GUILD_TAG_MAX,
  GUILD_INVITE_TTL_MS, GUILD_ROLES,
  normalizeGuildName, normalizeGuildTag, validateGuildName, validateGuildTag,
  canInvite, canRemoveMember, canPromote, canDemote, canTransferLeadership, canDissolve, canLeaveDirectly,
  isInviteExpired,
};
