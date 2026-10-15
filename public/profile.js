// Local profiling log. Off unless the server was started with `npm run profile`.
//
// What it records (one JSON object per line, sent to the server every 5 s and written to ./logs):
//   header      once: device, browser, GPU name, screen, XR support
//   frame       every second: fps, frame-time percentiles, hitches, CPU time split into update and render
//   renderer    every second: draw calls, triangles, geometries, textures, programs
//   sys         every 5 s: JS heap, audio context state and latency, WebSocket backlog, per-person link quality
//   xr          when a VR session starts or ends: refresh rate, foveation, framebuffer scale
//   event       things that happened (joined, avatar loaded, camera on/off, VR start, marks ...)
//   longtask    anything that blocked the main thread for over 50 ms
//   log / error console warnings, errors and uncaught exceptions
//
// Read it with `npm run summary` (tools/summarise-log.mjs), or just ask for the log to be checked.

const FLUSH_MS = 5000;
const MAX_QUEUE = 4000;

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
};
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

export class Profiler {
  constructor() {
    this.enabled = false;
    this.sid = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);
    this.t0 = performance.now();
    this.queue = [];
    this.world = null;
    this.net = null;
    this.audio = null;
    this.dts = [];
    this.updMs = [];
    this.renMs = [];
    this.secStart = 0;
    this.sysTimer = null;
    this.flushTimer = null;
    this.perfEl = null;
    this.lastKbps = new Map();
    this.logCount = 0;
  }

  /** Called once the server has said profiling is on. */
  start({ net, audio }) {
    if (this.enabled) return;
    this.enabled = true;
    this.net = net;
    this.audio = audio;
    this.perfEl = document.getElementById('perf');
    this.header();
    this.installCapture();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.sysTimer = setInterval(() => this.sampleSystem(), 5000);
    window.addEventListener('pagehide', () => this.flush(true));
    document.addEventListener('visibilitychange', () => {
      this.event(document.hidden ? 'tab-hidden' : 'tab-visible');
      if (document.hidden) this.flush(true);
    });
  }

  attachWorld(world) {
    this.world = world;
    this.secStart = performance.now();
    if (this.perfEl) this.perfEl.hidden = false;
  }

  // ---------------------------------------------------------------- writing

  push(kind, data) {
    if (!this.enabled) return;
    this.queue.push(JSON.stringify({ t: Date.now(), ms: Math.round(performance.now() - this.t0), k: kind, ...data }));
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
  }

  event(name, data = {}) {
    this.push('event', { name, ...data });
  }

  /** A moment the tester wants to find in the log ("it stuttered just now"). Key L, or B / Y on a Quest controller. */
  mark(label = '') {
    this.event('mark', { label });
    this.world?.flashMark?.();
  }

  async flush(beacon = false) {
    if (!this.queue.length) return;
    const body = this.queue.join('\n');
    const url = `/api/log?s=${this.sid}`;
    this.queue = [];
    try {
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(url, body);
      } else {
        const res = await fetch(url, { method: 'POST', body, keepalive: body.length < 60000 });
        if (!res.ok && res.status !== 204) throw new Error(String(res.status));
      }
    } catch {
      this.queue.unshift(...body.split('\n')); // try again next time
    }
  }

  // ---------------------------------------------------------------- one-off facts

  header() {
    let gpu = null;
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      gpu = ext ? { vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) } : { renderer: gl ? gl.getParameter(gl.RENDERER) : 'no webgl2' };
      gpu.maxTexture = gl?.getParameter(gl.MAX_TEXTURE_SIZE);
    } catch {}
    this.push('header', {
      sid: this.sid,
      ua: navigator.userAgent,
      platform: navigator.platform,
      cores: navigator.hardwareConcurrency,
      memGB: navigator.deviceMemory,
      screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio },
      window: { w: innerWidth, h: innerHeight },
      gpu,
      page: location.pathname.startsWith('/r/') ? 'room-link' : 'home',
      secure: window.isSecureContext,
      xr: !!navigator.xr,
    });
  }

  installCapture() {
    const self = this;
    for (const level of ['warn', 'error']) {
      const orig = console[level].bind(console);
      console[level] = (...args) => {
        orig(...args);
        if (self.logCount++ < 200) {
          let text = '';
          try {
            text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 400);
          } catch {}
          self.push('log', { level, text });
        }
      };
    }
    window.addEventListener('error', (e) => this.push('error', { text: String(e.message).slice(0, 300), src: `${e.filename || ''}:${e.lineno || 0}` }));
    window.addEventListener('unhandledrejection', (e) => this.push('error', { text: `unhandled promise rejection: ${String(e.reason && e.reason.message ? e.reason.message : e.reason).slice(0, 300)}` }));
    try {
      new PerformanceObserver((list) => {
        for (const en of list.getEntries()) this.push('longtask', { dur: Math.round(en.duration), at: Math.round(en.startTime) });
      }).observe({ entryTypes: ['longtask'] });
    } catch {}
  }

  xrStarted(session, test = {}) {
    const w = this.world;
    const gl = w?.renderer;
    const layer = session.renderState && session.renderState.baseLayer;
    this.event('xr-start', {
      scale: test.scale ?? 1,
      hzRequested: test.hzRequested ?? 0,
      eyeW: layer ? layer.framebufferWidth : null, // both eyes side by side, so one eye is about half of this
      eyeH: layer ? layer.framebufferHeight : null,
      frameRate: session.frameRate ?? null,
      supportedFrameRates: session.supportedFrameRates ? Array.from(session.supportedFrameRates) : null,
      fovea: gl?.xr.getFoveation?.() ?? null,
      fbScale: gl?.xr.getFramebufferScaleFactor?.() ?? null,
      pixelRatio: gl?.getPixelRatio?.() ?? null,
      environmentBlendMode: session.environmentBlendMode,
    });
    session.addEventListener('end', () => this.event('xr-end'));
    session.addEventListener('frameratechange', () => this.event('xr-frameratechange', { frameRate: session.frameRate }));
  }

  // ---------------------------------------------------------------- per frame

  /** rawDtMs: time since the previous frame. updMs / renMs: CPU time spent updating and submitting the frame. */
  frame(rawDtMs, updMs, renMs) {
    if (!this.enabled) return;
    if (this.dts.length < 4000) {
      this.dts.push(rawDtMs);
      this.updMs.push(updMs);
      this.renMs.push(renMs);
    }
    const now = performance.now();
    if (now - this.secStart < 1000) return;
    const secMs = now - this.secStart;
    this.secStart = now;

    const n = this.dts.length;
    const med = pct(this.dts, 50);
    const frame = {
      fps: r1((n * 1000) / secMs),
      avg: r2(this.dts.reduce((a, b) => a + b, 0) / n),
      p50: r1(med),
      p95: r1(pct(this.dts, 95)),
      p99: r1(pct(this.dts, 99)),
      max: r1(Math.max(...this.dts)),
      // frames that took a third longer than normal, or over 25 ms: the stutters you can feel
      hitches: this.dts.filter((d) => d > Math.max(med * 1.33, 25)).length,
      upd: r2(this.updMs.reduce((a, b) => a + b, 0) / n),
      updMax: r2(Math.max(...this.updMs)),
      ren: r2(this.renMs.reduce((a, b) => a + b, 0) / n),
      renMax: r2(Math.max(...this.renMs)),
      xr: !!this.world?.presenting,
    };
    this.dts = [];
    this.updMs = [];
    this.renMs = [];
    this.push('frame', frame);

    const info = this.world?.renderer?.info;
    let calls = 0;
    let tris = 0;
    if (info) {
      calls = info.render.calls;
      tris = info.render.triangles;
      this.push('renderer', {
        calls,
        tris,
        lines: info.render.lines,
        points: info.render.points,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs ? info.programs.length : null,
        people: this.world.avatars.size,
      });
    }
    if (this.perfEl && !frame.xr) {
      this.perfEl.textContent = `${frame.fps.toFixed(0)} fps · p95 ${frame.p95} ms · cpu ${r1(frame.upd + frame.ren)} ms · ${calls} calls · ${(tris / 1000).toFixed(1)}k tris`;
    }
  }

  // ---------------------------------------------------------------- every 5 seconds

  async sampleSystem() {
    const sys = {};
    const mem = performance.memory;
    if (mem) {
      sys.heapMB = r1(mem.usedJSHeapSize / 1048576);
      sys.heapLimitMB = Math.round(mem.jsHeapSizeLimit / 1048576);
    }
    const ctx = this.audio?.ctx;
    if (ctx) {
      sys.audio = { state: ctx.state, sampleRate: ctx.sampleRate, baseLatencyMs: r1((ctx.baseLatency || 0) * 1000), outputLatencyMs: r1((ctx.outputLatency || 0) * 1000) };
    }
    if (this.net?.ws) sys.wsBacklog = this.net.ws.bufferedAmount;
    sys.peers = [];
    if (this.net) {
      for (const id of this.net.peers.keys()) {
        try {
          const s = await this.net.profileStats(id);
          if (s) sys.peers.push({ id, ...s });
        } catch {}
      }
    }
    this.push('sys', sys);
  }
}
