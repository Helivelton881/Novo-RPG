'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const clients = new Map();
const ALLOWED_MAP = /^(vila|floresta|cripta|serra|pantano|torre|ilhas|vulcao)(?:_d)?$/;
const ALLOWED_CLASS = new Set(['guerreiro', 'druida', 'mago', 'arqueiro']);
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.json':'application/json; charset=utf-8'};

function cleanText(value, max) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload, except) {
  const data = JSON.stringify(payload);
  for (const ws of clients.keys()) if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(data);
}

function publicPlayer(player) {
  return {id:player.id,name:player.name,cls:player.cls,map:player.map,x:player.x,y:player.y,dir:player.dir,moving:player.moving,lvl:player.lvl,atkT:player.atkT||0,atkAng:player.atkAng||0};
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
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
    if (raw.length > 4096) return ws.close(1009, 'Mensagem grande demais');
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
      const atkT=Math.max(0,Math.min(.4,Number(msg.atkT)||0)),atkAng=Number(msg.atkAng)||0;
      Object.assign(p,{map,x,y,dir:Math.max(0,Math.min(3,Number(msg.dir)|0)),moving:!!msg.moving,lvl:Math.max(1,Math.min(99,Number(msg.lvl)||1)),atkT,atkAng:Math.max(-Math.PI*2,Math.min(Math.PI*2,atkAng))});
      broadcast({type:'state',player:publicPlayer(p)},ws);
    } else if (msg.type === 'chat') {
      const text=cleanText(msg.text,160);if(text)broadcast({type:'chat',from:p.name,text,at:Date.now()});
    }
  });
  ws.on('close', () => { const p=clients.get(ws);if(p){clients.delete(ws);broadcast({type:'player_leave',id:p.id})} });
});

setInterval(() => {
  for (const ws of clients.keys()) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive=false;ws.ping();
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => console.log(`MMORPG Online em http://localhost:${PORT}`));
