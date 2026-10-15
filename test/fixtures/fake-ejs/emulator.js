// A stand-in for EmulatorJS (src/emulator.js): same shape as far as ArcadeHost uses it, no real emulation.
// Draws a moving picture, plays a tone through its own AudioContext straight to the speakers (as the real one does),
// records every simulateInput call, and fails on request.
class EmulatorJS {
  constructor(sel, config) {
    window.__ejs = this;
    this.config = config;
    this.fns = {};
    this.inputs = [];
    this.restarts = 0;
    this.paused = false;
    this.controls = {};
    const root = document.querySelector(sel);
    this.elements = { parent: root };
    this.canvas = document.createElement('canvas');
    this.canvas.width = 320;
    this.canvas.height = 240;
    root.appendChild(this.canvas);
    this.gameManager = { simulateInput: (p, i, v) => this.inputs.push([p, i, v]), restart: () => this.restarts++ };
    this.Module = { pauseMainLoop: () => (this.paused = true) };
    setTimeout(() => {
      if (config.gameName === 'bad.zip') {
        this.textElem = { innerText: 'Failed to start game' };
        this.failedToStart = true;
        return;
      }
      this.controls = { 0: { 0: { value: 90 } }, 1: {}, 2: {}, 3: {} }; // EmulatorJS loads its default keys at start
      const g = this.canvas.getContext('2d');
      let n = 0;
      this.timer = setInterval(() => {
        n++;
        g.fillStyle = `hsl(${(n * 9) % 360},80%,50%)`;
        g.fillRect(0, 0, 320, 240);
        g.fillStyle = '#fff';
        g.fillRect((n * 5) % 280, 100, 30, 30);
      }, 20);
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      (this.fns.start || []).forEach((f) => f());
    }, 80);
  }
  on(e, f) {
    (this.fns[e] ||= []).push(f);
  }
}
window.EmulatorJS = EmulatorJS;
