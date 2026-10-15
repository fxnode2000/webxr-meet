// Summarise a profiling log:  npm run summary            (newest client log in ./logs)
//                             npm run summary -- logs/client_....jsonl [logs/server_....jsonl]
// Prints where the time went, the worst moments, network quality, and a plain-English verdict.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const args = process.argv.slice(2);

function newest(prefix) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.jsonl')).sort();
  return f.length ? path.join(dir, f[f.length - 1]) : null;
}

const clientFile = args.find((a) => path.basename(a).startsWith('client_')) || (args.length ? args[0] : newest('client_'));
const serverFile = args.find((a) => path.basename(a).startsWith('server_')) || (args.length ? null : newest('server_'));
if (!clientFile) {
  console.log('No log found. Start the server with `npm run profile`, use the app for a while, then run this again.');
  process.exit(1);
}

const read = (f) =>
  fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
};
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '-');
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

const rows = read(clientFile);
const of = (k) => rows.filter((r) => r.k === k);
const header = of('header')[0] || {};
const frames = of('frame');
const rend = of('renderer');
const sys = of('sys');
const events = of('event');

const others = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('client_') && n.endsWith('.jsonl') && path.join(dir, n) !== path.resolve(clientFile)).sort().slice(-4) : [];
console.log(`\n=== ${path.basename(clientFile)} ===`);
if (others.length) console.log(`(other recent client logs: ${others.join(', ')}; pass one as an argument to see it)`);
console.log(`Device:  ${header.ua || '?'}`);
console.log(`GPU:     ${header.gpu?.renderer || '?'}   cores ${header.cores ?? '?'}   screen ${header.screen ? `${header.screen.w}x${header.screen.h} @${header.screen.dpr}x` : '?'}`);

if (!frames.length) {
  console.log('No frame data yet (did you reach the room?).');
}

const sections = [
  { name: 'in the 2D page', rows: frames.filter((f) => !f.xr) },
  { name: 'in VR', rows: frames.filter((f) => f.xr) },
];
const verdicts = [];
for (const { name, rows: allRows } of sections) {
  // The first few seconds include shader compiling and texture upload, which is a one-off cost: report it
  // separately and judge the steady state.
  const warm = allRows.length > 8 ? allRows.slice(0, 3) : [];
  const fr = allRows.length > 8 ? allRows.slice(3) : allRows;
  if (fr.length < 3) continue;
  if (warm.length) console.log(`\n(first 3 seconds ${name}, ignored below: worst frame ${f1(Math.max(...warm.map((f) => f.max)))} ms, that is shader compile and texture upload)`);
  const fps = fr.map((f) => f.fps);
  const p95 = fr.map((f) => f.p95);
  const cpu = fr.map((f) => f.upd + f.ren);
  const med = pct(fr.map((f) => f.p50), 50);
  const target = med < 9 ? 120 : med < 11.5 ? 90 : med < 15 ? 72 : 60;
  const budget = 1000 / target;
  const hitchTotal = fr.reduce((a, f) => a + f.hitches, 0);
  const frameTotal = fr.reduce((a, f) => a + f.fps, 0);
  const slowSecs = fr.filter((f) => f.fps < target * 0.9).length;
  console.log(`\n--- Frames ${name}: ${fr.length} s ---`);
  console.log(`fps   avg ${f1(avg(fps))}  min ${f1(Math.min(...fps))}   (looks like a ${target} Hz display, ${f1(budget)} ms per frame)`);
  console.log(`frame time   typical ${f1(med)} ms   p95 ${f1(pct(p95, 50))} ms (median second) / ${f1(Math.max(...p95))} ms (worst)   worst single frame ${f1(Math.max(...fr.map((f) => f.max)))} ms`);
  console.log(`CPU per frame   update ${f1(avg(fr.map((f) => f.upd)))} ms   render submit ${f1(avg(fr.map((f) => f.ren)))} ms   total ${f1(avg(cpu))} ms of ${f1(budget)} ms budget`);
  console.log(`stutters   ${hitchTotal} hitch frames (${f1((hitchTotal / Math.max(1, frameTotal)) * 100)}% of frames);  ${slowSecs} of ${fr.length} seconds below 90% of target`);

  const cpuShare = pct(cpu, 50) / budget;
  const gap = avg(fr.map((f) => f.avg)) - avg(cpu);
  if (slowSecs / fr.length > 0.1) {
    if (cpuShare > 0.8) verdicts.push(`${name}: CPU-bound. The page's own JavaScript uses ${f1(cpuShare * 100)}% of the frame budget in a typical second. Look at update ${f1(avg(fr.map((f) => f.upd)))} ms vs render ${f1(avg(fr.map((f) => f.ren)))} ms.`);
    else verdicts.push(`${name}: probably GPU-bound (or waiting on the display). JavaScript only uses ${f1(cpuShare * 100)}% of the budget (typical second) but frames still run long, leaving ${f1(gap)} ms unexplained per frame. Fewer or smaller textures, fewer lit pixels and fewer lights are the levers.`);
  } else {
    verdicts.push(`${name}: healthy. ${f1(avg(fps))} fps average with ${f1(Math.max(0, 100 - cpuShare * 100))}% of the CPU budget spare.`);
  }

  // worst seconds
  const worst = [...fr].sort((a, b) => b.p99 - a.p99).slice(0, 5);
  console.log('worst seconds (by p99 frame time):');
  for (const w of worst) console.log(`   t=${mmss(w.ms)}  p99 ${f1(w.p99)} ms  max ${f1(w.max)} ms  fps ${f1(w.fps)}  upd ${f1(w.upd)}/${f1(w.updMax)}  render ${f1(w.ren)}/${f1(w.renMax)}`);
}

