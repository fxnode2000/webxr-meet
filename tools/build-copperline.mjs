// SPDX-License-Identifier: GPL-3.0-or-later
// Build Copperline's browser emulator from source and put it where the app loads it.
//   npm run emu:build
//
// Needs: git, Rust (rustup), and internet access to github.com and crates.io. Works on Windows, macOS and Linux.
// The source is pinned to a release tag AND a commit: if the tag ever points somewhere else, the build refuses.
// Output: public/emu/vendor/copperline/  (generated; see VERSION.json there for what was built and its hashes)
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = 'v1.0.0';
const COMMIT = '1a284cde0ff5ff6e460e906dbc98cf5b903e7c87';
const REPO = 'https://github.com/CopperlineHQ/Copperline.git';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(root, '.emu-build');
const src = path.join(work, 'Copperline');
const out = path.join(root, 'public', 'emu', 'vendor', 'copperline');

const say = (m) => console.log(`\n== ${m}`);
function die(m) {
  console.error(`\nBuild stopped: ${m}`);
  process.exit(1);
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) die(`could not run "${cmd}": ${r.error.message}. Is it installed and on your PATH?`);
  if (r.status !== 0) die(`"${cmd} ${args.join(' ')}" failed (exit ${r.status}).`);
}
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return r.error || r.status !== 0 ? null : (r.stdout || '').trim();
}
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

say('checking tools');
for (const [cmd, hint] of [['git', 'https://git-scm.com/'], ['cargo', 'https://rustup.rs/'], ['rustup', 'https://rustup.rs/']]) {
  if (capture(cmd, ['--version']) === null) die(`"${cmd}" was not found. Install it first: ${hint}`);
}
console.log(capture('cargo', ['--version']));

say(`getting Copperline ${TAG}`);
fs.mkdirSync(work, { recursive: true });
if (!fs.existsSync(path.join(src, '.git'))) run('git', ['clone', '--branch', TAG, '--depth', '1', REPO, src]);
else {
  run('git', ['fetch', '--depth', '1', 'origin', `tag`, TAG, '--no-tags'], { cwd: src });
  run('git', ['checkout', '--detach', TAG], { cwd: src });
}
const head = capture('git', ['rev-parse', 'HEAD'], { cwd: src });
if (head !== COMMIT) die(`${TAG} is at ${head}, but this build expects ${COMMIT}. Refusing to build unreviewed code.`);
const dirty = capture('git', ['status', '--porcelain'], { cwd: src });
if (dirty) die('the Copperline checkout has local changes. Delete the .emu-build folder and run again.');
console.log(`commit ${head} ok`);

const web = path.join(src, 'crates', 'copperline-web');
const cargoToml = fs.readFileSync(path.join(web, 'Cargo.toml'), 'utf8');
const wb = /^wasm-bindgen = "=(.+)"$/m.exec(cargoToml)?.[1];
if (!wb) die('could not read the wasm-bindgen version from Copperline.');

say('wasm target');
run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);

say(`wasm-bindgen ${wb}`);
const have = capture('wasm-bindgen', ['--version']);
if (!have || !have.endsWith(wb)) run('cargo', ['install', 'wasm-bindgen-cli', '--version', wb, '--locked']);
else console.log(`${have} already installed`);

say('compiling (this takes a few minutes the first time)');
const env = { ...process.env, RUSTFLAGS: `${process.env.RUSTFLAGS || ''} -C target-feature=+simd128`.trim() };
run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '--locked'], { cwd: web, env });
fs.rmSync(path.join(web, 'pkg'), { recursive: true, force: true });
run('wasm-bindgen', ['--target', 'web', '--out-dir', 'pkg', path.join('target', 'wasm32-unknown-unknown', 'release', 'copperline_web.wasm')], { cwd: web });

// wasm-opt makes the file smaller, but only a modern one is safe (old ones corrupt wasm-bindgen's glue).
const wasm = path.join(web, 'pkg', 'copperline_web_bg.wasm');
let optimised = false;
const wo = capture('wasm-opt', ['--version']);
const woVer = Number(/version_?\s*(\d+)/i.exec(wo || '')?.[1] || 0);
if (wo && woVer >= 120) {
  say(`optimising with ${wo}`);
  run('wasm-opt', ['-O3', wasm, '-o', wasm]);
  optimised = true;
} else {
  console.log(wo ? `\n(skipping wasm-opt: ${wo} is too old to be safe; need binaryen version_120 or newer)` : '\n(wasm-opt not installed: skipping, the bundle is just a little bigger)');
}
if (!fs.existsSync(wasm) || fs.statSync(wasm).size < 100000) die('the wasm file is missing or far too small.');

say('copying into the app');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'pkg'), { recursive: true });
fs.mkdirSync(path.join(out, 'aros'), { recursive: true });
const copy = (from, to) => fs.copyFileSync(path.join(src, from), path.join(out, to));
copy('crates/copperline-web/pkg/copperline_web.js', 'pkg/copperline_web.js');
copy('crates/copperline-web/pkg/copperline_web_bg.wasm', 'pkg/copperline_web_bg.wasm');
copy('crates/copperline-web/www/audio-worklet.js', 'audio-worklet.js');
for (const f of ['aros-amiga-m68k-rom.bin', 'aros-amiga-m68k-ext.bin', 'LICENSE', 'ACKNOWLEDGEMENTS']) copy(`assets/aros/${f}`, `aros/${f}`);
copy('LICENSE', 'COPPERLINE-LICENSE');
copy('CREDITS.md', 'COPPERLINE-CREDITS.md');

const files = {};
for (const f of ['pkg/copperline_web.js', 'pkg/copperline_web_bg.wasm', 'audio-worklet.js', 'aros/aros-amiga-m68k-rom.bin', 'aros/aros-amiga-m68k-ext.bin']) files[f] = sha256(path.join(out, f));
fs.writeFileSync(
  path.join(out, 'VERSION.json'),
  JSON.stringify({ project: 'Copperline', tag: TAG, commit: COMMIT, source: REPO.replace(/\.git$/, ''), license: 'GPL-3.0-or-later', wasmBindgen: wb, wasmOpt: optimised, builtAt: new Date().toISOString(), sha256: files }, null, 2) + '\n',
);

say('checking the result');
run(process.execPath, [path.join(root, 'tools', 'check-copperline.mjs')]);
console.log('\nDone. The Amiga is ready: start the server (npm start) and use the Amiga button in the room.');
