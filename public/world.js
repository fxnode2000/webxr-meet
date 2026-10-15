// 3D room, avatars, locomotion and the WebXR session.
//
// Built to be cheap enough for a Quest 2: a handful of low-poly meshes, Lambert/Basic
// materials, two lights, no shadows, no post-processing, no per-frame allocations.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const SLOT_COLORS = [0x4fb3ff, 0xff8a5c, 0x7ee081];
export const SLOT_CSS = SLOT_COLORS.map((c) => '#' + c.toString(16).padStart(6, '0'));

const SEAT_RADIUS = 2.0;
const ROOM_RADIUS = 7;
const EYE_HEIGHT = 1.6;
const MOVE_SPEED = 2.0;
const MUTE_HOLD_S = 0.4; // hold A / X this long to toggle the microphone
const POSE_HZ = 30;

// ---- kitchen layout. The model's room is x 0..3.11, z -5.1..0 (glTF space, metres).
// Four Windsor chairs stand round the table in an X (diagonals); three of them are seats: south-east, north-east and
// south-west (the north-west one by the dresser stays empty). Each seat is the chair's centre moved 0.1 m back against
// the chair back, and yaw turns the person to face the table. (yaw 0 faces -Z.)
const KITCHEN_SEATS = [
  { x: 1.68, z: -2.96, yaw: Math.PI / 4 },
  { x: 1.68, z: -4.27, yaw: (3 * Math.PI) / 4 },
  { x: 0.32, z: -2.96, yaw: -Math.PI / 4 },
];
// All four chairs can be clicked to sit on: the three above plus the north-west one by the dresser.
const CLICK_SEATS = [...KITCHEN_SEATS, { x: 0.32, z: -4.27, yaw: (-3 * Math.PI) / 4 }];
const KITCHEN_BOUNDS = { x0: 0.2, x1: 2.91, z0: -4.85, z1: -0.2 };
// solid furniture as rectangles (x0, x1, z0, z1) and the table legs as a circle
const KITCHEN_BOXES = [
  [0, 3.11, -0.66, 0],       // south run: fridge, oven column, hob units
  [2.45, 3.11, -3.66, -0.62], // east run: sink units and under-counter fridge
  [0, 1.35, -5.1, -4.43],    // corner mass with the poster, alcove post, louvre doors
  [1.2, 2.45, -5.1, -4.6],   // dresser
];
const KITCHEN_TABLE = { x: 0.95, z: -3.65, r: 0.35 };
const PLAYER_R = 0.25;
// The shared screen hangs in the air in front of the hob (face towards the table, -Z), a little under the beams. It is
// out of sight until somebody clicks the fridge-freezer by the west wall (or a share starts). The panel face is 0.88 m
// from the back wall; the furniture rectangles keep people a body-width further back, so nobody walks into it.
// Where the reflection probe sits: the middle of the kitchen, at head height (see captureProbe).
export const PROBE_AT = { x: 1.8, y: 1.35, z: -1.8 };

export const SCREEN = { x: 1.75, y: 1.62, z: -0.88, w: 1.4, h: 0.7875 };
// The fridge-freezer that works as the screen's switch (front face z = -0.61).
const FRIDGE = { x0: 0.03, x1: 0.56, y0: 0.02, y1: 1.44, z: -0.61 };

let LAYOUT = 'hall';

/** Where each of the three seats is, and the yaw that makes it face the table. */
export function seatPose(slot) {
  if (LAYOUT === 'kitchen') return KITCHEN_SEATS[slot % 3];
  const a = ((slot % 3) * Math.PI * 2) / 3;
  return { x: Math.sin(a) * SEAT_RADIUS, z: Math.cos(a) * SEAT_RADIUS, yaw: a };
}

const round = (v, f) => Math.round(v * f) / f;

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ------------------------------------------------------------------ avatar

