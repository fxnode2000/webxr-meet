// Avatar file inspection. No DOM and no three.js, so the same code runs in the browser
// (before anything is decoded or shown to other people) and in the Node tests.
//
// It reads the glTF JSON and accessor metadata only. Nothing is rendered or decoded here, and
// every size is checked against avatar-limits.json first, so a hostile file cannot make a
// browser allocate a huge texture or mesh.

export const PARTS = ['Head', 'Torso', 'HandL', 'HandR'];

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const ALLOWED_REQUIRED_EXT = new Set(['KHR_texture_transform']);
const MAX_JSON_BYTES = 256 * 1024;

const isPot = (n) => n > 0 && (n & (n - 1)) === 0;
const finite3 = (a) => Array.isArray(a) && a.length === 3 && a.every((x) => Number.isFinite(x));

function parseContainer(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 28) throw new Error('This is not a .glb file.');
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('This is not a .glb file (wrong header). Export as "glTF Binary (.glb)".');
  if (dv.getUint32(4, true) !== 2) throw new Error('Only glTF 2.0 is supported.');
  if (dv.getUint32(8, true) > buf.byteLength) throw new Error('The file is truncated.');
  let off = 12;
  let json = null;
  let bin = new Uint8Array(0);
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (start + len > buf.byteLength) throw new Error('The file is truncated.');
    if (type === 0x4e4f534a && json === null) {
      if (len > MAX_JSON_BYTES) throw new Error('The glTF description is unusually large.');
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, len)));
    } else if (type === 0x004e4942 && bin.length === 0) {
      bin = new Uint8Array(buf, start, len);
    }
    off = start + ((len + 3) & ~3);
  }
  if (!json) throw new Error('The file has no glTF data.');
  return { json, bin };
}

/** Width and height of a PNG or JPEG from its header bytes, or null. */
export function imageSize(b, mime) {
  if (mime === 'image/png') {
    if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20) };
  }
  if (mime === 'image/jpeg') {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return null;
}

/**
 * @param {ArrayBuffer} buf
 * @param {object} limits  contents of avatar-limits.json
 * @returns {{ok:boolean, errors:string[], warnings:string[], info:object}}
 */
