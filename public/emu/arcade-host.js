// SPDX-License-Identifier: GPL-3.0-or-later
//
// The arcade machine, host side. EmulatorJS (MAME 2003-Plus or FinalBurn Neo, compiled to WebAssembly) runs the game
// inside this page, out of sight; its picture and sound are captured into a MediaStream, which the room shares onto the
// kitchen TV exactly like the Amiga's. Everybody else only sends their controls.
//
// This class has the same small surface as AmigaHost (emu-host.js), so ArcadeSession can reuse the Amiga session code:
//   start(cfg) -> MediaStream | stop() | key(code, down) | setJoystick(player, state) | releaseAll() | reset()
//
// EmulatorJS is a whole emulator front end with its own menus and keyboard handling. We use its core and nothing else:
// its page is parked off screen, its own keyboard/gamepad mapping is emptied once the game runs, and input goes in
// through gameManager.simulateInput(). The ROM never leaves this computer: it is read from the file the host picked.

import { BITS, joyFromKeys } from './arcade-controls.js';

export const ARCADE_BASE = '/emu/vendor/ejs/';
export const ARCADE_LIMITS = { romBytes: 64 * 1024 * 1024 };
export const ARCADE_CORES = {
  mame2003_plus: { label: 'MAME 2003-Plus (about 5,000 classic games, the safest choice)', note: 'Pac-Man, Street Fighter II, Metal Slug...' },
  fbneo: { label: 'FinalBurn Neo (Neo Geo, Capcom and Konami boards; very accurate)', note: 'Neo Geo games also need their BIOS inside the zip.' },
};

// scripts, in the order EmulatorJS's own loader.js loads them
const SCRIPTS = ['emulator.js', 'nipplejs.js', 'shaders.js', 'storage.js', 'gamepad.js', 'GameManager.js', 'socket.io.min.js', 'compression.js'];
const LOAD_TIMEOUT_MS = 90000;
const AUDIO_WAIT_MS = 4000;

// libretro joypad indices: B A Y X are the four face buttons, L R the shoulders. MAME maps them to buttons 1..6.
const INDEX = { b1: 0, b2: 8, b3: 1, b4: 9, b5: 10, b6: 11, coin: 2, start: 3, up: 4, down: 5, left: 6, right: 7 };

const defaultDeps = {
  now: () => performance.now(),
  loadScript: (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    }),
  loadStyle: (href) =>
    new Promise((resolve) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.onload = l.onerror = () => resolve();
      document.head.appendChild(l);
    }),
};

let scriptsLoaded = null; // EmulatorJS's code is loaded once per page, not once per game

function describeError(e) {
  const m = String(e?.message ?? e ?? 'unknown error');
  return m.length > 300 ? `${m.slice(0, 300)}...` : m;
}

export class ArcadeHost {
  /** @param {{base?: string, onState?: Function, onStats?: Function}} opts */
  constructor(opts = {}, deps = {}) {
    this.base = opts.base || ARCADE_BASE;
    this.onState = opts.onState || (() => {});
    this.onStats = opts.onStats || (() => {});
    this.deps = { ...defaultDeps, ...deps };
    this.state = 'idle';
    this.error = null;
    this.emu = null;
    this.stream = null;
    this.root = null;
    this.running = false;
    this.pressed = new Set();
    this.joy = [0, 0, 0, 0]; // packed bits last sent to each player
    this._audio = new Map(); // tracked AudioContext -> its MediaStreamDestination
    this._restore = [];
    this._watch = 0;
  }

  _set(state, error = null) {
    this.state = state;
    this.error = error;
    try {
      this.onState(state, error);
    } catch (e) {
      console.error('arcade onState threw', e);
    }
  }

