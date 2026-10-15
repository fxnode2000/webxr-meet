// Tests the "headset taken off, comes back" behaviour of the server: node test/rejoin.test.js
//  - a frozen socket is dropped only after several missed pings, and the others see them leave
//  - an emptied room stays open for a grace period, so people can come straight back, then closes
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18600 + Math.floor(Math.random() * 300);
const server = spawn(process.execPath, ['server.js', '--http'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), HEARTBEAT_MS: '200', HEARTBEAT_MISSES: '3', ROOM_GRACE_MS: '1500' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start')), 8000);
  server.stdout.on('data', (d) => d.toString().includes('listening') && (clearTimeout(t), resolve()));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = async (room) => (await (await fetch(`http://127.0.0.1:${PORT}/api/room/${room}`)).json()).exists;

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
  return {
    ws,
    open: new Promise((r) => ws.on('open', r)),
    send: (o) => ws.send(JSON.stringify(o)),
    next: (type, ms = 3000) =>
      new Promise((resolve, reject) => {
        const i = queue.findIndex((m) => m.type === type);
        if (i >= 0) return resolve(queue.splice(i, 1)[0]);
        const t = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), ms);
        waiters.push({ type, resolve: (m) => (clearTimeout(t), resolve(m)) });
      }),
  };
}
const ok = (m) => console.log(`  ok  ${m}`);

try {
  // --- a frozen socket is dropped after a few missed pings, a live one is not
  const a = client();
  await a.open;
  a.send({ type: 'create', name: 'Ann', pin: null });
  const created = await a.next('joined');
  const room = created.room;
  const b = client();
  await b.open;
  b.send({ type: 'join', room, name: 'Ben' });
  await b.next('joined');
  await a.next('peer-joined');

  await sleep(700); // several heartbeat ticks: both are answering pings, nobody is dropped
  assert.equal(await exists(room), true);
  assert.equal(a.ws.readyState, WebSocket.OPEN);
  ok('answering sockets are kept');

  b.ws._socket.pause(); // the page is frozen: pings are never read, so never answered
  const left = await a.next('peer-left', 4000);
  assert.ok(left.id);
  ok('frozen socket is dropped after missed pings, other person sees them leave');

  // --- rejoin the same room as the same person
  const b2 = client();
  await b2.open;
  b2.send({ type: 'join', room, name: 'Ben' });
  const rj = await b2.next('joined');
  assert.equal(rj.room, room);
  assert.equal(rj.peers.length, 1);
  assert.equal((await a.next('peer-joined')).peer.name, 'Ben');
  ok('dropped person can join the same room again');

  // --- everyone drops: room stays open for the grace period, then closes
  a.ws.close();
  b2.ws.close();
  await sleep(500);
  assert.equal(await exists(room), true);
  ok('emptied room stays open during the grace period');

  const c = client();
  await c.open;
  c.send({ type: 'join', room, name: 'Cat' });
  const cj = await c.next('joined');
  assert.equal(cj.peers.length, 0);
  ok('someone can still come back to an emptied room');

  c.ws.close();
  await sleep(2200); // grace 1.5 s + a heartbeat tick
  assert.equal(await exists(room), false);
  ok('room closes once the grace period is over');

  console.log('\n6 rejoin checks passed');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  server.kill();
}
