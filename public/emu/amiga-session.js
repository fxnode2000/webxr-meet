// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Amiga in the room, from the person's side: starting it, who is playing, and where their input goes.
//
//  - The HOST runs the emulator (emu-host.js) and shares its picture and sound like a shared screen.
//    Host keyboard and mouse go straight in while "play mode" is on. Guests send joystick states over the data
//    channel; controls.js decides which Amiga port each guest is on.
//  - A GUEST watches the wall as usual. Pressing "Play" asks the host for a joystick; their keyboard (play mode),
//    gamepad or Quest controllers then drive it. Everything a guest sends is a 6-bit number.
//
// Nothing here touches the 3D world or the page directly: the app passes in what is needed (deps), which keeps this
// testable and keeps the emulator code in a clearly bounded set of files.
import { AmigaHost, LIMITS } from './emu-host.js';
import { ControlMap, packJoy, unpackJoy, joyFromKeys, joyFromGamepad, joyFromXr, mergeJoy } from './controls.js';

/** The Amiga's controls, bundled. The arcade option swaps in its own bundle (arcade-controls.js) and a different host. */
export const AMIGA_PROFILE = { name: 'amiga', label: 'the Amiga', ControlMap, ports: [1, 2], packJoy, unpackJoy, joyFromKeys, joyFromGamepad, joyFromXr, mergeJoy };

const SEND_EVERY_MS = 250; // a guest repeats its state even when nothing changed, so a lost message cannot leave a button stuck
const STALE_MS = 1500; // the host lets go of a guest's controls if nothing has been heard for this long
const POLL_MS = 16;
export const PLAY_KEY = 'F8';

export class AmigaSession {
  /**
   * @param {object} d
   * @param {object} d.net                 the Net instance (startScreen, stopScreen, emuJoin, emuJoy, emuPort, on)
   * @param {Function} d.onChange          called whenever anything the UI shows has changed
   * @param {Function} d.banner            show a message to the person
   * @param {Function} d.onLocalStream     (stream) the host's own picture and sound, to show/play locally
   * @param {Function} d.onLocalEnd        the host's emulator ended
   * @param {Function} d.getXrSources      () => inputSources of the running XR session, or []
   * @param {Function} d.setSteering       (bool) pause walking while the left stick steers the Amiga
   * @param {Function} d.hostId            () => id of the person running the Amiga, as a guest sees it
   * @param {Function} [d.createHost]      test seam
   * @param {Function} [d.getGamepads]     test seam
   */
  constructor(d) {
    this.d = d;
    this.host = null; // AmigaHost when I am running it
    this.P = d.profile || AMIGA_PROFILE;
    this.controls = new this.P.ControlMap();
    this.lastSeen = new Map();
    this.playMode = false;
    this.port = 0; // guest: the port I was given (0 = none yet)
    this.joined = false; // guest: I asked to play
    this.keys = new Set();
    this.lastSent = -1;
    this.lastSentAt = 0;
    this.state = 'idle'; // host side: idle | loading | running | error
    this.error = null;
    this.stats = null;
    this._timer = 0;
    this._onKeyDown = (e) => this._key(e, true);
    this._onKeyUp = (e) => this._key(e, false);
    this._onMouseMove = (e) => this._mouseMove(e);
    this._onMouseButton = (e, down) => this._mouseButton(e, down);
    this._md = (e) => this._onMouseButton(e, true);
    this._mu = (e) => this._onMouseButton(e, false);
    this._blur = () => this._lostFocus();
    d.net.on('emu-join', (id, on) => this._guestJoin(id, on));
    d.net.on('emu-joy', (id, bits) => this._guestJoy(id, bits));
    d.net.on('emu-port', (id, port) => this._gotPort(id, port));
  }

  get hosting() {
    return !!this.host;
  }

  // ------------------------------------------------------------ host

  /** Start the emulator. `files` are File objects from the picker: disk (required), kickstart (optional). */
  async startHost({ model, disk, kickstart }) {
    if (this.host) return;
    if (!disk) throw new Error('Pick a disk image first (.adf, .adz or .dms).');
    if (disk.size > LIMITS.diskBytes) throw new Error('That disk image is too big (16 MB limit).');
    if (kickstart && kickstart.size > LIMITS.romBytes) throw new Error('That Kickstart file is too big.');
    const diskBytes = new Uint8Array(await disk.arrayBuffer());
    const ksBytes = kickstart ? new Uint8Array(await kickstart.arrayBuffer()) : null;
    return this._launch((host) => host.start({ model, disk: { bytes: diskBytes, name: disk.name }, kickstart: ksBytes }));
  }

