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
const POSE_HZ = 30;

// ---- kitchen layout. The model's room is x 0..3.11, z -5.1..0 (glTF space, metres).
// Seats are the chairs around the gateleg table: south, east, west. (yaw 0 faces -Z.)
const KITCHEN_SEATS = [
  { x: 0.92, z: -2.85, yaw: 0 },
  { x: 1.74, z: -3.6, yaw: Math.PI / 2 },
  { x: 0.17, z: -3.65, yaw: -Math.PI / 2 },
];
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

    const color = SLOT_COLORS[slot % 3];
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

    this.body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.15, 0.4, 3, 10),
      new THREE.MeshLambertMaterial({ color }),
    );

    const handGeo = new THREE.SphereGeometry(0.045, 10, 8);
    const handMat = new THREE.MeshLambertMaterial({ color });
    this.handL = new THREE.Mesh(handGeo, handMat);
    this.handR = new THREE.Mesh(handGeo, handMat);
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
        if (!mesh.visible) mesh.position.copy(t.p);
        mesh.visible = true;
        mesh.position.lerp(t.p, k);
      } else {
        mesh.visible = false;
      }
    }

    this.label.position.set(this.head.position.x, this.head.position.y + 0.3, this.head.position.z);

    // Voice-activity glow on the head.
    this.glow += (Math.min(1, this.level * 6) - this.glow) * 0.35;
    this.headMat.emissiveIntensity = this.muted ? 0 : this.glow * 0.9;
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
  }
}

// ------------------------------------------------------------------ world

export class World {
  constructor({ container, audio, onLocalPose, onToggleMute }) {
    this.audio = audio;
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
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const old = o.material;
      if (!cache.has(old)) {
        const m = new THREE.MeshLambertMaterial({
          map: old.map || null,
          emissive: old.emissive ? old.emissive.clone() : new THREE.Color(0),
          emissiveMap: old.emissiveMap || null,
          emissiveIntensity: old.emissiveIntensity ?? 1,
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
    return true;
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
    this.drawPanels();
  }

  removePeer(id) {
    const a = this.avatars.get(id);
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

  bindDesktopInput(el) {
    el.addEventListener('click', () => {
      if (!this.presenting && document.pointerLockElement !== el) el.requestPointerLock?.();
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
          if (!gp) continue;
          const hand = src.handedness;
          const ax = gp.axes;
          // xr-standard mapping puts the thumbstick on axes 2/3; fall back to 0/1.
          const x = dead(ax.length >= 4 ? ax[2] : ax[0] || 0);
          const y = dead(ax.length >= 4 ? ax[3] : ax[1] || 0);

          if (hand === 'left') {
            mx += x;
            mz -= y;
          } else if (hand === 'right') {
            // Snap turning (comfortable; smooth turning makes many people queasy)
            if (Math.abs(x) > 0.7 && this.snapReady) {
              this.turnRig((-Math.sign(x) * Math.PI) / 6);
              this.snapReady = false;
            } else if (Math.abs(x) < 0.3) {
              this.snapReady = true;
            }
          }

          // A / X button toggles the microphone
          const pressed = !!gp.buttons[4]?.pressed;
          if (hand && pressed && !this.btnWas[hand]) this.onToggleMute?.();
          if (hand) this.btnWas[hand] = pressed;
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

  async enterVR() {
    if (!navigator.xr) throw new Error('WebXR is not available in this browser.');
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor'],
    });
    await this.renderer.xr.setSession(session);
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
    const dt = Math.min(0.1, this.last ? (time - this.last) / 1000 : 0.016);
    this.last = time;

    this.locomote(dt);
    this.rig.updateMatrixWorld(true);

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

    this.renderer.render(this.scene, this.camera);
  }
}
