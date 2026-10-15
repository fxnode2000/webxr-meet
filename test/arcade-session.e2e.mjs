// Three-player arcade test: a host running a stand-in EmulatorJS and two guests, in three real browsers.
//   node test/arcade-session.e2e.mjs      (needs playwright, see screen.e2e.mjs)
// The real ArcadeHost, ArcadeSession and network run; only EmulatorJS itself is replaced by test/fixtures/fake-ejs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { needPlaywright, startServer, until, counter, BROWSER_ARGS, newPage, measureReceived, root } from './e2e-helpers.mjs';

const chromium = needPlaywright();
const { server, base: BASE } = await startServer(19900);
const { ok } = counter();
const fixtureDir = path.join(root, 'test', 'fixtures', 'fake-ejs');
const fixture = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname.replace(/^\/(src\/)?/, '');
  const h = { 'Access-Control-Allow-Origin': '*' };
  const file = path.join(fixtureDir, p);
  if (!p || p.includes('..') || !fs.existsSync(file)) return res.writeHead(404, h).end();
  res.writeHead(200, { ...h, 'Content-Type': p.endsWith('.css') ? 'text/css' : 'text/javascript' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const FIX = `http://127.0.0.1:${fixture.address().port}/`;

const zip = (n = 2000) => {
  const b = new Uint8Array(n);
  b[0] = 0x50;
  b[1] = 0x4b;
  return b;
};

let browser;
try {
  browser = await chromium.launch({ args: BROWSER_ARGS });
  const A = await newPage(browser, BASE, { name: 'Host', mic: true });
  const B = await newPage(browser, BASE, { name: 'Bo', room: A.room, mic: true });
  const C = await newPage(browser, BASE, { name: 'Cy', room: A.room, mic: true });
  for (const p of [A, B, C]) await until(() => p.page.evaluate(() => window.net.peers.size === 2 && [...window.net.peers.values()].every((x) => x.pc.connectionState === 'connected')), `${p.name} connected`);

  await A.page.evaluate(async (FIX) => {
    const { ArcadeSession } = await import('/emu/arcade-session.js');
    const { ArcadeHost } = await import('/emu/arcade-host.js');
    window.bubbled = [];
    window.addEventListener('keydown', (e) => window.bubbled.push(e.code));
    window.localStreams = [];
    window.sess = new ArcadeSession({
      net: window.net,
      onChange() {},
      banner: (t) => (window.lastBanner = t),
      onLocalStream: (s) => window.localStreams.push(s),
      onLocalEnd() {},
      getXrSources: () => [],
      setSteering() {},
      hostId: () => null,
      createHost: (o) => new ArcadeHost({ ...o, base: FIX }),
    });
  }, FIX);

  // ---- bad files are refused with a readable message and nothing is left running
  const tryStart = (name, bytes, core = 'mame2003_plus') =>
    A.page.evaluate(
      async ({ name, bytes, core }) => {
        try {
          await window.sess.startHost({ core, rom: new File([new Uint8Array(bytes)], name) });
          return 'started';
        } catch (e) {
          return e.message;
        }
      },
      { name, bytes: Array.from(bytes), core },
    );
  assert.match(await tryStart('notazip.zip', new Uint8Array(100)), /does not look like an arcade game/);
  assert.match(await tryStart('pacman.rom', zip()), /\.zip/);
  assert.match(await tryStart('bad.zip', zip()), /failed to start/i);
  assert.equal(await A.page.evaluate(() => !!window.sess.host), false, 'no half-started host left behind');
  assert.equal(await A.page.evaluate(() => document.querySelectorAll('[id^=arcade-host-]').length), 0, 'its page is removed');
  ok('a non-game, a wrong extension and a game that fails to start give clear errors and leave nothing behind');

  // ---- a real start
  assert.equal(await tryStart('pacman.zip', zip()), 'started');
  const cfg = await A.page.evaluate(() => ({ g: window.__ejs.config.gameName, sys: window.__ejs.config.system, db: window.__ejs.config.disableDatabases, ls: window.__ejs.config.disableLocalStorage, keys: JSON.stringify(window.__ejs.controls) }));
  assert.equal(cfg.g, 'pacman.zip');
  assert.equal(cfg.sys, 'mame2003_plus');
  assert.equal(cfg.db && cfg.ls, true, 'nothing is written to the browser');
  assert.equal(cfg.keys, '{"0":{},"1":{},"2":{},"3":{}}', "EmulatorJS's own keys are cleared");
  const local = await A.page.evaluate(() => ({ v: window.localStreams[0].getVideoTracks().length, a: window.localStreams[0].getAudioTracks().length }));
  assert.deepEqual(local, { v: 1, a: 1 }, 'the host gets a picture and the game sound as one stream');
  ok('the game starts: picture and sound are captured, EmulatorJS keys are cleared, nothing is stored');

  // ---- guests see it as an arcade machine, with real moving video and sound
  for (const g of [B, C]) {
    await g.page.evaluate(async (hostId) => {
      const { ArcadeSession } = await import('/emu/arcade-session.js');
      window.pad = null;
      window.sess = new ArcadeSession({
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
    await until(() => g.page.evaluate(() => window.ev.some((e) => e.t === 'screen' && e.kind === 'emulator' && e.emu === 'arcade')), `${g.name} sees the arcade machine`);
  }
  const m = await B.page.evaluate(measureReceived);
  assert.ok(m.frames > 5 && m.distinctColours > 2 && m.audioLevel > 0.01, `moving picture arrived (${JSON.stringify(m)})`);
  assert.ok(await B.page.evaluate(() => window.lastScreen.getAudioTracks().length === 1), 'the sound arrived');
  ok('both guests see it announced as the arcade machine; the picture moves and the sound comes with it');


  const padWith = (btns, axes = [0, 0]) => `window.pad = { connected: true, axes: ${JSON.stringify(axes)}, buttons: Array.from({length:17},(_, i)=>({pressed: ${JSON.stringify(btns)}.includes(i)})) }`;
  const inputs = () => A.page.evaluate(() => window.__ejs.inputs.slice());

  // ---- guests join: players 2 and 3
  await B.page.evaluate(() => window.sess.join(true));
  await until(() => B.page.evaluate(() => window.sess.port === 2), 'Bo is player 2');
  await C.page.evaluate(() => window.sess.join(true));
  await until(() => C.page.evaluate(() => window.sess.port === 3), 'Cy is player 3');
  ok('guests ask to play and become players 2 and 3');

  // ---- their controls reach the right player with the right libretro button
  await B.page.evaluate(padWith([15, 0, 9])); // right, button 1, start
  await C.page.evaluate(padWith([14, 8])); // left, coin
  await until(async () => { const i = await inputs(); return i.some((x) => x.join() === '1,7,1') && i.some((x) => x.join() === '1,0,1') && i.some((x) => x.join() === '1,3,1'); }, 'Bo (player 2) right + button 1 + start');
  await until(async () => { const i = await inputs(); return i.some((x) => x.join() === '2,6,1') && i.some((x) => x.join() === '2,2,1'); }, 'Cy (player 3) left + coin');
  await B.page.evaluate(padWith([]));
  await until(async () => (await inputs()).some((x) => x.join() === '1,7,0'), 'Bo lets go');
  ok('Bo drives player 2 and Cy player 3: stick, button 1, Start and Coin land on the right libretro inputs, releases too');

  // ---- host keyboard is player 1 and never reaches the avatar
  await A.page.evaluate(() => window.sess.setPlayMode(true));
  await A.page.keyboard.down('KeyZ');
  await A.page.keyboard.down('Digit5');
  await A.page.keyboard.up('Digit5');
  await A.page.keyboard.up('KeyZ');
  const hostIn = (await inputs()).filter((x) => x[0] === 0).map((x) => x.join());
  assert.deepEqual(hostIn, ['0,0,1', '0,2,1', '0,2,0', '0,0,0'], 'Z = button 1, 5 = coin, in order, then released');
  assert.equal((await A.page.evaluate(() => window.bubbled)).filter((c) => c === 'KeyZ').length, 0, 'the avatar does not walk while the host plays');
  ok('the host plays player 1 on the keyboard at the same time and the avatar stays put');

  // a held key is let go when play mode ends
  await A.page.keyboard.down('ArrowLeft');
  await A.page.keyboard.press('F8');
  assert.deepEqual((await inputs()).filter((x) => x[0] === 0 && x[1] === 6).at(-1), [0, 6, 0]);
  await A.page.keyboard.up('ArrowLeft');
  ok('F8 leaves play mode and lets go of everything held');

  // ---- a guest that goes quiet is released
  await C.page.evaluate(padWith([14]));
  await until(async () => (await inputs()).filter((x) => x[0] === 2 && x[1] === 6).at(-1)?.[2] === 1, 'Cy holds left');
  await C.page.evaluate(() => clearInterval(window.sess._timer));
  await until(async () => (await inputs()).filter((x) => x[0] === 2 && x[1] === 6).at(-1)?.[2] === 0, 'quiet guest released', 6000);
  ok('a guest who goes silent is released after a moment');

  // ---- one emulator at a time
  await A.page.evaluate(() => (window.firstEjs = window.__ejs));
  await tryStart('again.zip', zip());
  assert.equal(await A.page.evaluate(() => window.firstEjs === window.__ejs), true, 'a second start while running is ignored');

  // ---- stop: guests are told, everything is freed
  await A.page.evaluate(() => window.sess.stopHost());
  await until(() => B.page.evaluate(() => window.ev.some((e) => e.t === 'end')), 'guests see the end');
  const after = await A.page.evaluate(() => ({ paused: window.__ejs?.paused, roots: document.querySelectorAll('[id^=arcade-host-]').length, state: window.sess.state, ended: window.localStreams[0].getTracks().every((t) => t.readyState === 'ended') }));
  assert.deepEqual(after, { paused: true, roots: 0, state: 'idle', ended: true });
  ok('stopping ends the share for everyone, pauses the game, and removes its page and tracks');

  console.log('\narcade session checks passed');
} catch (e) {
  console.error('\nFAILED:', e.stack || e);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  fixture.close();
  server.kill();
}
