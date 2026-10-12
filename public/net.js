// Signalling (WebSocket) + full-mesh WebRTC for voice.
//
// Rule that avoids offer collisions: whoever joins later makes the offers.
// A newcomer gets the list of people already in the room and calls each of them;
// the people already there just answer.

/** Ask Opus for a higher speech bitrate, mono, with forward error correction. */
function tuneOpus(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/);
  if (!m) return sdp;
  const pt = m[1];
  const lines = sdp.split('\r\n');
  const prefix = `a=fmtp:${pt} `;
  const idx = lines.findIndex((l) => l.startsWith(prefix));
  const params = new Map();
  if (idx >= 0) {
    for (const kv of lines[idx].slice(prefix.length).split(';')) {
      const [k, v] = kv.split('=');
      if (k) params.set(k.trim(), v);
    }
  }
  params.set('maxaveragebitrate', '64000');
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
  return lines.join('\r\n');
}

export class Net {
  constructor() {
    this.ws = null;
    this.peers = new Map(); // id -> { id, pc, sender, initiator, queue, last }
    this.handlers = {};
    this.localStream = null;
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    this.pending = null;
    this.you = null;
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
    } catch {}
  }

  connect() {
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
    const peer = { id, pc, sender: null, initiator, queue: Promise.resolve(), last: null };
    this.peers.set(id, peer);

    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) peer.sender = pc.addTrack(track, this.localStream);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ type: 'signal', to: id, data: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      this.emit('stream', id, stream);
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
    peer.pc.onicecandidate = peer.pc.ontrack = peer.pc.onconnectionstatechange = null;
    peer.pc.oniceconnectionstatechange = peer.pc.onnegotiationneeded = null;
    peer.pc.close();
    this.peers.delete(id);
  }

  async replaceTrack(track) {
    for (const p of this.peers.values()) {
      if (p.sender) await p.sender.replaceTrack(track).catch((e) => console.warn('replaceTrack', e));
    }
  }

  /** Link quality for the debug panel: path type, RTT, jitter, loss, bitrate. */
  async stats(id) {
    const peer = this.peers.get(id);
    if (!peer) return null;
    const rep = await peer.pc.getStats();
    let inbound = null;
    let pair = null;
    rep.forEach((s) => {
      if (s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) inbound = s;
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

  close() {
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
  }
}
