// Custom avatars: validate, build cheap three.js parts, remember the user's own file.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { inspectGlb, PARTS } from './avatar-check.js';

let limitsPromise = null;
export function loadLimits() {
  limitsPromise ||= fetch('/avatar-limits.json', { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error('Could not load avatar limits.');
    return r.json();
  });
  return limitsPromise;
}

/** Check a .glb against the published limits. Never throws. */
export async function checkAvatar(buf) {
  try {
    return inspectGlb(buf, await loadLimits());
  } catch (e) {
    return { ok: false, errors: [e.message || 'Could not check the file.'], warnings: [], info: {} };
  }
}

/**
 * Turn a checked .glb into four parts. Only geometry, the base colour texture and the part names
 * are used. Materials are replaced with the cheapest lit shader (Lambert), and every part is
 * turned half a turn so the front of a standard glTF model (+Z) faces the app's front (-Z).
 * Positions inside the file are ignored: each part is placed by its own origin.
 */
export async function buildAvatar(buf) {
  const gltf = await new GLTFLoader().parseAsync(buf, '');
  const matCache = new Map();
  const toLambert = (src) => {
    if (!matCache.has(src)) {
      const map = src.map || null;
      if (map) {
        map.colorSpace = THREE.SRGBColorSpace;
        map.anisotropy = 1;
      }
      matCache.set(src, new THREE.MeshLambertMaterial({ map, color: src.color ? src.color.clone() : new THREE.Color(0xffffff) }));
    }
    return matCache.get(src);
  };

  const parts = {};
  for (const name of PARTS) {
    const src = gltf.scene.getObjectByName(name);
    if (!src) throw new Error(`Part ${name} is missing.`);
    const inner = new THREE.Group();
    inner.rotation.y = Math.PI;
    src.traverse((o) => {
      if (o.isMesh) {
        const mesh = new THREE.Mesh(o.geometry, toLambert(Array.isArray(o.material) ? o.material[0] : o.material));
        mesh.frustumCulled = false;
        inner.add(mesh);
      }
    });
    parts[name] = inner;
  }
  parts.materials = [...matCache.values()];
  return parts;
}

// ---------------------------------------------------------------- remember my own avatar

const DB = 'webxr-meet';
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export async function saveAvatar(name, buf) {
  try {
    await tx('readwrite', (s) => s.put({ name, buf }, 'avatar'));
  } catch {}
}

export async function loadSavedAvatar() {
  try {
    return (await tx('readonly', (s) => s.get('avatar'))) || null;
  } catch {
    return null;
  }
}

export async function clearSavedAvatar() {
  try {
    await tx('readwrite', (s) => s.delete('avatar'));
  } catch {}
}
