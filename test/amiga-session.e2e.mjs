// Three-player test: a host running the (stand-in) Amiga and two guests on joysticks, in three real browsers.
//   node test/amiga-session.e2e.mjs      (needs playwright, see screen.e2e.mjs)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { needPlaywright, startServer, until, sleep, counter, BROWSER_ARGS, newPage, root } from './e2e-helpers.mjs';

const chromium = needPlaywright();
const { server, base: BASE } = await startServer(19700);
const { ok } = counter();
const fx = (f) => fs.readFileSync(path.join(root, 'test', 'fixtures', f));
const fixture = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname.replace(/^\//, '');
  const h = { 'Access-Control-Allow-Origin': '*' };
  const send = (type, body) => (res.writeHead(200, { ...h, 'Content-Type': type }), res.end(body));
  if (p === 'pkg/copperline_web.js') return send('text/javascript', fx('fake-copperline.js'));
  if (p === 'audio-worklet.js') return send('text/javascript', fx('copperline-audio-worklet.js'));
  if (p.startsWith('aros/')) return send('application/octet-stream', Buffer.alloc(512 * 1024, 1));
  res.writeHead(404, h).end();
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const FIX = `http://127.0.0.1:${fixture.address().port}/`;

let browser;
try {
  browser = await chromium.launch({ args: BROWSER_ARGS });
  const A = await newPage(browser, BASE, { name: 'Host', mic: true });
  const B = await newPage(browser, BASE, { name: 'Bo', room: A.room, mic: true });
  const C = await newPage(browser, BASE, { name: 'Cy', room: A.room, mic: true });
  for (const p of [A, B, C]) await until(() => p.page.evaluate(() => window.net.peers.size === 2 && [...window.net.peers.values()].every((x) => x.pc.connectionState === 'connected')), `${p.name} connected`);

  // host: the real session + the real AmigaHost with the stand-in emulator
  await A.page.evaluate(async (FIX) => {
    const { AmigaSession } = await import('/emu/amiga-session.js');
    const { AmigaHost } = await import('/emu/emu-host.js');
    window.bubbled = [];
    window.addEventListener('keydown', (e) => window.bubbled.push(e.code)); // stands in for the room's walking keys
    window.sess = new AmigaSession({
      net: window.net,
      onChange() {},
      banner: (t) => (window.lastBanner = t),
      onLocalStream() {},
      onLocalEnd() {},
      getXrSources: () => [],
      setSteering() {},
      hostId: () => null,
      createHost: (o) => new AmigaHost({ ...o, base: FIX }),
    });
    await window.sess.startHost({ model: 'A500', disk: new File([new Uint8Array(901120)], 'demo.adf') });
  }, FIX);

  for (const g of [B, C]) {
    await g.page.evaluate(async (hostId) => {
      const { AmigaSession } = await import('/emu/amiga-session.js');
      window.pad = null;
      window.sess = new AmigaSession({
        net: window.net,
        onChange() {},
        banner: (t) => (window.lastBanner = t),
        onLocalStream() {},
        onLocalEnd() {},
        getXrSources: () => [],
        setSteering() {},
        hostId: () => hostId,
        getGamepads: () => [window.pad],
      });
    }, A.you);
    await until(() => g.page.evaluate(() => window.ev.some((e) => e.t === 'screen' && e.kind === 'emulator')), `${g.name} sees the Amiga`);
  }
  ok('host runs the Amiga; both guests see it');

  const padWith = (btns, axes = [0, 0]) => `window.pad = { connected: true, axes: ${JSON.stringify(axes)}, buttons: Array.from({length:17},(_, i)=>({pressed: ${JSON.stringify(btns)}.includes(i)})) }`;
  const joyNow = (port) => A.page.evaluate((port) => [...window.__fake.joy].reverse().find((j) => j[0] === port) || null, port);

  // ---- guests join and get ports
  await B.page.evaluate(() => window.sess.join(true));
  await until(() => B.page.evaluate(() => window.sess.port === 2), 'Bo gets port 2');
  await C.page.evaluate(() => window.sess.join(true));
  await until(() => C.page.evaluate(() => window.sess.port === 1), 'Cy gets port 1');
  const ports = await A.page.evaluate(() => window.__fake.ports);
  assert.deepEqual(ports.at(-1), [2, 'joystick']);
  assert.ok(ports.some((p) => p[0] === 1 && p[1] === 'joystick'), 'port 1 became a joystick for Cy');
  ok('guests ask to play and are put on port 2 and port 1; the host mouse gives way');

  // ---- both play at once, host plays on the keyboard at the same time
  await B.page.evaluate(padWith([15, 0])); // right + fire
  await C.page.evaluate(padWith([14])); // left
  await until(async () => { const j = await joyNow(2); return j && j[4] && j[5]; }, 'Bo right+fire reaches port 2');
  await until(async () => { const j = await joyNow(1); return j && j[3] && !j[4]; }, 'Cy left reaches port 1');
  await A.page.evaluate(() => window.sess.setPlayMode(true));
  await A.page.keyboard.down('KeyA');
  await A.page.keyboard.up('KeyA');
  const keys = await A.page.evaluate(() => ({ fake: window.__fake.keys.filter((k) => k[0] === 'KeyA'), bubbled: window.bubbled.filter((c) => c === 'KeyA') }));
  assert.deepEqual(keys.fake, [['KeyA', true], ['KeyA', false]], 'host keyboard reaches the Amiga');
  assert.equal(keys.bubbled.length, 0, 'the avatar does not walk while the host plays');
  ok('three people play at once: host keyboard, Bo on port 2, Cy on port 1, and the avatar stays put');

  // ---- play mode off with F8 lets keys through again and lets go of everything
  await A.page.keyboard.down('KeyD');
  await A.page.keyboard.press('F8');
  assert.equal(await A.page.evaluate(() => window.sess.playMode), false);
  const rel = await A.page.evaluate(() => window.__fake.keys.filter((k) => k[0] === 'KeyD'));
  assert.deepEqual(rel.at(-1), ['KeyD', false], 'a key held when play mode ends is released');
  await A.page.keyboard.up('KeyD');
  await A.page.keyboard.press('KeyW');
  assert.ok((await A.page.evaluate(() => window.bubbled)).includes('KeyW'), 'keys go back to the room');
  ok('F8 leaves play mode: nothing stays held, keys return to the room');

  // ---- a guest that goes quiet is let go of (never a stuck button)
  await B.page.evaluate(() => clearInterval(window.sess._timer));
  await until(async () => { const j = await joyNow(2); return j && j.slice(1).every((x) => x === false); }, 'quiet guest released', 6000);
  ok('a guest who goes silent is released after a moment');

  // ---- leaving frees the port; the mouse comes back when port 1 frees
  await C.page.evaluate(() => window.sess.join(false));
  await until(() => A.page.evaluate(() => [...window.__fake.ports].reverse().find((p) => p[0] === 1)?.[1] === 'mouse'), 'mouse back on port 1');
  ok('a guest stops playing: their port is freed and the host mouse returns');

  // ---- host stops: guests are told
  await A.page.evaluate(() => window.sess.stopHost());
  await until(() => B.page.evaluate(() => window.ev.some((e) => e.t === 'end')), 'guests see the end');
  assert.equal(await A.page.evaluate(() => window.sess.state), 'idle');
  assert.equal(await A.page.evaluate(() => window.__fake.freed >= 1), true, 'emulator freed');
  ok('stopping the Amiga ends the share for everyone and frees the emulator');

  console.log('\namiga session checks passed');
} catch (e) {
  console.error('\nFAILED:', e.stack || e);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  fixture.close();
  server.kill();
}
