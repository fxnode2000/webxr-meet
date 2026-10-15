// SPDX-License-Identifier: GPL-3.0-or-later
// Fetch EmulatorJS and its two arcade cores (MAME 2003-Plus and FinalBurn Neo) from npm into public/emu/vendor/ejs.
//   npm run emu:fetch-arcade
// Only what the Arcade option needs is copied (a few dozen files, about 30 MB), not the 50-odd consoles in the
// full EmulatorJS package. Run it once after cloning, and as part of a deploy build (see render.yaml).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '4.2.3';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'emu', 'vendor', 'ejs');
const CORES = ['mame2003_plus', 'fbneo'];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ejs-'));
const fetchPkg = (name) => {
  const dest = path.join(tmp, name.replace(/[@/]/g, '_'));
  fs.mkdirSync(dest, { recursive: true });
  const tgz = execSync(`npm pack ${name}@${VERSION} --silent --pack-destination "${dest}"`, { cwd: dest, encoding: 'utf8' }).trim().split(/\r?\n/).pop();
  execSync(`tar -xzf "${path.join(dest, tgz)}" -C "${dest}"`);
  return path.join(dest, 'package');
};
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
};

try {
  fs.mkdirSync(out, { recursive: true }); // files are overwritten in place; nothing is deleted
  const ejs = fetchPkg('@emulatorjs/emulatorjs');
  const data = path.join(ejs, 'data');
  for (const f of ['loader.js', 'emulator.css', 'version.json']) if (fs.existsSync(path.join(data, f))) fs.copyFileSync(path.join(data, f), (fs.mkdirSync(out, { recursive: true }), path.join(out, f)));
  for (const d of ['src', 'compression', 'localization']) copyDir(path.join(data, d), path.join(out, d));
  fs.copyFileSync(path.join(ejs, 'LICENSE'), path.join(out, 'LICENSE-EmulatorJS.txt'));
  for (const core of CORES) {
    const pkg = fetchPkg(`@emulatorjs/core-${core}`);
    fs.mkdirSync(path.join(out, 'cores', 'reports'), { recursive: true });
    for (const f of [`${core}-wasm.data`, `${core}-legacy-wasm.data`]) fs.copyFileSync(path.join(pkg, f), path.join(out, 'cores', f));
    fs.copyFileSync(path.join(pkg, 'reports', `${core}.json`), path.join(out, 'cores', 'reports', `${core}.json`));
  }
  fs.writeFileSync(path.join(out, 'ARCADE-VERSION.json'), JSON.stringify({ emulatorjs: VERSION, cores: CORES }, null, 2) + '\n');
  const n = (function count(d) { return fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0); })(out);
  console.log(`EmulatorJS ${VERSION} with ${CORES.join(', ')} is in public/emu/vendor/ejs (${n} files)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
