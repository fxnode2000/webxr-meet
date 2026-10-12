// WebXR Meet - signalling + static file server.
//
// Serves the client, hosts room state, and relays WebRTC signalling and avatar
// poses. Audio never touches this server: it flows peer-to-peer between clients.
//
//   npm start            HTTPS with an auto-generated self-signed cert (needed for Quest on the LAN)
//   npm run start:http   plain HTTP (use behind a tunnel that provides HTTPS, e.g. cloudflared)

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');

const USE_HTTP = process.env.HTTP === '1' || process.argv.includes('--http');
const PORT = Number(process.env.PORT) || (USE_HTTP ? 8080 : 8443);

const MAX_PEERS = 3;
const MAX_ROOMS = 200;
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 2 * 60 * 1000;
const MSG_LIMIT_PER_SEC = 400;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.glb': 'model/gltf-binary',
};

// ---------------------------------------------------------------- rooms

/** @type {Map<string, Room>} */
const rooms = new Map();
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (i, l, o, 0, 1)

function newRoomId() {
  for (;;) {
    let id = '';
    for (let i = 0; i < 6; i++) id += ID_CHARS[crypto.randomInt(ID_CHARS.length)];
    if (!rooms.has(id)) return id;
  }
}

function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24);
  return s.length ? s : null;
}

function freeSlot(room) {
  const used = new Set([...room.peers.values()].map((p) => p.slot));
  for (let i = 0; i < MAX_PEERS; i++) if (!used.has(i)) return i;
  return -1;
}

const peerView = (p) => ({ id: p.id, name: p.name, slot: p.slot, muted: p.muted });

function publicRoomInfo(room) {
  if (!room) return { exists: false };
  return {
    exists: true,
    needsPin: !!room.pin,
    full: room.peers.size >= MAX_PEERS,
    hostName: room.pin ? null : room.hostName,
  };
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptId) {
  const data = JSON.stringify(obj);
  for (const p of room.peers.values()) {
    if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(data);
  }
}

function addPeer(room, ws, name) {
  const peer = {
    id: crypto.randomBytes(4).toString('hex'),
    name,
    slot: freeSlot(room),
    muted: false,
    ws,
  };
  room.peers.set(peer.id, peer);
  ws.peerId = peer.id;
  ws.roomId = room.id;
  return peer;
}

function pinMatches(expected, given) {
  if (typeof given !== 'string' || !/^\d{4}$/.test(given)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

function handleCreate(ws, msg) {
  const name = cleanName(msg.name);
  if (!name) return send(ws, { type: 'error', code: 'bad-name' });
  let pin = null;
  if (msg.pin !== null && msg.pin !== undefined && msg.pin !== '') {
    if (typeof msg.pin !== 'string' || !/^\d{4}$/.test(msg.pin)) {
      return send(ws, { type: 'error', code: 'bad-pin-format' });
    }
    pin = msg.pin;
  }
  if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', code: 'busy' });

  const room = { id: newRoomId(), pin, hostName: name, peers: new Map(), fails: 0, lockedUntil: 0 };
  rooms.set(room.id, room);
  const peer = addPeer(room, ws, name);
  console.log(`[room ${room.id}] created by ${name}${pin ? ' (PIN)' : ''}`);
  send(ws, { type: 'joined', room: room.id, hasPin: !!pin, you: peerView(peer), peers: [] });
}

function handleJoin(ws, msg) {
  const name = cleanName(msg.name);
  if (!name) return send(ws, { type: 'error', code: 'bad-name' });
  const room = typeof msg.room === 'string' ? rooms.get(msg.room.toLowerCase()) : null;
  if (!room) return send(ws, { type: 'error', code: 'no-room' });

  const now = Date.now();
  if (room.pin && room.lockedUntil > now) {
    return send(ws, { type: 'error', code: 'locked', retryIn: Math.ceil((room.lockedUntil - now) / 1000) });
  }
  if (room.peers.size >= MAX_PEERS) return send(ws, { type: 'error', code: 'full' });

  if (room.pin && !pinMatches(room.pin, msg.pin)) {
    room.fails++;
    if (room.fails >= PIN_MAX_FAILS) {
      room.fails = 0;
      room.lockedUntil = now + PIN_LOCK_MS;
      console.log(`[room ${room.id}] locked for ${PIN_LOCK_MS / 1000}s after repeated wrong PINs`);
      return send(ws, { type: 'error', code: 'locked', retryIn: PIN_LOCK_MS / 1000 });
    }
    return send(ws, { type: 'error', code: 'bad-pin', triesLeft: PIN_MAX_FAILS - room.fails });
  }
  room.fails = 0;

  const existing = [...room.peers.values()].map(peerView);
  const peer = addPeer(room, ws, name);
  console.log(`[room ${room.id}] ${name} joined (${room.peers.size}/${MAX_PEERS})`);
  send(ws, { type: 'joined', room: room.id, hasPin: !!room.pin, you: peerView(peer), peers: existing });
  broadcast(room, { type: 'peer-joined', peer: peerView(peer) }, peer.id);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPose = (a) => Array.isArray(a) && a.length === 7 && a.every(isNum);

function handleMessage(ws, msg) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'create' || msg.type === 'join') {
    if (ws.roomId) return send(ws, { type: 'error', code: 'already-in-room' });
    return msg.type === 'create' ? handleCreate(ws, msg) : handleJoin(ws, msg);
  }

  const room = rooms.get(ws.roomId);
  const me = room && room.peers.get(ws.peerId);
  if (!me) return;

  switch (msg.type) {
    case 'signal': {
      const target = room.peers.get(msg.to);
      if (target && target.id !== me.id && msg.data && typeof msg.data === 'object') {
        send(target.ws, { type: 'signal', from: me.id, data: msg.data });
      }
      break;
    }
    case 'pose': {
      if (!isPose(msg.h)) return;
      const out = { type: 'pose', from: me.id, h: msg.h, l: isPose(msg.l) ? msg.l : null, r: isPose(msg.r) ? msg.r : null };
      broadcast(room, out, me.id);
      break;
    }
    case 'state': {
      me.muted = !!msg.muted;
      broadcast(room, { type: 'state', from: me.id, muted: me.muted }, me.id);
      break;
    }
    default:
      break;
  }
}

function leave(ws) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  const peer = room.peers.get(ws.peerId);
  if (!peer) return;
  room.peers.delete(peer.id);
  ws.roomId = null;
  console.log(`[room ${room.id}] ${peer.name} left (${room.peers.size}/${MAX_PEERS})`);
  if (room.peers.size === 0) {
    rooms.delete(room.id);
    console.log(`[room ${room.id}] closed (empty)`);
  } else {
    broadcast(room, { type: 'peer-left', id: peer.id });
  }
}

