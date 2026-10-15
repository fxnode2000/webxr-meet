// A small turntable preview of an uploaded avatar, shown on the create/join screen.
// It has its own renderer and releases it as soon as the user joins, so it never competes with the room.

import * as THREE from 'three';

/** Free everything a built avatar (see avatar.js) holds on the GPU. */
export function disposeParts(parts) {
  if (!parts) return;
  const seen = new Set();
  for (const k of ['Head', 'Torso', 'HandL', 'HandR']) {
    parts[k]?.traverse((o) => {
      o.geometry?.dispose();
      const m = o.material;
      if (m && !seen.has(m)) {
        seen.add(m);
        m.map?.dispose();
        m.dispose();
      }
    });
  }
}

export class AvatarPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.parts = null;
    this.raf = 0;
  }

  init() {
    if (this.renderer) return;
    const c = this.canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(c.width, c.height, false);
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a96a8, 2.2));
    const sun = new THREE.DirectionalLight(0xfff0dd, 1.8);
    sun.position.set(1.5, 2.5, -2);
    this.scene.add(sun);
    this.camera = new THREE.PerspectiveCamera(30, c.width / c.height, 0.1, 10);
    this.camera.position.set(0, 1.25, -2.5); // the avatar's front is -Z, so we look at it from there
    this.camera.lookAt(0, 1.2, 0);
    this.turn = new THREE.Group();
    this.scene.add(this.turn);
  }

  /** parts: the object returned by buildAvatar(). Placed the way the room places them. */
  show(parts) {
    this.init();
    this.clear();
    this.parts = parts;
    const place = (obj, x, y, z) => {
      obj.position.set(x, y, z);
      this.turn.add(obj);
    };
    place(parts.Head, 0, 1.6, 0);
    place(parts.Torso, 0, 1.1, 0); // the room hangs the torso 0.5 m below the head
    place(parts.HandL, 0.3, 1.0, -0.1);
    place(parts.HandR, -0.3, 1.0, -0.1);
    this.canvas.hidden = false;
    this.last = performance.now();
    if (!this.raf) this.loop();
  }

  loop() {
    this.raf = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    this.turn.rotation.y += ((now - this.last) / 1000) * 0.7;
    this.last = now;
    this.renderer.render(this.scene, this.camera);
  }

  clear() {
    if (!this.parts) return;
    this.turn.clear();
    disposeParts(this.parts);
    this.parts = null;
  }

  hide() {
    this.clear();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas.hidden = true;
  }

  /** Release the WebGL context entirely (called when joining the room). */
  dispose() {
    this.hide();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer = null;
    }
  }
}
