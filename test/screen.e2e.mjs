// End-to-end test of the shared screen (picture + sound) between three real browsers:
//   node test/screen.e2e.mjs        (needs: npm i -D playwright && npx playwright install chromium)
//
// It starts the real server, opens three Chromium pages that use the real public/net.js, and checks that
//  - a share (a moving canvas + a tone, the same shape as the Amiga stream) arrives as real, changing frames and sound,
//  - voice keeps working while a share is on,
//  - a person without a microphone can still share and watch (fixed line order),
//  - stopping, leaving and late joining all behave.
// It is not part of `npm test` because it needs a browser; it skips itself cleanly when none is installed.
import assert from 'node:assert/strict';
import { needPlaywright, startServer, until, counter, BROWSER_ARGS, startFakeScreen, measureReceived, newPage } from './e2e-helpers.mjs';

const chromium = needPlaywright();
const { server, base: BASE } = await startServer();
const { ok } = counter();
let browser;
let passed = 0;
try {
  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });

  const A = await newPage(browser, BASE, { name: 'Ann', mic: true });
  const B = await newPage(browser, BASE, { name: 'Bo', room: A.room, mic: true });
  const C = await newPage(browser, BASE, { name: 'Cy', room: A.room, mic: false }); // no microphone on purpose
  const everyoneConnected = (p, n) => p.page.evaluate((n) => [...window.net.peers.values()].filter((x) => x.pc.connectionState === 'connected').length === n, n);
  for (const p of [A, B, C]) await until(() => everyoneConnected(p, 2), `${p.name} connected to both others`);
  ok('three browsers connected in a full mesh');

  // ---- A shares (picture + sound)
  await A.page.evaluate(startFakeScreen, true);
  for (const p of [B, C]) {
    const ev = await until(() => p.page.evaluate(() => window.ev.find((e) => e.t === 'screen')), `${p.name} sees the share`);
    assert.equal(ev.id, A.you);
    assert.equal(ev.v, 1);
    assert.equal(ev.a, 1);
    assert.equal(ev.kind, 'emulator');
  }
  ok('both others are told about the share, with picture and sound lines');

  for (const p of [B, C]) {
    const m = await p.page.evaluate(measureReceived);
    assert.ok(m.width >= 320, `${p.name}: frame width ${m.width}`);
    assert.ok(m.frames >= 15, `${p.name}: only ${m.frames} frames in 2 s`);
    assert.ok(m.distinctColours >= 4, `${p.name}: picture is not changing (${m.distinctColours} colours)`);
    assert.ok(m.audioLevel > 0.01, `${p.name}: shared sound is silent (${m.audioLevel})`);
    console.log(`      ${p.name}: ${m.width}x${m.height}, ${m.frames} frames/2s, ${m.distinctColours} colours, audio ${m.audioLevel.toFixed(3)}`);
  }
  ok('the picture really moves and the sound really plays on both receivers');

  // voice must be unaffected: everybody with a mic still reaches everyone
  assert.ok(await B.page.evaluate((id) => window.micIn.has(id), A.you), 'B hears A');
  assert.ok(await C.page.evaluate((id) => window.micIn.has(id), A.you), 'C hears A');
  assert.ok(await A.page.evaluate((id) => window.micIn.has(id), B.you), 'A hears B');
  assert.ok(!(await A.page.evaluate((id) => window.ev.some((e) => e.t === 'screen' && e.id === id), A.you)), 'no echo of own share');
  ok('voice lines are untouched by the share (and nobody receives their own share)');

  // the sender's encoder budget was applied
  const enc = await A.page.evaluate(() => {
    const out = [];
    for (const p of window.net.peers.values()) {
      const params = p.ssender.getParameters();
      out.push({ bitrate: params.encodings[0].maxBitrate, fps: params.encodings[0].maxFramerate, degr: params.degradationPreference, hint: window.fakeStream.getVideoTracks()[0].contentHint });
    }
    return out;
  });
  for (const e of enc) {
    assert.equal(e.bitrate, 2000000);
    assert.equal(e.fps, 50);
    assert.equal(e.degr, 'maintain-resolution');
    assert.equal(e.hint, 'detail');
  }
  ok('emulator share gets its own bitrate/fps budget and keeps sharp pixels');

  // ---- stop
  await A.page.evaluate(() => {
    clearInterval(window.fakeTimer);
    for (const t of window.fakeStream.getTracks()) t.stop();
    window.net.stopScreen();
  });
  for (const p of [B, C]) await until(() => p.page.evaluate((id) => window.ev.some((e) => e.t === 'end' && e.id === id), A.you), `${p.name} sees the share end`);
  ok('stopping the share is seen by everyone');

  // ---- the person with no microphone shares (line order must still line up)
  await B.page.evaluate(() => (window.ev.length = 0));
  await A.page.evaluate(() => (window.ev.length = 0));
  await C.page.evaluate(startFakeScreen, false);
  for (const p of [A, B]) {
    const ev = await until(() => p.page.evaluate(() => window.ev.find((e) => e.t === 'screen')), `${p.name} sees C's share`);
    assert.equal(ev.id, C.you);
    assert.equal(ev.v, 1);
    assert.equal(ev.a, 0, 'no audio line announced for a silent share');
    const m = await p.page.evaluate(measureReceived);
    assert.ok(m.frames >= 15 && m.distinctColours >= 4, `${p.name}: C's picture is not moving`);
  }
  ok('someone with no microphone can share; others watch it (line order is fixed)');
  assert.ok(await A.page.evaluate((id) => window.micIn.has(id), B.you), 'A still hears B');
  await C.page.evaluate(() => {
    clearInterval(window.fakeTimer);
    for (const t of window.fakeStream.getTracks()) t.stop();
    window.net.stopScreen();
  });
  for (const p of [A, B]) await until(() => p.page.evaluate((id) => window.ev.some((e) => e.t === 'end' && e.id === id), C.you), `${p.name} sees C's share end`);

  // ---- a late joiner sees a share that is already running
  await A.page.evaluate(startFakeScreen, true);
  for (const p of [B, C]) await until(() => p.page.evaluate(() => window.ev.some((e) => e.t === 'screen')), `${p.name} sees A's second share`);
  await C.page.close();
  await until(() => B.page.evaluate(() => window.net.peers.size === 1), 'C gone from B');
  const C2 = await newPage(browser, BASE, { name: 'Cy2', room: A.room, mic: true });
  const late = await until(() => C2.page.evaluate(() => window.ev.find((e) => e.t === 'screen')), 'late joiner sees the running share');
  assert.equal(late.id, A.you);
  const m2 = await C2.page.evaluate(measureReceived);
  assert.ok(m2.frames >= 15 && m2.audioLevel > 0.01, 'late joiner gets real picture and sound');
  ok('a late joiner sees and hears a share that was already running');

  // ---- the sharer leaves: everyone is told
  await A.page.close();
  for (const p of [B, C2]) await until(() => p.page.evaluate((id) => window.ev.some((e) => e.t === 'end' && e.id === id), A.you), `${p.name} sees the sharer leave`);
  ok('when the sharer leaves, the share ends for everyone');

  console.log('\nscreen checks passed');
} catch (e) {
  console.error('\nFAILED:', e.stack || e);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  server.kill();
}
