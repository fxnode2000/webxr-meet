// SPDX-License-Identifier: GPL-3.0-or-later
//
// Who controls the Amiga. Pure logic, no browser APIs, so it can be tested on its own.
//
// An Amiga has two controller ports. The host always has the keyboard. Port 1 is the host's mouse until a player is
// put on it as a joystick; port 2 is a joystick. So three people can play at once: the host (keyboard, and the mouse
// when port 1 is the mouse) plus up to two guests on joysticks. The host decides who is on which port (and the first
// guests to ask are placed automatically).

export const BITS = { up: 1, down: 2, left: 4, right: 8, fire: 16, button2: 32 };
export const ALL_BITS = 63;

/** { up, down, ... } -> small integer (this is what travels over the network). */
export function packJoy(s) {
  let b = 0;
  for (const k of Object.keys(BITS)) if (s && s[k]) b |= BITS[k];
  return b;
}

/** Small integer -> { up, down, ... }. Anything that is not an integer 0..63 counts as "nothing pressed". */
export function unpackJoy(b) {
  const v = Number.isInteger(b) && b >= 0 && b <= ALL_BITS ? b : 0;
  const out = {};
  for (const k of Object.keys(BITS)) out[k] = (v & BITS[k]) !== 0;
  return out;
}

export class ControlMap {
  constructor() {
    // owner of each joystick port: a peer id, or null. Port 1 with no owner is the host's mouse.
    this.owner = { 1: null, 2: null };
    this.wants = new Set(); // peers that asked to play, in the order they asked
  }

  /** What each port should have plugged in right now. */
  devices() {
    return { 1: this.owner[1] ? 'joystick' : 'mouse', 2: this.owner[2] ? 'joystick' : 'none' };
  }

  portOf(peerId) {
    if (this.owner[2] === peerId) return 2;
    if (this.owner[1] === peerId) return 1;
    return null;
  }

  /**
   * A guest asks to play. Returns the port they got (1 or 2) or null if both are taken.
   * Port 2 goes first (it is already a joystick); port 1 second (that takes the host's mouse away).
   */
  join(peerId) {
    this.wants.add(peerId);
    const have = this.portOf(peerId);
    if (have) return have;
    if (!this.owner[2]) return (this.owner[2] = peerId), 2;
    if (!this.owner[1]) return (this.owner[1] = peerId), 1;
    return null;
  }

  /** A guest stops playing, leaves or drops. Returns the port they held, or null. The next person waiting gets it. */
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

  /** The host moves someone (or nobody) onto a port. peerId must be known (asked to play) or null to free the port. */
  assign(port, peerId) {
    if (![1, 2].includes(port)) return false;
    if (peerId === null) {
      this.owner[port] = null;
      return true;
    }
    if (!this.wants.has(peerId)) return false;
    const other = this.portOf(peerId);
    if (other && other !== port) this.owner[other] = null; // moving: free the old port
    this.owner[port] = peerId;
    return true;
  }

  /** Which port should a joystick state from this peer go to? null if they are not allowed to control anything. */
  route(peerId) {
    return this.portOf(peerId);
  }

  clear() {
    this.owner = { 1: null, 2: null };
    this.wants.clear();
  }
}

// ---------------------------------------------------------------- where a player's joystick comes from

const DEAD = 0.45;
const none = () => ({ up: false, down: false, left: false, right: false, fire: false, button2: false });

/** Keyboard joystick (a guest in play mode): arrows steer, Ctrl/Space/Z fire, X/Shift/Alt second button. */
export function joyFromKeys(down) {
  const j = none();
  j.up = down.has('ArrowUp');
  j.down = down.has('ArrowDown');
  j.left = down.has('ArrowLeft');
  j.right = down.has('ArrowRight');
  j.fire = down.has('Space') || down.has('KeyZ') || down.has('ControlLeft') || down.has('ControlRight');
  j.button2 = down.has('KeyX') || down.has('ShiftLeft') || down.has('ShiftRight') || down.has('AltLeft');
  return j;
}

/** A standard-mapping gamepad: d-pad or left stick, A/X fire, B/Y second button. */
export function joyFromGamepad(gp) {
  const j = none();
  if (!gp || !gp.connected) return j;
  const b = (i) => !!gp.buttons?.[i]?.pressed;
  const ax = gp.axes || [];
  j.up = b(12) || (ax[1] || 0) < -DEAD;
  j.down = b(13) || (ax[1] || 0) > DEAD;
  j.left = b(14) || (ax[0] || 0) < -DEAD;
  j.right = b(15) || (ax[0] || 0) > DEAD;
  j.fire = b(0) || b(2) || b(7);
  j.button2 = b(1) || b(3) || b(6);
  return j;
}

/**
 * Quest controllers. The left thumbstick normally walks you around the room, so it only steers the Amiga
 * while the left grip is held. Either trigger fires; the right grip is the second button.
 * Returns { joy, steering } where steering says the left stick is being used (so walking should pause).
 */
export function joyFromXr(sources) {
  const j = none();
  let steering = false;
  for (const src of sources || []) {
    const gp = src.gamepad;
    if (!gp) continue;
    const b = (i) => !!gp.buttons?.[i]?.pressed;
    const ax = gp.axes || [];
    if (b(0)) j.fire = true;
    if (src.handedness === 'right' && b(1)) j.button2 = true;
    if (src.handedness === 'left' && b(1)) {
      steering = true;
      const x = ax.length >= 4 ? ax[2] : ax[0] || 0;
      const y = ax.length >= 4 ? ax[3] : ax[1] || 0;
      j.left = x < -DEAD;
      j.right = x > DEAD;
      j.up = y < -DEAD;
      j.down = y > DEAD;
    }
  }
  return { joy: j, steering };
}

/** Combine several sources: a direction is pressed if any source presses it. */
export function mergeJoy(...list) {
  const out = none();
  for (const s of list) for (const k of Object.keys(out)) if (s && s[k]) out[k] = true;
  return out;
}
