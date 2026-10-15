// Checks for the avatar validator: node test/avatar.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inspectGlb } from '../public/avatar-check.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const limits = JSON.parse(readFileSync(path.join(here, '../public/avatar-limits.json'), 'utf8'));
const sample = readFileSync(path.join(here, '../public/avatar-kit/avatar_template.glb'));
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' ' + extra}`);
  if (!cond) failed++;
};

// Rebuild a glb after editing its JSON chunk.
function edit(fn) {
  const len = sample.readUInt32LE(12);
  const json = JSON.parse(sample.subarray(20, 20 + len).toString());
  fn(json);
  let js = Buffer.from(JSON.stringify(json));
  while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
  const rest = sample.subarray(20 + len);
  const out = Buffer.alloc(12 + 8 + js.length + rest.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(js.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  js.copy(out, 20);
  rest.copy(out, 20 + js.length);
  return ab(out);
}

const good = inspectGlb(ab(sample), limits);
check('sample avatar passes', good.ok, JSON.stringify(good.errors));
check('sample triangle count is read', good.info.totalTris === 590, String(good.info.totalTris));
check('sample texture is 256x256', good.info.textures[0]?.w === 256 && good.info.textures[0]?.h === 256);

check('not a glb is rejected', !inspectGlb(new TextEncoder().encode('hello hello hello hello hello hello hello').buffer, limits).ok);
check('truncated file is rejected', !inspectGlb(ab(sample.subarray(0, 5000)), limits).ok);
check('oversize file is rejected', !inspectGlb(ab(sample), { ...limits, maxFileBytes: 1000 }).ok);
check('triangle limit is enforced', !inspectGlb(ab(sample), { ...limits, spec: { ...limits.spec, Head: { ...limits.spec.Head, maxTris: 100 } } }).ok);
check('total triangle limit is enforced', !inspectGlb(ab(sample), { ...limits, totalTris: 500 }).ok);
check('texture size limit is enforced', !inspectGlb(ab(sample), { ...limits, maxTexPx: 128 }).ok);

const renamed = inspectGlb(edit((j) => (j.nodes.find((n) => n.name === 'Torso').name = 'Body')), limits);
check('missing part is reported', !renamed.ok && renamed.errors.some((e) => e.includes('Torso')), JSON.stringify(renamed.errors));

const scaled = inspectGlb(edit((j) => (j.nodes.find((n) => n.name === 'Head').scale = [2, 2, 2])), limits);
check('unapplied scale is reported', !scaled.ok && scaled.errors.some((e) => e.includes('scale')));

const rigged = inspectGlb(edit((j) => (j.skins = [{ joints: [0] }])), limits);
check('skins are rejected', !rigged.ok);

const ext = inspectGlb(edit((j) => (j.extensionsRequired = ['KHR_draco_mesh_compression'])), limits);
check('compressed meshes are rejected', !ext.ok);

const huge = inspectGlb(edit((j) => (j.accessors[0].count = 100000000)), limits);
check('accessor past the end of the file is rejected', !huge.ok);

const moved = inspectGlb(
  edit((j) => {
    const m = j.meshes[j.nodes.find((n) => n.name === 'Head').mesh];
    const a = j.accessors[m.primitives[0].attributes.POSITION];
    a.min = a.min.map((x) => x + 1);
    a.max = a.max.map((x) => x + 1);
  }),
  limits,
);
check('off-centre origin is reported', !moved.ok && moved.errors.some((e) => e.includes('origin')));

const ext2 = inspectGlb(edit((j) => { delete j.images[0].bufferView; j.images[0].uri = 'http://example.com/x.png'; }), limits);
check('external texture is rejected', !ext2.ok);

console.log(failed ? `\n${failed} FAILED` : '\nall avatar checks passed');
process.exit(failed ? 1 : 0);
