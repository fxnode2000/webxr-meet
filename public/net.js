// Signalling (WebSocket) + full-mesh WebRTC for voice.
//
// Rule that avoids offer collisions: whoever joins later makes the offers.
// A newcomer gets the list of people already in the room and calls each of them;
// the people already there just answer.

/**
 * Ask Opus for forward error correction and a fixed bitrate, on every audio line of the SDP.
 * Line 0 is the microphone (mono speech, 64 kbps); any further audio line is the shared screen's sound (96 kbps,
 * still mono: it is played from one spot in the room, so stereo would only cost bandwidth).
 * Exported so it can be tested on its own.
 */
export function tuneOpus(sdp) {
  const nl = sdp.includes('\r\n') ? '\r\n' : '\n';
  const parts = sdp.split(/(?=^m=)/m); // session header, then one chunk per media line
  let audioIdx = 0;
  const out = parts.map((part) => {
    if (!part.startsWith('m=audio')) return part;
    const bitrate = audioIdx++ === 0 ? '64000' : '96000';
    const m = part.match(/a=rtpmap:(\d+) opus\/48000\/2/);
    if (!m) return part;
    const pt = m[1];
    const lines = part.split(nl);
    const prefix = `a=fmtp:${pt} `;
    const idx = lines.findIndex((l) => l.startsWith(prefix));
    const params = new Map();
    if (idx >= 0) {
      for (const kv of lines[idx].slice(prefix.length).split(';')) {
        const [k, v] = kv.split('=');
        if (k) params.set(k.trim(), v);
      }
    }
    params.set('maxaveragebitrate', bitrate);
    params.set('stereo', '0');
    params.set('sprop-stereo', '0');
    params.set('useinbandfec', '1');
    params.set('usedtx', '0');
    const line = prefix + [...params].map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join(';');
    if (idx >= 0) lines[idx] = line;
    else {
      const r = lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
      lines.splice(r + 1, 0, line);
    }
    return lines.join(nl);
  });
  return out.join('');
}

const AVATAR_MAX_BYTES = 1_100_000;
const r1 = (n) => Math.round(n * 10) / 10;

export class Net {
  constructor() {
    this.ws = null;
    this.peers = new Map(); // id -> { id, pc, sender, initiator, queue, last }
    this.handlers = {};
    this.localStream = null;
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    this.pending = null;
    this.you = null;
    this.profileOn = false; // the server was started with --profile
    this.localAvatar = null; // ArrayBuffer of my own avatar, sent to every peer once the data channel opens
    this.localColor = null; // my random default-avatar colour (0xRRGGBB), sent to everyone
    this.localVideoTrack = null; // webcam track (desktop only), or null
    this.videoStream = null;
    this.localScreen = null; // { v, a, kind } the shared screen I am sending (a browser tab or the Amiga), or null
    this.screenStream = null; // msid carrier for the screen lines
  }

  on(evt, fn) {
    (this.handlers[evt] ||= []).push(fn);
    return this;
  }

  emit(evt, ...args) {
    for (const fn of this.handlers[evt] || []) {
      try {
        fn(...args);
      } catch (e) {
        console.error(`handler for ${evt} threw`, e);
      }
    }
  }

  async loadIce() {
    try {
      const r = await fetch('/api/ice', { cache: 'no-store' });
      const j = await r.json();
      if (Array.isArray(j.iceServers) && j.iceServers.length) this.iceServers = j.iceServers;
      this.profileOn = !!j.profile;
    } catch {}
  }

