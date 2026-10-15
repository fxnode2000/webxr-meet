// SPDX-License-Identifier: GPL-3.0-or-later
//
// AmigaHost: runs the Copperline emulator (WebAssembly, see vendor/copperline/) and turns it into a MediaStream
// (picture + sound) that the room shares like any other screen. This file talks to Copperline only through its
// documented WebEmu API (docs/guide/browser.md in the Copperline source, release v1.0.0) and knows nothing about
// rooms, people or WebRTC. Copperline is GPL-3.0-or-later; see vendor/copperline/LICENSE and CREDITS.md.
//
// Design rules, because emulators and VR are ruined by glitches:
//  * Nothing here may throw into the room. Every failure becomes state 'error' with a plain-English message.
//  * The picture is drawn onto a fixed-size canvas, so the video stream never changes resolution mid-game.
//  * The picture is redrawn a few times a second even when the Amiga screen is still, so a late joiner always
//    gets a frame (a still canvas would send nothing).
//  * Audio is paced by the audio queue (like the Copperline page does): the machine never runs ahead of the sound.
//  * A hidden tab keeps running from the audio clock, which browsers do not throttle.

export const EMU_BASE = '/emu/vendor/copperline/';
export const LIMITS = { diskBytes: 16 * 1024 * 1024, romBytes: 2 * 1024 * 1024 };
export const MODELS = ['A500', 'A1200'];

const STREAM_W = 800; // fixed 4:3 output, whatever the Amiga does with its screen mode
const STREAM_H = 600;
const STREAM_FPS = 50;
const KEEPALIVE_MS = 200; // redraw at least this often so a still picture still reaches new viewers
const GATE_CLOSE_MS = 150; // audio queue above this: stop stepping until it drains (same numbers as Copperline's page)
const GATE_OPEN_MS = 90;
const MAX_CATCHUP_FRAMES = 5;
const WATCHDOG_MS = 500; // nothing has stepped the machine for this long: step it from a timer (see _watchdog)

const ZERO_JOY = { up: false, down: false, left: false, right: false, fire: false, button2: false };

