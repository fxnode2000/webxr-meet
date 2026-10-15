// Spatial voice engine (Web Audio).
//
// Signal path per remote person:
//   MediaStream -> source -> panner (HRTF, distance + voice cone) -> out -> master -> limiter -> speakers
//                         -> flat (non-spatial A/B path)           ->
//                 out -> reverb send -> shared ConvolverNode -> master
// Everything is mono Opus from the network; the panner turns it into binaural stereo.

function makeImpulse(ctx, seconds = 0.75) {
  // Synthetic small-room reverb tail: noise that decays and gets darker over time.
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const pre = Math.floor(rate * 0.012);
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += ((Math.random() * 2 - 1) - lp) * (0.6 - 0.45 * t);
      d[i] = i < pre ? 0 : lp * Math.pow(1 - t, 3);
    }
  }
  return buf;
}

function rms(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

export class SpatialAudio {
  constructor() {
    this.ctx = null;
    this.peers = new Map();
    this.local = null;
    this.s = { master: 1, spatial: true, rolloff: 1, refDistance: 2, reverb: 0.15, directivity: 0.35, screen: 0.6 };
  }

  /** Must be called from a user gesture (click) so the browser lets audio start. */
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));

    this.master = ctx.createGain();
    // Gentle safety limiter so three people talking at once can never clip.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.15;
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.reverbIn = ctx.createGain();
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx);
    this.reverbIn.connect(this.reverb);
    this.reverb.connect(this.master);

    this.apply();
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch (e) {
        console.warn('AudioContext resume failed', e);
      }
    }
  }

  /** Open the microphone with the processing that matters for speech. */
  async openMic(deviceId) {
    const constraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { ...constraints, deviceId: { exact: deviceId } } : constraints,
        video: false,
      });
    } catch (e) {
      if (deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
      } else {
        throw e;
      }
    }
    if (this.local) this.local.src.disconnect();
    const src = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an); // meter only, never routed to the speakers
    this.local = { src, an, buf: new Float32Array(an.fftSize) };
    return stream;
  }

  set(partial) {
    Object.assign(this.s, partial);
    this.apply();
  }

  apply() {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(this.s.master, this.ctx.currentTime, 0.02);
    for (const p of this.peers.values()) this.applyPeer(p);
    if (this.scr) this.scr.gain.gain.setTargetAtTime(this.s.screen, this.ctx.currentTime, 0.05);
  }

  applyPeer(p) {
    const s = this.s;
    const t = this.ctx.currentTime;
    p.panner.refDistance = Math.max(0.1, s.refDistance);
    p.panner.rolloffFactor = s.rolloff;
    p.panner.coneOuterGain = 1 - 0.7 * s.directivity;
    p.spatialGain.gain.setTargetAtTime(s.spatial ? 1 : 0, t, 0.02);
    p.flatGain.gain.setTargetAtTime(s.spatial ? 0 : 1, t, 0.02);
    p.send.gain.setTargetAtTime(s.reverb * 0.6, t, 0.05);
  }

  addPeer(id, stream) {
    this.removePeer(id);
    const ctx = this.ctx;

    // Chrome only delivers a WebRTC stream's audio to Web Audio if the stream is
    // also attached to a media element. Keep it muted: Web Audio does the playback.
    const el = new Audio();
    el.muted = true;
    el.autoplay = true;
    el.srcObject = stream;
    el.play().catch(() => {});

    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.maxDistance = 100;
    panner.coneInnerAngle = 80;
    panner.coneOuterAngle = 220;

    const spatialGain = ctx.createGain();
    const flatGain = ctx.createGain();
    const out = ctx.createGain();
    const send = ctx.createGain();

    src.connect(an);
    src.connect(panner);
    panner.connect(spatialGain);
    spatialGain.connect(out);
    src.connect(flatGain);
    flatGain.connect(out);
    out.connect(this.master);
    out.connect(send);
    send.connect(this.reverbIn);

    const p = { id, el, stream, src, an, buf: new Float32Array(an.fftSize), panner, spatialGain, flatGain, out, send };
    this.peers.set(id, p);
    this.applyPeer(p);
  }


  /** Play a shared screen's sound from the screen itself (pos = its centre, nrm = the way it faces). */
  setScreenAudio(stream, pos, nrm) {
    this.clearScreenAudio();
    if (!this.ctx || !stream || !stream.getAudioTracks().length) return;
    const ctx = this.ctx;
    const el = new Audio(); // Chrome needs the stream attached to an element before Web Audio gets its sound
    el.muted = true;
    el.srcObject = stream;
    el.play().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 2;
    panner.rolloffFactor = 0.6;
    panner.maxDistance = 100;
    if (panner.positionX) {
      panner.positionX.value = pos.x; panner.positionY.value = pos.y; panner.positionZ.value = pos.z;
      panner.orientationX.value = nrm.x; panner.orientationY.value = nrm.y; panner.orientationZ.value = nrm.z;
    } else {
      panner.setPosition(pos.x, pos.y, pos.z);
      panner.setOrientation(nrm.x, nrm.y, nrm.z);
    }
    panner.coneInnerAngle = 140;
    panner.coneOuterAngle = 300;
    panner.coneOuterGain = 0.6;
    const gain = ctx.createGain();
    gain.gain.value = this.s.screen;
    src.connect(panner);
    panner.connect(gain);
    gain.connect(this.master);
    this.scr = { el, src, panner, gain };
  }

  clearScreenAudio() {
    const p = this.scr;
    if (!p) return;
    try {
      p.src.disconnect();
      p.panner.disconnect();
      p.gain.disconnect();
    } catch {}
    p.el.pause();
    p.el.srcObject = null;
    this.scr = null;
  }

  removePeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    try {
      p.src.disconnect();
      p.panner.disconnect();
      p.spatialGain.disconnect();
      p.flatGain.disconnect();
      p.out.disconnect();
      p.send.disconnect();
    } catch {}
    p.el.pause();
    p.el.srcObject = null;
    this.peers.delete(id);
  }

  /** Listener = the local head. pos/fwd/up are THREE.Vector3-like. */
  setListener(pos, fwd, up) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos.x;
      l.positionY.value = pos.y;
      l.positionZ.value = pos.z;
      l.forwardX.value = fwd.x;
      l.forwardY.value = fwd.y;
      l.forwardZ.value = fwd.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  /** A remote person's mouth position and the direction they are facing. */
  updatePeer(id, pos, fwd) {
    const p = this.peers.get(id);
    if (!p) return;
    const n = p.panner;
    if (n.positionX) {
      n.positionX.value = pos.x;
      n.positionY.value = pos.y;
      n.positionZ.value = pos.z;
      n.orientationX.value = fwd.x;
      n.orientationY.value = fwd.y;
      n.orientationZ.value = fwd.z;
    } else {
      n.setPosition(pos.x, pos.y, pos.z);
      n.setOrientation(fwd.x, fwd.y, fwd.z);
    }
  }

  level(id) {
    const p = this.peers.get(id);
    return p ? rms(p.an, p.buf) : 0;
  }

  localLevel() {
    return this.local ? rms(this.local.an, this.local.buf) : 0;
  }

  /** Short non-spatial beep, so you can hear mute toggles while in VR. */
  cue(kind) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.value = kind === 'on' ? 880 : 440;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.16);
  }
}