// ---------------------------------------------------------------- http

function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  }
  return list;
}

function safeJoin(base, rel) {
  if (rel.includes('\0')) return null;
  const p = path.normalize(path.join(base, rel));
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function requestHandler(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  if (pathname === '/api/ice') return json(res, 200, { iceServers: iceServers() });

  if (pathname.startsWith('/api/room/')) {
    const id = pathname.slice('/api/room/'.length).toLowerCase();
    return json(res, 200, publicRoomInfo(rooms.get(id)));
  }

  if (pathname.startsWith('/r/')) return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));

  if (pathname.startsWith('/vendor/three/')) {
    const rel = pathname.slice('/vendor/three/'.length);
    if (!(rel.startsWith('build/') || rel.startsWith('examples/jsm/'))) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const file = safeJoin(THREE_DIR, rel);
    if (!file) {
      res.writeHead(404);
      return res.end('Not found');
    }
    return serveFile(res, file);
  }

  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = safeJoin(PUBLIC_DIR, rel);
  if (!file) {
    res.writeHead(404);
    return res.end('Not found');
  }
  serveFile(res, file);
}

// ---------------------------------------------------------------- tls

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal) out.push(i.address);
    }
  }
  return out;
}

async function loadTlsOptions() {
  const dir = path.join(__dirname, '.certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const metaPath = path.join(dir, 'ips.json');
  const ips = lanAddresses().sort();

  let reuse = false;
  try {
    reuse =
      fs.existsSync(keyPath) &&
      fs.existsSync(certPath) &&
      JSON.stringify(JSON.parse(fs.readFileSync(metaPath, 'utf8'))) === JSON.stringify(ips);
  } catch {
    reuse = false;
  }

  if (!reuse) {
    const { default: selfsigned } = await import('selfsigned');
    const notBeforeDate = new Date();
    const notAfterDate = new Date(notBeforeDate.getTime() + 365 * 24 * 3600 * 1000);
    const altNames = [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
      ...ips.map((ip) => ({ type: 7, ip })),
    ];
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'webxr-meet.local' }], {
      keySize: 2048,
      algorithm: 'sha256',
      notBeforeDate,
      notAfterDate,
      extensions: [{ name: 'subjectAltName', altNames }],
    });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);
    fs.writeFileSync(metaPath, JSON.stringify(ips));
    console.log('Generated a self-signed certificate in .certs/');
  }
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

// ---------------------------------------------------------------- start

const server = USE_HTTP
  ? http.createServer(requestHandler)
  : https.createServer(await loadTlsOptions(), requestHandler);

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomId = null;
  ws.peerId = null;
  let count = 0;
  const reset = setInterval(() => (count = 0), 1000);

  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data) => {
    if (++count > MSG_LIMIT_PER_SEC) return; // flood guard
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    handleMessage(ws, msg);
  });
  ws.on('close', () => {
    clearInterval(reset);
    leave(ws);
  });
  ws.on('error', () => {});
});

// Drop half-dead sockets (e.g. a headset taken off mid-session).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, '0.0.0.0', () => {
  const scheme = USE_HTTP ? 'http' : 'https';
  console.log(`\nWebXR Meet listening (${scheme.toUpperCase()}, port ${PORT})`);
  console.log(`  Desktop:  ${scheme}://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Quest:    ${scheme}://${ip}:${PORT}`);
  if (!USE_HTTP) console.log('  (accept the certificate warning once on each device)');
  console.log('');
});
