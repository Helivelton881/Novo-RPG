'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const authAttempts = new Map();
const clients = new Map();
const maps = new Map();
const ALLOWED_MAP = /^(vila|floresta|cripta|serra|pantano|torre|ilhas|vulcao)(?:_d)?$/;
const ALLOWED_CLASS = new Set(['guerreiro', 'druida', 'mago', 'arqueiro']);
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.json':'application/json; charset=utf-8'};

// Espelha GEAR/tiers do index.html (so os campos usados pela validacao
// anti-cheat) para recalcular stats de item no servidor em vez de confiar
// nos numeros que o cliente manda.
const GEAR_TIERS = {
  sword:  [null,{atk:2,req:1},{atk:5,req:4},{atk:9,req:8},{atk:14,req:12},{atk:22,req:20}],
  bow:    [null,{atk:2,req:1},{atk:5,req:4},{atk:9,req:8},{atk:14,req:12},{atk:22,req:20}],
  staffd: [null,{atk:2,req:1},{atk:5,req:4},{atk:9,req:8},{atk:14,req:12},{atk:22,req:20}],
  staffm: [null,{atk:2,req:1},{atk:5,req:4},{atk:9,req:8},{atk:14,req:12},{atk:22,req:20}],
  shield: [null,{def:2,blk:.10},{def:4,blk:.14},{def:7,blk:.18},{def:11,blk:.22},{def:16,blk:.26}],
  armor:  [null,{def:2,hp:10},{def:4,hp:25},{def:7,hp:45},{def:10,hp:70},{def:15,hp:105}],
  helmet: [null,{def:1,hp:6},{def:3,hp:14},{def:5,hp:28},{def:8,hp:44},{def:12,hp:66}],
  cape:   [null,{def:1,hp:8},{def:2,hp:16},{def:4,hp:30},{def:6,hp:48},{def:9,hp:72}],
  jewel:  [null,{atk:1,hp:5},{atk:2,hp:12},{atk:4,hp:20},{atk:6,hp:34},{atk:9,hp:52}],
  boots:  [null,{def:1,spd:.03},{def:2,spd:.05},{def:4,spd:.08},{def:6,spd:.12},{def:9,spd:.16}],
};
const EQ_SLOTS = ['sword','shield','armor','helmet','cape','jewel','boots'];
const COUNTER_FIELDS = ['gk','ki','kit','kt','ktt','kp','kpt','ks','ke','kw','kwt','kv','kvt','ap','key','scr','sl','gb','bs','dt'];
// Espelha classTypes() do cliente: quais tipos de item cada classe pode
// receber de sorteio (a propria arma da classe, e escudo so pro guerreiro).
const CLASS_ITEM_TYPES = {
  guerreiro: ['sword','shield','armor','helmet','cape','jewel','boots'],
  druida:    ['staffd','armor','helmet','cape','jewel','boots'],
  mago:      ['staffm','armor','helmet','cape','jewel','boots'],
  arqueiro:  ['bow','armor','helmet','cape','jewel','boots'],
};

// Espelha os precos reais da loja (buildShop/shopDo em index.html) pra
// validar compra/venda no servidor em vez de confiar no que o cliente manda.
const GEAR_PRICES = {
  sword: {1:60, 2:60}, bow: {1:60, 2:60}, staffd: {1:60, 2:60}, staffm: {1:60, 2:60},
  shield: {1:25}, armor: {1:30, 2:70}, helmet: {1:25}, cape: {1:20}, jewel: {1:40}, boots: {1:25},
};
const STK_PRICES = {pv:10, pa:10, ap:5, scr:30};
const SELL_PRICES = [0, 8, 22, 60, 140, 320];
const PORTAL_PRICES = {floresta:400, cripta:900, serra:1600, pantano:2500, torre:3600, ilhas:5000, vulcao:7000};
const GEM_SELL_PRICE = 25;
const SKILL_RESET_PRICE = 30;
const SHOP_BAG_MAX = 12;
function typeSlot(type) { return (type === 'sword' || type === 'bow' || type === 'staffd' || type === 'staffm') ? 'sword' : type; }

// Espelha as recompensas de missao dos dialogos (NPC_SCRIPT em index.html,
// callbacks end() dos estagios que dao premio) pra conceder ouro/gema/XP no
// servidor em vez de aceitar o que o cliente ja gravou no P.gold/P.gem/P.xp.
// So os 8 estagios que realmente pagam premio estao aqui; os demais (aceitar
// missao, "portal liberado" sem recompensa) nao movem nada de valor e
// continuam so no cliente.
const QUEST_REWARDS = {
  2:  {next:3,  gold:30,   gem:0, xp:20,   pv:1},
  4:  {next:5,  gold:60,   gem:1, xp:80},
  8:  {next:9,  gold:150,  gem:2, xp:300},
  12: {next:13, gold:250,  gem:3, xp:500},
  16: {next:17, gold:400,  gem:4, xp:800},
  20: {next:21, gold:600,  gem:5, xp:1200},
  24: {next:25, gold:800,  gem:6, xp:1800},
  28: {next:29, gold:1000, gem:7, xp:2500},
};
// Espelha need() do cliente (index.html): XP necessario pra passar do nivel l.
const questNeed = l => 30 * l;
function applyQuestXp(save, lvl, xpGain) {
  let xp = save.xp + xpGain;
  while (xp >= questNeed(lvl)) { xp -= questNeed(lvl); lvl = Math.min(99, lvl + 1); }
  return { xp, lvl };
}

// Espelha os 7 bauis de mapa (um por area de campo, floresta..vulcao -- o
// baui de masmorra usa outro fluxo, sem flag persistido, fora do escopo) --
// cada `flag` e o nome que o cliente usa em P[ch.flag] (openChest em
// index.html); `field` e o nome correspondente gravado no save (chest,
// chest2..chest7). So abre uma vez por personagem: field vira true e trava.
const CHEST_REWARDS = {
  chestOpen:  {field:'chest',  gold:60,  tier:4},
  chestOpen2: {field:'chest2', gold:60,  tier:4},
  chestOpen3: {field:'chest3', gold:60,  tier:4},
  chestOpen4: {field:'chest4', gold:100, tier:5},
  chestOpen5: {field:'chest5', gold:150, tier:5},
  chestOpen6: {field:'chest6', gold:200, tier:5},
  chestOpen7: {field:'chest7', gold:250, tier:5},
};
function rollChestItem(save, lvl, tier) {
  const types = CLASS_ITEM_TYPES[save.cls] || ['armor'];
  const type = types[Math.floor(Math.random() * types.length)];
  const item = sanitizeItem({ type, tier });
  if (!item) return null;
  const slot = typeSlot(type), canEquip = !save.eq[slot] && (!item.req || lvl >= item.req);
  if (canEquip) save.eq[slot] = item;
  else if (save.bag.length < 24) save.bag.push(item);
  else return null;
  return item;
  return { xp, lvl };
}