  /**
   * @param {{core?: string, rom: {bytes: Uint8Array, name: string}}} cfg
   * Resolves with the MediaStream once the game is running; rejects with a readable Error (state is 'error' too).
   */
  async start(cfg = {}) {
    if (this.state !== 'idle') throw new Error('The arcade machine is already started.');
    this._set('loading');
    try {
      const core = ARCADE_CORES[cfg.core] ? cfg.core : 'mame2003_plus';
      const rom = cfg.rom;
      if (!rom || !rom.bytes || rom.bytes.length === 0) throw new Error('Pick a game first (a .zip file).');
      if (rom.bytes.length > ARCADE_LIMITS.romBytes) throw new Error('That game file is too big (64 MB limit).');
      if (!(rom.bytes[0] === 0x50 && rom.bytes[1] === 0x4b)) throw new Error('That does not look like an arcade game. It should be a .zip file, left zipped.');
      // MAME finds the game by the zip's file name (pacman.zip -> "pacman"), so keep it but make it safe.
      const name = String(rom.name || 'game.zip').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
      if (!/\.zip$/i.test(name)) throw new Error('Arcade games are .zip files (leave them zipped).');

      this._captureAudio(true);
      await this._loadEngine();
      this._buildPage();
      const stream = await this._boot(core, rom.bytes, name);
      this.stream = stream;
      this.running = true;
      this._set('running');
      return stream;
    } catch (e) {
      const text = describeError(e);
      console.error('Arcade start failed', e);
      this._teardown();
      this._set('error', text);
      throw new Error(text);
    }
  }

  async _loadEngine() {
    if (!scriptsLoaded) {
      scriptsLoaded = (async () => {
        const dir = `${this.base}src/`;
        for (const f of SCRIPTS) await this.deps.loadScript(dir + f);
        await this.deps.loadStyle(`${this.base}emulator.css`);
        if (typeof window.EmulatorJS !== 'function') throw new Error('EmulatorJS did not load.');
      })().catch((e) => {
        scriptsLoaded = null;
        throw e;
      });
    }
    await scriptsLoaded;
  }

