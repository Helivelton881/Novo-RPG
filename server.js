const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const rooms = new Map();
function roomOf(zone) {
  if (!rooms.has(zone)) rooms.set(zone, new Map());
  return rooms.get(zone);
}
function broadcast(zone, payload, exceptId) {
  const room = rooms.get(zone);
  if (!room) return;
  const msg = JSON.stringify(payload);
  for (const [id, peer] of room) {
    if (id === exceptId) continue;
    if (peer.ws.readyState === 1) peer.ws.send(msg);
  }
}
function peerList(zone) {
  const room = rooms.get(zone);
  if (!room) return [];
  return [...room.values()].map(p => p.state);
}
function leaveAll(id, zone) {
  if (!zone) return;
  const room = rooms.get(zone);
  if (room && room.delete(id)) broadcast(zone, { t: 'leave', id }, id);
}
let nextId = 1;
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {

  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Erro ao carregar o jogo.');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8'
      });

      res.end(data);
    });

    return;
  }

  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8'
  });

  res.end('404 - Arquivo não encontrado');
});
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  const id = 'p' + (nextId++);
  let zone = null;
  let username = 'Herói';
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'hello') {
      username = String(msg.username || 'Herói').slice(0, 20);
      zone = msg.zone || 'vila';
      const room = roomOf(zone);
      room.set(id, { ws, state: { id, username, cls: msg.cls || 'guerreiro', lvl: msg.lvl || 1,
        x: msg.x || 0, y: msg.y || 0, dir: 0, anim: 'idle', hp: 1, hpmax: 1 } });
      ws.send(JSON.stringify({ t: 'welcome', id, peers: peerList(zone).filter(p => p.id !== id) }));
      broadcast(zone, { t: 'join', peer: room.get(id).state }, id);
      return;
    }
    if (!zone) return;
    if (msg.t === 'zone' && msg.zone !== zone) {
      leaveAll(id, zone);
      zone = msg.zone;
      const room = roomOf(zone);
      room.set(id, { ws, state: { id, username, cls: msg.cls || 'guerreiro', lvl: msg.lvl || 1,
        x: msg.x || 0, y: msg.y || 0, dir: 0, anim: 'idle', hp: 1, hpmax: 1 } });
      ws.send(JSON.stringify({ t: 'welcome', id, peers: peerList(zone).filter(p => p.id !== id) }));
      broadcast(zone, { t: 'join', peer: room.get(id).state }, id);
      return;
    }
    if (msg.t === 'move') {
      const room = roomOf(zone);
      const p = room.get(id); if (!p) return;
      Object.assign(p.state, { x: msg.x, y: msg.y, dir: msg.dir, anim: msg.anim,
        hp: msg.hp, hpmax: msg.hpmax, lvl: msg.lvl });
      broadcast(zone, { t: 'move', peer: p.state }, id);
      return;
    }
    if (msg.t === 'chat') {
      const body = String(msg.body || '').slice(0, 240);
      if (!body.trim()) return;
      broadcast(zone, { t: 'chat', username, body, at: Date.now() }, null);
      return;
    }
    if (msg.t === 'fx') {
      broadcast(zone, { t: 'fx', id, kind: msg.kind, x: msg.x, y: msg.y, dir: msg.dir }, id);
      return;
    }
  });
  ws.on('close', () => leaveAll(id, zone));
});
server.listen(PORT, () => console.log('servidor local no ar: ws://localhost:' + PORT));