// shopSold e efemero por personagem (lista de recompra), como party --
// nao sobrevive a um restart, nao precisa de tabela.
const shopSoldByChar = new Map();

// Espelha a formula de dano e o cooldown de cada skill (CLASSES/SKILL_FX em
// index.html) pra computar o dano no servidor em vez de aceitar o numero que
// o cliente manda. O cliente so informa QUAL skill/rank foi usada; o "quanto
// de dano" sai sempre do calculo abaixo.
const CLASS_DMG = {
  guerreiro: {dmg0:11, dmgL:3.2}, druida: {dmg0:9, dmgL:2.8},
  mago: {dmg0:13, dmgL:3.7}, arqueiro: {dmg0:10, dmgL:3},
};
const BASIC_CD_MS = {guerreiro:420, druida:500, mago:620, arqueiro:400};
const SKILL_CD_MS = {spin:5000, dash:4000, warcry:18000, heal:7000, roots:9000, thorns:10000, fireball:4000, frost:7000, barrier:16000, multi:4000, evade:5000, pierce:8000};
const CLASS_SKILLS = {
  guerreiro: ['spin','dash','warcry'], druida: ['heal','roots','thorns'],
  mago: ['fireball','frost','barrier'], arqueiro: ['multi','evade','pierce'],
};
const DAMAGE_SKILLS = new Set(['spin','dash','roots','thorns','fireball','frost','multi','pierce']);
function skillDamageMul(id, r) {
  switch (id) {
    case 'spin': return 1.4 + .3 * (r - 1);
    case 'dash': return 1.2 + .25 * (r - 1);
    case 'roots': return .8 + .2 * (r - 1);
    case 'thorns': return .45 + .1 * (r - 1);
    case 'fireball': return 1.8 + .4 * (r - 1);
    case 'frost': return 1 + .25 * (r - 1);
    case 'multi': return .75 + .05 * (r - 1);
    case 'pierce': return 2.2 + .4 * (r - 1);
    default: return 0;
  }
}
function clampAtk(v) { return Math.max(0, Math.min(35, Number(v) || 0)); }
function baseDmgOf(cls, lvl) { const c = CLASS_DMG[cls] || CLASS_DMG.guerreiro; return c.dmg0 + c.dmgL * (lvl - 1); }
function buffMulOf(p) { return 1 + ((p.buffUntil && Date.now() < p.buffUntil) ? (p.buffAtk || 0) : 0); }
function skBaseOf(p, atk) { return (baseDmgOf(p.cls, p.lvl) + clampAtk(atk) + 2) * buffMulOf(p); }

// Compartilhado por mob_damage e player_damage: nunca confia no numero que o
// cliente manda, so em qual skill foi usada (basic com formula+cooldown por
// classe, ou o valor "pendente" computado no cast_skill). Retorna null se a
// skill nao pode causar dano agora (sem cast valido, cooldown, ou spam).
function resolveAttackDamage(p, msg, now) {
  const skill = cleanText(msg.skill, 16) || 'basic';
  let dmg = 0;
  if (skill === 'basic') {
    p.recentBasic = (p.recentBasic || []).filter(t => now - t < (BASIC_CD_MS[p.cls] || 420));
    if (p.recentBasic.length >= 6) return null;
    p.recentBasic.push(now);
    dmg = Math.round((baseDmgOf(p.cls, p.lvl) + clampAtk(msg.atk)) * buffMulOf(p)) + Math.floor(Math.random() * 4);
  } else if (DAMAGE_SKILLS.has(skill)) {
    const pend = p.pendingSkill && p.pendingSkill[skill];
    if (!pend || now > pend.expiresAt) return null;
    dmg = msg.splash ? Math.round(pend.dmg * .6) : pend.dmg;
  } else return null;
  const lvl = Math.max(1, Math.min(99, Number(p.lvl) || 1)), maxHit = Math.min(6500, 50 + lvl * 60);
  dmg = Math.max(0, Math.min(maxHit, dmg));
  return dmg || null;
}

function cleanText(value, max) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
}

function json(res, status, payload) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 262144) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('INVALID_JSON')); } });
    req.on('error', reject);
  });
}

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tiers = GEAR_TIERS[raw.type]; if (!tiers) return null;
  const tier = Math.round(Number(raw.tier));
  if (!Number.isInteger(tier) || tier < 1 || tier >= tiers.length) return null;
  const t = tiers[tier];
  return {type: raw.type, tier, n: cleanText(raw.n, 40) || 'Item', atk: t.atk || 0, def: t.def || 0, hp: t.hp || 0, blk: t.blk || 0, spd: t.spd || 0, req: t.req || 0};
}