class Avatar {
  constructor(name, slot, pos) {
    this.name = name;
    this.slot = slot;
    this.muted = false;
    this.level = 0;
    this.glow = 0;

    const color = SLOT_COLORS[slot % 3]; // until their own random colour arrives
    this.color = new THREE.Color(color);
    this.root = new THREE.Group();

    this.headMat = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0 });
    this.head = new THREE.Group();
    this.head.add(new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), this.headMat));
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.07, 0.08),
      new THREE.MeshLambertMaterial({ color: 0x10151d }),
    );
    visor.position.set(0, 0.015, -0.085); // front of the head = -Z
    this.head.add(visor);

    this.bodyMat = new THREE.MeshLambertMaterial({ color });
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.4, 3, 10), this.bodyMat);

    const handGeo = new THREE.SphereGeometry(0.045, 10, 8);
    this.handMat = new THREE.MeshLambertMaterial({ color });
    this.handL = new THREE.Mesh(handGeo, this.handMat);
    this.handR = new THREE.Mesh(handGeo, this.handMat);
    this.handL.visible = this.handR.visible = false;

    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 160;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.label.scale.set(0.6, 0.1875, 1);
    this.drawLabel();

    this.root.add(this.head, this.body, this.handL, this.handR, this.label);

    this.tPos = new THREE.Vector3(pos.x, EYE_HEIGHT, pos.z);
    this.tQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pos.yaw);
    this.tL = null;
    this.tR = null;
    this.head.position.copy(this.tPos);
    this.head.quaternion.copy(this.tQuat);
    this.bodyQuat = this.tQuat.clone();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._yawQ = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /**
   * Swap the built-in head, torso and hands for an uploaded avatar's parts (see avatar.js).
   * Each part is a Group already turned to face -Z, with its own origin as the pivot.
   */
  /** The default avatar's colour (each person picks a random one). Uploaded avatars keep their own colours. */
  setColor(hex) {
    this.color.setHex(hex);
    if (this.custom) return;
    this.headMat?.color.setHex(hex);
    this.headMat?.emissive.setHex(hex);
    this.bodyMat?.color.setHex(hex);
    this.handMat?.color.setHex(hex);
    if (this.video) {
      this.frameBase = this.color.clone().multiplyScalar(0.3);
      this.frameGlow = this.color.clone();
    }
  }

  /**
   * Replace the head with a square showing someone's webcam (desktop users only), or put the normal head back
   * with setVideo(null). The frame behind it lights up when they speak, like the glow on the normal head.
   */
  setVideo(el) {
    this.clearVideo();
    if (!el) return;
    const S = 0.26;
    const tex = new THREE.VideoTexture(el);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    // Show the middle square of the picture, whatever shape the camera is.
    const fit = () => {
      const w = el.videoWidth;
      const h = el.videoHeight;
      if (!w || !h) return;
      const a = w / h;
      if (a > 1) {
        tex.repeat.set(1 / a, 1);
        tex.offset.set((1 - 1 / a) / 2, 0);
      } else {
        tex.repeat.set(1, a);
        tex.offset.set(0, (1 - a) / 2);
      }
    };
    el.addEventListener('loadedmetadata', fit);
    el.addEventListener('resize', fit);
    fit();

    this.frameBase = this.color.clone().multiplyScalar(0.3);
    this.frameGlow = this.color.clone();
    this.frameMat = new THREE.MeshBasicMaterial({ color: this.frameBase.clone(), side: THREE.DoubleSide });
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(S + 0.035, S + 0.035), this.frameMat);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    face.position.z = 0.003; // in front of the frame
    const group = new THREE.Group();
    group.add(frame, face);
    group.rotation.y = Math.PI; // a plane faces +Z, the head faces -Z
    for (const c of this.head.children) c.visible = false;
    this.head.add(group);
    this.video = { el, tex, group, fit, hidden: [...this.head.children].filter((c) => c !== group) };
  }

  clearVideo() {
    const v = this.video;
    if (!v) return;
    this.video = null;
    v.el.removeEventListener('loadedmetadata', v.fit);
    v.el.removeEventListener('resize', v.fit);
    this.head.remove(v.group);
    v.group.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    v.tex.dispose();
    this.frameMat = null;
    for (const c of v.hidden) c.visible = true;
  }

  applyCustom(parts) {
    const videoEl = this.video?.el;
    this.clearVideo();
    this.custom = true;
    this.dispose(); // frees the default geometry and materials
    this.root.remove(this.head, this.body, this.handL, this.handR);

    const head = new THREE.Group();
    head.add(parts.Head);
    const handL = parts.HandL;
    const handR = parts.HandR;
    const body = new THREE.Group();
    body.add(parts.Torso);

    head.position.copy(this.head.position);
    head.quaternion.copy(this.head.quaternion);
    body.quaternion.copy(this.body.quaternion);
    body.position.copy(this.body.position);
    handL.visible = handR.visible = false;
    this.head = head;
    this.body = body;
    this.handL = handL;
    this.handR = handR;
    this.root.add(head, body, handL, handR);

    // Voice glow: brighten the texture itself instead of tinting the whole head.
    this.headMat = null;
    this.glowMats = [];
    parts.Head.traverse((o) => {
      if (o.isMesh && o.material && !this.glowMats.includes(o.material)) {
        o.material.emissive = new THREE.Color(0xffffff);
        o.material.emissiveMap = o.material.map || null;
        o.material.emissiveIntensity = 0;
        this.glowMats.push(o.material);
      }
    });
    this.customMaterials = parts.materials || [];
    if (videoEl) this.setVideo(videoEl); // the webcam stays on the new head
  }

  drawLabel() {
    const ctx = this.canvas.getContext('2d');
    const { width: w, height: h } = this.canvas;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(10,14,22,0.78)';
    roundedRect(ctx, 8, 8, w - 16, h - 16, 30);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 64;
    ctx.font = `bold ${size}px sans-serif`;
    while (ctx.measureText(this.name).width > w - 60 && size > 28) {
      size -= 4;
      ctx.font = `bold ${size}px sans-serif`;
    }
    ctx.fillStyle = this.muted ? '#9aa4b2' : '#ffffff';
    ctx.fillText(this.name, w / 2, this.muted ? 62 : h / 2);
    if (this.muted) {
      ctx.font = 'bold 38px sans-serif';
      ctx.fillStyle = '#ff6b6b';
      ctx.fillText('MIC OFF', w / 2, 118);
    }
    this.tex.needsUpdate = true;
  }

  setMuted(m) {
    if (this.muted === m) return;
    this.muted = m;
    this.drawLabel();
  }

  setTarget(h, l, r) {
    this.tPos.set(h[0], h[1], h[2]);
    this.tQuat.set(h[3], h[4], h[5], h[6]).normalize();
    this.tL = l ? { p: new THREE.Vector3(l[0], l[1], l[2]), q: new THREE.Quaternion(l[3], l[4], l[5], l[6]) } : null;
    this.tR = r ? { p: new THREE.Vector3(r[0], r[1], r[2]), q: new THREE.Quaternion(r[3], r[4], r[5], r[6]) } : null;
  }

  update(dt) {
    const k = 1 - Math.exp(-dt * 20);
    this.head.position.lerp(this.tPos, k);
    this.head.quaternion.slerp(this.tQuat, k);

    // Torso follows the head's yaw only, and hangs below it.
    this._e.setFromQuaternion(this.tQuat, 'YXZ');
    this._yawQ.setFromAxisAngle(this._up, this._e.y);
    this.bodyQuat.slerp(this._yawQ, k * 0.5);
    this.body.quaternion.copy(this.bodyQuat);
    this.body.position.set(this.head.position.x, this.head.position.y - 0.5, this.head.position.z);

    for (const [mesh, t] of [[this.handL, this.tL], [this.handR, this.tR]]) {
      if (t) {
        if (!mesh.visible) {
          mesh.position.copy(t.p);
          mesh.quaternion.copy(t.q);
        }
        mesh.visible = true;
        mesh.position.lerp(t.p, k);
        if (this.custom) mesh.quaternion.slerp(t.q, k); // the default hands are balls, so only custom ones turn
      } else {
        mesh.visible = false;
      }
    }

    this.label.position.set(this.head.position.x, this.head.position.y + 0.3, this.head.position.z);

    // Voice-activity glow on the head.
    this.glow += (Math.min(1, this.level * 6) - this.glow) * 0.35;
    const g = this.muted ? 0 : this.glow;
    if (this.headMat) this.headMat.emissiveIntensity = g * 0.9;
    if (this.glowMats) for (const m of this.glowMats) m.emissiveIntensity = g * 0.35;
    if (this.frameMat) this.frameMat.color.copy(this.frameBase).lerp(this.frameGlow, g);
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material !== this.label?.material) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
  }
}

// ------------------------------------------------------------------ world