if (rend.length) {
  const last = rend[rend.length - 1];
  console.log('\n--- Scene (renderer) ---');
  console.log(`draw calls ${f1(avg(rend.map((r) => r.calls)))} avg (max ${Math.max(...rend.map((r) => r.calls))})   triangles ${f1(avg(rend.map((r) => r.tris)))} avg (max ${Math.max(...rend.map((r) => r.tris))})`);
  console.log(`geometries ${last.geometries}   textures ${last.textures}   shader programs ${last.programs}   people in room ${last.people}`);
}

const heap = sys.filter((s) => s.heapMB != null);
if (heap.length > 2) {
  const grew = heap[heap.length - 1].heapMB - heap[0].heapMB;
  console.log(`\n--- JS memory ---\nheap ${f1(heap[0].heapMB)} MB -> ${f1(heap[heap.length - 1].heapMB)} MB over ${mmss(heap[heap.length - 1].ms - heap[0].ms)} (${grew > 20 ? 'growing, worth a look' : 'steady'})`);
}

const aud = sys.map((s) => s.audio).filter(Boolean);
if (aud.length) {
  const a = aud[aud.length - 1];
  console.log(`\n--- Audio engine ---\nstate ${a.state}   sample rate ${a.sampleRate}   base latency ${a.baseLatencyMs} ms   output latency ${a.outputLatencyMs} ms`);
}

const peerIds = [...new Set(sys.flatMap((s) => s.peers.map((p) => p.id)))];
for (const id of peerIds) {
  const ps = sys.flatMap((s) => s.peers.filter((p) => p.id === id));
  const col = (fn) => ps.map(fn).filter((v) => v != null && Number.isFinite(v));
  console.log(`\n--- Link to ${id} (${ps.length} samples, path ${ps[ps.length - 1].path || '?'}) ---`);
  console.log(`rtt ${f1(avg(col((p) => p.rttMs)))} ms avg / ${f1(Math.max(0, ...col((p) => p.rttMs)))} ms max   voice jitter ${f1(avg(col((p) => p.aIn?.jitterMs)))} ms avg / ${f1(Math.max(0, ...col((p) => p.aIn?.jitterMs)))} max   jitter buffer ${f1(avg(col((p) => p.aIn?.jbDelayMs)))} ms   concealed ${f1(Math.max(0, ...col((p) => p.aIn?.concealedPct)))}%   lost ${Math.max(0, ...col((p) => p.aIn?.lost))} packets`);
  console.log(`voice in ${f1(avg(col((p) => p.aIn?.kbps)))} kbps   out ${f1(avg(col((p) => p.aOut?.kbps)))} kbps`);
  const v = ps.filter((p) => p.vIn || p.vOut);
  if (v.length) {
    console.log(`video in ${f1(avg(col((p) => p.vIn?.kbps)))} kbps ${f1(avg(col((p) => p.vIn?.fps)))} fps decode ${f1(avg(col((p) => p.vIn?.decodeMs)))} ms freezes ${Math.max(0, ...col((p) => p.vIn?.freezes))}   out ${f1(avg(col((p) => p.vOut?.kbps)))} kbps encode ${f1(avg(col((p) => p.vOut?.encodeMs)))} ms ${ps.some((p) => p.vOut?.limited) ? '(limited: ' + ps.find((p) => p.vOut?.limited).vOut.limited + ')' : ''}`);
  }
}

