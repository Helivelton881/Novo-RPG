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
      if (body.length > 16384) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('INVALID_JSON')); } });
    req.on('error', reject);
  });
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
      const token=bearer(req);if(!token){json(res,401,{error:'Sessão ausente'});return true}
      const rows=await supabase('sessions',{query:`?select=expires_at,users(id,username)&token=eq.${tokenHash(token)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`});
      const row=rows[0], user=Array.isArray(row?.users)?row.users[0]:row?.users;
      if(!user){json(res,401,{error:'Sessão expirada'});return true}
      json(res,200,{user:{id:user.id,name:user.username,key:user.username},expiresAt:row.expires_at});return true;
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
  if(!state){state={id,mobs:new Map(),authorityId:null};maps.set(id,state)}
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
      p = {id:crypto.randomUUID(),name:cleanText(msg.name,14)||'Herói',cls:ALLOWED_CLASS.has(msg.cls)?msg.cls:'guerreiro',map:'vila',x:720,y:1258,dir:0,moving:false,lvl:Math.max(1,Math.min(99,Number(msg.lvl)||1)),atkT:0,atkAng:0};
      clients.set(ws,p);
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
    } else if (msg.type === 'mob_damage') {
      const map=cleanText(msg.map,24),state=maps.get(map);if(!state||map!==p.map)return;
      const mob=state.mobs.get(cleanText(msg.id,48)),damage=Math.max(0,Math.min(100000,Number(msg.damage)||0));
      if(!mob||mob.dead||!damage)return;
      mob.hp=Math.max(0,mob.hp-damage);
      if(mob.hp<=0){mob.dead=true;mob.respawnAt=Date.now()+(mob.boss?60000:30000)}
      broadcastMap(map,{type:'mob_state',map,mob,killerId:mob.dead?p.id:null});
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
  ws.on('close', () => { const p=clients.get(ws);if(p){clients.delete(ws);broadcast({type:'player_leave',id:p.id});const state=maps.get(p.map);if(state){chooseAuthority(state);broadcastMap(p.map,{type:'authority',map:p.map,authorityId:state.authorityId})}} });
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