// Reconstroi o save inteiro a partir de limites plausiveis em vez de
// confiar no JSON que o cliente manda: mesmo com o jogo ainda calculando
// dano/inventario no cliente, isso impede que editar localStorage/memoria
// vire ouro, itens ou XP infinitos persistidos na nuvem.
function sanitizeSave(raw, lvl) {
  const save = raw && typeof raw === 'object' ? raw : {};
  const clampInt = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  const map = ALLOWED_MAP.test(cleanText(save.map, 24)) ? cleanText(save.map, 24) : 'vila';
  const out = {
    cls: ALLOWED_CLASS.has(save.cls) ? save.cls : 'guerreiro', lvl,
    xp: clampInt(save.xp, 30 * (lvl + 1) * 3), gold: clampInt(save.gold, 500000), gem: clampInt(save.gem, 5000),
    pv: clampInt(save.pv, 999), pa: clampInt(save.pa, 999), quest: clampInt(save.quest, 40), kills: clampInt(save.kills, 999999),
    hp: clampInt(save.hp, 100000), mp: clampInt(save.mp, 100000),
    x: Number.isFinite(Number(save.x)) ? Number(save.x) : 0, y: Number.isFinite(Number(save.y)) ? Number(save.y) : 0,
    pt: clampInt(save.pt, 10000000), map,
    chest: !!save.chest, chest2: !!save.chest2, chest3: !!save.chest3, chest4: !!save.chest4, chest5: !!save.chest5, chest6: !!save.chest6, chest7: !!save.chest7,
    name: cleanText(save.name, 14) || 'Herói',
    bar: Array.isArray(save.bar) ? save.bar.slice(0, 8).map(x => typeof x === 'string' && x.length < 20 ? x : null) : [],
    gunlock: save.gunlock && typeof save.gunlock === 'object' ? Object.fromEntries(Object.entries(save.gunlock).slice(0, 20).map(([k, v]) => [cleanText(k, 24), !!v])) : {},
    skSeen: save.skSeen && typeof save.skSeen === 'object' ? Object.fromEntries(Object.entries(save.skSeen).slice(0, 20).map(([k, v]) => [cleanText(k, 20), !!v])) : {},
    sk: save.sk && typeof save.sk === 'object' ? Object.fromEntries(Object.entries(save.sk).slice(0, 10).map(([k, v]) => [cleanText(k, 20), clampInt(v, 3)])) : {},
    bag: Array.isArray(save.bag) ? save.bag.slice(0, 24).map(sanitizeItem).filter(Boolean) : [],
    eq: {},
    chat: Array.isArray(save.chat) ? save.chat.slice(-40).map(m => ({n: cleanText(m && m.n, 20), t: cleanText(m && m.t, 240), sys: !!(m && m.sys)})) : [],
  };
  for (const f of COUNTER_FIELDS) out[f] = clampInt(save[f], 999);
  // Um item equipado com req (nivel minimo) maior que o nivel real nunca
  // acontece num cliente honesto (giveItem/loja so equipam se lvl>=req) --
  // so surge editando o save direto. Em vez de aceitar, desequipa e devolve
  // pra mochila (nunca perde o item, so tira a vantagem indevida do slot).
  for (const s of EQ_SLOTS) {
    let item = save.eq && save.eq[s] ? sanitizeItem(save.eq[s]) : null;
    if (item && item.req && item.req > lvl) { if (out.bag.length < 24) out.bag.push(item); item = null; }
    out.eq[s] = item;
  }
  // Pontos de habilidade gastos (rank-1 por skill) nunca podem passar de
  // lvl-1 disponivel (skillPoints() no cliente) -- um cliente honesto nunca
  // sobe rank sem ter ponto livre. Sem isso, um save editado podia upar as
  // 3 skills da classe pro rank maximo (3) em qualquer nivel. Se o total
  // gasto excede o orcamento, reseta as 3 pro rank base -- mesmo resultado
  // que a acao "redistribuir" da loja ja produz normalmente.
  const validSkills = CLASS_SKILLS[out.cls] || [];
  const filteredSk = {}; for (const id of validSkills) filteredSk[id] = out.sk[id] || 1;
  const spentPts = validSkills.reduce((sum, id) => sum + (filteredSk[id] - 1), 0);
  out.sk = spentPts > Math.max(0, lvl - 1) ? Object.fromEntries(validSkills.map(id => [id, 1])) : filteredSk;
  return out;
}

function authIp(req) {
  return cleanText(String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0], 64);
}