export class World {
  constructor({ container, audio, onLocalPose, onToggleMute, onExit }) {
    this.audio = audio;
    this.onExit = onExit;
    this.interactables = []; // things a laser pointer / the screen centre can aim at: { mesh, hover(on), activate() }
    this.onLocalPose = onLocalPose;
    this.onToggleMute = onToggleMute;
    this.avatars = new Map();
    this.slot = 0;
    this.muted = false;
    this.poseTimer = 0;
    this.last = 0;
    this.keys = new Set();
    this.snapReady = true;
    this.btnWas = { left: false, right: false };
    this.grips = [];
    this.panels = [];

    // reusable temporaries (nothing allocates inside the frame loop)
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._f = new THREE.Vector3();
    this._u = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._Y = new THREE.Vector3(0, 1, 0);

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setSize(window.innerWidth, window.innerHeight);
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType('local-floor');
    r.xr.setFoveation(1); // Quest 2: cheaper periphery, nobody notices in a simple scene
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d121b);

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 40);
    this.camera.rotation.order = 'YXZ';
    this.camera.position.set(0, EYE_HEIGHT, 0);
    this.rig = new THREE.Group(); // the thing that moves/turns; the headset moves inside it
    this.rig.add(this.camera);
    this.scene.add(this.rig);

    this.hall = new THREE.Group(); // the fallback round hall; removed when the kitchen model loads
    this.scene.add(this.hall);
    this.brightness = 1;
    this.lights = [];
    this.buildRoom();
    this.buildControllers();
    this.buildRays();
    this.bindDesktopInput(r.domElement);

    r.xr.addEventListener('sessionstart', () => {
      this.audio.resume();
      this.drawPanels();
    });
    r.xr.addEventListener('sessionend', () => {
      this.camera.position.set(0, EYE_HEIGHT, 0);
      this.camera.rotation.set(0, 0, 0);
      this.camera.quaternion.identity();
    });
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      if (!r.xr.isPresenting) r.setSize(window.innerWidth, window.innerHeight);
    });

    r.setAnimationLoop((t) => this.frame(t));
  }

  get presenting() {
    return this.renderer.xr.isPresenting;
  }

  // ---- scene

  buildRoom() {
    const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
    const add = (m) => (this.hall.add(m), m);

    const floor = add(new THREE.Mesh(new THREE.CircleGeometry(ROOM_RADIUS, 48), lambert(0x222c3b)));
    floor.rotation.x = -Math.PI / 2;
    const rug = add(new THREE.Mesh(new THREE.CircleGeometry(3.3, 48), lambert(0x2c3c55)));
    rug.rotation.x = -Math.PI / 2;
    rug.position.y = 0.004;

    const walls = add(
      new THREE.Mesh(
        new THREE.CylinderGeometry(ROOM_RADIUS, ROOM_RADIUS, 3.4, 32, 1, true),
        lambert(0x1b2433, { side: THREE.BackSide }),
      ),
    );
    walls.position.y = 1.7;
    const ceiling = add(new THREE.Mesh(new THREE.CircleGeometry(ROOM_RADIUS, 32), lambert(0x141a26)));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = 3.4;

    // Table
    const top = add(new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.05, 32), lambert(0x6b4f3a)));
    top.position.y = 0.74;
    const leg = add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 0.72, 12), lambert(0x3a2b20)));
    leg.position.y = 0.36;

    // Coloured seat markers
    for (let i = 0; i < 3; i++) {
      const s = seatPose(i);
      const pad = add(
        new THREE.Mesh(new THREE.CircleGeometry(0.45, 24), new THREE.MeshBasicMaterial({ color: SLOT_COLORS[i] })),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(s.x, 0.008, s.z);
    }

    // Pillars of different colours around the wall: easy orientation cues for spatial hearing.
    const pillarGeo = new THREE.BoxGeometry(0.28, 3.2, 0.28);
    const pillarMat = lambert(0x2a3446);
    const stripGeo = new THREE.BoxGeometry(0.07, 2.6, 0.04);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const g = new THREE.Group();
      g.add(new THREE.Mesh(pillarGeo, pillarMat));
      const strip = new THREE.Mesh(
        stripGeo,
        new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(i / 8, 0.65, 0.58) }),
      );
      strip.position.z = -0.15; // inward-facing side after the rotation below
      g.add(strip);
      g.position.set(Math.sin(a) * (ROOM_RADIUS - 0.2), 1.6, Math.cos(a) * (ROOM_RADIUS - 0.2));
      g.rotation.y = a;
      this.hall.add(g);
    }

    // Lighting: hemisphere + one directional. No shadows.
    const sun = new THREE.DirectionalLight(0xfff0dd, 1.6);
    sun.position.set(2, 5, 1);
    this.addLights([
      [new THREE.HemisphereLight(0xc4d6ff, 0x20242c, 2.4), 2.4],
      [sun, 1.6],
    ], this.hall);
  }

  /** Lights keep their base intensity so the brightness slider can scale them. */
  addLights(list, parent) {
    for (const [light, base] of list) {
      light.userData.base = base;
      light.intensity = base * this.brightness;
      parent.add(light);
      this.lights.push(light);
    }
  }

  setBrightness(v) {
    this.brightness = v;
    for (const l of this.lights) l.intensity = l.userData.base * v;
  }

  /**
   * Load the low-poly kitchen. On any failure the round hall stays, so the app still works.
   * Materials are swapped for Lambert (cheapest lit shader) and the colour palette texture is
   * sampled with NEAREST so mipmaps cannot bleed neighbouring swatches together.
   */
  async loadKitchen(url) {
    let gltf;
    try {
      gltf = await new GLTFLoader().loadAsync(url);
    } catch (e) {
      console.warn('Kitchen model not loaded, using the fallback hall.', e);
      return false;
    }
    const aniso = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    const cache = new Map();
    // A file with a baked lightmap (see tools/glbtool.py --lightmap-scale) carries it in the occlusion slot, on the second
    // UV set, stored sRGB at `scale` times its real brightness. Then the room is drawn unlit-but-baked: the bake already
    // holds the lamp, the daylight and the bounced light, so no lights are needed for the room itself (they stay for the
    // people in it). Without one, the older arrangement is used: a baked occlusion map under two real lights.
    const baked = gltf.asset?.extras?.lightmap;
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const old = o.material;
      if (!cache.has(old)) {
        // Only what the cheap lit shader can use is kept: base colour (factor and texture), vertex colours, emissive,
        // and a baked occlusion / light texture (read from the mesh's second UV set when the file says so).
        // Normal, roughness and metalness maps are dropped on purpose.
        if (baked && baked.scale > 0) {
          const selfLit = !!old.emissiveMap || (old.emissive && old.emissive.getHex() !== 0);
          const light = old.aoMap || null;
          if (light) {
            light.colorSpace = THREE.SRGBColorSpace;
            light.anisotropy = 1;
          }
          // Metal cannot be pre-lit (its look is the room reflected in it), so it keeps a PBR material and borrows a light
          // probe of the room, captured once the kitchen is in place (captureProbe).
          if (!selfLit && (old.metalness ?? 0) >= 0.5) {
            const mm = new THREE.MeshStandardMaterial({
              color: old.color ? old.color.clone() : new THREE.Color(0xffffff),
              map: old.map || null,
              vertexColors: !!old.vertexColors,
              metalness: old.metalness,
              roughness: old.roughness ?? 0.4,
              envMapIntensity: 1,
              side: THREE.FrontSide,
            });
            mm.name = old.name;
            if (old.map) old.map.anisotropy = aniso;
            (this.metalMats ||= []).push(mm);
            cache.set(old, mm);
            old.dispose();
            o.material = mm;
            o.frustumCulled = false;
            o.matrixAutoUpdate = false;
            o.updateMatrix();
            return;
          }
          const mb = new THREE.MeshBasicMaterial(
            selfLit
              ? { color: old.emissiveMap ? new THREE.Color(0xffffff) : old.emissive.clone(), map: old.emissiveMap || old.map || null, side: THREE.FrontSide }
              : { color: old.color ? old.color.clone() : new THREE.Color(0xffffff), map: old.map || null, vertexColors: !!old.vertexColors, lightMap: light, lightMapIntensity: Math.PI / baked.scale, side: THREE.FrontSide },
          );
          mb.name = old.name;
          if (old.name === 'K_palette' && old.map) {
            old.map.minFilter = old.map.magFilter = THREE.NearestFilter;
            old.map.generateMipmaps = false;
            old.map.needsUpdate = true;
          } else if (old.map) {
            old.map.anisotropy = aniso;
          }
          cache.set(old, mb);
          old.dispose();
          o.material = mb;
          o.frustumCulled = false;
          o.matrixAutoUpdate = false;
          o.updateMatrix();
          return;
        }
        const m = new THREE.MeshLambertMaterial({
          color: old.color ? old.color.clone() : new THREE.Color(0xffffff),
          map: old.map || null,
          vertexColors: !!old.vertexColors,
          emissive: old.emissive ? old.emissive.clone() : new THREE.Color(0),
          emissiveMap: old.emissiveMap || null,
          emissiveIntensity: old.emissiveIntensity ?? 1,
          aoMap: old.aoMap || null,
          aoMapIntensity: old.aoMapIntensity ?? 1,
          lightMap: old.lightMap || null,
          lightMapIntensity: old.lightMapIntensity ?? 1,
          side: THREE.FrontSide,
        });
        m.name = old.name;
        if (old.name === 'K_palette' && old.map) {
          old.map.minFilter = old.map.magFilter = THREE.NearestFilter;
          old.map.generateMipmaps = false;
          old.map.needsUpdate = true;
        } else if (old.map) {
          old.map.anisotropy = aniso;
        }
        cache.set(old, m);
        old.dispose();
      }
      o.material = cache.get(old);
      o.frustumCulled = false; // one static mesh: culling it only costs time
      o.matrixAutoUpdate = false;
      o.updateMatrix();
    });

    this.scene.remove(this.hall);
    this.lights = [];
    this.kitchen = gltf.scene;
    this.scene.add(this.kitchen);
    this.scene.background = new THREE.Color(0x10151d);

    const pendant = new THREE.PointLight(0xffd9a0, 5, 0, 2);
    pendant.position.set(0.95, 1.4, -3.65);
    this.addLights([
      [new THREE.HemisphereLight(0xfff4e0, 0x3a3228, 2.4), 2.4],
      [pendant, 5],
    ], this.scene);

    LAYOUT = 'kitchen';
    this.layout = 'kitchen';
    this.buildScreen();
    this.buildExitSign();
    this.buildChairSeats();
    this.captureProbe();
    return true;
  }

  /**
   * Reflection probe for the metal in the room (sink, taps, knobs, lamp). The room is drawn once into a cube map from a
   * spot in the middle of the kitchen, blurred into an environment map (PMREM) and handed to every metal material, so
   * they reflect the baked room rather than a generic sky. The metal itself is hidden for the capture so it cannot
   * reflect its own unlit self. One capture at load; nothing is drawn extra per frame.
   */
  captureProbe(at = PROBE_AT, size = 256) {
    const mats = this.metalMats;
    if (!mats || !mats.length) return false;
    const r = this.renderer;
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
    const cam = new THREE.CubeCamera(0.05, 40, rt);
    cam.position.set(at.x, at.y, at.z);
    this.scene.add(cam);
    const hidden = [];
    for (const m of mats) { hidden.push(m.visible); m.visible = false; }
    const rig = this.rig ? this.rig.visible : true;
    if (this.rig) this.rig.visible = false;
    try {
      cam.update(r, this.scene);
      const pm = new THREE.PMREMGenerator(r);
      const env = pm.fromCubemap(rt.texture).texture;
      pm.dispose();
      this.probeEnv?.dispose?.();
      this.probeEnv = env;
      for (const m of mats) { m.envMap = env; m.needsUpdate = true; }
    } catch (e) {
      console.warn('Reflection probe failed; metal stays plain.', e);
    } finally {
      mats.forEach((m, i) => { m.visible = hidden[i]; });
      if (this.rig) this.rig.visible = rig;
      this.scene.remove(cam);
      rt.dispose();
      r.xr.enabled = prevXr;
    }
    return true;
  }


  // ---- shared screen: a frame and a flat panel hanging in front of the hob. Idle it says nobody is sharing; otherwise it plays the
  // sharer's tab as a video texture (unlit, so it keeps its own brightness).

  buildScreen() {
    if (this.screen) return;
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 288;
    const g = cv.getContext('2d');
    g.fillStyle = '#0b0d11';
    g.fillRect(0, 0, 512, 288);
    g.fillStyle = '#6d7a90';
    g.font = '600 28px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('Nobody is sharing', 256, 140);
    g.font = '20px system-ui, sans-serif';
    g.fillStyle = '#4a5568';
    g.fillText('A desktop user can share a tab or run an Amiga', 256, 178);
    const idle = new THREE.CanvasTexture(cv);
    idle.colorSpace = THREE.SRGBColorSpace;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN.w, SCREEN.h), new THREE.MeshBasicMaterial({ map: idle, toneMapped: false }));
    const frame = new THREE.Mesh(new THREE.BoxGeometry(SCREEN.w + 0.08, SCREEN.h + 0.08, 0.04), new THREE.MeshLambertMaterial({ color: 0x14100c }));
    const grp = new THREE.Group();
    grp.position.set(SCREEN.x, SCREEN.y, SCREEN.z);
    grp.rotation.y = Math.PI; // the plane faces +Z by default; turn it to face -Z, into the room
    panel.position.z = 0.022;
    grp.add(frame, panel);

    // Two thin cords up to the ceiling, so it reads as hanging rather than floating (length found from the model).
    const up = new THREE.Raycaster(new THREE.Vector3(SCREEN.x, SCREEN.y + SCREEN.h / 2 + 0.05, SCREEN.z), new THREE.Vector3(0, 1, 0), 0, 2);
    this.scene.updateMatrixWorld(true);
    const hit = up.intersectObject(this.kitchen, true)[0];
    if (hit && hit.distance > 0.03) {
      const len = hit.distance;
      const cordGeo = new THREE.CylinderGeometry(0.004, 0.004, len, 6).translate(0, len / 2, 0);
      const cordMat = new THREE.MeshLambertMaterial({ color: 0x1a1612 });
      for (const sx of [-1, 1]) {
        const cord = new THREE.Mesh(cordGeo, cordMat);
        cord.position.set(sx * (SCREEN.w / 2 - 0.12), SCREEN.h / 2 + 0.04, 0);
        grp.add(cord);
      }
    }
    grp.visible = false;
    this.scene.add(grp);
    this.screen = { grp, panel, idle, tex: null, el: null };

    // The fridge-freezer is the switch. An invisible box on its front takes the click; a faint glow shows what the
    // pointer is on.
    const fw = FRIDGE.x1 - FRIDGE.x0;
    const fh = FRIDGE.y1 - FRIDGE.y0;
    const box = new THREE.BoxGeometry(fw, fh, 0.12);
    const hitBox = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
    hitBox.position.set((FRIDGE.x0 + FRIDGE.x1) / 2, (FRIDGE.y0 + FRIDGE.y1) / 2, FRIDGE.z - 0.04);
    hitBox.visible = false;
    hitBox.name = 'FridgeSwitch';
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(fw, fh), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false }));
    glow.rotation.y = Math.PI;
    glow.position.set(hitBox.position.x, hitBox.position.y, FRIDGE.z - 0.012);
    glow.visible = false;
    this.scene.add(hitBox, glow);
    this.interactables.push({
      mesh: hitBox,
      hover: (on) => (glow.visible = on),
      activate: () => this.toggleScreen(),
    });
    if (this.wantScreenEl) this.setScreenVideo(this.wantScreenEl); // a share that started before the model finished loading
  }

  /** Every chair is a seat you can click: an invisible box over the chair takes the click and a faint glow shows it is
   *  the one under the pointer. A seat somebody else is sitting in does nothing. */
  buildChairSeats() {
    this.chairSeats = [];
    for (const seat of CLICK_SEATS) {
      // the chair's centre is 0.1 m in front of the seat point, towards the table (yaw 0 faces -Z)
      const cx = seat.x - Math.sin(seat.yaw) * 0.1;
      const cz = seat.z - Math.cos(seat.yaw) * 0.1;
      const geo = new THREE.BoxGeometry(0.52, 0.98, 0.52);
      const hit = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
      hit.position.set(cx, 0.49, cz);
      hit.rotation.y = seat.yaw;
      hit.visible = false;
      hit.name = 'ChairSeat';
      // a soft outline round the chair says "this one" without hiding it
      const glow = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(0.5, 0.96, 0.5)),
        new THREE.LineBasicMaterial({ color: 0xfff1c8, transparent: true, opacity: 0.85 }),
      );
      glow.position.copy(hit.position);
      glow.rotation.y = seat.yaw;
      glow.visible = false;
      this.scene.add(hit, glow);
      this.interactables.push({
        mesh: hit,
        hover: (on) => (glow.visible = on && !this.seatTaken(seat)),
        activate: () => this.sitAt(seat),
      });
      this.chairSeats.push({ seat, hit, glow });
    }
  }

  /** True when another person's head is at this seat. */
  seatTaken(seat) {
    for (const a of this.avatars.values()) {
      const p = a.head.position;
      if (Math.hypot(p.x - seat.x, p.z - seat.z) < 0.45) return true;
    }
    return false;
  }

  /** Move this person to a seat, facing the table. Returns false if it is taken. */
  sitAt(seat) {
    if (this.seatTaken(seat)) return false;
    this.rig.position.set(seat.x, 0, seat.z);
    this.rig.rotation.y = seat.yaw;
    return true;
  }

  /** Show or hide the hanging screen (this person's view only). */
  toggleScreen(show = !this.screen?.grp.visible) {
    if (this.screen) this.screen.grp.visible = !!show;
  }

  /** Show a playing <video> on the hanging screen, or the idle card when el is null. */
  setScreenVideo(el) {
    this.wantScreenEl = el || null;
    if (!this.screen) return;
    const sc = this.screen;
    if (sc.tex) {
      sc.tex.dispose();
      sc.tex = null;
    }
    sc.el = el || null;
    if (el) {
      sc.tex = new THREE.VideoTexture(el);
      sc.tex.colorSpace = THREE.SRGBColorSpace;
      sc.tex.minFilter = THREE.LinearFilter;
      sc.tex.generateMipmaps = false;
      sc.panel.material.map = sc.tex;
    } else {
      sc.panel.material.map = sc.idle;
    }
    sc.panel.material.needsUpdate = true;
    if (el) sc.grp.visible = true; // a share has started: bring the screen out so nobody has to know about the fridge
  }

  screenPose() {
    return { pos: new THREE.Vector3(SCREEN.x, SCREEN.y, SCREEN.z), nrm: new THREE.Vector3(0, 0, -1), ready: !!this.screen };
  }

  /** Keep the player inside the kitchen and out of the furniture (rectangles + one circle). */
  constrain() {
    if (this.layout !== 'kitchen') {
      const r = Math.hypot(this.rig.position.x, this.rig.position.z);
      if (r > ROOM_RADIUS - 1.5) {
        const s = (ROOM_RADIUS - 1.5) / r;
        this.rig.position.x *= s;
        this.rig.position.z *= s;
      }
      return;
    }
    const p = this.rig.position;
    const B = KITCHEN_BOUNDS;
    p.x = Math.min(B.x1, Math.max(B.x0, p.x));
    p.z = Math.min(B.z1, Math.max(B.z0, p.z));
    for (const [x0, x1, z0, z1] of KITCHEN_BOXES) {
      const ex0 = x0 - PLAYER_R, ex1 = x1 + PLAYER_R, ez0 = z0 - PLAYER_R, ez1 = z1 + PLAYER_R;
      if (p.x > ex0 && p.x < ex1 && p.z > ez0 && p.z < ez1) {
        const push = [p.x - ex0, ex1 - p.x, p.z - ez0, ez1 - p.z];
        const i = push.indexOf(Math.min(...push));
        if (i === 0) p.x = ex0; else if (i === 1) p.x = ex1; else if (i === 2) p.z = ez0; else p.z = ez1;
      }
    }
    const T = KITCHEN_TABLE;
    const dx = p.x - T.x, dz = p.z - T.z, d = Math.hypot(dx, dz), min = T.r + PLAYER_R;
    if (d < min && d > 1e-4) {
      p.x = T.x + (dx / d) * min;
      p.z = T.z + (dz / d) * min;
    }
  }

  buildControllers() {
    for (let i = 0; i < 2; i++) {
      const grip = this.renderer.xr.getControllerGrip(i);
      grip.userData.hand = null;
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }));
      grip.add(orb);
      grip.userData.orb = orb;

      // Wrist status panel (shown on the left controller only)
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 128;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(0.16, 0.08),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
      );
      panel.rotation.x = -Math.PI / 2;
      panel.position.set(0, 0.07, 0.02);
      panel.visible = false;
      panel.userData = { canvas, tex };
      grip.add(panel);
      this.panels.push(panel);

      grip.addEventListener('connected', (e) => {
        grip.userData.hand = e.data.handedness;
        panel.visible = e.data.handedness === 'left';
        this.drawPanels();
      });
      grip.addEventListener('disconnected', () => {
        grip.userData.hand = null;
        panel.visible = false;
      });
      this.rig.add(grip);
      this.grips.push(grip);
    }
  }

  drawPanels() {
    for (const panel of this.panels) {
      const { canvas, tex } = panel.userData;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 256, 128);
      ctx.fillStyle = 'rgba(10,14,22,0.85)';
      roundedRect(ctx, 4, 4, 248, 120, 18);
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 44px sans-serif';
      ctx.fillStyle = this.muted ? '#ff6b6b' : '#6ee7a0';
      ctx.fillText(this.muted ? 'MIC OFF' : 'MIC ON', 128, 44);
      ctx.font = '24px sans-serif';
      ctx.fillStyle = '#c4ccd8';
      ctx.fillText('X / A = mute', 128, 86);
      ctx.fillText(`${this.avatars.size + 1} / 3 here`, 128, 110);
      tex.needsUpdate = true;
    }
  }

  // ---- people

  setSelf(slot, name) {
    this.slot = slot;
    this.name = name;
    const s = seatPose(slot);
    this.rig.position.set(s.x, 0, s.z);
    this.rig.rotation.y = s.yaw;
    for (const g of this.grips) g.userData.orb.material.color.setHex(SLOT_COLORS[slot % 3]);
    this.drawPanels();
  }

  setSelfMuted(m) {
    this.muted = m;
    this.drawPanels();
  }

  addPeer(p) {
    if (this.avatars.has(p.id)) return;
    const a = new Avatar(p.name, p.slot, seatPose(p.slot));
    a.setMuted(!!p.muted);
    this.avatars.set(p.id, a);
    this.scene.add(a.root);
    const col = this.colorOf?.get(p.id);
    if (col !== undefined) a.setColor(col);
    const vid = this.videoOf?.get(p.id);
    if (vid) a.setVideo(vid);
    const parts = this.pendingParts?.get(p.id);
    if (parts) {
      this.pendingParts.delete(p.id);
      a.applyCustom(parts);
    }
    this.drawPanels();
  }

  /** A person's chosen default-avatar colour (0xRRGGBB). Safe to call before they have been added. */
  setPeerColor(id, hex) {
    (this.colorOf ||= new Map()).set(id, hex);
    this.avatars.get(id)?.setColor(hex);
  }

  /** Show a person's webcam on their head (el = <video> element), or pass null to go back to the normal head. */
  setPeerVideo(id, el) {
    this.videoOf ||= new Map();
    if (el) this.videoOf.set(id, el);
    else this.videoOf.delete(id);
    this.avatars.get(id)?.setVideo(el);
  }

  /** Give a person an uploaded avatar. Safe to call before they have been added. */
  setPeerAvatar(id, parts) {
    const a = this.avatars.get(id);
    if (a) {
      if (!a.custom) a.applyCustom(parts);
    } else {
      (this.pendingParts ||= new Map()).set(id, parts);
    }
  }

  removePeer(id) {
    this.pendingParts?.delete(id);
    this.videoOf?.delete(id);
    this.colorOf?.delete(id);
    const a = this.avatars.get(id);
    a?.clearVideo();
    if (!a) return;
    this.scene.remove(a.root);
    a.dispose();
    this.avatars.delete(id);
    this.drawPanels();
  }

  setPose(id, msg) {
    this.avatars.get(id)?.setTarget(msg.h, msg.l, msg.r);
  }

  setMuted(id, muted) {
    this.avatars.get(id)?.setMuted(muted);
  }

  // ---- input

  // ---- laser pointers and the exit sign.
  // A controller's ray (or, on a desktop, the screen centre / the mouse) is tested against the few things in
  // `this.interactables`. The sign is the only one so far; the screen will use the same list.
  buildRays() {
    this._rc = new THREE.Raycaster();
    this._rc.far = 6;
    this._ro = new THREE.Vector3();
    this._rd = new THREE.Vector3();
    this.rays = [];
    for (let i = 0; i < 2; i++) {
      const c = this.renderer.xr.getController(i);
      const beam = new THREE.Mesh(
        new THREE.BoxGeometry(0.004, 0.004, 1).translate(0, 0, -0.5),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false }),
      );
      beam.visible = false;
      beam.scale.z = 0.8;
      c.add(beam);
      c.userData.beam = beam;
      c.addEventListener('connected', (e) => {
        beam.visible = e.data.targetRayMode === 'tracked-pointer' || e.data.targetRayMode === 'gaze';
      });
      c.addEventListener('disconnected', () => (beam.visible = false));
      c.addEventListener('selectstart', () => this.activateAimed(c));
      this.rig.add(c);
      this.rays.push(c);
    }
  }

  /** First interactable under a ray from `obj` (a controller: straight ahead) or from the camera through (ndcX, ndcY). */
  aim(obj, ndcX, ndcY) {
    if (!this.interactables.length) return null;
    obj.updateWorldMatrix(true, false);
    const rc = this._rc;
    if (obj === this.camera) {
      rc.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    } else {
      obj.matrixWorld.decompose(this._p, this._q, this._s);
      rc.ray.origin.copy(this._p);
      rc.ray.direction.set(0, 0, -1).applyQuaternion(this._q);
    }
    const hit = rc.intersectObjects(this.interactables.map((t) => t.mesh), false)[0];
    return hit ? { target: this.interactables.find((t) => t.mesh === hit.object), distance: hit.distance } : null;
  }

  activateAimed(obj, ndcX = 0, ndcY = 0) {
    const h = this.aim(obj, ndcX, ndcY);
    if (!h) return false;
    // not through a wall or a door: the ray is still set from aim(), so one test against the room settles it
    const block = this.kitchen ? this._rc.intersectObject(this.kitchen, true)[0] : null;
    if (block && block.distance < h.distance - 0.02) return false;
    h.target.activate();
    return true;
  }

  updateAim(time) {
    if (!this.interactables.length) return;
    const over = new Set();
    if (this.presenting) {
      for (const c of this.rays) {
        const beam = c.userData.beam;
        if (!beam.visible) continue;
        const h = this.aim(c);
        beam.scale.z = h ? h.distance : 0.8;
        if (h) over.add(h.target);
      }
    } else if (document.pointerLockElement === this.renderer.domElement) {
      const h = this.aim(this.camera, 0, 0);
      if (h) over.add(h.target);
    }
    for (const t of this.interactables) {
      const on = over.has(t);
      if (on !== !!t.over) {
        t.over = on;
        t.hover?.(on);
      }
      t.tick?.(time);
    }
  }

  /** The green exit sign is on the east wall just beside the doorway (the opening is z -4.9 .. -4.4, 2.0 m high; the
   *  beams hang down to 2.15 m, so there is no room above it). Its arrow points at the door. */
  buildExitSign() {
    const W = 0.44;
    const H = 0.18;
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 256;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
    mesh.position.set(3.1, 1.78, -4.06);
    mesh.rotation.y = -Math.PI / 2; // faces into the room (-X)
    mesh.name = 'ExitSign';
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    const state = { over: false, confirmUntil: 0 };
    const paint = () => {
      const ctx = canvas.getContext('2d');
      const confirm = state.confirmUntil > 0;
      const g = state.over || confirm ? '#17c45a' : '#0c9a43';
      ctx.fillStyle = '#0b2b17';
      ctx.fillRect(0, 0, 640, 256);
      ctx.fillStyle = confirm ? '#e6a417' : g;
      roundedRect(ctx, 14, 14, 612, 228, 26);
      ctx.fill();
      ctx.lineWidth = 8;
      ctx.strokeStyle = '#ffffff';
      roundedRect(ctx, 22, 22, 596, 212, 20);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (confirm) {
        ctx.font = '700 70px system-ui, Arial, sans-serif';
        ctx.fillText('LEAVE ROOM?', 320, 98);
        ctx.font = '600 44px system-ui, Arial, sans-serif';
        ctx.fillText('click again to confirm', 320, 178);
      } else {
        // an arrow pointing at the doorway (to the left as you face the wall), then the word
        ctx.lineWidth = 16;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(176, 128);
        ctx.lineTo(60, 128);
        ctx.moveTo(100, 84);
        ctx.lineTo(56, 128);
        ctx.lineTo(100, 172);
        ctx.stroke();
        ctx.font = '800 150px system-ui, Arial, sans-serif';
        ctx.fillText('EXIT', 408, 138);
      }
      tex.needsUpdate = true;
    };
    paint();
    const sign = {
      mesh,
      hover: (on) => {
        state.over = on;
        paint();
      },
      activate: () => {
        if (state.confirmUntil > 0) {
          state.confirmUntil = 0;
          paint();
          this.onExit?.();
        } else {
          state.confirmUntil = performance.now() + 4000;
          paint();
        }
      },
      tick: () => {
        if (state.confirmUntil > 0 && performance.now() > state.confirmUntil) {
          state.confirmUntil = 0;
          paint();
        }
      },
    };
    this.scene.add(mesh);
    this.exitSign = sign;
    this.interactables.push(sign);
  }

  bindDesktopInput(el) {
    el.addEventListener('click', (e) => {
      if (this.presenting) return;
      if (document.pointerLockElement === el) return void this.activateAimed(this.camera, 0, 0); // aim with the screen centre
      const r = el.getBoundingClientRect(); // free mouse: clicking the sign leaves, anything else grabs the mouse
      const x = ((e.clientX - r.left) / r.width) * 2 - 1;
      const y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      if (!this.activateAimed(this.camera, x, y)) el.requestPointerLock?.();
    });
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== el || this.presenting) return;
      this.rig.rotation.y -= e.movementX * 0.0022;
      this.camera.rotation.x = Math.max(-1.4, Math.min(1.4, this.camera.rotation.x - e.movementY * 0.0022));
    });
    const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || '');
    window.addEventListener('keydown', (e) => {
      if (!typing(e)) this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  headYaw() {
    this.camera.getWorldQuaternion(this._q);
    return this._e.setFromQuaternion(this._q, 'YXZ').y;
  }

  /** Turn the rig around the head's position so the head stays put in the world. */
  turnRig(angle) {
    this.camera.getWorldPosition(this._p);
    this.rig.position.sub(this._p).applyAxisAngle(this._Y, angle).add(this._p);
    this.rig.rotation.y += angle;
  }

  /** Profiling: what the headset says each input is (controller or tracked hand) and what we have seen it do. */
  inputRecord(src) {
    const m = (this.inputSeen ||= new Map());
    let rec = m.get(src);
    if (!rec) {
      rec = {
        hand: src.handedness || 'none',
        mode: src.targetRayMode,
        tracked: !!src.hand, // true when this is a tracked hand, not a controller
        gamepad: !!src.gamepad,
        profiles: Array.from(src.profiles || []).slice(0, 3),
        mapping: src.gamepad ? src.gamepad.mapping : null,
        axes: src.gamepad ? src.gamepad.axes.length : 0,
        buttons: src.gamepad ? src.gamepad.buttons.length : 0,
        axMax: [0, 0, 0, 0],
        pressed: new Set(),
      };
      m.set(src, rec);
    }
    return rec;
  }

  /** Called every few seconds by the profiler. Returns the peaks since the last call. */
  inputProbe() {
    const session = this.renderer.xr.getSession();
    if (!session) return null;
    for (const src of session.inputSources) this.inputRecord(src);
    const out = [];
    for (const [src, rec] of this.inputSeen) {
      if (![...session.inputSources].includes(src)) {
        this.inputSeen.delete(src);
        continue;
      }
      out.push({ ...rec, axMax: rec.axMax.map((v) => Math.round(v * 100) / 100), pressed: [...rec.pressed] });
      rec.axMax = [0, 0, 0, 0];
      rec.pressed = new Set();
    }
    const yaw = Math.round((((this.rig.rotation.y * 180) / Math.PI) % 360) * 10) / 10;
    return { sources: out, rig: [Math.round(this.rig.position.x * 100) / 100, Math.round(this.rig.position.z * 100) / 100, yaw] };
  }

  locomote(dt) {
    let mx = 0;
    let mz = 0; // +forward
    const dead = (v) => (Math.abs(v) < 0.15 ? 0 : v);

    if (!this.presenting) {
      const k = this.keys;
      if (k.has('KeyW') || k.has('ArrowUp')) mz += 1;
      if (k.has('KeyS') || k.has('ArrowDown')) mz -= 1;
      if (k.has('KeyA')) mx -= 1;
      if (k.has('KeyD')) mx += 1;
      if (k.has('ArrowLeft') || k.has('KeyQ')) this.rig.rotation.y += 1.6 * dt;
      if (k.has('ArrowRight') || k.has('KeyE')) this.rig.rotation.y -= 1.6 * dt;
    } else {
      const session = this.renderer.xr.getSession();
      if (session) {
        for (const src of session.inputSources) {
          const gp = src.gamepad;
          const rec = this.inputRecord(src);
          if (!gp) continue; // hand tracking has no thumbsticks or buttons: nothing to read here
          const hand = src.handedness;
          const ax = gp.axes;
          // xr-standard mapping puts the thumbstick on axes 2/3; fall back to 0/1.
          const x = dead(ax.length >= 4 ? ax[2] : ax[0] || 0);
          const y = dead(ax.length >= 4 ? ax[3] : ax[1] || 0);
          for (let i = 0; i < ax.length && i < 4; i++) rec.axMax[i] = Math.max(rec.axMax[i], Math.abs(ax[i]));
          for (let i = 0; i < gp.buttons.length; i++) if (gp.buttons[i].pressed) rec.pressed.add(i);

          if (hand === 'left') {
            if (!this.suppressMove) {
              mx += x;
              mz -= y;
            }
          } else if (hand === 'right') {
            // Snap turning (comfortable; smooth turning makes many people queasy)
            if (Math.abs(x) > 0.7 && this.snapReady) {
              this.turnRig((-Math.sign(x) * Math.PI) / 6);
              this.snapReady = false;
            } else if (Math.abs(x) < 0.3) {
              this.snapReady = true;
            }
          }

          // A / X button toggles the microphone, but only when held for a moment, so a bump while picking the
          // controllers up (or putting them down) cannot mute you without you noticing.
          const pressed = !!gp.buttons[4]?.pressed;
          if (hand) {
            const h = (this.muteHold ||= { t: { left: 0, right: 0 }, fired: { left: false, right: false } });
            if (pressed) {
              h.t[hand] += dt;
              if (h.t[hand] >= MUTE_HOLD_S && !h.fired[hand]) {
                h.fired[hand] = true;
                this.onToggleMute?.();
              }
            } else {
              h.t[hand] = 0;
              h.fired[hand] = false;
            }
          }
          // B / Y button: drop a marker in the profiling log ("it stuttered just now")
          const mk = !!gp.buttons[5]?.pressed;
          if (hand && mk && !this.markWas?.[hand]) this.prof?.mark('controller');
          if (hand) (this.markWas ||= {})[hand] = mk;
        }
      }
    }

    if (mx || mz) {
      const len = Math.hypot(mx, mz);
      this._d.set(mx / len, 0, -mz / len).applyAxisAngle(this._Y, this.headYaw());
      const speed = MOVE_SPEED * Math.min(1, len);
      this.rig.position.addScaledVector(this._d, speed * dt);
      this.constrain();
    }
  }

  // ---- XR

  /** opts (profiling only): { scale: render-resolution multiplier, hz: requested refresh rate, 0 = headset default } */
  async enterVR(opts = {}) {
    if (!navigator.xr) throw new Error('WebXR is not available in this browser.');
    const scale = Math.min(2, Math.max(0.5, Number(opts.scale) || 1));
    this.renderer.xr.setFramebufferScaleFactor(scale);
    this.xrScale = scale;
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor'],
    });
    await this.renderer.xr.setSession(session);
    const hz = Number(opts.hz) || 0; // the menu passes the text "0" for "headset default"
    if (hz > 0 && session.updateTargetFrameRate) {
      try {
        await session.updateTargetFrameRate(hz);
      } catch (e) {
        console.warn('Could not set the refresh rate:', e && e.message);
      }
    }
    this.prof?.xrStarted(session, { scale, hzRequested: hz });
  }

  // ---- frame

  poseOf(obj, out) {
    obj.updateWorldMatrix(true, false);
    obj.matrixWorld.decompose(this._p, this._q, this._s);
    out[0] = round(this._p.x, 1000);
    out[1] = round(this._p.y, 1000);
    out[2] = round(this._p.z, 1000);
    out[3] = round(this._q.x, 10000);
    out[4] = round(this._q.y, 10000);
    out[5] = round(this._q.z, 10000);
    out[6] = round(this._q.w, 10000);
    return out;
  }

  frame(time) {
    const prof = this.prof;
    const tFrame = prof ? performance.now() : 0;
    const rawMs = this.last ? time - this.last : 16.7;
    const dt = Math.min(0.1, this.last ? (time - this.last) / 1000 : 0.016);
    this.last = time;

    this.locomote(dt);
    this.rig.updateMatrixWorld(true);
    this.updateAim(time);

    // Listener = head
    this.camera.updateWorldMatrix(true, false);
    this.camera.matrixWorld.decompose(this._p, this._q, this._s);
    this._f.set(0, 0, -1).applyQuaternion(this._q);
    this._u.set(0, 1, 0).applyQuaternion(this._q);
    this.audio.setListener(this._p, this._f, this._u);

    // Remote people: smooth, light up when talking, and move their voice with them
    for (const [id, a] of this.avatars) {
      a.level = this.audio.level(id);
      a.update(dt);
      this._f.set(0, 0, -1).applyQuaternion(a.head.quaternion);
      this.audio.updatePeer(id, a.head.position, this._f);
    }

    // Send our own pose ~30 times a second
    this.poseTimer += dt;
    if (this.poseTimer >= 1 / POSE_HZ) {
      this.poseTimer = 0;
      const pose = { h: this.poseOf(this.camera, new Array(7)), l: null, r: null };
      if (this.presenting) {
        for (const g of this.grips) {
          if (!g.visible) continue;
          if (g.userData.hand === 'left') pose.l = this.poseOf(g, new Array(7));
          else if (g.userData.hand === 'right') pose.r = this.poseOf(g, new Array(7));
        }
      }
      this.onLocalPose?.(pose);
    }

    if (prof) {
      const tRender = performance.now();
      this.renderer.render(this.scene, this.camera);
      prof.frame(rawMs, tRender - tFrame, performance.now() - tRender);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}
