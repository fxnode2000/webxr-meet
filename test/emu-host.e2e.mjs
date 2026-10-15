// Browser test of the Amiga host (public/emu/emu-host.js) feeding the room's shared screen:
//   node test/emu-host.e2e.mjs      (needs playwright, see screen.e2e.mjs)
//
// The real emu-host.js, the real net.js and Copperline's real audio worklet run in real Chromium pages. Only the
// WebAssembly emulator is replaced by test/fixtures/fake-copperline.js (same WebEmu API, moving picture + tone).
// The real bundle gets its own check: npm run emu:check.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { needPlaywright, startServer, until, sleep, counter, BROWSER_ARGS, measureReceived, newPage, root } from './e2e-helpers.mjs';

const chromium = needPlaywright();
const { server, base: BASE } = await startServer(19600);
const { ok } = counter();
let browser;

const fx = (f) => fs.readFileSync(path.join(root, 'test', 'fixtures', f));

// The stand-in bundle is served by a tiny second server (with CORS), because Playwright cannot intercept audio
// worklet module loads. AmigaHost takes the bundle location as an option, so the production code path is unchanged.
import http from 'node:http';
const fixtureServers = [];
async function fixtureBase({ missing = false } = {}) {
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname.replace(/^\//, '');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const send = (status, type, body) => (res.writeHead(status, { ...cors, 'Content-Type': type }), res.end(body));
    if (missing) return send(404, 'text/plain', 'nope');
    if (p === 'pkg/copperline_web.js') return send(200, 'text/javascript', fx('fake-copperline.js'));
    if (p === 'audio-worklet.js') return send(200, 'text/javascript', fx('copperline-audio-worklet.js'));
    if (p.startsWith('aros/')) return send(200, 'application/octet-stream', Buffer.alloc(512 * 1024, 1));
    return send(404, 'text/plain', 'unexpected ' + p);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  fixtureServers.push(srv);
  return `http://127.0.0.1:${srv.address().port}/`;
}

const ADF = 901120;
async function startHost(page, { disk = ADF, missing = false } = {}) {
  const base = await fixtureBase({ missing });
  return page.evaluate(
    async ({ disk, base }) => {
      const { AmigaHost } = await import('/emu/emu-host.js');
      window.stateLog = [];
      window.statLog = [];
      const host = (window.host = new AmigaHost(
        { base, onState: (s, e) => window.stateLog.push([s, e]), onStats: (s) => window.statLog.push(s) },
        { isHidden: () => !!window.__hidden },
      ));
      try {
        const stream = await host.start({ model: 'A500', disk: disk ? { bytes: new Uint8Array(disk), name: 'demo.adf' } : null });
        window.net?.startScreen(stream, { kind: 'emulator' });
        return { ok: true, v: stream.getVideoTracks().length, a: stream.getAudioTracks().length };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    },
    { disk, base },
  );
}

try {
  browser = await chromium.launch({ args: BROWSER_ARGS });

  const A = await newPage(browser, BASE, { name: 'Host', mic: true });
  const B = await newPage(browser, BASE, { name: 'Bo', room: A.room, mic: true });
  const pageErrors = [];
  A.page.on('pageerror', (e) => pageErrors.push(e.message));
  for (const p of [A, B]) await until(() => p.page.evaluate(() => [...window.net.peers.values()].every((x) => x.pc.connectionState === 'connected') && window.net.peers.size === 1), 'connected');

  // ---- start and stream
  const r = await startHost(A.page);
  assert.deepEqual(r, { ok: true, v: 1, a: 1 });
  const log = await A.page.evaluate(() => window.__fake);
  assert.equal(log.model, 'A500');
  assert.equal(log.rom.main, 512 * 1024);
  assert.equal(log.disks[0].label, 'demo.adf');
  assert.equal(await A.page.evaluate(() => window.host.state), 'running');
  ok('starts with the bundled ROM and a disk, and gives one picture track and one sound track');

  const ev = await until(() => B.page.evaluate(() => window.ev.find((e) => e.t === 'screen')), 'B sees the Amiga');
  assert.equal(ev.kind, 'emulator');
  const m = await B.page.evaluate(measureReceived);
  assert.equal(m.width, 800, 'fixed output width');
  assert.equal(m.height, 600, 'fixed output height');
  assert.ok(m.frames >= 15, `only ${m.frames} frames`);
  assert.ok(m.distinctColours >= 4, 'picture is not changing');
  assert.ok(m.audioLevel > 0.01, `silent (${m.audioLevel})`);
  console.log(`      viewer: ${m.width}x${m.height}, ${m.frames} frames/2s, audio ${m.audioLevel.toFixed(3)}`);
  ok('another browser sees and hears the Amiga: moving picture at a fixed 800x600, real sound');

  const rate = await until(async () => (await A.page.evaluate(() => window.statLog.at(-1)))?.fps >= 40, 'about 50 emulated frames per second');
  const stat = await A.page.evaluate(() => window.statLog.at(-1));
  assert.ok(stat.fps >= 40 && stat.fps <= 60, `fps ${stat.fps}`);
  assert.ok(stat.queuedMs < 160, `audio queue ${stat.queuedMs} ms`);
  assert.ok(stat.underruns <= 3, `underruns ${stat.underruns}`);
  console.log(`      host: ${stat.fps} fps, step ${stat.stepMs} ms, audio queue ${stat.queuedMs} ms, ${stat.underruns} underruns`);
  ok('runs in real time with a healthy audio queue');

  // ---- input
  const inp = await A.page.evaluate(() => {
    const h = window.host;
    const used = h.key('KeyA', true);
    const unused = h.key('F12', true);
    h.mouseMove(3, -2);
    h.mouseMove(NaN, 1); // ignored
    h.mouseMove(1e9, 0); // clamped
    h.mouseButton(0, true);
    h.mouseButton(7, true); // ignored
    h.setJoystick(2, { left: true, right: true, fire: true }); // impossible stick: left+right cancels
    h.setJoystick(3, { up: true }); // no such port
    const before = JSON.stringify(window.__fake.keys.length);
    h.releaseAll();
    const f = window.__fake;
    return { used, unused, keys: f.keys, mouse: f.mouse, joy: f.joy, before };
  });
  assert.equal(inp.used, true);
  assert.equal(inp.unused, false);
  assert.deepEqual(inp.mouse.slice(0, 2), [['move', 3, -2], ['move', 500, 0]]);
  assert.ok(!inp.mouse.some((x) => x[0] === 'button' && x[1] === 7));
  assert.deepEqual(inp.joy[0], [2, false, false, false, false, true, false]);
  assert.ok(inp.keys.some((k) => k[0] === 'KeyA' && k[1] === false), 'KeyA was released');
  assert.ok(inp.keys.some((k) => k[0] === 'F12' && k[1] === false), 'F12 was released');
  assert.ok(inp.mouse.some((x) => x[0] === 'button' && x[1] === 0 && x[2] === false), 'mouse button released');
  const last2 = inp.joy.slice(-2);
  assert.deepEqual(last2.map((j) => j[0]).sort(), [1, 2]);
  assert.ok(last2.every((j) => j.slice(1).every((v) => v === false)), 'both sticks centred');
  ok('input is clamped and validated, impossible joystick states are cancelled, releaseAll lets go of everything');

  // ---- a still Amiga screen must still reach someone who joins later
  await A.page.evaluate(() => (window.__fake.still = true));
  await sleep(600);
  const C = await newPage(browser, BASE, { name: 'Cy', room: A.room, mic: true });
  await until(() => C.page.evaluate(() => window.ev.some((e) => e.t === 'screen')), 'late joiner told about the Amiga');
  const m2 = await C.page.evaluate(measureReceived);
  assert.ok(m2.width === 800 && m2.frames >= 3, `late joiner got ${m2.frames} frames of a still screen`);
  ok('someone joining while the Amiga screen is perfectly still still gets a picture');
  await A.page.evaluate(() => (window.__fake.still = false));

  // ---- host tab hidden: the audio clock keeps the machine going when animation frames stop
  const hid = await A.page.evaluate(async () => {
    const realRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0; // the browser stops sending animation frames to a hidden tab...
    window.__hidden = true; // ...at the same moment the page reports itself hidden
    await new Promise((r) => setTimeout(r, 100));
    const f0 = window.__fake.frames;
    await new Promise((r) => setTimeout(r, 2000));
    const f1 = window.__fake.frames;
    return { frames: f1 - f0, realRaf: String(realRaf).length > 0 };
  });
  assert.ok(hid.frames >= 60, `only ${hid.frames} frames in 2 s while hidden`);
  console.log(`      hidden: ${hid.frames} frames in 2 s`);
  ok('a hidden host tab keeps emulating from the audio clock');

  // ...and the nasty case: the machine is left unstepped long enough for the audio queue to run dry, which
  // silences the worklet's clock. The watchdog must restart it.
  const stalled = await A.page.evaluate(async () => {
    window.__hidden = false;
    await new Promise((r) => setTimeout(r, 400));
    window.__hidden = true; // nobody steps the machine for 400 ms now (rAF is already dead): the queue runs dry
    await new Promise((r) => setTimeout(r, 1500));
    const f0 = window.__fake.frames;
    await new Promise((r) => setTimeout(r, 2000));
    return { frames: window.__fake.frames - f0, dog: window.statLog.at(-1)?.watchdogSteps };
  });
  assert.ok(stalled.frames >= 60, `machine stayed frozen after a stall (${stalled.frames} frames in 2 s)`);
  assert.ok(stalled.dog >= 1, 'the watchdog had to step it');
  console.log(`      after a stall: ${stalled.frames} frames in 2 s, watchdog stepped ${stalled.dog}x`);
  ok('after a stall while hidden, a watchdog restarts the clock instead of freezing the machine');
  await A.page.evaluate(() => (window.__hidden = false));

  // ---- crash handling: the room must never see an exception
  const crash = await A.page.evaluate(async () => {
    const tracks = window.host.stream.getTracks();
    window.__fake.crash = true;
    // Nothing animates in this test page, so only the stall watchdog steps the machine (after 500 ms of quiet, then every 200 ms).
    for (let i = 0; i < 60 && window.host.state !== 'error'; i++) await new Promise((r) => setTimeout(r, 100));
    return { state: window.host.state, err: window.host.error, ended: tracks.every((t) => t.readyState === 'ended'), freed: window.__fake.freed };
  });
  assert.equal(crash.state, 'error');
  assert.match(crash.err, /The emulator stopped/);
  assert.ok(crash.ended, 'picture and sound tracks were stopped');
  assert.equal(crash.freed, 1, 'the machine was freed');
  ok('an emulator crash becomes a readable error, stops the streams and frees the machine');

  // ---- bad inputs
  const A2 = await newPage(browser, BASE, { name: 'Host2', mic: true });
  const bad = await startHost(A2.page, { disk: 1234 });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /not accepted/);
  ok('a file that is not a disk image is refused with a plain message');

  const A3 = await newPage(browser, BASE, { name: 'Host3', mic: true });
  const miss = await startHost(A3.page, { missing: true });
  assert.equal(miss.ok, false);
  assert.match(miss.message, /emulator files could not be loaded/);
  assert.equal(await A3.page.evaluate(() => window.host.state), 'error');
  ok('a missing emulator build gives a clear message instead of a blank screen');

  // ---- stop
  const A4 = await newPage(browser, BASE, { name: 'Host4', mic: true });
  await startHost(A4.page);
  const stopped = await A4.page.evaluate(async () => {
    const tracks = window.host.stream.getTracks();
    window.host.stop();
    await new Promise((r) => setTimeout(r, 200));
    const frames = window.__fake.frames;
    await new Promise((r) => setTimeout(r, 300));
    return { state: window.host.state, ended: tracks.every((t) => t.readyState === 'ended'), still: window.__fake.frames === frames, freed: window.__fake.freed };
  });
  assert.deepEqual(stopped, { state: 'stopped', ended: true, still: true, freed: 1 });
  ok('stop ends the streams, halts the machine and frees it');

  assert.deepEqual(pageErrors, [], 'no uncaught exceptions reached the page');
  ok('no uncaught exceptions anywhere in the host page');
  console.log('\nAmiga host checks passed');
} catch (e) {
  console.error('\nFAILED:', e.stack || e);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  for (const f of fixtureServers) f.close();
  server.kill();
}
