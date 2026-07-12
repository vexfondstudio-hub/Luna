const http = require('http');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');

const CONFIG = {
  myId: crypto.randomUUID(),
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 19131,
  discoveryPort: 47101,  // UDP-обнаружение других телефонов в той же Wi-Fi сети
  maxHearDistance: 30,
  fullVolumeDistance: 3
};

const peers = new Map();   // id -> { ip, username, lastSeen }
const inbox = [];          // очередь событий для локальной веб-страницы (poll)
let myPosition = { x: 0, y: 0, z: 0, dimension: 'overworld' };
let mcConnected = false;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/whoami', (req, res) => res.json({ id: CONFIG.myId, config: CONFIG }));
app.get('/peers', (req, res) => res.json(Array.from(peers.entries()).map(([id, p]) => ({ id, ...p }))));
app.get('/inbox', (req, res) => res.json(inbox.splice(0, inbox.length)));

// Публичный API для мода/сторонних клиентов: базовая информация о сервере LunaVS
app.get('/api/info', (req, res) => res.json({
  name: 'LunaVS',
  version: '1.0.0',
  id: CONFIG.myId,
  connectPort: CONFIG.port,
  mcConnectAddress: `localhost:${CONFIG.port}`,
  peers: peers.size,
  mcConnected: mcConnected
}));

// входящее от других телефонов в сети
app.post('/signal', (req, res) => { inbox.push({ kind: 'signal', ...req.body }); res.sendStatus(200); });
app.post('/position', (req, res) => { inbox.push({ kind: 'position', ...req.body }); res.sendStatus(200); });

// от локальной веб-страницы: переслать сигнал конкретному пиру
app.post('/send-signal', (req, res) => {
  const { to, ...payload } = req.body;
  const peer = peers.get(to);
  if (peer) httpPost(peer.ip, '/signal', { from: CONFIG.myId, ...payload });
  res.sendStatus(200);
});

const server = http.createServer(app);

// ---------- Minecraft /connect мост (тот же порт, WS upgrade) ----------
const mcWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  mcWss.handleUpgrade(req, socket, head, (ws) => mcWss.emit('connection', ws, req));
});

mcWss.on('connection', (ws) => {
  console.log('[MC] Minecraft подключился');
  mcConnected = true;
  inbox.push({ kind: 'mc-status', connected: true });

  const subscribe = (eventName) => ws.send(JSON.stringify({
    header: { version: 1, requestId: crypto.randomUUID(), messagePurpose: 'subscribe' },
    body: { eventName }
  }));
  subscribe('PlayerTravelled');
  subscribe('PlayerTransform');

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const p = msg.body && msg.body.player;
    if (p && p.position) {
      myPosition = { x: p.position.x, y: p.position.y, z: p.position.z, dimension: p.dimension ?? myPosition.dimension };
      inbox.push({ kind: 'self-position', ...myPosition });
      for (const [, peer] of peers) httpPost(peer.ip, '/position', { from: CONFIG.myId, ...myPosition });
    }
  });

  ws.on('close', () => { mcConnected = false; inbox.push({ kind: 'mc-status', connected: false }); });
});

function httpPost(ip, route, payload) {
  const data = JSON.stringify(payload);
  const req = http.request({
    host: ip, port: CONFIG.port, path: route, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    timeout: 2000
  });
  req.on('error', () => {}); // best-effort по локальной сети
  req.write(data);
  req.end();
}

// ---------- UDP-обнаружение других телефонов в той же Wi-Fi ----------
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const username = (os.userInfo && os.userInfo().username) || ('player-' + CONFIG.myId.slice(0, 4));

udp.on('message', (msg, rinfo) => {
  let d;
  try { d = JSON.parse(msg.toString()); } catch { return; }
  if (!d.id || d.id === CONFIG.myId) return;
  peers.set(d.id, { ip: rinfo.address, username: d.username, lastSeen: Date.now() });
});

udp.bind(CONFIG.discoveryPort, () => {
  udp.setBroadcast(true);
  setInterval(() => {
    const payload = Buffer.from(JSON.stringify({ id: CONFIG.myId, username }));
    udp.send(payload, CONFIG.discoveryPort, '255.255.255.255');
  }, 2000);
});

setInterval(() => {
  const now = Date.now();
  for (const [id, p] of peers) if (now - p.lastSeen > 8000) peers.delete(id);
}, 3000);

server.listen(CONFIG.port, () => {
  console.log(`LunaVS запущен. Открой в браузере телефона: http://localhost:${CONFIG.port}`);
  console.log(`В Minecraft набери: /connect localhost:${CONFIG.port}`);
  console.log(`API: http://localhost:${CONFIG.port}/api/info`);
});