const defaultDeps = {
  async loadBundle(base) {
    const mod = await import(/* @vite-ignore */ `${base}pkg/copperline_web.js`);
    const wasm = await mod.default({ module_or_path: `${base}pkg/copperline_web_bg.wasm` });
    return { WebEmu: mod.WebEmu, memory: wasm.memory };
  },
  async fetchBytes(url) {
    const r = await fetch(url, { cache: 'force-cache' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  },
  now: () => performance.now(),
  isHidden: () => (typeof document !== 'undefined' ? document.hidden : false),
};

/** Friendly text for the things that actually go wrong. */
export function describeError(e) {
  const msg = String(e?.message ?? e ?? 'unknown error');
  if (/Failed to fetch|NetworkError|HTTP 404|dynamically imported module|Failed to load module/i.test(msg)) {
    return 'The emulator files could not be loaded. Has the Copperline build been installed (npm run emu:build)?';
  }
  if (/WebAssembly|wasm|CompileError|LinkError/i.test(msg)) return `The emulator could not start in this browser (${msg}).`;
  return msg;
}

export class AmigaHost {
  /**
   * @param {{base?: string, onState?: Function, onStats?: Function}} opts
   * @param {object} deps test seams; production uses the defaults
   */
  constructor(opts = {}, deps = {}) {
    this.base = opts.base || EMU_BASE;
    this.onState = opts.onState || (() => {});
    this.onStats = opts.onStats || (() => {});
    this.deps = { ...defaultDeps, ...deps };
    this.state = 'idle';
    this.error = null;
    this.emu = null;
    this.stream = null;
    this.canvas = null;
    this.running = false;
    this.pressed = new Set();
    this.joy = { 1: { ...ZERO_JOY }, 2: { ...ZERO_JOY } };
    this.buttons = new Set();
    this.queuedMs = 0;
    this.underruns = 0;
    this.gateClosed = false;
    this.frames = 0;
    this.stat = { t0: 0, frames: 0, steps: 0, coreMs: 0 };
    this.lastDraw = 0;
    this.drawnFrames = 0;
    this._raf = 0;
    this._keepalive = 0;
    this.lastStepAt = 0;
  }

  _set(state, error = null) {
    this.state = state;
    this.error = error;
    try {
      this.onState(state, error);
    } catch (e) {
      console.error('emu onState threw', e);
    }
  }

  /**
   * Load everything and start running. Resolves with the MediaStream, or rejects with an Error whose message is
   * already readable (state is 'error' too).
   * @param {{model?: string, video?: string, disk?: {bytes: Uint8Array, name: string}|null, kickstart?: Uint8Array|null}} cfg
   */
  async start(cfg = {}) {
    if (this.state !== 'idle') throw new Error('The Amiga is already started.');
    this._set('loading');
    try {
      const model = MODELS.includes(cfg.model) ? cfg.model : 'A500';
      const video = cfg.video === 'NTSC' ? 'NTSC' : 'PAL';
      if (cfg.disk && cfg.disk.bytes.length > LIMITS.diskBytes) throw new Error('That disk image is too big (16 MB limit).');
      if (cfg.disk && cfg.disk.bytes.length === 0) throw new Error('That disk image is empty.');

      const { WebEmu, memory } = await this.deps.loadBundle(this.base);
      this.memory = memory;

      let rom;
      let ext = null;
      if (cfg.kickstart) {
        // A Kickstart the person owns: 256 or 512 KiB.
        if (cfg.kickstart.length !== 256 * 1024 && cfg.kickstart.length !== 512 * 1024) {
          throw new Error('That does not look like a Kickstart ROM (it should be 256 KB or 512 KB).');
        }
        rom = cfg.kickstart;
      } else {
        rom = await this.deps.fetchBytes(`${this.base}aros/aros-amiga-m68k-rom.bin`);
        ext = await this.deps.fetchBytes(`${this.base}aros/aros-amiga-m68k-ext.bin`);
      }
      if (rom.length > LIMITS.romBytes || (ext && ext.length > LIMITS.romBytes)) throw new Error('The ROM file is too big.');

      const emu = new WebEmu(model, video, 2);
      this.emu = emu;
      if (ext) emu.load_rom(rom, ext);
      else emu.load_rom(rom);
      if (cfg.disk) {
        try {
          emu.insert_floppy(0, cfg.disk.bytes, String(cfg.disk.name || 'disk.adf').slice(0, 64));
        } catch (e) {
          throw new Error(`That disk image was not accepted (${e?.message ?? e}). Use an .adf, .adz or .dms file.`);
        }
      }
      emu.set_volume_percent?.(100);

      await this._buildAudio();
      this._buildCanvas();
      this.stream = new MediaStream([...this.canvas.captureStream(STREAM_FPS).getVideoTracks(), ...this.audioDest.stream.getAudioTracks()]);

      this.running = true;
      this.stat = { t0: this.deps.now(), frames: 0, steps: 0, coreMs: 0 };
      this.emu.resync_clock?.();
      this._raf = requestAnimationFrame(this._tick);
      // A still Amiga screen produces no new picture; keep a trickle going (see the header comment).
      this.lastStepAt = this.deps.now();
      this._keepalive = setInterval(() => {
        this._watchdog();
        this._redrawIfStill();
      }, KEEPALIVE_MS);
      this._set('running');
      return this.stream;
    } catch (e) {
      const text = describeError(e);
      console.error('Amiga start failed', e);
      this._teardown();
      this._set('error', text);
      throw new Error(text);
    }
  }

  async _buildAudio() {
    const ctx = new AudioContext({ sampleRate: 44100 }); // the Amiga's rate: no resampling inside the worklet
    this.audioCtx = ctx;
    await ctx.audioWorklet.addModule(`${this.base}audio-worklet.js`);
    const node = new AudioWorkletNode(ctx, 'copperline-audio', { outputChannelCount: [2] });
    node.port.onmessage = (e) => {
      if (typeof e.data?.queuedMs === 'number') this.queuedMs = e.data.queuedMs;
      if (typeof e.data?.underruns === 'number') this.underruns = e.data.underruns;
      // The audio clock is never throttled: it keeps the machine going when the tab is hidden.
      if (this.running && this.deps.isHidden()) this._step(this.deps.now());
    };
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest); // never to the speakers: the room plays it from the TV in the kitchen
    this.audioNode = node;
    this.audioDest = dest;
    await ctx.resume().catch(() => {});
  }

  _buildCanvas() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = STREAM_W;
    this.canvas.height = STREAM_H;
    this.ctx2d = this.canvas.getContext('2d', { alpha: false });
    this.ctx2d.fillStyle = '#000';
    this.ctx2d.fillRect(0, 0, STREAM_W, STREAM_H);
    this.src = document.createElement('canvas');
    this.srcCtx = this.src.getContext('2d', { alpha: false });
  }

  _tick = (now) => {
    if (!this.running) return;
    this._step(now);
    this._raf = requestAnimationFrame(this._tick);
  };

  /**
   * Safety net. Copperline's audio worklet stops sending its clock ticks once its queue has run dry, and a hidden tab
   * gets no animation frames, so one brief stall in the background could freeze the machine for good. Timers still
   * fire about once a second in a hidden tab, so if nothing has stepped the machine for a while, step it from here:
   * the audio it produces refills the queue and the audio clock starts ticking again. The same net catches a
   * visible but starved window (covered by another window, say).
   */
  _watchdog() {
    if (!this.running || !this.emu) return;
    const now = this.deps.now();
    if (now - this.lastStepAt < WATCHDOG_MS) return;
    this.watchdogSteps = (this.watchdogSteps || 0) + 1;
    // No resync here: that would make this step produce nothing. The step is capped at a few frames, and the
    // emulator's own pacer forgives time it cannot catch up on, so this cannot burst.
    this._step(now);
  }

  _step(now) {
    if (!this.running || !this.emu) return;
    this.lastStepAt = this.deps.now();
    try {
      // Pace by the audio queue: when it is full, wait for it to drain instead of running ahead.
      const limit = this.gateClosed ? GATE_OPEN_MS : GATE_CLOSE_MS;
      this.gateClosed = this.queuedMs > limit;
      let max = MAX_CATCHUP_FRAMES;
      if (this.gateClosed) {
        this.emu.resync_clock?.();
        max = 0;
      }
      const t0 = this.deps.now();
      const stepped = this.emu.run(now, max);
      this.stat.coreMs += this.deps.now() - t0;
      this.stat.steps++;
      this.stat.frames += stepped;
      this.frames += stepped;
      if (stepped > 0) this._blit();

      const samples = this.emu.take_audio();
      if (samples.length > 0 && this.audioNode) this.audioNode.port.postMessage(samples, [samples.buffer]);
      this._reportStats(now);
    } catch (e) {
      this._crash(e);
    }
  }

  _blit() {
    const rows = this.emu.present_rows();
    if (rows <= 0) return;
    const width = this.emu.present_width();
    if (this.src.width !== width || this.src.height !== rows) {
      this.src.width = width;
      this.src.height = rows;
    }
    // Make the view fresh every time: WebAssembly memory growth detaches old views.
    const pixels = new Uint8ClampedArray(this.memory.buffer, this.emu.present_ptr(), width * rows * 4);
    this.srcCtx.putImageData(new ImageData(pixels, width, rows), 0, 0);
    this._draw();
  }

  _draw() {
    // The Amiga screen is shown at 4:3 like a monitor would, filling the fixed output.
    this.ctx2d.imageSmoothingEnabled = true;
    this.ctx2d.drawImage(this.src, 0, 0, STREAM_W, STREAM_H);
    this.lastDraw = this.deps.now();
    this.drawnFrames++;
  }

  _redrawIfStill() {
    if (!this.running || !this.src || this.src.width === 0) return;
    if (this.deps.now() - this.lastDraw >= KEEPALIVE_MS) this._draw();
  }

  _reportStats(now) {
    const s = this.stat;
    const t = this.deps.now();
    if (t - s.t0 < 1000) return;
    const secs = (t - s.t0) / 1000;
    let emulated = 0;
    try {
      emulated = this.emu.emulated_seconds?.() ?? 0;
    } catch {}
    this.onStats({
      fps: Math.round(s.frames / secs),
      stepMs: s.steps ? Math.round((s.coreMs / s.steps) * 10) / 10 : 0,
      queuedMs: Math.round(this.queuedMs),
      underruns: this.underruns,
      emulatedSeconds: Math.round(emulated * 10) / 10,
      hidden: this.deps.isHidden(),
      watchdogSteps: this.watchdogSteps || 0,
    });
    this.stat = { t0: t, frames: 0, steps: 0, coreMs: 0 };
  }

  _crash(e) {
    console.error('Amiga crashed', e);
    const text = `The emulator stopped: ${e?.message ?? e}`;
    this._teardown();
    this._set('error', text);
  }

  // ------------------------------------------------------------------ input (all safe to call at any time)

  /** A key on the real keyboard, by its W3C code ("KeyA", "ArrowUp"). Returns true if the Amiga used it. */
  key(code, pressed) {
    if (!this.emu || !this.running) return false;
    try {
      if (pressed) this.pressed.add(code);
      else this.pressed.delete(code);
      return !!this.emu.key_event(code, pressed);
    } catch (e) {
      console.warn('key', e);
      return false;
    }
  }

  mouseMove(dx, dy) {
    if (!this.emu || !this.running) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    try {
      this.emu.mouse_delta(Math.max(-500, Math.min(500, dx)), Math.max(-500, Math.min(500, dy)));
    } catch (e) {
      console.warn('mouse', e);
    }
  }

  mouseButton(button, pressed) {
    if (!this.emu || !this.running || ![0, 1, 2].includes(button)) return;
    try {
      if (pressed) this.buttons.add(button);
      else this.buttons.delete(button);
      this.emu.mouse_button(button, pressed);
    } catch (e) {
      console.warn('mouse button', e);
    }
  }

  /** What is plugged into a port: 'mouse', 'joystick' or 'none'. Port 1 starts as the mouse, port 2 as a joystick. */
  setPortDevice(port, device) {
    if (!this.emu || !this.running || ![1, 2].includes(port) || !['mouse', 'joystick', 'none'].includes(device)) return false;
    try {
      this.emu.set_port_device(port, device);
      return true;
    } catch (e) {
      console.warn('port device', e);
      return false;
    }
  }

  /** A joystick state for port 1 or 2: { up, down, left, right, fire, button2 } (anything missing counts as released). */
  setJoystick(port, s) {
    if (!this.emu || !this.running || ![1, 2].includes(port)) return;
    const j = { up: !!s?.up, down: !!s?.down, left: !!s?.left, right: !!s?.right, fire: !!s?.fire, button2: !!s?.button2 };
    // Left+right or up+down at once is impossible on a real stick (and trips some games): cancel both.
    if (j.left && j.right) j.left = j.right = false;
    if (j.up && j.down) j.up = j.down = false;
    this.joy[port] = j;
    try {
      this.emu.set_joystick_port(port, j.up, j.down, j.left, j.right, j.fire, j.button2);
    } catch (e) {
      console.warn('joystick', e);
    }
  }

  /** Let go of everything (focus lost, someone left, play mode off): nothing may stay stuck down. */
  releaseAll() {
    if (!this.emu) return;
    for (const code of [...this.pressed]) this.key(code, false);
    for (const b of [...this.buttons]) this.mouseButton(b, false);
    this.setJoystick(1, ZERO_JOY);
    this.setJoystick(2, ZERO_JOY);
  }

  /** Put another disk in a drive (0 or 1), or null to eject. Returns an error text, or null if it worked. */
  insertDisk(drive, disk) {
    if (!this.emu || !this.running || ![0, 1].includes(drive)) return 'The Amiga is not running.';
    try {
      if (!disk) {
        this.emu.eject_floppy(drive);
        return null;
      }
      if (disk.bytes.length > LIMITS.diskBytes) return 'That disk image is too big (16 MB limit).';
      this.emu.insert_floppy(drive, disk.bytes, String(disk.name || 'disk.adf').slice(0, 64));
      return null;
    } catch (e) {
      return `That disk image was not accepted (${e?.message ?? e}).`;
    }
  }

  /** Cold reset (keeps the disks). */
  reset() {
    try {
      this.emu?.reset();
    } catch (e) {
      this._crash(e);
    }
  }

  stop() {
    if (this.state === 'stopped' || this.state === 'idle') return;
    this._teardown();
    this._set('stopped');
  }

  _teardown() {
    try {
      this.releaseAll(); // before running goes false: nothing may stay held down inside the machine
    } catch {}
    this.running = false;
    cancelAnimationFrame(this._raf);
    clearInterval(this._keepalive);
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      this.audioNode?.disconnect();
      this.audioNode && (this.audioNode.port.onmessage = null);
      this.audioCtx?.close().catch(() => {});
    } catch {}
    try {
      this.emu?.free?.();
    } catch {}
    this.emu = null;
    this.audioNode = null;
    this.audioCtx = null;
    this.audioDest = null;
  }
}
