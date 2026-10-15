// SPDX-License-Identifier: GPL-3.0-or-later
//
// The arcade machine in the room, from the person's side. It is the Amiga session (amiga-session.js) with a different
// set of controls (arcade-controls.js: stick, six buttons, Start, Coin; host = player 1, guests = players 2 and 3)
// and a different host (arcade-host.js: EmulatorJS running MAME or FinalBurn Neo).
import { AmigaSession } from './amiga-session.js';
import { ARCADE_PROFILE } from './arcade-controls.js';
import { ArcadeHost, ARCADE_LIMITS } from './arcade-host.js';

export const ARCADE_SESSION_PROFILE = { ...ARCADE_PROFILE, label: 'the arcade machine' };

export class ArcadeSession extends AmigaSession {
  constructor(d) {
    super({ ...d, profile: ARCADE_SESSION_PROFILE });
  }

  /** `rom` is the File the host picked (a .zip, left zipped); `core` is 'mame2003_plus' or 'fbneo'. */
  async startHost({ core, rom }) {
    if (this.host) return;
    if (!rom) throw new Error('Pick a game first (a .zip file).');
    if (rom.size > ARCADE_LIMITS.romBytes) throw new Error('That game file is too big (64 MB limit).');
    const bytes = new Uint8Array(await rom.arrayBuffer());
    return this._launch((host) => host.start({ core, rom: { bytes, name: rom.name } }));
  }

  _makeHost(o) {
    return new ArcadeHost(o);
  }

  insertDisk() {
    return 'An arcade machine has no disk drive.';
  }
}
