// SPDX-License-Identifier: GPL-3.0-or-later
//
// Who controls the arcade machine. Pure logic, no browser APIs, so it can be tested on its own.
//
// An arcade game has up to four players, but a room has three people: the host is always player 1 (keyboard), and up to
// two guests are players 2 and 3. A player's controls are a stick, six buttons, Start and a Coin slot. They travel as
// one small integer (the same message the Amiga joystick uses), so the host can check it with a single range test.

export const BITS = {
  up: 1,
  down: 2,
  left: 4,
  right: 8,
  b1: 16,
  b2: 32,
  b3: 64,
  b4: 128,
  b5: 256,
  b6: 512,
  start: 1024,
  coin: 2048,
};
export const ALL_BITS = 4095;
export const GUEST_PORTS = [2, 3];

export function packJoy(s) {
  let b = 0;
  for (const k of Object.keys(BITS)) if (s && s[k]) b |= BITS[k];
  return b;
}

/** Anything that is not an integer 0..4095 counts as "nothing pressed". */
export function unpackJoy(b) {
  const v = Number.isInteger(b) && b >= 0 && b <= ALL_BITS ? b : 0;
  const out = {};
  for (const k of Object.keys(BITS)) out[k] = (v & BITS[k]) !== 0;
  return out;
}

const none = () => Object.fromEntries(Object.keys(BITS).map((k) => [k, false]));

export class ArcadeControlMap {
  constructor() {
    this.owner = { 2: null, 3: null }; // player number -> peer id
    this.wants = new Set(); // peers that asked to play, in the order they asked
  }

  portOf(peerId) {
    for (const p of GUEST_PORTS) if (this.owner[p] === peerId) return p;
    return null;
  }

  /** A guest asks to play. Returns the player number they got (2 or 3) or null when both are taken. */
  join(peerId) {
    this.wants.add(peerId);
    const have = this.portOf(peerId);
    if (have) return have;
    for (const p of GUEST_PORTS) if (!this.owner[p]) return (this.owner[p] = peerId), p;
    return null;
  }

  /** A guest stops playing, leaves or drops. Returns the player number they held, or null. The next in line gets it. */
  leave(peerId) {
    this.wants.delete(peerId);
    const port = this.portOf(peerId);
    if (!port) return null;
    this.owner[port] = null;
    for (const w of this.wants) {
      if (this.portOf(w)) continue;
      this.owner[port] = w;
      break;
    }
    return port;
  }

  assign(port, peerId) {
    if (!GUEST_PORTS.includes(port)) return false;
    if (peerId === null) {
      this.owner[port] = null;
      return true;
    }
    if (!this.wants.has(peerId)) return false;
    const other = this.portOf(peerId);
    if (other && other !== port) this.owner[other] = null;
    this.owner[port] = peerId;
    return true;
  }

  route(peerId) {
    return this.portOf(peerId);
  }

  /** The Amiga plugs devices into ports; an arcade machine does not. */
  devices() {
    return {};
  }

  clear() {
    this.owner = { 2: null, 3: null };
    this.wants.clear();
  }
}

// ---------------------------------------------------------------- where a player's controls come from

const DEAD = 0.45;

/**
 * Keyboard: arrows steer; Z X C and A S D are buttons 1 to 6; Enter or 1 is Start; 5 is the coin slot.
 * (These are also MAME's own habits: 1 = player 1 start, 5 = insert coin.)
 */
export function joyFromKeys(down) {
  const j = none();
  j.up = down.has('ArrowUp');
  j.down = down.has('ArrowDown');
  j.left = down.has('ArrowLeft');
  j.right = down.has('ArrowRight');
  j.b1 = down.has('KeyZ') || down.has('Space') || down.has('ControlLeft');
  j.b2 = down.has('KeyX') || down.has('AltLeft');
  j.b3 = down.has('KeyC') || down.has('ShiftLeft');
  j.b4 = down.has('KeyA');
  j.b5 = down.has('KeyS');
  j.b6 = down.has('KeyD');
  j.start = down.has('Enter') || down.has('Digit1');
  j.coin = down.has('Digit5');
  return j;
}

/** A standard gamepad: d-pad or left stick; A X Y B... = buttons 1 to 4, shoulders 5 and 6; Menu = Start; View = Coin. */
export function joyFromGamepad(gp) {
  const j = none();
  if (!gp || !gp.connected) return j;
  const b = (i) => !!gp.buttons?.[i]?.pressed;
  const ax = gp.axes || [];
  j.up = b(12) || (ax[1] || 0) < -DEAD;
  j.down = b(13) || (ax[1] || 0) > DEAD;
  j.left = b(14) || (ax[0] || 0) < -DEAD;
  j.right = b(15) || (ax[0] || 0) > DEAD;
  j.b1 = b(0);
  j.b2 = b(1);
  j.b3 = b(2);
  j.b4 = b(3);
  j.b5 = b(4);
  j.b6 = b(5);
  j.coin = b(8);
  j.start = b(9);
  return j;
}

/**
 * Quest controllers. The left thumbstick normally walks you around the room, so it steers only while the left grip is
 * held (as for the Amiga). Right trigger = button 1, right grip = button 2, right A = button 3, right B = button 4,
 * left trigger = button 5, left X = Coin, left Y = Start.
 */
export function joyFromXr(sources) {
  const j = none();
  let steering = false;
  for (const src of sources || []) {
    const gp = src.gamepad;
    if (!gp) continue;
    const b = (i) => !!gp.buttons?.[i]?.pressed;
    const ax = gp.axes || [];
    if (src.handedness === 'right') {
      if (b(0)) j.b1 = true;
      if (b(1)) j.b2 = true;
      if (b(4)) j.b3 = true;
      if (b(5)) j.b4 = true;
    } else if (src.handedness === 'left') {
      if (b(0)) j.b5 = true;
      if (b(4)) j.coin = true;
      if (b(5)) j.start = true;
      if (b(1)) {
        steering = true;
        const x = ax.length >= 4 ? ax[2] : ax[0] || 0;
        const y = ax.length >= 4 ? ax[3] : ax[1] || 0;
        j.left = x < -DEAD;
        j.right = x > DEAD;
        j.up = y < -DEAD;
        j.down = y > DEAD;
      }
    }
  }
  return { joy: j, steering };
}

export function mergeJoy(...list) {
  const out = none();
  for (const s of list) for (const k of Object.keys(out)) if (s && s[k]) out[k] = true;
  return out;
}

/** The pieces a session needs, bundled (the Amiga has its own bundle in controls.js). */
export const ARCADE_PROFILE = {
  name: 'arcade',
  ControlMap: ArcadeControlMap,
  ports: GUEST_PORTS,
  packJoy,
  unpackJoy,
  joyFromKeys,
  joyFromGamepad,
  joyFromXr,
  mergeJoy,
};
