// SPDX-License-Identifier: GPL-3.0-or-later
// Load the built Copperline bundle in Node, boot the free AROS ROM on an A500 and an A1200, run a few seconds of
// emulation and check that it produces a picture and sound, takes input, and matches VERSION.json.
//   npm run emu:check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'public', 'emu', 'vendor', 'copperline');
const fail = (m) => {
  console.error(`emu:check FAILED: ${m}`);
  process.exit(1);
};
if (!fs.existsSync(path.join(dir, 'VERSION.json'))) fail('no bundle found. Run "npm run emu:build" first.');
const ver = JSON.parse(fs.readFileSync(path.join(dir, 'VERSION.json'), 'utf8'));
for (const [f, hash] of Object.entries(ver.sha256)) {
  const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  if (got !== hash) fail(`${f} does not match VERSION.json (it was changed after the build).`);
}
console.log(`bundle ${ver.tag} (${ver.commit.slice(0, 8)}), files match their recorded hashes`);

// the glue is an ES module behind a .js name; load a copy with .mjs so every Node version treats it as one
const tmp = path.join(dir, 'pkg', '.check-glue.mjs');
fs.copyFileSync(path.join(dir, 'pkg', 'copperline_web.js'), tmp);
try {
  const { default: init, WebEmu } = await import(pathToFileURL(tmp).href);
  await init({ module_or_path: fs.readFileSync(path.join(dir, 'pkg', 'copperline_web_bg.wasm')) });
  const rom = new Uint8Array(fs.readFileSync(path.join(dir, 'aros', 'aros-amiga-m68k-rom.bin')));
  const ext = new Uint8Array(fs.readFileSync(path.join(dir, 'aros', 'aros-amiga-m68k-ext.bin')));
  for (const model of ['A500', 'A1200']) {
    const emu = new WebEmu(model, 'PAL', 2);
    emu.load_rom(rom, ext);
    emu.insert_floppy(0, new Uint8Array(901120), 'blank.adf');
    let now = 0;
    let audio = 0;
    const t0 = Date.now();
    for (let i = 0; i < 400; i++) {
      now += 20;
      emu.run(now, 5);
      audio += emu.take_audio().length;
      if (i === 100) {
        emu.key_event('KeyA', true);
        emu.key_event('KeyA', false);
        emu.mouse_delta(5, 5);
        emu.set_port_device(1, 'joystick');
        emu.set_joystick_port(1, false, false, true, false, true, false);
        emu.set_joystick_port(1, false, false, false, false, false, false);
        emu.set_port_device(1, 'mouse');
      }
    }
    const secs = emu.emulated_seconds();
    if (!(secs > 2)) fail(`${model}: only ${secs} emulated seconds after 8 s of host time (too slow or stuck)`);
    if (!(emu.present_rows() > 100 && emu.present_width() > 200)) fail(`${model}: no picture (${emu.present_width()}x${emu.present_rows()})`);
    if (audio === 0) fail(`${model}: no audio samples were produced`);
    console.log(`${model}: ${secs.toFixed(1)} emulated seconds in ${Date.now() - t0} ms, picture ${emu.present_width()}x${emu.present_rows()}, ${audio} audio samples`);
    emu.free();
  }
  console.log('emu:check passed');
} catch (e) {
  fail(e && e.stack ? e.stack : String(e));
} finally {
  fs.rmSync(tmp, { force: true });
}