function rateLimited(req) {
  const now = Date.now(), key = authIp(req), recent = (authAttempts.get(key) || []).filter(t => now - t < 60000);
  recent.push(now); authAttempts.set(key, recent);
  return recent.length > 12;
}

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function scrypt(password, salt, keylen, options) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, keylen, options, (err, key) => err ? reject(err) : resolve(key)));
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16), N = 16384, r = 8, p = 1;
  const key = await scrypt(password, salt, 32, {N, r, p, maxmem: 64 * 1024 * 1024});
  return `scrypt$${N}$${r}$${p}$${b64url(salt)}$${b64url(key)}`;
}
async function verifyPassword(password, encoded) {
  if (/^\$2[aby]\$/.test(String(encoded || ''))) {
    try { return await bcrypt.compare(password, encoded); } catch { return false; }
  }
  const parts = String(encoded || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [,n,rr,pp,salt64,key64] = parts, expected = Buffer.from(key64, 'base64url');
  if (!expected.length) return false;
  try {
    const actual = await scrypt(password, Buffer.from(salt64, 'base64url'), expected.length, {N:Number(n), r:Number(rr), p:Number(pp), maxmem:64 * 1024 * 1024});
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

async function supabase(table, {method='GET', query='', body, prefer}={}) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('SUPABASE_NOT_CONFIGURED');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method,
    headers:{apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${SUPABASE_SECRET_KEY}`,'Content-Type':'application/json',...(prefer?{Prefer:prefer}:{})},
    body:body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) { const err = new Error('SUPABASE_REQUEST_FAILED'); err.status=response.status; err.detail=data; throw err; }
  return data;
}

async function createSession(userId) {
  const token = b64url(crypto.randomBytes(32)), expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await supabase('sessions', {method:'POST', body:{token:tokenHash(token),user_id:userId,expires_at:expiresAt}, prefer:'return=minimal'});
  return {token, expiresAt};
}

function bearer(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  return match ? match[1] : '';
}

async function resolveUser(req) {
  const token = bearer(req);
  if (!token) return null;
  const rows = await supabase('sessions', {query:`?select=expires_at,users(id,username)&token=eq.${tokenHash(token)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`});
  const row = rows[0], user = Array.isArray(row?.users) ? row.users[0] : row?.users;
  return user ? {id: user.id, username: user.username, expiresAt: row.expires_at} : null;
}

async function handleAuth(req, res, pathname) {
  if (!pathname.startsWith('/api/auth/')) return false;
  if (req.method === 'POST' && rateLimited(req)) { json(res,429,{error:'Muitas tentativas. Aguarde um minuto.'}); return true; }
  try {
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      const input=await readJson(req), username=String(input.username||'').trim().toLowerCase(), password=String(input.password||'');
      if(!/^[a-z0-9_]{3,16}$/.test(username)){json(res,400,{error:'Usuário: de 3 a 16 letras, números ou _'});return true}
      if(password.length<8||password.length>72){json(res,400,{error:'A senha precisa ter de 8 a 72 caracteres'});return true}
      const found=await supabase('users',{query:`?select=id&username=eq.${encodeURIComponent(username)}&limit=1`});
      if(found.length){json(res,409,{error:'Esse usuário já existe'});return true}
      const password_hash=await hashPassword(password);
      let rows;
      try { rows=await supabase('users',{method:'POST',body:{username,password_hash},prefer:'return=representation'}); }
      catch(e){if(e.status===409){json(res,409,{error:'Esse usuário já existe'});return true}throw e}
      const session=await createSession(rows[0].id);
      json(res,201,{user:{id:rows[0].id,name:username,key:username},...session});return true;
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const input=await readJson(req), username=String(input.username||'').trim().toLowerCase(), password=String(input.password||'');
      if(!username||!password){json(res,400,{error:'Digite o usuário e a senha'});return true}
      const rows=await supabase('users',{query:`?select=id,username,password_hash&username=eq.${encodeURIComponent(username)}&limit=1`});
      const user=rows[0];
      if(!user||!(await verifyPassword(password,user.password_hash))){json(res,401,{error:'Usuário ou senha incorretos'});return true}
      const update={last_login:new Date().toISOString()};
      if(/^\$2[aby]\$/.test(user.password_hash))update.password_hash=await hashPassword(password);
      await supabase('users',{method:'PATCH',query:`?id=eq.${encodeURIComponent(user.id)}`,body:update,prefer:'return=minimal'});
      const session=await createSession(user.id);
      json(res,200,{user:{id:user.id,name:user.username,key:user.username},...session});return true;
    }
    if (pathname === '/api/auth/session' && req.method === 'GET') {
      const user=await resolveUser(req);
      if(!user){json(res,401,{error:'Sessão expirada'});return true}
      json(res,200,{user:{id:user.id,name:user.username,key:user.username},expiresAt:user.expiresAt});return true;
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const token=bearer(req);if(token)await supabase('sessions',{method:'DELETE',query:`?token=eq.${tokenHash(token)}`,prefer:'return=minimal'});
      json(res,200,{ok:true});return true;
    }
    json(res,405,{error:'Método não permitido'});return true;
  } catch (err) {
    console.error('auth_error', err.message, err.status || '', err.detail || '');
    if (!res.headersSent) json(res,err.message==='SUPABASE_NOT_CONFIGURED'?503:500,{error:err.message==='SUPABASE_NOT_CONFIGURED'?'Login online ainda não configurado no servidor.':'Não foi possível concluir. Tente novamente.'});
    return true;
  }
}

const CHAR_ID_RE = /^\/api\/characters\/([0-9a-fA-F-]{8,36})$/;

async function handleCharacters(req, res, pathname) {
  if (!pathname.startsWith('/api/characters')) return false;
  try {
    const user = await resolveUser(req);
    if (!user) { json(res,401,{error:'Sessão ausente ou expirada'}); return true; }

    if (pathname === '/api/characters' && req.method === 'GET') {
      const rows = await supabase('characters', {query:`?select=id,slot,name,cls,lvl,map,save,updated_at&user_id=eq.${user.id}&order=slot.asc`});
      json(res,200,{characters: rows}); return true;
    }

    if (pathname === '/api/characters' && req.method === 'POST') {
      const input = await readJson(req);
      const slot = Number(input.slot);
      const name = cleanText(input.name, 14);
      const cls = ALLOWED_CLASS.has(input.cls) ? input.cls : 'guerreiro';
      if (!Number.isInteger(slot) || slot < 0 || slot > 3) { json(res,400,{error:'Espaço inválido'}); return true; }
      if (name.length < 2) { json(res,400,{error:'Nome do personagem inválido'}); return true; }
      let rows;
      try {
        rows = await supabase('characters', {method:'POST', body:{user_id:user.id, slot, name, cls, lvl:1, map:'vila', save:{}}, prefer:'return=representation'});
      } catch (e) {
        if (e.status === 409) { json(res,409,{error:'Espaço ou nome já em uso'}); return true; }
        throw e;
      }
      json(res,201,{character: rows[0]}); return true;
    }

    const idMatch = CHAR_ID_RE.exec(pathname);
    if (idMatch && req.method === 'PUT') {
      const id = idMatch[1];
      const input = await readJson(req);
      const lvl = Math.max(1, Math.min(99, Number(input.lvl) || 1));
      const save = sanitizeSave(input.save, lvl);
      const rows = await supabase('characters', {method:'PATCH', query:`?id=eq.${encodeURIComponent(id)}&user_id=eq.${user.id}`, body:{lvl, map: save.map, save}, prefer:'return=representation'});
      if (!rows.length) { json(res,404,{error:'Personagem não encontrado'}); return true; }
      json(res,200,{character: rows[0]}); return true;
    }

    if (idMatch && req.method === 'DELETE') {
      const id = idMatch[1];
      const rows = await supabase('characters', {method:'DELETE', query:`?id=eq.${encodeURIComponent(id)}&user_id=eq.${user.id}`, prefer:'return=representation'});
      if (!rows.length) { json(res,404,{error:'Personagem não encontrado'}); return true; }
      json(res,200,{ok:true}); return true;
    }

    json(res,405,{error:'Método não permitido'}); return true;
  } catch (err) {
    console.error('characters_error', err.message, err.status || '', err.detail || '');
    if (!res.headersSent) json(res, err.message==='SUPABASE_NOT_CONFIGURED'?503:500, {error: err.message==='SUPABASE_NOT_CONFIGURED'?'Salvamento online ainda não configurado no servidor.':'Não foi possível salvar. Tente novamente.'});
    return true;
  }
}

const SHOP_ID_RE = /^\/api\/characters\/([0-9a-fA-F-]{8,36})\/shop$/;
const QUEST_ID_RE = /^\/api\/characters\/([0-9a-fA-F-]{8,36})\/quest$/;
const CHEST_ID_RE = /^\/api\/characters\/([0-9a-fA-F-]{8,36})\/chest$/;

// Loja/economia server-autoritativa: le o save atual do personagem no banco,
// aplica a transacao contra as tabelas de preco acima (nunca confia em preco
// ou "eu tenho X moedas" que o cliente manda) e grava o resultado. Fecha a
// brecha que a sanitizacao do save sozinha nao fecha: sanitizeItem garante
// que um item tem stats legitimos pro tier dele, mas nao garante que foi
// pago -- so uma transacao de verdade garante isso.
async function handleShop(req, res, pathname) {
  const m = SHOP_ID_RE.exec(pathname);
  if (!m) return false;
  if (req.method !== 'POST') { json(res,405,{error:'Método não permitido'}); return true; }
  const charId = m[1];
  try {
    const user = await resolveUser(req);
    if (!user) { json(res,401,{error:'Sessão ausente ou expirada'}); return true; }
    const rows0 = await supabase('characters', {query:`?select=lvl,save&id=eq.${encodeURIComponent(charId)}&user_id=eq.${user.id}&limit=1`});
    const row = rows0[0];
    if (!row) { json(res,404,{error:'Personagem não encontrado'}); return true; }
    const lvl = row.lvl;
    const save = sanitizeSave(row.save, lvl);
    const input = await readJson(req);
    const action = String(input.action || '');
    let error = null;

    if (action === 'buy_gear') {
      const type = String(input.type || ''), tier = Math.round(Number(input.tier));
      const price = GEAR_PRICES[type] && GEAR_PRICES[type][tier];
      const item = price ? sanitizeItem({type, tier}) : null;
      if (!item) error = 'Item inválido';
      else if (save.gold < price) error = 'Moedas insuficientes';
      else {
        const slot = typeSlot(type), canEquip = !save.eq[slot] && (!item.req || lvl >= item.req);
        if (!canEquip && save.bag.length >= SHOP_BAG_MAX) error = 'Mochila cheia';
        else { save.gold -= price; if (canEquip) save.eq[slot] = item; else save.bag.push(item); }
      }
    } else if (action === 'buy_stack') {
      const key = String(input.key || ''), qty = Math.max(1, Math.min(99, Math.round(Number(input.qty) || 1)));
      const unit = ['pv','pa','ap','scr'].includes(key) ? STK_PRICES[key] : null;
      if (!unit) error = 'Item inválido';
      else if (save.gold < unit * qty) error = 'Moedas insuficientes';
      else if ((save[key] || 0) + qty > 99) error = 'Você não consegue carregar tanto assim';
      else { save.gold -= unit * qty; save[key] = (save[key] || 0) + qty; }
    } else if (action === 'sell_item') {
      const idx = Math.round(Number(input.bagIndex));
      if (!Number.isInteger(idx) || idx < 0 || idx >= save.bag.length) error = 'Item não encontrado';
      else {
        const it = save.bag[idx], price = SELL_PRICES[it.tier] || 0;
        save.bag.splice(idx, 1); save.gold += price;
        const list = shopSoldByChar.get(charId) || [];
        list.unshift({it, price: Math.ceil(price * 1.5)}); list.length = Math.min(list.length, 10);
        shopSoldByChar.set(charId, list);
      }
    } else if (action === 'sell_common') {
      let total = 0; const kept = []; const list = shopSoldByChar.get(charId) || [];
      for (const it of save.bag) {
        if (it.tier === 1) { total += SELL_PRICES[1]; list.unshift({it, price: Math.ceil(SELL_PRICES[1] * 1.5)}); }
        else kept.push(it);
      }
      save.bag = kept; save.gold += total; list.length = Math.min(list.length, 10);
      shopSoldByChar.set(charId, list);
    } else if (action === 'sell_gem') {
      const qty = Math.round(Number(input.qty) || 1);
      if (!Number.isInteger(qty) || qty < 1 || qty > save.gem) error = 'Sem gemas suficientes';
      else { save.gem -= qty; save.gold += qty * GEM_SELL_PRICE; }
    } else if (action === 'buyback') {
      const idx = Math.round(Number(input.index));
      const list = shopSoldByChar.get(charId) || [];
      if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) error = 'Item não encontrado';
      else {
        const entry = list[idx];
        if (save.gold < entry.price) error = 'Moedas insuficientes';
        else {
          const slot = typeSlot(entry.it.type), canEquip = !save.eq[slot] && (!entry.it.req || lvl >= entry.it.req);
          if (!canEquip && save.bag.length >= SHOP_BAG_MAX) error = 'Mochila cheia';
          else { list.splice(idx, 1); shopSoldByChar.set(charId, list); save.gold -= entry.price; if (canEquip) save.eq[slot] = entry.it; else save.bag.push(entry.it); }
        }
      }
    } else if (action === 'skill_reset') {
      if (save.gold < SKILL_RESET_PRICE) error = 'Moedas insuficientes';
      else { save.gold -= SKILL_RESET_PRICE; for (const k of Object.keys(save.sk)) save.sk[k] = 1; }
    } else if (action === 'buy_portal') {
      const dest = String(input.dest || ''), price = PORTAL_PRICES[dest];
      if (!price) error = 'Destino inválido';
      else if (save.gunlock[dest]) error = 'Já liberado';
      else if (save.gold < price) error = 'Moedas insuficientes';
      else { save.gold -= price; save.gunlock[dest] = true; }
    } else {
      error = 'Ação inválida';
    }

    if (error) { json(res,400,{error}); return true; }
    const rows = await supabase('characters', {method:'PATCH', query:`?id=eq.${encodeURIComponent(charId)}&user_id=eq.${user.id}`, body:{save}, prefer:'return=representation'});
    if (!rows.length) { json(res,404,{error:'Personagem não encontrado'}); return true; }
    json(res,200,{character: rows[0], shopSold: shopSoldByChar.get(charId) || []}); return true;
  } catch (err) {
    console.error('shop_error', err.message, err.status || '', err.detail || '');
    if (!res.headersSent) json(res, err.message==='SUPABASE_NOT_CONFIGURED'?503:500, {error: err.message==='SUPABASE_NOT_CONFIGURED'?'Loja online ainda não configurada no servidor.':'Não foi possível concluir. Tente novamente.'});
    return true;
  }
}

async function handleQuest(req, res, pathname) {
  const m = QUEST_ID_RE.exec(pathname);
  if (!m) return false;
  if (req.method !== 'POST') { json(res,405,{error:'Método não permitido'}); return true; }
  const charId = m[1];
  try {
    const user = await resolveUser(req);
    if (!user) { json(res,401,{error:'Sessão ausente ou expirada'}); return true; }
    const rows0 = await supabase('characters', {query:`?select=lvl,save&id=eq.${encodeURIComponent(charId)}&user_id=eq.${user.id}&limit=1`});
    const row = rows0[0];
    if (!row) { json(res,404,{error:'Personagem não encontrado'}); return true; }
    let lvl = row.lvl;
    const save = sanitizeSave(row.save, lvl);
    const input = await readJson(req);
    const from = Math.round(Number(input.from));
    const reward = QUEST_REWARDS[from];

    if (!reward || save.quest !== from) { json(res,400,{error:'Missão inválida ou já concluída'}); return true; }

    save.gold = Math.min(500000, save.gold + reward.gold);
    save.gem = Math.min(5000, save.gem + reward.gem);
    if (reward.pv) save.pv = Math.min(999, save.pv + reward.pv);
    const leveled = applyQuestXp(save, lvl, reward.xp);
    save.xp = leveled.xp; lvl = leveled.lvl;
    save.quest = reward.next;
    save.lvl = lvl;

    const rows = await supabase('characters', {method:'PATCH', query:`?id=eq.${encodeURIComponent(charId)}&user_id=eq.${user.id}`, body:{lvl, save}, prefer:'return=representation'});
    if (!rows.length) { json(res,404,{error:'Personagem não encontrado'}); return true; }
    json(res,200,{character: rows[0]}); return true;
  } catch (err) {
    console.error('quest_error', err.message, err.status || '', err.detail || '');
    if (!res.headersSent) json(res, err.message==='SUPABASE_NOT_CONFIGURED'?503:500, {error: err.message==='SUPABASE_NOT_CONFIGURED'?'Missões online ainda não configuradas no servidor.':'Não foi possível concluir. Tente novamente.'});
    return true;
  }
}

async function handleChest(req, res, pathname) {
  const m = CHEST_ID_RE.exec(pathname);
  if (!m) return false;
  if (req.method !== 'POST') { json(res,405,{error:'Método não permitido'}); return true; }
  const charId = m[1];
  try {
    const user = await resolveUser(req);
    if (!user) { json(res,401,{error:'Sessão ausente ou expirada'}); return true; }
    const rows0 = await supabase('characters', {query:`?select=lvl,save&id=eq.${encodeURIComponent(charId)}&user_id=eq.${user.id}&limit=1`});
    const row = rows0[0];
    if (!row) { json(res,404,{error:'Personagem não encontrado'}); return true; }
    const lvl = row.lvl;
    const save = sanitizeSave(row.save, lvl);
    const input = await readJson(req);
    const reward = CHEST_REWARDS[String(input.flag || '')];

    if (!reward) { json(res,400,{error:'Baú inválido'}); return true; }
    if (save[reward.field]) { json(res,400,{error:'Esse baú já foi aberto'}); return true; }
    if (save.key < 1) { json(res,400,{error:'Sem chave'}); return true; }

    save.key -= 1;
    save[reward.field] = true;
    save.gold = Math.min(500000, save.gold + reward.gold);
    const item = rollChestItem(save, lvl, reward.tier);

    const rows = await supabase('characters', {method:'PATCH', query:`?id=eq.${encodeURIComponent(charId)}&user_id=eq.${user.id}`, body:{save}, prefer:'return=representation'});
    if (!rows.length) { json(res,404,{error:'Personagem não encontrado'}); return true; }
    json(res,200,{character: rows[0], item}); return true;
  } catch (err) {
    console.error('chest_error', err.message, err.status || '', err.detail || '');
    if (!res.headersSent) json(res, err.message==='SUPABASE_NOT_CONFIGURED'?503:500, {error: err.message==='SUPABASE_NOT_CONFIGURED'?'Baús online ainda não configurados no servidor.':'Não foi possível concluir. Tente novamente.'});
    return true;
  }
}

// accountSockets: userId -> Set<ws> conectados agora (qualquer mapa), para
// status online real de amigos/grupo. Populado no 'join' do WS quando o
// cliente manda um userId de conta online.
const accountSockets = new Map();
function isAccountOnline(userId) { const s = accountSockets.get(userId); return !!s && s.size > 0; }

async function handleFriends(req, res, pathname) {
  if (!pathname.startsWith('/api/friends')) return false;
  try {
    const user = await resolveUser(req);
    if (!user) { json(res,401,{error:'Sessão ausente ou expirada'}); return true; }

    if (pathname === '/api/friends' && req.method === 'GET') {
      const rows = await supabase('friends', {query:`?select=friend_id,users!friend_id(username)&user_id=eq.${user.id}&order=created_at.asc`});
      const friends = rows.map(r => {const u = Array.isArray(r.users) ? r.users[0] : r.users; return {id:r.friend_id, username:u?u.username:'?', online:isAccountOnline(r.friend_id)}});
      json(res,200,{friends}); return true;
    }

    if (pathname === '/api/friends' && req.method === 'POST') {
      const input = await readJson(req);
      const username = String(input.username || '').trim().toLowerCase();
      if (!/^[a-z0-9_]{3,16}$/.test(username)) { json(res,400,{error:'Usuário inválido'}); return true; }
      if (username === user.username) { json(res,400,{error:'Esse é você'}); return true; }
      const found = await supabase('users', {query:`?select=id&username=eq.${encodeURIComponent(username)}&limit=1`});
      if (!found.length) { json(res,404,{error:'Esse usuário não existe'}); return true; }
      const count = await supabase('friends', {query:`?select=friend_id&user_id=eq.${user.id}`});
      if (count.length >= 20) { json(res,400,{error:'Lista cheia (20 amigos)'}); return true; }
      try { await supabase('friends', {method:'POST', body:{user_id:user.id, friend_id:found[0].id}, prefer:'return=minimal'}); }
      catch (e) { if (e.status !== 409) throw e; }
      const rows = await supabase('friends', {query:`?select=friend_id,users!friend_id(username)&user_id=eq.${user.id}&order=created_at.asc`});
      const friends = rows.map(r => {const u = Array.isArray(r.users) ? r.users[0] : r.users; return {id:r.friend_id, username:u?u.username:'?', online:isAccountOnline(r.friend_id)}});
      json(res,201,{friends}); return true;
    }

    const delMatch = /^\/api\/friends\/([a-z0-9_]{3,16})$/i.exec(pathname);
    if (delMatch && req.method === 'DELETE') {
      const username = delMatch[1].toLowerCase();
      const found = await supabase('users', {query:`?select=id&username=eq.${encodeURIComponent(username)}&limit=1`});
      if (found.length) await supabase('friends', {method:'DELETE', query:`?user_id=eq.${user.id}&friend_id=eq.${found[0].id}`, prefer:'return=minimal'});
      const rows = await supabase('friends', {query:`?select=friend_id,users!friend_id(username)&user_id=eq.${user.id}&order=created_at.asc`});
      const friends = rows.map(r => {const u = Array.isArray(r.users) ? r.users[0] : r.users; return {id:r.friend_id, username:u?u.username:'?', online:isAccountOnline(r.friend_id)}});
      json(res,200,{friends}); return true;
    }

    json(res,405,{error:'Método não permitido'}); return true;
  } catch (err) {
    console.error('friends_error', err.message, err.status || '', err.detail || '');
    if (!res.headersSent) json(res, err.message==='SUPABASE_NOT_CONFIGURED'?503:500, {error: err.message==='SUPABASE_NOT_CONFIGURED'?'Amigos online ainda não configurado no servidor.':'Não foi possível concluir. Tente novamente.'});
    return true;
  }
}

// Grupos sao efemeros (nao sobrevivem a um restart do servidor), como a
// autoridade de monstros por mapa - por isso ficam so em memoria, sem tabela.
const parties = new Map(); // code -> {ownerId, members: Map<userId, username>}
const memberParty = new Map(); // userId -> code
const PARTY_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genPartyCode() { let c = ''; for (let i = 0; i < 6; i++) c += PARTY_CODE_CHARS[Math.floor(Math.random() * PARTY_CODE_CHARS.length)]; return c; }
function partyView(code) {
  const p = parties.get(code); if (!p) return null;
  return {code, ownerId: p.ownerId, members: [...p.members.entries()].map(([id, username]) => ({id, username, online: isAccountOnline(id)}))};
}
function leaveParty(userId) {
  const code = memberParty.get(userId); if (!code) return;
  const p = parties.get(code);
  if (p) { p.members.delete(userId); if (!p.members.size) parties.delete(code); else if (p.ownerId === userId) p.ownerId = [...p.members.keys()][0]; }
  memberParty.delete(userId);
}

async function handleParty(req, res, pathname) {
  if (!pathname.startsWith('/api/party')) return false;
  try {
    const user = await resolveUser(req);
    if (!user) { json(res,401,{error:'Sessão ausente ou expirada'}); return true; }

    if (pathname === '/api/party' && req.method === 'GET') {
      const code = memberParty.get(user.id);
      json(res,200,{party: code ? partyView(code) : null}); return true;
    }
    if (pathname === '/api/party' && req.method === 'POST') {
      leaveParty(user.id);
      let code; do { code = genPartyCode(); } while (parties.has(code));
      parties.set(code, {ownerId: user.id, members: new Map([[user.id, user.username]])});
      memberParty.set(user.id, code);
      json(res,201,{party: partyView(code)}); return true;
    }
    if (pathname === '/api/party/join' && req.method === 'POST') {
      const input = await readJson(req);
      const code = cleanText(input.code, 8).toUpperCase();
      const p = parties.get(code);
      if (!p) { json(res,404,{error:'Código inválido'}); return true; }
      if (p.members.size >= 4 && !p.members.has(user.id)) { json(res,400,{error:'Grupo cheio'}); return true; }
      leaveParty(user.id);
      p.members.set(user.id, user.username); memberParty.set(user.id, code);
      json(res,200,{party: partyView(code)}); return true;
    }
    if (pathname === '/api/party/leave' && req.method === 'POST') {
      leaveParty(user.id);
      json(res,200,{ok:true}); return true;
    }
    json(res,405,{error:'Método não permitido'}); return true;
  } catch (err) {
    console.error('party_error', err.message);
    if (!res.headersSent) json(res,500,{error:'Não foi possível concluir. Tente novamente.'});
    return true;
  }
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload, except) {
  const data = JSON.stringify(payload);
  for (const ws of clients.keys()) if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(data);
}

function playersOnMap(map) {
  return [...clients.entries()].filter(([,p]) => p.map === map);
}

function broadcastMap(map, payload) {
  const data=JSON.stringify(payload);
  for(const [ws,p] of clients) if(p.map===map&&ws.readyState===WebSocket.OPEN) ws.send(data);
}

function mapState(id) {
  let state=maps.get(id);
  if(!state){state={id,mobs:new Map(),authorityId:null,hitGuard:new Map(),pvpGuard:new Map()};maps.set(id,state)}
  return state;
}

function chooseAuthority(state) {
  const present=playersOnMap(state.id);
  if(!present.some(([,p])=>p.id===state.authorityId)) state.authorityId=present[0]?.[1].id||null;
  return state.authorityId;
}

function publicPlayer(player) {
  return {id:player.id,name:player.name,cls:player.cls,map:player.map,x:player.x,y:player.y,dir:player.dir,moving:player.moving,lvl:player.lvl,atkT:player.atkT||0,atkAng:player.atkAng||0};
}

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (await handleAuth(req, res, pathname)) return;
  if (await handleShop(req, res, pathname)) return;
  if (await handleQuest(req, res, pathname)) return;
  if (await handleChest(req, res, pathname)) return;
  if (await handleCharacters(req, res, pathname)) return;
  if (await handleFriends(req, res, pathname)) return;
  if (await handleParty(req, res, pathname)) return;
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type':MIME[path.extname(file).toLowerCase()] || 'application/octet-stream','Cache-Control':'no-cache'});
    fs.createReadStream(file).pipe(res);
  });
});

const wss = new WebSocketServer({ server, path: '/game' });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    if (raw.length > 65536) return ws.close(1009, 'Mensagem grande demais');
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    let p = clients.get(ws);
    if (msg.type === 'join' && !p) {
      const userId = typeof msg.userId === 'string' && /^[0-9a-f-]{36}$/i.test(msg.userId) ? msg.userId : null;
      p = {id:crypto.randomUUID(),userId,name:cleanText(msg.name,14)||'Herói',cls:ALLOWED_CLASS.has(msg.cls)?msg.cls:'guerreiro',map:'vila',x:720,y:1258,dir:0,moving:false,lvl:Math.max(1,Math.min(99,Number(msg.lvl)||1)),atkT:0,atkAng:0};
      clients.set(ws,p);
      if (userId) { if (!accountSockets.has(userId)) accountSockets.set(userId, new Set()); accountSockets.get(userId).add(ws); }
      send(ws,{type:'welcome',id:p.id,players:[...clients.values()].filter(x=>x!==p).map(publicPlayer)});
      broadcast({type:'player_join',player:publicPlayer(p)},ws);
      return;
    }
    if (!p) return;
    if (msg.type === 'state') {
      const map = cleanText(msg.map,24);
      if (!ALLOWED_MAP.test(map)) return;
      const x = Number(msg.x), y = Number(msg.y);
      if (!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>2880||y>2112) return;
      const oldMap=p.map,atkT=Math.max(0,Math.min(.4,Number(msg.atkT)||0)),atkAng=Number(msg.atkAng)||0;
      Object.assign(p,{map,x,y,dir:Math.max(0,Math.min(3,Number(msg.dir)|0)),moving:!!msg.moving,lvl:Math.max(1,Math.min(99,Number(msg.lvl)||1)),atkT,atkAng:Math.max(-Math.PI*2,Math.min(Math.PI*2,atkAng))});
      if(oldMap!==map){const oldState=maps.get(oldMap);if(oldState){chooseAuthority(oldState);broadcastMap(oldMap,{type:'authority',map:oldMap,authorityId:oldState.authorityId})}}
      broadcast({type:'state',player:publicPlayer(p)},ws);
    } else if (msg.type === 'map_join') {
      const map=cleanText(msg.map,24);if(!ALLOWED_MAP.test(map)||map!==p.map)return;
      const state=mapState(map),defs=Array.isArray(msg.mobs)?msg.mobs.slice(0,120):[];
      if(!state.mobs.size) for(const d of defs){
        const id=cleanText(d.id,48),maxhp=Math.max(1,Math.min(1000000,Number(d.maxhp)||1));if(!id)continue;
        state.mobs.set(id,{id,maxhp,hp:maxhp,dead:false,x:Number(d.x)||0,y:Number(d.y)||0,state:'idle',respawnAt:0,boss:!!d.boss});
      }
      chooseAuthority(state);
      send(ws,{type:'map_state',map,authorityId:state.authorityId,mobs:[...state.mobs.values()]});
      broadcastMap(map,{type:'authority',map,authorityId:state.authorityId});
    } else if (msg.type === 'cast_skill') {
      const map=cleanText(msg.map,24);if(map!==p.map)return;
      const id=cleanText(msg.id,16),sk=Math.max(1,Math.min(3,Math.round(Number(msg.sk))||1)),atk=clampAtk(msg.atk);
      if(!(CLASS_SKILLS[p.cls]||[]).includes(id))return;
      const now=Date.now();
      p.skillCd=p.skillCd||{};
      if(now<(p.skillCd[id]||0))return;
      p.skillCd[id]=now+(SKILL_CD_MS[id]||1000);
      if(id==='warcry'){p.buffUntil=now+(6+2*(sk-1))*1000;p.buffAtk=.3+.1*(sk-1)}
      if(DAMAGE_SKILLS.has(id)){
        p.pendingSkill=p.pendingSkill||{};
        p.pendingSkill[id]={dmg:Math.round(skBaseOf(p,atk)*skillDamageMul(id,sk)),expiresAt:now+(id==='thorns'?4000:2000)};
      }
    } else if (msg.type === 'mob_damage') {
      const map=cleanText(msg.map,24),state=maps.get(map);if(!state||map!==p.map)return;
      const mobId=cleanText(msg.id,48),mob=state.mobs.get(mobId);
      if(!mob||mob.dead)return;
      // alcance plausivel: usa a posicao real do jogador (rastreada via
      // 'state') e a ultima posicao conhecida do monstro (rastreada via
      // mob_snapshot) para rejeitar um golpe em algo longe demais pra
      // qualquer ataque do jogo (o maior caso real e a Flecha Perfurante,
      // que viaja ate ~476; roots/thorns podem mirar ate 320 de distancia
      // + 90 de raio). O servidor ainda nao simula a posicao do monstro
      // (isso seria a Fase C completa) -- aqui so audita o que ja recebe.
      if(Math.hypot(mob.x-p.x,mob.y-p.y)>550)return;
      // anti-spam por (jogador,monstro): bloqueia macro/cliente adulterado
      // batendo no mesmo alvo rapido demais.
      const now=Date.now(),guard=state.hitGuard.get(mobId);
      if(guard&&guard.playerId===p.id&&now-guard.at<80)return;
      const dmg=resolveAttackDamage(p,msg,now);
      if(!dmg)return;
      state.hitGuard.set(mobId,{playerId:p.id,at:now});
      mob.hp=Math.max(0,mob.hp-dmg);
      if(mob.hp<=0){mob.dead=true;mob.respawnAt=Date.now()+(mob.boss?60000:30000)}
      broadcastMap(map,{type:'mob_state',map,mob,killerId:mob.dead?p.id:null});
    } else if (msg.type === 'player_damage') {
      // PvP: liberado fora da vila. O servidor nunca rastreia o HP do
      // defensor -- reaproveita a mesma validacao de dano/cooldown do PvE
      // (resolveAttackDamage) e manda o dano bruto pro alvo, que aplica a
      // propria mitigacao (defesa/bloqueio/escudo) localmente, exatamente
      // como ja faz contra ataques de monstro (hurtPlayer no cliente).
      const map=cleanText(msg.map,24);if(map!==p.map||map==='vila')return;
      const targetId=cleanText(msg.targetId,64);if(!targetId||targetId===p.id)return;
      let target=null;for(const other of clients.values())if(other.id===targetId&&other.map===map){target=other;break}
      if(!target)return;
      if(p.userId&&target.userId){const pc=memberParty.get(p.userId),tc=memberParty.get(target.userId);if(pc&&pc===tc)return}
      if(Math.hypot(target.x-p.x,target.y-p.y)>550)return;
      const state=mapState(map);
      const now=Date.now(),gk=p.id+'>'+targetId,lastHit=state.pvpGuard.get(gk);
      if(lastHit&&now-lastHit<80)return;
      const dmg=resolveAttackDamage(p,msg,now);
      if(!dmg)return;
      state.pvpGuard.set(gk,now);
      broadcastMap(map,{type:'player_hit',map,targetId,attackerId:p.id,attackerName:p.name,dmg});
    } else if (msg.type === 'mob_snapshot') {
      const map=cleanText(msg.map,24),state=maps.get(map);if(!state||map!==p.map||state.authorityId!==p.id||!Array.isArray(msg.mobs))return;
      for(const u of msg.mobs.slice(0,120)){const mob=state.mobs.get(cleanText(u.id,48));if(!mob||mob.dead)continue;const x=Number(u.x),y=Number(u.y);if(Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&x<=2880&&y>=0&&y<=2112){mob.x=x;mob.y=y;mob.state=cleanText(u.state,16)||'idle'}}
      broadcastMap(map,{type:'mob_snapshot',map,mobs:msg.mobs.slice(0,120)},ws);
    } else if (msg.type === 'projectile') {
      const map=cleanText(msg.map,24),id=cleanText(msg.id,64),kind=cleanText(msg.kind,12);
      if(map!==p.map||!ALLOWED_MAP.test(map)||!id||!['arrow','bolt','leaf','fire'].includes(kind))return;
      const x=Number(msg.x),y=Number(msg.y),vx=Number(msg.vx),vy=Number(msg.vy),life=Math.max(.05,Math.min(2,Number(msg.life)||.5));
      if(![x,y,vx,vy].every(Number.isFinite)||Math.hypot(vx,vy)>900)return;
      broadcastMap(map,{type:'projectile',map,ownerId:p.id,projectile:{id,kind,x,y,vx,vy,life,r:Math.max(3,Math.min(14,Number(msg.r)||7)),pierce:!!msg.pierce}});
    } else if (msg.type === 'projectile_end') {
      const map=cleanText(msg.map,24),id=cleanText(msg.id,64);if(map!==p.map||!id)return;
      broadcastMap(map,{type:'projectile_end',map,ownerId:p.id,id,x:Number(msg.x)||0,y:Number(msg.y)||0,boom:!!msg.boom});
    } else if (msg.type === 'chat') {
      const text=cleanText(msg.text,160);if(text)broadcast({type:'chat',from:p.name,text,at:Date.now()});
    }
  });
  ws.on('close', () => { const p=clients.get(ws);if(p){clients.delete(ws);if(p.userId){const s=accountSockets.get(p.userId);if(s){s.delete(ws);if(!s.size)accountSockets.delete(p.userId)}}broadcast({type:'player_leave',id:p.id});const state=maps.get(p.map);if(state){chooseAuthority(state);broadcastMap(p.map,{type:'authority',map:p.map,authorityId:state.authorityId})}} });
});

setInterval(()=>{
  const now=Date.now();
  for(const state of maps.values())for(const mob of state.mobs.values())if(mob.dead&&mob.respawnAt&&now>=mob.respawnAt){mob.dead=false;mob.hp=mob.maxhp;mob.respawnAt=0;mob.x=Number(mob.x)||0;mob.y=Number(mob.y)||0;mob.state='idle';broadcastMap(state.id,{type:'mob_state',map:state.id,mob,killerId:null})}
},1000);

setInterval(() => {
  for (const ws of clients.keys()) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive=false;ws.ping();
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => console.log(`MMORPG Online em http://localhost:${PORT}`));