export function inspectGlb(buf, limits) {
  const errors = [];
  const warnings = [];
  const info = { bytes: buf?.byteLength ?? 0, tris: {}, totalTris: 0, materials: 0, textures: [] };
  const fail = (t) => errors.push(t);
  const warn = (t) => warnings.push(t);
  const result = () => ({ ok: errors.length === 0, errors, warnings, info });

  if (info.bytes > limits.maxFileBytes) {
    fail(`The file is ${(info.bytes / 1e6).toFixed(2)} MB, the limit is ${(limits.maxFileBytes / 1e6).toFixed(1)} MB.`);
    return result();
  }

  let json;
  let bin;
  try {
    ({ json, bin } = parseContainer(buf));
  } catch (e) {
    fail(e.message || 'The file could not be read.');
    return result();
  }

  try {
    const req = json.extensionsRequired || [];
    for (const e of req) if (!ALLOWED_REQUIRED_EXT.has(e)) fail(`The file requires the glTF extension ${e}, which is not supported (no Draco or mesh compression).`);
    if (json.skins?.length) fail('Rigged meshes (skins) are not supported. The four parts move rigidly.');
    if (json.animations?.length) warn('Animations are ignored.');
    if (json.cameras?.length) warn('Cameras are ignored.');

    const nodes = json.nodes || [];
    const meshes = json.meshes || [];
    const accessors = json.accessors || [];
    const views = json.bufferViews || [];
    const materials = json.materials || [];
    const textures = json.textures || [];
    const images = json.images || [];

    const byName = new Map();
    for (const n of nodes) if (typeof n.name === 'string') byName.set(n.name, [...(byName.get(n.name) || []), n]);

    const usedMaterials = new Set();
    let total = 0;

    const checkAccessor = (idx, what) => {
      const a = accessors[idx];
      if (!a || !Number.isInteger(a.count) || a.count <= 0) throw new Error(`${what}: invalid data.`);
      if (a.sparse) throw new Error(`${what}: sparse data is not supported.`);
      const v = views[a.bufferView];
      if (!v) throw new Error(`${what}: missing data.`);
      const size = (COMPONENT_BYTES[a.componentType] || 0) * (TYPE_COUNT[a.type] || 0);
      const stride = v.byteStride || size;
      const end = (v.byteOffset || 0) + (a.byteOffset || 0) + (a.count - 1) * stride + size;
      if (!size || end > bin.length) throw new Error(`${what}: data runs past the end of the file.`);
      return a;
    };

    for (const name of limits.parts || PARTS) {
      const spec = limits.spec[name];
      const list = byName.get(name) || [];
      if (list.length === 0) {
        fail(`Missing part "${name}". Name each object exactly Head, Torso, HandL and HandR.`);
        continue;
      }
      if (list.length > 1) {
        fail(`More than one object is called "${name}".`);
        continue;
      }
      const node = list[0];
      if (node.mesh === undefined) {
        fail(`"${name}" is not a mesh.`);
        continue;
      }
      if (node.skin !== undefined) fail(`"${name}" is rigged, which is not supported.`);
      const q = node.rotation || [0, 0, 0, 1];
      const s = node.scale || [1, 1, 1];
      const rotOff = Math.hypot(q[0], q[1], q[2], q[3] - 1);
      const scaleOff = Math.max(Math.abs(s[0] - 1), Math.abs(s[1] - 1), Math.abs(s[2] - 1));
      if (rotOff > 2e-3 && Math.hypot(q[0], q[1], q[2], q[3] + 1) > 2e-3) fail(`"${name}" has an unapplied rotation (Ctrl+A > Rotation & Scale in Blender).`);
      if (scaleOff > 2e-3) fail(`"${name}" has an unapplied scale (Ctrl+A > Rotation & Scale in Blender).`);

      const mesh = meshes[node.mesh];
      if (!mesh || !mesh.primitives?.length) {
        fail(`"${name}" has no geometry.`);
        continue;
      }
      if (mesh.primitives.length > 2) fail(`"${name}" uses ${mesh.primitives.length} materials, at most 2 per part.`);

      let tris = 0;
      let verts = 0;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const prim of mesh.primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) throw new Error(`${name}: only triangle meshes are supported.`);
        if (prim.targets?.length) throw new Error(`${name}: shape keys are not supported.`);
        if (prim.attributes?.JOINTS_0 !== undefined) throw new Error(`${name}: rigged meshes are not supported.`);
        const pos = checkAccessor(prim.attributes?.POSITION, name);
        if (pos.type !== 'VEC3' || pos.componentType !== 5126) throw new Error(`${name}: unexpected position format.`);
        if (!finite3(pos.min) || !finite3(pos.max)) throw new Error(`${name}: missing bounds.`);
        for (let i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i], pos.min[i]);
          hi[i] = Math.max(hi[i], pos.max[i]);
        }
        verts += pos.count;
        if (prim.indices !== undefined) {
          const ia = checkAccessor(prim.indices, name);
          if (ia.count % 3) throw new Error(`${name}: bad triangle data.`);
          tris += ia.count / 3;
        } else {
          if (pos.count % 3) throw new Error(`${name}: bad triangle data.`);
          tris += pos.count / 3;
        }
        if (prim.attributes.TEXCOORD_0 !== undefined) checkAccessor(prim.attributes.TEXCOORD_0, name);
        if (prim.attributes.NORMAL !== undefined) checkAccessor(prim.attributes.NORMAL, name);
        usedMaterials.add(prim.material === undefined ? -1 : prim.material);
      }
      info.tris[name] = tris;
      total += tris;
      if (tris > spec.maxTris) fail(`${name}: ${tris} triangles, the limit is ${spec.maxTris}.`);
      if (verts > spec.maxTris * 3) fail(`${name}: too many vertices.`);

      const dim = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      if (dim < spec.size[0] || dim > spec.size[1]) {
        fail(`${name}: largest dimension is ${dim.toFixed(2)} m, expected ${spec.size[0].toFixed(2)} to ${spec.size[1].toFixed(2)} m.`);
      }
      const off = Math.hypot((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
      if (off > spec.pivotTol) {
        fail(`${name}: the origin is ${(off * 100).toFixed(0)} cm from the middle of the mesh (limit ${(spec.pivotTol * 100).toFixed(0)} cm).`);
      }
    }
    info.totalTris = total;
    if (total > limits.totalTris) fail(`${total} triangles in total, the limit is ${limits.totalTris}.`);

    // materials and textures
    const used = [...usedMaterials].filter((i) => i >= 0);
    info.materials = used.length;
    if (used.length > limits.maxMaterials) fail(`${used.length} materials, the limit is ${limits.maxMaterials}.`);
    const imageSet = new Set();
    for (const mi of used) {
      const m = materials[mi];
      if (!m) {
        fail('A mesh points at a missing material.');
        continue;
      }
      if (m.alphaMode && m.alphaMode !== 'OPAQUE') warn('Transparency is not supported and will render opaque.');
      const base = m.pbrMetallicRoughness?.baseColorTexture;
      if (base) {
        const tex = textures[base.index];
        if (!tex || tex.source === undefined) fail('A material uses a texture that cannot be read.');
        else imageSet.add(tex.source);
      }
      if (m.normalTexture || m.emissiveTexture || m.occlusionTexture || m.pbrMetallicRoughness?.metallicRoughnessTexture) {
        warn('Only the base colour texture is used. Normal, emissive and roughness maps are ignored.');
      }
    }
    if (imageSet.size > limits.maxTextures) fail(`${imageSet.size} textures, the limit is ${limits.maxTextures}.`);
    for (const ii of imageSet) {
      const im = images[ii];
      if (!im || im.bufferView === undefined) {
        fail('Textures must be embedded in the .glb.');
        continue;
      }
      if (im.mimeType !== 'image/png' && im.mimeType !== 'image/jpeg') {
        fail('Textures must be PNG or JPEG.');
        continue;
      }
      const v = views[im.bufferView];
      if (!v || (v.byteOffset || 0) + v.byteLength > bin.length) {
        fail('A texture runs past the end of the file.');
        continue;
      }
      const dims = imageSize(bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength), im.mimeType);
      if (!dims) {
        fail('A texture could not be read.');
        continue;
      }
      info.textures.push(dims);
      if (dims.w > limits.maxTexPx || dims.h > limits.maxTexPx) fail(`A texture is ${dims.w}x${dims.h}, the maximum is ${limits.maxTexPx}x${limits.maxTexPx}.`);
      else if (!isPot(dims.w) || !isPot(dims.h)) warn(`A texture is ${dims.w}x${dims.h}. Powers of two (256, 512) work best.`);
    }
  } catch (e) {
    fail(e.message || 'The file could not be checked.');
  }
  return result();
}
