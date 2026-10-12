// Smoke test for the signalling server: node test/signalling.test.js
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18080 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['server.js', '--http'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start')), 8000);
  server.stdout.on('data', (d) => {
    if (d.toString().includes('listening')) {
      clearTimeout(t);
      resolve();
    }
  });
});

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else queue.push(m);
  });
  const c = {
    ws,
    open: new Promise((r) => ws.on('open', r)),
    send: (o) => ws.send(JSON.stringify(o)),
    next(type, ms = 2000) {
      const i = queue.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { type, resolve };
        waiters.push(w);
        setTimeout(() => {
          const j = waiters.indexOf(w);
          if (j >= 0) {
            waiters.splice(j, 1);
            reject(new Error(`timeout waiting for ${type}`));
          }
        }, ms);
      });
    },
    async none(type, ms = 250) {
      await new Promise((r) => setTimeout(r, ms));
      assert.equal(queue.some((m) => m.type === type), false, `unexpected ${type}`);
    },
    close: () => ws.close(),
  };
  return c;
}

const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, text: await r.text(), type: r.headers.get('content-type') };
};

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ok  ${name}`);
};

try {
  // --- room without PIN
  const host = client();
  await host.open;
  host.send({ type: 'create', name: '  Andrew  ', pin: null });
  const created = await host.next('joined');
  assert.equal(created.you.name, 'Andrew');
  assert.equal(created.you.slot, 0);
  assert.deepEqual(created.peers, []);
  assert.equal(created.hasPin, false);
  const room = created.room;
  assert.match(room, /^[a-z0-9]{6}$/);
  ok('create room, name trimmed, slot 0');

  const info = JSON.parse((await get(`/api/room/${room}`)).text);
  assert.deepEqual(info, { exists: true, needsPin: false, full: false, hostName: 'Andrew' });
  assert.deepEqual(JSON.parse((await get('/api/room/zzzzzz')).text), { exists: false });
  ok('room info endpoint');

  const b = client();
  await b.open;
  b.send({ type: 'join', room, name: 'Bea' });
  const bj = await b.next('joined');
  assert.equal(bj.you.slot, 1);
  assert.equal(bj.peers.length, 1);
  assert.equal(bj.peers[0].name, 'Andrew');
  const pj = await host.next('peer-joined');
  assert.equal(pj.peer.name, 'Bea');
  ok('second peer joins, host notified');

  host.send({ type: 'state', muted: true });
  await b.next('state');
  ok('mute state relayed');

  const c = client();
  await c.open;
  c.send({ type: 'join', room, name: 'Cal' });
  const cj = await c.next('joined');
  assert.equal(cj.you.slot, 2);
  assert.equal(cj.peers.find((p) => p.name === 'Andrew').muted, true);
  ok('third peer joins, late joiner sees muted state');

  const d = client();
  await d.open;
  d.send({ type: 'join', room, name: 'Dee' });
  assert.equal((await d.next('error')).code, 'full');
  assert.equal(JSON.parse((await get(`/api/room/${room}`)).text).full, true);
  ok('fourth peer rejected (room full)');

  // --- relay
  b.send({ type: 'signal', to: created.you.id, data: { candidate: { x: 1 } } });
  const sig = await host.next('signal');
  assert.equal(sig.from, bj.you.id);
  assert.deepEqual(sig.data, { candidate: { x: 1 } });
  ok('signal relayed with sender id');

  host.send({ type: 'signal', to: 'nope', data: {} });
  await b.none('signal');
  ok('signal to unknown peer ignored');

  const pose = [0, 1.6, 0, 0, 0, 0, 1];
  host.send({ type: 'pose', h: pose, l: pose, r: null });
  const p = await b.next('pose');
  assert.equal(p.from, created.you.id);
  assert.deepEqual(p.h, pose);
  assert.equal(p.r, null);
  host.send({ type: 'pose', h: [1, 2, 3] });
  host.send({ type: 'pose', h: ['a', 1, 1, 1, 1, 1, 1] });
  await b.none('pose');
  ok('pose relayed, malformed poses dropped');

  // --- leaving / slot reuse
  b.close();
  const left = await host.next('peer-left');
  assert.equal(left.id, bj.you.id);
  d.send({ type: 'join', room, name: 'Dee' });
  const dj = await d.next('joined');
  assert.equal(dj.you.slot, 1);
  ok('peer-left broadcast, freed slot reused');

  // --- bad input
  const bad = client();
  await bad.open;
  bad.send({ type: 'create', name: '   ', pin: null });
  assert.equal((await bad.next('error')).code, 'bad-name');
  bad.send({ type: 'create', name: 'X', pin: '12a4' });
  assert.equal((await bad.next('error')).code, 'bad-pin-format');
  bad.send({ type: 'join', room: 'nonexistent', name: 'X' });
  assert.equal((await bad.next('error')).code, 'no-room');
  ok('bad name / PIN format / missing room rejected');

  // --- PIN room
  const ph = client();
  await ph.open;
  ph.send({ type: 'create', name: 'Pia', pin: '4821' });
  const pc = await ph.next('joined');
  assert.equal(pc.hasPin, true);
  const pinfo = JSON.parse((await get(`/api/room/${pc.room}`)).text);
  assert.equal(pinfo.needsPin, true);
  assert.equal(pinfo.hostName, null);
  ok('PIN room hides host name from public info');

  const g = client();
  await g.open;
  g.send({ type: 'join', room: pc.room, name: 'Guest' });
  assert.equal((await g.next('error')).code, 'bad-pin');
  g.send({ type: 'join', room: pc.room, name: 'Guest', pin: '0000' });
  const wrong = await g.next('error');
  assert.equal(wrong.code, 'bad-pin');
  assert.equal(wrong.triesLeft, 3);
  g.send({ type: 'join', room: pc.room, name: 'Guest', pin: '4821' });
  assert.equal((await g.next('joined')).you.name, 'Guest');
  ok('wrong PIN rejected, correct PIN accepted');

  // lockout: new room, five wrong tries, then the right PIN is refused
  const lh = client();
  await lh.open;
  lh.send({ type: 'create', name: 'Lou', pin: '1111' });
  const lc = await lh.next('joined');
  const att = client();
  await att.open;
  let last;
  for (let i = 0; i < 5; i++) {
    att.send({ type: 'join', room: lc.room, name: 'Mallory', pin: '9999' });
    last = await att.next('error');
  }
  assert.equal(last.code, 'locked');
  att.send({ type: 'join', room: lc.room, name: 'Mallory', pin: '1111' });
  assert.equal((await att.next('error')).code, 'locked');
  ok('room locks after 5 wrong PINs, even the right PIN is refused');

  // --- static
  const idx = await get('/');
  assert.equal(idx.status, 200);
  assert.match(idx.type, /text\/html/);
  assert.equal((await get(`/r/${room}`)).status, 200);
  assert.equal((await get('/vendor/three/build/three.module.js')).status, 200);
  assert.equal((await get('/vendor/three/package.json')).status, 404);
  assert.equal((await get('/..%2fserver.js')).status, 404);
  assert.equal((await get('/%2e%2e/%2e%2e/etc/passwd')).status, 404);
  assert.equal((await get('/api/ice')).status, 200);
  ok('static files, SPA route, three vendor path, traversal blocked');

  console.log(`\n${passed} checks passed`);
} catch (err) {
  console.error('\nFAILED:', err);
  process.exitCode = 1;
} finally {
  server.kill();
}