  /** EmulatorJS draws into a page element; this one is parked off screen and cannot be clicked or focused. */
  _buildPage() {
    this.root = document.createElement('div');
    this.root.id = `arcade-host-${Math.random().toString(36).slice(2, 8)}`;
    Object.assign(this.root.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      width: '640px',
      height: '480px',
      pointerEvents: 'none',
      overflow: 'hidden',
    });
    this.root.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.root);
  }

  _boot(core, bytes, name) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        fn(v);
      };
      const timer = setTimeout(() => done(reject, new Error('The game took too long to start.')), LOAD_TIMEOUT_MS);

      // Everything EmulatorJS would normally read from its loader.js, written out. No ads, no cloud saves, no
      // network play, no browser storage; the game is handed over as bytes.
      const config = {
        gameUrl: bytes,
        gameName: name,
        dataPath: this.base,
        system: core,
        color: '#000000',
        volume: 1,
        startOnLoad: true,
        threads: false,
        noAutoFocus: true,
        disableDatabases: true,
        disableLocalStorage: true,
        hideSettings: true,
        shaders: Object.assign({}, window.EJS_SHADERS),
        defaultOptions: { 'save-state-location': 'browser' },
      };
      // EmulatorJS looks for a stable update number on localhost; there is nothing to say to the cdn.
      this._blockUpdateCheck();
      let emu;
      try {
        emu = new window.EmulatorJS(`#${this.root.id}`, config);
      } catch (e) {
        done(reject, e);
        return;
      }
      this.emu = emu;
      window.EJS_emulator = emu;
      emu.on('start', async () => {
        try {
          // Once the game runs EmulatorJS has loaded its default keys; clear them, the room handles the controls.
          emu.controls = { 0: {}, 1: {}, 2: {}, 3: {} };
          try {
            emu.elements.parent.querySelectorAll('.ejs_menu_bar').forEach((el) => (el.style.display = 'none'));
          } catch {}
          const video = emu.canvas.captureStream(60);
          const audio = await this._audioTrack();
          if (!audio) console.warn('Arcade: no game sound was found; the picture is shared without sound.');
          done(resolve, new MediaStream([...video.getVideoTracks(), ...(audio ? [audio] : [])]));
        } catch (e) {
          done(reject, e);
        }
      });
      // EmulatorJS reports a failure by writing it on its screen, not by an event.
      const poll = setInterval(() => {
        if (emu.failedToStart) done(reject, new Error(this._screenText(emu) || 'The game could not be started.'));
      }, 250);
    });
  }

  _screenText(emu) {
    const t = String(emu?.textElem?.innerText || '').trim();
    if (/failed to start|network error|outdated|error for site owner|check console/i.test(t)) {
      return /failed to start/i.test(t) ? 'The game failed to start. Check that the zip is a complete game for this emulator (try the other one).' : t;
    }
    return t;
  }

  _blockUpdateCheck() {
    const real = window.fetch;
    window.fetch = (input, ...rest) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (/cdn\.emulatorjs\.org/.test(url)) return Promise.resolve(new Response('', { status: 503 }));
      return real.call(window, input, ...rest);
    };
    this._restore.push(() => {
      window.fetch = real;
    });
    // put fetch back as soon as the engine has started; later requests are ours
    setTimeout(() => {
      if (window.fetch !== real) window.fetch = real;
    }, 3000);
  }

  // ------------------------------------------------------------ sound
  //
  // EmulatorJS plays through an AudioContext of its own, straight to the speakers. We want that sound on the TV in the
  // kitchen and not on the host's speakers, so: any AudioContext created while the game loads is remembered, and what
  // it sends to its output is redirected into a MediaStreamDestination instead.

  _captureAudio(on) {
    const Native = window.AudioContext;
    if (!Native || !on) return;
    const dests = this._audio;
    const proto = AudioNode.prototype;
    const realConnect = proto.connect;
    let tracking = true;
    this._stopTracking = () => (tracking = false);
    class Tracked extends Native {
      constructor(...a) {
        super(...a);
        if (tracking) dests.set(this, this.createMediaStreamDestination());
      }
    }
    window.AudioContext = Tracked;
    proto.connect = function (target, ...rest) {
      const d = dests.get(this.context);
      if (d && typeof AudioDestinationNode !== 'undefined' && target instanceof AudioDestinationNode) return realConnect.call(this, d, ...rest);
      return realConnect.call(this, target, ...rest);
    };
    this._restore.push(() => {
      window.AudioContext = Native;
      proto.connect = realConnect;
    });
  }

  async _audioTrack() {
    const t0 = this.deps.now();
    while (this._audio.size === 0 && this.deps.now() - t0 < AUDIO_WAIT_MS) await new Promise((r) => setTimeout(r, 100));
    this._stopTracking?.();
    for (const [ctx, dest] of this._audio) {
      ctx.resume?.().catch(() => {});
      const track = dest.stream.getAudioTracks()[0];
      if (track) return track;
    }
    return null;
  }

  // ------------------------------------------------------------ controls

  /** Player 1 is the host on the keyboard. `code` is KeyboardEvent.code. */
  key(code, down) {
    if (down) this.pressed.add(code);
    else this.pressed.delete(code);
    this.setJoystick(1, joyFromKeys(this.pressed));
  }

  /** `player` is 1..4 (as in the control map); `state` is { up, down, ..., coin } booleans. */
  setJoystick(player, state) {
    const p = player - 1;
    if (!this.running || !(p >= 0 && p < 4)) return;
    let bits = 0;
    for (const k of Object.keys(BITS)) if (state && state[k]) bits |= BITS[k];
    const was = this.joy[p];
    if (bits === was) return;
    this.joy[p] = bits;
    for (const k of Object.keys(BITS)) {
      if ((bits & BITS[k]) !== (was & BITS[k])) this._input(p, INDEX[k], (bits & BITS[k]) !== 0 ? 1 : 0);
    }
  }

  _input(player, index, value) {
    try {
      this.emu?.gameManager?.simulateInput(player, index, value);
    } catch (e) {
      console.warn('arcade input', e);
    }
  }

  releaseAll() {
    this.pressed.clear();
    for (let p = 1; p <= 4; p++) this.setJoystick(p, {});
  }

  // the Amiga's mouse, ports and disks have no meaning here
  setPortDevice() {}
  mouseMove() {}
  mouseButton() {}
  insertDisk() {
    return 'An arcade machine has no disk drive.';
  }

  /** Restart the game from the attract screen. */
  reset() {
    try {
      this.emu?.gameManager?.restart();
    } catch (e) {
      console.warn('arcade reset', e);
    }
  }

  // ------------------------------------------------------------ the end

  stop() {
    this._teardown();
    this._set('idle');
  }

  _teardown() {
    this.running = false;
    clearInterval(this._watch);
    try {
      this.emu?.Module?.pauseMainLoop?.();
    } catch {}
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {}
    for (const ctx of this._audio.keys()) {
      try {
        ctx.close();
      } catch {}
    }
    this._audio.clear();
    for (const fn of this._restore.splice(0)) {
      try {
        fn();
      } catch {}
    }
    try {
      this.root?.remove();
    } catch {}
    if (window.EJS_emulator === this.emu) delete window.EJS_emulator;
    this.emu = null;
    this.stream = null;
    this.root = null;
    this.joy = [0, 0, 0, 0];
    this.pressed.clear();
  }
}