  /** Create the host object, start it with `begin(host)` and put its picture and sound on the shared screen. */
  async _launch(begin) {
    const make = this.d.createHost || ((o) => this._makeHost(o));
    const host = make({
      onState: (s, err) => {
        this.state = s;
        this.error = err;
        if (s === 'error') this._hostFailed(err);
        this.d.onChange();
      },
      onStats: (st) => {
        this.stats = st;
        this.d.onChange();
      },
    });
    this.host = host;
    this.state = 'loading';
    this.d.onChange();
    let stream;
    try {
      stream = await begin(host);
    } catch (e) {
      this.host = null;
      this.state = 'error';
      this.error = e.message;
      this.d.onChange();
      throw e;
    }
    this.d.net.startScreen(stream, { kind: 'emulator', emu: this.P.name });
    this.d.onLocalStream(stream);
    this._applyDevices();
    this._startTimer();
    this.d.onChange();
  }

  _makeHost(o) {
    return new AmigaHost(o);
  }

  _hostFailed(text) {
    // The emulator died while running: take it off the wall and say why (it never fails silently).
    if (!this.host) return;
    this._endHost();
    this.d.banner(`${this.P.label[0].toUpperCase()}${this.P.label.slice(1)} stopped: ${text || 'unknown error'}`);
  }

  stopHost() {
    if (!this.host) return;
    this._endHost();
  }

  _endHost() {
    const host = this.host;
    this.host = null;
    this.setPlayMode(false);
    try {
      this.d.net.stopScreen();
    } catch {}
    try {
      host.stop();
    } catch (e) {
      console.warn('emulator stop', e);
    }
    // everyone who was playing is told they have no port any more
    for (const id of [...this.controls.wants]) this.d.net.emuPort(id, 0);
    this.controls.clear();
    this.lastSeen.clear();
    this.state = 'idle';
    this._stopTimerIfIdle();
    this.d.onLocalEnd();
    this.d.onChange();
  }

  insertDisk(drive, disk) {
    return this.host ? this.host.insertDisk(drive, disk) : 'The Amiga is not running.';
  }

  reset() {
    this.host?.reset();
  }

  _applyDevices() {
    if (!this.host) return;
    const dev = this.controls.devices();
    this.host.setPortDevice(1, dev[1]);
    this.host.setPortDevice(2, dev[2]);
  }

  _guestJoin(id, on) {
    if (!this.host) return;
    if (on) {
      const port = this.controls.join(id);
      this.lastSeen.set(id, performance.now());
      this.d.net.emuPort(id, port || 0);
      if (!port) this.d.banner('All the player slots are taken.');
    } else {
      this.guestGone(id);
      this.d.net.emuPort(id, 0);
    }
    this._afterPortChange();
  }

  /** A guest left the room or stopped playing. */
  guestGone(id) {
    if (!this.host) return;
    const port = this.controls.portOf(id);
    if (port) this.host.setJoystick(port, {});
    const next = this.controls.leave(id);
    this.lastSeen.delete(id);
    if (next) {
      const heir = this.controls.owner[next];
      if (heir) this.d.net.emuPort(heir, next);
    }
    this._afterPortChange();
  }

  _afterPortChange() {
    this._applyDevices();
    this.d.onChange();
  }

  _guestJoy(id, bits) {
    if (!this.host) return;
    const port = this.controls.route(id); // strangers and unassigned guests are ignored
    if (!port) return;
    this.lastSeen.set(id, performance.now());
    this.host.setJoystick(port, this.P.unpackJoy(bits));
  }

  /** Who is on which port, for the screen. */
  players() {
    const out = [];
    for (const port of this.P.ports) if (this.controls.owner[port]) out.push({ port, id: this.controls.owner[port] });
    return out;
  }

  // ------------------------------------------------------------ guest

  /** A guest asks (or stops asking) to play. */
  join(on) {
    if (this.host) return;
    this.joined = !!on;
    if (!on) this.port = 0;
    this.d.net.emuJoin(this.joined);
    if (!on) this.setPlayMode(false);
    this.lastSent = -1;
    this._startTimer();
    this.d.onChange();
  }