const lt = of('longtask');
if (lt.length) {
  console.log(`\n--- Main thread blocked over 50 ms: ${lt.length} times, worst ${Math.max(...lt.map((l) => l.dur))} ms ---`);
  for (const l of [...lt].sort((a, b) => b.dur - a.dur).slice(0, 5)) console.log(`   t=${mmss(l.ms)}  ${l.dur} ms`);
}

const bad = rows.filter((r) => r.k === 'error' || (r.k === 'log' && r.level === 'error'));
const warns = rows.filter((r) => r.k === 'log' && r.level === 'warn');
if (bad.length || warns.length) {
  console.log(`\n--- Errors ${bad.length}, warnings ${warns.length} ---`);
  for (const r of [...bad, ...warns].slice(0, 12)) console.log(`   t=${mmss(r.ms)} ${r.k === 'log' ? r.level : 'error'}: ${r.text}`);
}

console.log('\n--- Timeline ---');
for (const e of events) {
  if (e.name === 'peer-connection' && e.state === 'connecting') continue;
  const { t, ms, k, name, ...rest } = e; // rest.took = how long that step took, in ms
  console.log(`   ${mmss(ms)}  ${name}${name === 'mark' ? '  <== marked' : ''} ${Object.keys(rest).length ? JSON.stringify(rest) : ''}`);
}

// What was happening around each mark
const marks = events.filter((e) => e.name === 'mark');
for (const m of marks) {
  const near = frames.filter((f) => Math.abs(f.ms - m.ms) < 4000).sort((a, b) => b.p99 - a.p99)[0];
  if (near) console.log(`   near mark at ${mmss(m.ms)}: worst nearby second had p99 ${f1(near.p99)} ms, max ${f1(near.max)} ms, fps ${f1(near.fps)}`);
}

// One line per VR session, so the render-resolution test (Audio settings > Test: VR render resolution) reads as a table.
const xrRuns = [];
{
  let cur = null;
  for (const e of events) {
    if (e.name === 'xr-start') cur = { start: e.ms, end: Infinity, scale: e.scale ?? 1, hz: e.hzRequested || 0, w: e.eyeW, h: e.eyeH, rate: null };
    else if (e.name === 'xr-frameratechange' && cur) cur.rate = e.frameRate;
    else if (e.name === 'xr-end' && cur) {
      cur.end = e.ms;
      xrRuns.push(cur);
      cur = null;
    }
  }
  if (cur) xrRuns.push(cur);
}
if (xrRuns.length) {
  console.log('\n--- VR sessions (first 3 s of each ignored) ---');
  for (const r of xrRuns) {
    const fr = frames.filter((f) => f.xr && f.ms > r.start + 3000 && f.ms <= r.end);
    if (fr.length < 3) continue;
    const target = r.rate || (pct(fr.map((f) => f.p50), 50) < 9 ? 120 : pct(fr.map((f) => f.p50), 50) < 11.5 ? 90 : 72);
    const slow = fr.filter((f) => f.fps < target * 0.9).length;
    const hitches = fr.reduce((a, f) => a + f.hitches, 0);
    const size = r.w ? `${r.w}x${r.h}` : '?';
    console.log(`   scale ${r.scale}  buffer ${size}  target ${target} Hz   ${fr.length} s   fps avg ${f1(avg(fr.map((f) => f.fps)))} min ${f1(Math.min(...fr.map((f) => f.fps)))}   slow seconds ${slow}   hitches ${hitches}`);
  }
}

if (serverFile) {
  const srv = read(serverFile).filter((r) => r.k === 'server');
  if (srv.length) {
    console.log(`\n=== ${path.basename(serverFile)} ===`);
    console.log(`server cpu ${f1(avg(srv.map((s) => s.cpuPct)))}% avg / ${f1(Math.max(...srv.map((s) => s.cpuPct)))}% max   event-loop delay p99 ${f1(Math.max(...srv.map((s) => s.loopP99Ms)))} ms (max ${f1(Math.max(...srv.map((s) => s.loopMaxMs)))} ms)   rss ${f1(srv[srv.length - 1].rssMB)} MB`);
    console.log(`signalling traffic in ${f1(avg(srv.map((s) => s.inPerSec)))} msg/s (${f1(avg(srv.map((s) => s.inKBps)))} KB/s)   out ${f1(avg(srv.map((s) => s.outPerSec)))} msg/s (${f1(avg(srv.map((s) => s.outKBps)))} KB/s)`);
  }
}

console.log('\n=== Verdict ===');
if (!verdicts.length) console.log('Not enough frame data to judge yet.');
for (const v of verdicts) console.log(`- ${v}`);
console.log('');
