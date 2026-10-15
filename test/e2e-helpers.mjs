// Shared plumbing for the browser tests (they need playwright; `npm test` does not).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** Returns chromium, or exits 0 with a note when playwright is not installed. */
export function needPlaywright() {
  try {
    return require('playwright').chromium;
  } catch {}
  try {
    return require(path.join(process.env.PLAYWRIGHT_NODE_PATH || '/opt/npm-tools/node_modules', 'playwright')).chromium;
  } catch {
    console.log('skipped: playwright is not installed (npm i -D playwright && npx playwright install chromium)');
    process.exit(0);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

export async function startServer(portBase = 19080) {
  const PORT = portBase + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, ['server.js', '--http'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    server.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  return { server, base: `http://127.0.0.1:${PORT}` };
}

export const BROWSER_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'];

export function counter() {
  let passed = 0;
  return {
    ok(name) {
      passed++;
      console.log(`  ok  ${name}`);
    },
    get passed() {
      return passed;
    },
  };
}

// ---- code that runs inside each page
export async function boot({ name, room, mic }) {
  const { Net } = await import('/net.js');
  const net = (window.net = new Net());
  window.ev = [];
  window.micIn = new Set();
  net.on('screen', (id, stream, kind, info) => window.ev.push({ t: 'screen', id, v: stream.getVideoTracks().length, a: stream.getAudioTracks().length, kind: info?.kind, emu: info?.emu }));
  net.on('screen-end', (id) => window.ev.push({ t: 'end', id }));
  net.on('stream', (id) => window.micIn.add(id));
  net.on('screen', (id, stream) => (window.lastScreen = stream));
  if (mic) net.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  await net.loadIce();
  await net.connect();
  const joined = await net.enter(room ? { type: 'join', room, name } : { type: 'create', name, pin: null });
  return { room: joined.room, you: joined.you.id };
}

export function startFakeScreen(withAudio) {
  const cv = document.createElement('canvas');
  cv.width = 640;
  cv.height = 480;
  const g = cv.getContext('2d');
  let n = 0;
  window.fakeTimer = setInterval(() => {
    n++;
    g.fillStyle = `hsl(${(n * 9) % 360},80%,50%)`;
    g.fillRect(0, 0, 640, 480);
    g.fillStyle = '#fff';
    g.fillRect((n * 7) % 600, 200, 40, 40);
  }, 20);
  const stream = cv.captureStream(50);
  if (withAudio) {
    const ac = (window.fakeAc = new AudioContext());
    const osc = ac.createOscillator();
    osc.frequency.value = 440;
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    ac.resume();
    for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
  }
  window.fakeStream = stream;
  window.net.startScreen(stream, { kind: 'emulator' });
}

export async function measureReceived() {
  // Is the screen that arrived real, moving video and real sound?
  const stream = window.lastScreen;
  const vid = document.createElement('video');
  vid.muted = true;
  vid.playsInline = true;
  vid.srcObject = stream;
  document.body.appendChild(vid);
  await vid.play().catch(() => {});
  let frames = 0;
  const cb = () => {
    frames++;
    vid.requestVideoFrameCallback(cb);
  };
  vid.requestVideoFrameCallback(cb);
  const cv = document.createElement('canvas');
  cv.width = 32;
  cv.height = 24;
  const g = cv.getContext('2d');
  const samples = new Set();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (vid.videoWidth) {
      g.drawImage(vid, 0, 0, 32, 24);
      const d = g.getImageData(1, 1, 1, 1).data;
      samples.add(`${d[0] >> 4},${d[1] >> 4},${d[2] >> 4}`);
    }
  }
  let level = 0;
  if (stream.getAudioTracks().length) {
    const ac = new AudioContext();
    await ac.resume();
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    el.play().catch(() => {});
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 100));
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const x of buf) s += x * x;
      level = Math.max(level, Math.sqrt(s / buf.length));
    }
    await ac.close();
  }
  vid.remove();
  return { width: vid.videoWidth, height: vid.videoHeight, frames, distinctColours: samples.size, audioLevel: level };
}

export async function newPage(browser, BASE, opts) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('  [page error]', opts.name, e.message));
  await page.goto(`${BASE}/api/ice`); // same origin, no app UI to get in the way
  const info = await page.evaluate(boot, opts);
  return { page, ...info, name: opts.name };
}