  _gotPort(id, port) {
    if (this.host || id !== this.d.hostId()) return; // only the person running the Amiga may assign ports
    this.port = port;
    if (port === 0 && this.joined) this.d.banner('You are not a player yet. The slots may all be taken.');
    this.d.onChange();
  }

  /** The Amiga went away on the guest's side. */
  hostEnded() {
    this.joined = false;
    this.port = 0;
    this.setPlayMode(false);
    this._stopTimerIfIdle();
    this.d.onChange();
  }

  // ------------------------------------------------------------ play mode (keyboard + mouse)

  setPlayMode(on) {
    on = !!on && (this.hosting || this.joined);
    if (on === this.playMode) return;
    this.playMode = on;
    if (on) {
      window.addEventListener('keydown', this._onKeyDown, true);
      window.addEventListener('keyup', this._onKeyUp, true);
      window.addEventListener('blur', this._blur);
      if (this.hosting) {
        document.addEventListener('mousemove', this._onMouseMove, true);
        document.addEventListener('mousedown', this._md, true);
        document.addEventListener('mouseup', this._mu, true);
      }
    } else {
      window.removeEventListener('keydown', this._onKeyDown, true);
      window.removeEventListener('keyup', this._onKeyUp, true);
      window.removeEventListener('blur', this._blur);
      document.removeEventListener('mousemove', this._onMouseMove, true);
      document.removeEventListener('mousedown', this._md, true);
      document.removeEventListener('mouseup', this._mu, true);
      this._lostFocus();
    }
    this.d.onChange();
  }

  _lostFocus() {
    this.keys.clear();
    this.host?.releaseAll();
  }

  _key(e, down) {
    if (!this.playMode) return;
    if (e.code === PLAY_KEY) {
      if (down && !e.repeat) this.setPlayMode(false);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || '')) return;
    // Everything else belongs to the game: the avatar must not walk around while you play.
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (this.hosting) this.host.key(e.code, down);
    else if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
  }

  _mouseMove(e) {
    if (!this.hosting || document.pointerLockElement == null) return;
    e.stopImmediatePropagation(); // the room's own mouse-look must not turn your head while you play
    this.host.mouseMove(e.movementX || 0, e.movementY || 0);
  }

  _mouseButton(e, down) {
    if (!this.hosting || document.pointerLockElement == null) return;
    e.stopImmediatePropagation();
    this.host.mouseButton(e.button, down);
  }

  // ------------------------------------------------------------ the joystick poll (guests)

  _startTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this._poll(), POLL_MS);
  }

  _stopTimerIfIdle() {
    if (this._timer && !this.host && !this.joined) {
      clearInterval(this._timer);
      this._timer = 0;
    }
  }

  _poll() {
    const now = performance.now();
    if (this.host) {
      // let go of a guest that has gone quiet (closed laptop, dropped connection): never leave a button stuck
      for (const [id, t] of this.lastSeen) {
        if (now - t > STALE_MS) {
          const port = this.controls.portOf(id);
          if (port) this.host.setJoystick(port, {});
          this.lastSeen.set(id, now); // check again after another interval, not every tick
        }
      }
      return;
    }
    if (!this.joined) return;
    const pads = (this.d.getGamepads ? this.d.getGamepads() : navigator.getGamepads?.() || []) || [];
    const pad = [...pads].find((p) => p && p.connected);
    const xr = this.P.joyFromXr(this.d.getXrSources());
    this.d.setSteering(xr.steering);
    const joy = this.P.mergeJoy(this.playMode ? this.P.joyFromKeys(this.keys) : null, this.P.joyFromGamepad(pad), xr.joy);
    const bits = this.P.packJoy(joy);
    if (bits !== this.lastSent || now - this.lastSentAt >= SEND_EVERY_MS) {
      this.lastSent = bits;
      this.lastSentAt = now;
      const hostId = this.d.hostId();
      if (hostId) this.d.net.emuJoy(hostId, bits);
    }
  }

  /** The room is closing or the page is going away. */
  dispose() {
    this.stopHost();
    this.join(false);
    this.setPlayMode(false);
    if (this._timer) clearInterval(this._timer);
    this._timer = 0;
  }
}
