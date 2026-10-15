// A stand-in for Copperline's wasm-bindgen module, following the WebEmu API documented in its docs/guide/browser.md.
// Used by the browser tests only. It is NOT an emulator: it draws a moving picture and plays a tone, 50 frames a second,
// and records what it was asked to do in window.__fake so tests can check it.
export const memory = new WebAssembly.Memory({ initial: 64 });
const W = 736;
const H = 284;
const PTR = 4096;
const log = (window.__fake = window.__fake || { keys: [], mouse: [], joy: [], ports: [], disks: [], resets: 0, frames: 0, still: false, crash: false, freed: 0, runs: 0 });

export default async function init() {
  return { memory };
}

export class WebEmu {
  constructor(model = 'A500', video = 'PAL', drives = 2) {
    if (!['A500', 'A1200'].includes(model)) throw new Error(`unknown model ${model}`);
    this.model = model;
    this.last = null;
    this.frame = 0;
    this.carry = 0;
    this.rows = 0;
    this.sec = 0;
    log.model = model;
    log.video = video;
  }
  load_rom(rom, ext) {
    if (!rom || rom.length < 1024) throw new Error('ROM too small');
    log.rom = { main: rom.length, ext: ext ? ext.length : 0 };
  }
  insert_floppy(drive, bytes, label) {
    if (bytes.length !== 901120) throw new Error('not an ADF');
    log.disks.push({ drive, label, bytes: bytes.length });
  }
  eject_floppy(drive) {
    log.disks.push({ drive, eject: true });
  }
  set_volume_percent() {}
  resync_clock() {
    this.last = null;
  }
  reset() {
    log.resets++;
  }
  free() {
    log.freed++;
  }
  emulated_seconds() {
    return this.sec;
  }
  run(nowMs, maxFrames) {
    log.runs++;
    if (log.crash) throw new Error('guru meditation (test crash)');
    if (this.last === null) {
      this.last = nowMs;
      return 0;
    }
    const due = Math.floor((nowMs - this.last) / 20);
    const n = Math.min(due, maxFrames);
    this.last += due * 20; // like the real pacer: forgive what we cannot catch up
    for (let i = 0; i < n; i++) this.step();
    return n;
  }
  step() {
    this.frame++;
    this.sec += 0.02;
    log.frames++;
    const still = log.still && this.frame > 5;
    if (!still || this.rows === 0) this.render(still ? 5 : this.frame);
    this.audio = this.audio || [];
    const a = new Float32Array(882 * 2); // 20 ms of 44.1 kHz stereo
    for (let i = 0; i < 882; i++) {
      const v = Math.sin(((this.frame * 882 + i) / 44100) * 2 * Math.PI * 440) * 0.5;
      a[i * 2] = v;
      a[i * 2 + 1] = v;
    }
    this.audio.push(a);
  }
  render(f) {
    const px = new Uint8Array(memory.buffer, PTR, W * H * 4);
    const hue = (f * 9) % 256;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const box = x >= (f * 7) % (W - 40) && x < ((f * 7) % (W - 40)) + 40 && y > 100 && y < 140;
        px[o] = box ? 255 : hue;
        px[o + 1] = box ? 255 : 255 - hue;
        px[o + 2] = box ? 255 : 120;
        px[o + 3] = 255;
      }
    }
    this.rows = H;
  }
  present_rows() {
    return this.rows;
  }
  present_width() {
    return W;
  }
  present_ptr() {
    return PTR;
  }
  take_audio() {
    const parts = this.audio || [];
    this.audio = [];
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) (out.set(p, o), (o += p.length));
    return out;
  }
  key_event(code, pressed) {
    log.keys.push([code, pressed]);
    return code !== 'F12'; // pretend F12 is not an Amiga key
  }
  mouse_delta(dx, dy) {
    log.mouse.push(['move', dx, dy]);
  }
  mouse_button(b, p) {
    log.mouse.push(['button', b, p]);
  }
  set_joystick_port(port, up, down, left, right, fire, b2) {
    log.joy.push([port, up, down, left, right, fire, b2]);
  }
  set_port_device(port, device) {
    log.ports.push([port, device]);
  }
}