  connect() {
    if (this.ws) {
      // Replacing a dead socket: its close event must not look like a new drop.
      this.ws.onclose = this.ws.onmessage = this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not reach the server.'));
      ws.onmessage = (e) => this.onMessage(e.data);
      ws.onclose = () => this.emit('closed');
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  sendPose(pose) {
    if (this.ws && this.ws.readyState === 1 && this.ws.bufferedAmount < 64 * 1024) {
      this.ws.send(JSON.stringify({ type: 'pose', ...pose }));
    }
  }

  /** Send a create/join request and wait for the server's answer. */
  enter(msg) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.send(msg);
    });
  }

  onMessage(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    switch (m.type) {
      case 'joined': {
        this.you = m.you;
        const p = this.pending;
        this.pending = null;
        if (p) p.resolve(m);
        for (const peer of m.peers) this.makePeer(peer.id, true);
        break;
      }
      case 'error': {
        const p = this.pending;
        this.pending = null;
        if (p) p.reject(Object.assign(new Error(m.code), { code: m.code, info: m }));
        else this.emit('error', m);
        break;
      }
      case 'peer-joined':
        this.makePeer(m.peer.id, false);
        this.emit('peer-joined', m.peer);
        break;
      case 'peer-left':
        this.dropPeer(m.id);
        this.emit('peer-left', m.id);
        break;
      case 'signal':
        this.onSignal(m.from, m.data);
        break;
      case 'pose':
        this.emit('pose', m.from, m);
        break;
      case 'state':
        this.emit('state', m.from, m.muted);
        break;
      default:
        break;
    }
  }

  makePeer(id, initiator) {
    const existing = this.peers.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = {
      id, pc, sender: null, vsender: null, ssender: null, sasender: null, initiator, queue: Promise.resolve(), last: null,
      screenRx: { v: null, a: null }, screenCtl: null, screenOn: false,
    };
    this.peers.set(id, peer);

    // Fixed line order, the same on both sides (the caller creates the lines, the answerer follows them by order):
    //   audio 0 = microphone, video 0 = webcam, video 1 = shared screen, audio 1 = shared screen's sound.
    // Every line is always there, so starting or stopping a share is only a track swap, never a renegotiation.
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) peer.sender = pc.addTrack(track, this.localStream);
    }
    if (initiator && !peer.sender) peer.sender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender; // no mic: keep line 0

    // The caller always offers one (initially silent) video line, so a webcam can be switched on or off later with a
    // plain track swap: no renegotiation, so the voice connection is never touched. The other side picks it up
    // from the offer (see onSignal).
    if (initiator) {
      const vtx = pc.addTransceiver('video', { direction: 'sendrecv', streams: [this.videoStream || (this.videoStream = new MediaStream())] });
      peer.vsender = vtx.sender;
      if (this.localVideoTrack) vtx.sender.replaceTrack(this.localVideoTrack).catch((e) => console.warn('video start', e));
      const sc = this.screenStream || (this.screenStream = new MediaStream());
      peer.ssender = pc.addTransceiver('video', { direction: 'sendrecv', streams: [sc] }).sender;
      peer.sasender = pc.addTransceiver('audio', { direction: 'sendrecv', streams: [sc] }).sender;
      this.attachScreen(peer);
    }

    // Avatars travel over a small data channel next to the voice. The caller creates it, the other side receives it.
    if (initiator) this.setupChannel(peer, pc.createDataChannel('avatar', { ordered: true }));
    else pc.ondatachannel = (e) => this.setupChannel(peer, e.channel);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ type: 'signal', to: id, data: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      const kind = e.track.kind;
      // Which line is it? The second video and second audio line belong to the shared screen (see the line order above).
      const line = pc.getTransceivers().filter((t) => t.receiver.track.kind === kind).indexOf(e.transceiver);
      if (line === 1) {
        if (kind === 'video') peer.screenRx.v = e.track;
        else peer.screenRx.a = e.track;
        this.applyScreenCtl(peer);
        return;
      }
      const stream = e.streams[0] || new MediaStream([e.track]);
      // Voice goes to the audio engine, webcam video to the avatar's head. Never mix them up.
      if (kind === 'video') this.emit('video', id, stream);
      else this.emit('stream', id, stream);
    };
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable') this.tuneSenders(peer);
    };
    pc.onconnectionstatechange = () => this.emit('conn', id, pc.connectionState);
    pc.oniceconnectionstatechange = () => {
      // Only the original caller restarts ICE, which avoids both sides offering at once.
      if (pc.iceConnectionState === 'failed' && peer.initiator) pc.restartIce();
    };
    pc.onnegotiationneeded = () => {
      if (peer.initiator) this.makeOffer(peer).catch((e) => console.error('offer failed', e));
    };
    return peer;
  }

  setupChannel(peer, dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 64 * 1024;
    peer.dc = dc;
    peer.rx = null;
    dc.onopen = () => {
      if (this.localColor !== null) this.sendCtl(peer, { t: 'color', c: this.localColor });
      if (this.localVideoTrack) this.sendCtl(peer, { t: 'cam', on: true });
      if (this.localScreen) this.sendScreenCtl(peer);
      this.pushAvatar(peer);
    };
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.t === 'cam') {
          this.emit('cam', peer.id, !!m.on);
        } else if (m.t === 'screen') {
          peer.screenCtl = { on: !!m.on, audio: !!m.audio, kind: m.kind === 'emulator' ? 'emulator' : 'tab', emu: m.emu === 'arcade' ? 'arcade' : 'amiga' };
          this.applyScreenCtl(peer);
        } else if (m.t === 'emu-join') {
          this.emit('emu-join', peer.id, !!m.on);
        } else if (m.t === 'emu-joy') {
          // joystick bits from a player; the host validates and routes them (see emu/controls.js)
          if (Number.isInteger(m.b)) this.emit('emu-joy', peer.id, m.b);
        } else if (m.t === 'emu-port') {
          // host tells a guest which port they have (0 = none)
          if (m.p === 0 || m.p === 1 || m.p === 2 || m.p === 3) this.emit('emu-port', peer.id, m.p);
        } else if (m.t === 'color') {
          if (Number.isInteger(m.c) && m.c >= 0 && m.c <= 0xffffff) this.emit('color', peer.id, m.c);
        } else if (m.t === 'av-start') {
          const size = Number(m.size);
          // Never accept more than the published limit (plus a little slack).
          peer.rx = Number.isFinite(size) && size > 0 && size <= AVATAR_MAX_BYTES ? { size, got: 0, chunks: [] } : null;
        } else if (m.t === 'av-end' && peer.rx) {
          const rx = peer.rx;
          peer.rx = null;
          if (rx.got === rx.size) {
            const out = new Uint8Array(rx.size);
            let o = 0;
            for (const c of rx.chunks) {
              out.set(new Uint8Array(c), o);
              o += c.byteLength;
            }
            this.emit('avatar', peer.id, out.buffer);
          }
        }
      } else if (peer.rx) {
        peer.rx.got += e.data.byteLength;
        if (peer.rx.got > peer.rx.size) peer.rx = null; // sender lied about the size: drop it
        else peer.rx.chunks.push(e.data);
      }
    };
  }

  sendCtl(peer, obj) {
    if (peer.dc && peer.dc.readyState === 'open') {
      try {
        peer.dc.send(JSON.stringify(obj));
      } catch {}
    }
  }

  /** Start, replace or stop sending my webcam. It is only a track swap, so the voice connection is never touched. */
  setCamera(track) {
    this.localVideoTrack = track || null;
    if (track && !this.videoStream) this.videoStream = new MediaStream();
    for (const p of this.peers.values()) {
      if (p.vsender) p.vsender.replaceTrack(track || null).catch((e) => console.warn('video replaceTrack', e));
      this.sendCtl(p, { t: 'cam', on: !!track });
    }
  }

  /**
   * Start sending a shared screen: stream = a MediaStream with one video track and (optionally) one audio track.
   * opts.kind is 'tab' (a browser tab) or 'emulator' (the Amiga). Only a track swap, so voice is never touched.
   */
  startScreen(stream, opts = {}) {
    const v = stream?.getVideoTracks()[0] || null;
    const a = stream?.getAudioTracks()[0] || null;
    if (!v) throw new Error('A shared screen needs a video track.');
    const kind = opts.kind === 'emulator' ? 'emulator' : 'tab';
    if (kind === 'emulator') v.contentHint = 'detail'; // sharp pixels beat smooth motion for an emulator picture
    this.localScreen = { v, a, kind, emu: opts.emu === 'arcade' ? 'arcade' : 'amiga' };
    for (const p of this.peers.values()) this.attachScreen(p);
  }

  /** Stop sending the shared screen (the caller stops the tracks themselves). */
  stopScreen() {
    this.localScreen = null;
    for (const p of this.peers.values()) this.attachScreen(p);
  }

  /** Put whatever I am sharing (or nothing) on this peer's screen lines and tell them. */
  attachScreen(peer) {
    if (!peer.ssender || !peer.sasender) return;
    const sc = this.localScreen;
    peer.ssender.replaceTrack(sc ? sc.v : null).catch((e) => console.warn('screen video', e));
    peer.sasender.replaceTrack(sc ? sc.a : null).catch((e) => console.warn('screen audio', e));
    this.tuneSenders(peer);
    this.sendScreenCtl(peer);
  }

  /** Ask the host to put me on a joystick port (on) or take me off (off). Goes to everyone; only the host acts on it. */
  emuJoin(on) {
    for (const p of this.peers.values()) this.sendCtl(p, { t: 'emu-join', on: !!on });
  }

  /** My joystick state as packed bits (emu/controls.js). Sent to the host only. */
  emuJoy(hostId, bits) {
    const p = this.peers.get(hostId);
    if (p) this.sendCtl(p, { t: 'emu-joy', b: bits });
  }

  /** Host: tell one guest which port they have (0 = none). */
  emuPort(guestId, port) {
    const p = this.peers.get(guestId);
    if (p) this.sendCtl(p, { t: 'emu-port', p: port });
  }

  sendScreenCtl(peer) {
    const sc = this.localScreen;
    this.sendCtl(peer, { t: 'screen', on: !!sc, audio: !!(sc && sc.a), kind: sc ? sc.kind : 'tab', emu: sc ? sc.emu : 'amiga' });
  }

  /** The sender said their screen is on or off: hand it to the room once the tracks have really arrived. */
  applyScreenCtl(peer) {
    const c = peer.screenCtl;
    if (!c) return;
    if (!c.on) {
      if (peer.screenOn) {
        peer.screenOn = false;
        this.emit('screen-end', peer.id);
      }
      return;
    }
    const v = peer.screenRx.v;
    if (!v) return; // the video line is not here yet; ontrack will call us again
    const wantAudio = c.audio && peer.screenRx.a;
    const key = `${c.kind}:${c.emu}:${wantAudio ? 1 : 0}`;
    if (peer.screenOn === key) return;
    peer.screenOn = key;
    this.emit('screen', peer.id, new MediaStream(wantAudio ? [v, peer.screenRx.a] : [v]), 'video', { kind: c.kind, emu: c.emu });
  }

  /**
   * Voice is the priority. Webcam: tiny and very low priority. Shared screen: much bigger (it is the point of the
   * share) but still below voice. Run again whenever a share starts, because its kind decides the budget.
   */
  tuneSenders(peer) {
    const sc = this.localScreen;
    const want = (s) => {
      if (s === peer.sender) return { priority: 'high' };
      if (s === peer.vsender) return { maxBitrate: 200000, maxFramerate: 15, priority: 'very-low' };
      if (s === peer.sasender) return { priority: 'medium' };
      if (s === peer.ssender) {
        return sc && sc.kind === 'emulator'
          ? { maxBitrate: 2000000, maxFramerate: 50, priority: 'low', degradation: 'maintain-resolution' }
          : { maxBitrate: 2500000, maxFramerate: 30, priority: 'low' };
      }
      return null;
    };
    for (const s of peer.pc.getSenders()) {
      const w = want(s);
      if (!w) continue;
      try {
        const params = s.getParameters();
        if (!params.encodings || !params.encodings.length) continue;
        const e = params.encodings[0];
        let changed = false;
        if (w.maxBitrate !== undefined && e.maxBitrate !== w.maxBitrate) (e.maxBitrate = w.maxBitrate), (changed = true);
        if (w.maxFramerate !== undefined && e.maxFramerate !== w.maxFramerate) (e.maxFramerate = w.maxFramerate), (changed = true);
        if (e.priority !== w.priority) (e.priority = e.networkPriority = w.priority), (changed = true);
        if (w.degradation && params.degradationPreference !== w.degradation) (params.degradationPreference = w.degradation), (changed = true);
        if (changed) s.setParameters(params).catch(() => {});
      } catch {}
    }
  }

  /** Send my avatar to one peer in small chunks, pausing while the channel's buffer is full. */
  async pushAvatar(peer) {
    const dc = peer.dc;
    const buf = this.localAvatar;
    if (!dc || dc.readyState !== 'open' || !buf) return;
    try {
      dc.send(JSON.stringify({ t: 'av-start', size: buf.byteLength }));
      const CHUNK = 16 * 1024;
      for (let off = 0; off < buf.byteLength; off += CHUNK) {
        if (dc.readyState !== 'open') return;
        if (dc.bufferedAmount > 256 * 1024) {
          await new Promise((resolve) => {
            dc.onbufferedamountlow = () => {
              dc.onbufferedamountlow = null;
              resolve();
            };
          });
        }
        dc.send(buf.slice(off, off + CHUNK));
      }
      dc.send(JSON.stringify({ t: 'av-end' }));
    } catch (e) {
      console.warn('avatar send failed', e);
    }
  }

  async makeOffer(peer) {
    const pc = peer.pc;
    if (pc.signalingState !== 'stable') return;
    const offer = await pc.createOffer();
    offer.sdp = tuneOpus(offer.sdp);
    await pc.setLocalDescription(offer);
    this.send({ type: 'signal', to: peer.id, data: { description: pc.localDescription } });
  }

  onSignal(from, data) {
    if (!data) return;
    const peer = this.peers.get(from) || this.makePeer(from, false);
    // Handle one signal at a time per peer so ICE candidates never overtake the SDP.
    peer.queue = peer.queue
      .then(async () => {
        const pc = peer.pc;
        if (data.description) {
          const d = data.description;
          if (d.type === 'offer') {
            await pc.setRemoteDescription(d);
            if (!peer.vsender) {
              // Use the caller's video line for my own webcam too.
              const vt = pc.getTransceivers().find((t) => t.receiver.track.kind === 'video');
              if (vt) {
                vt.direction = 'sendrecv';
                peer.vsender = vt.sender;
                if (this.localVideoTrack) await vt.sender.replaceTrack(this.localVideoTrack).catch((e) => console.warn('video start', e));
              }
            }
            if (!peer.ssender) {
              // Same for the shared screen: the second video line and the second audio line (see makePeer).
              const tcs = pc.getTransceivers();
              const sv = tcs.filter((t) => t.receiver.track.kind === 'video')[1];
              const sa = tcs.filter((t) => t.receiver.track.kind === 'audio')[1];
              if (sv && sa) {
                sv.direction = sa.direction = 'sendrecv';
                peer.ssender = sv.sender;
                peer.sasender = sa.sender;
                this.attachScreen(peer);
              }
            }
            const answer = await pc.createAnswer();
            answer.sdp = tuneOpus(answer.sdp);
            await pc.setLocalDescription(answer);
            this.send({ type: 'signal', to: from, data: { description: pc.localDescription } });
          } else if (d.type === 'answer') {
            await pc.setRemoteDescription(d);
          }
        } else if (data.candidate) {
          await pc.addIceCandidate(data.candidate);
        }
      })
      .catch((err) => console.warn('signal handling error', err));
  }

  dropPeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    if (peer.screenOn) this.emit('screen-end', id);
    peer.pc.onicecandidate = peer.pc.ontrack = peer.pc.onconnectionstatechange = null;
    peer.pc.oniceconnectionstatechange = peer.pc.onnegotiationneeded = peer.pc.ondatachannel = peer.pc.onsignalingstatechange = null;
    if (peer.dc) peer.dc.onopen = peer.dc.onmessage = peer.dc.onbufferedamountlow = null;
    peer.pc.close();
    this.peers.delete(id);
  }

  async replaceTrack(track) {
    for (const p of this.peers.values()) {
      if (p.sender) await p.sender.replaceTrack(track).catch((e) => console.warn('replaceTrack', e));
    }
  }

  /** The mid of the nth audio/video line (0 = microphone / webcam), so the screen lines never skew the voice figures. */
  lineMid(peer, kind, n) {
    const t = peer.pc.getTransceivers().filter((x) => x.receiver.track.kind === kind)[n];
    return t && t.mid != null ? t.mid : null;
  }

  /** Link quality for the debug panel: path type, RTT, jitter, loss, bitrate. */
  async stats(id) {
    const peer = this.peers.get(id);
    if (!peer) return null;
    const rep = await peer.pc.getStats();
    const micMid = this.lineMid(peer, 'audio', 0);
    let inbound = null;
    let pair = null;
    rep.forEach((s) => {
      if (s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio') && (s.mid === undefined || micMid === null || s.mid === micMid)) inbound = s;
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
    });
    const out = {};
    if (pair) {
      if (pair.currentRoundTripTime != null) out.rtt = pair.currentRoundTripTime * 1000;
      const lc = rep.get(pair.localCandidateId);
      const rc = rep.get(pair.remoteCandidateId);
      out.path = lc?.candidateType === 'relay' || rc?.candidateType === 'relay' ? 'relay' : 'direct';
    }
    if (inbound) {
      if (inbound.jitter != null) out.jitter = inbound.jitter * 1000;
      const total = (inbound.packetsLost || 0) + (inbound.packetsReceived || 0);
      out.loss = total ? ((inbound.packetsLost || 0) / total) * 100 : 0;
      if (peer.last && inbound.timestamp > peer.last.ts) {
        out.kbps = ((inbound.bytesReceived - peer.last.bytes) * 8) / (inbound.timestamp - peer.last.ts);
      }
      peer.last = { bytes: inbound.bytesReceived, ts: inbound.timestamp };
    }
    return out;
  }

  /** Detailed link figures for the profiling log (voice quality, video decode/encode, bitrates). Deltas are per call. */
  async profileStats(id) {
    const peer = this.peers.get(id);
    if (!peer) return null;
    const rep = await peer.pc.getStats();
    const micMid = this.lineMid(peer, 'audio', 0);
    const camMid = this.lineMid(peer, 'video', 0);
    const mine = (st, mid) => st.mid === undefined || mid === null || st.mid === mid; // not the shared screen's lines
    const now = performance.now();
    const prev = peer.pLast || {};
    const cur = {};
    const out = { conn: peer.pc.connectionState, ice: peer.pc.iceConnectionState };
    const kbps = (key, bytes) => {
      cur[key] = bytes;
      return prev[key] !== undefined && prev.ts ? Math.round(((bytes - prev[key]) * 8) / (now - prev.ts)) : null;
    };
    rep.forEach((st) => {
      if (st.type === 'candidate-pair' && st.nominated && st.state === 'succeeded') {
        out.rttMs = st.currentRoundTripTime != null ? Math.round(st.currentRoundTripTime * 1000) : null;
        out.availOutKbps = st.availableOutgoingBitrate ? Math.round(st.availableOutgoingBitrate / 1000) : null;
        const lc = rep.get(st.localCandidateId);
        const rc = rep.get(st.remoteCandidateId);
        out.path = lc?.candidateType === 'relay' || rc?.candidateType === 'relay' ? 'relay' : 'direct';
      } else if (st.type === 'inbound-rtp' && st.kind === 'audio' && mine(st, micMid)) {
        out.aIn = {
          kbps: kbps('aInB', st.bytesReceived),
          jitterMs: st.jitter != null ? r1(st.jitter * 1000) : null,
          lost: st.packetsLost,
          jbDelayMs: st.jitterBufferEmittedCount ? r1((st.jitterBufferDelay / st.jitterBufferEmittedCount) * 1000) : null,
          concealedPct: st.totalSamplesReceived ? r1((st.concealedSamples / st.totalSamplesReceived) * 100) : null,
        };
      } else if (st.type === 'inbound-rtp' && st.kind === 'video' && st.framesDecoded > 0 && mine(st, camMid)) {
        out.vIn = {
          kbps: kbps('vInB', st.bytesReceived),
          fps: st.framesPerSecond ?? null,
          size: st.frameWidth ? `${st.frameWidth}x${st.frameHeight}` : null,
          decodeMs: st.framesDecoded ? r1((st.totalDecodeTime / st.framesDecoded) * 1000) : null,
          freezes: st.freezeCount ?? null,
          dropped: st.framesDropped ?? null,
        };
      } else if (st.type === 'outbound-rtp' && st.kind === 'audio' && mine(st, micMid)) {
        out.aOut = { kbps: kbps('aOutB', st.bytesSent) };
      } else if (st.type === 'outbound-rtp' && st.kind === 'video' && st.bytesSent > 0 && mine(st, camMid)) {
        out.vOut = {
          kbps: kbps('vOutB', st.bytesSent),
          fps: st.framesPerSecond ?? null,
          encodeMs: st.framesEncoded ? r1((st.totalEncodeTime / st.framesEncoded) * 1000) : null,
          limited: st.qualityLimitationReason && st.qualityLimitationReason !== 'none' ? st.qualityLimitationReason : null,
        };
      }
    });
    cur.ts = now;
    peer.pLast = cur;
    return out;
  }

  /** Forget every voice link (used before rejoining on a fresh socket). */
  dropAllPeers() {
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
  }

  close() {
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
  }
}
