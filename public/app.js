// Lobby, HUD and glue between audio, network and the 3D world.

import { SpatialAudio } from './audio.js';
import { Net } from './net.js';
import { World, SLOT_CSS } from './world.js';

const $ = (id) => document.getElementById(id);

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const audio = new SpatialAudio();
const net = new Net();
let world = null;
let micStream = null;
let muted = false;
let me = null;
let roomId = null;
const people = new Map(); // id -> { id, name, slot, muted }
const rows = new Map(); // id ('me' for self) -> { bar, stat, mic }
const conns = new Map(); // id -> RTCPeerConnection state

const m = location.pathname.match(/^\/r\/([a-z0-9]+)/i);
const roomIdFromUrl = m ? m[1].toLowerCase() : null;

// ------------------------------------------------------------ lobby

function showError(text) {
  $('lobbyErr').textContent = text;
}

function errorText(e) {
  const i = e.info || {};
  switch (e.code) {
    case 'no-room': return "That room doesn't exist (any more). Ask the host for a fresh link.";
    case 'full': return 'This room is full (3 people maximum).';
    case 'bad-pin': return `Wrong PIN. ${i.triesLeft} ${i.triesLeft === 1 ? 'try' : 'tries'} left.`;
    case 'locked': return `Too many wrong PINs. Try again in ${i.retryIn} seconds.`;
    case 'bad-name': return 'Please enter a name.';
    case 'bad-pin-format': return 'The PIN must be exactly 4 digits.';
    case 'busy': return 'The server is busy. Try again in a moment.';
    default: return e.message || 'Something went wrong.';
  }
}

function micErrorText(e) {
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
    return "Microphone access was blocked. Allow the microphone for this site in the browser's site settings, then try again.";
  }
  if (e && e.name === 'NotFoundError') return 'No microphone was found.';
  return `Could not open the microphone: ${e && e.message ? e.message : e}`;
}

async function initLobby() {
  $('name').value = store.get('name', '');

  if (!window.isSecureContext || !navigator.mediaDevices) {
    showError('This page needs HTTPS (or localhost) for microphone and VR access. Open the https:// address printed by the server.');
    $('go').disabled = true;
  }

  $('usePin').onchange = () => {
    $('pin').hidden = !$('usePin').checked;
    if (!$('pin').hidden) $('pin').focus();
  };

  if (!roomIdFromUrl) return;

  $('createOpts').hidden = true;
  $('lobbyTitle').textContent = 'Join the room';
  $('go').textContent = 'Join room';
  try {
    const info = await (await fetch(`/api/room/${roomIdFromUrl}`, { cache: 'no-store' })).json();
    if (!info.exists) {
      showError(errorText({ code: 'no-room' }));
      $('go').disabled = true;
    } else if (info.full) {
      showError(errorText({ code: 'full' }));
      $('go').disabled = true;
    } else {
      $('lobbyInfo').textContent = info.hostName ? `${info.hostName} invited you.` : 'You have been invited.';
      $('joinPinWrap').hidden = !info.needsPin;
    }
  } catch {
    showError('Could not reach the server.');
  }
}

$('go').onclick = async () => {
  showError('');
  const name = $('name').value.trim();
  if (!name) return showError('Please enter your name.');

  let pin = null;
  if (!roomIdFromUrl && $('usePin').checked) {
    pin = $('pin').value.trim();
    if (!/^\d{4}$/.test(pin)) return showError('The PIN must be exactly 4 digits.');
  }
  if (roomIdFromUrl && !$('joinPinWrap').hidden) {
    pin = $('joinPin').value.trim();
    if (!/^\d{4}$/.test(pin)) return showError('Enter the 4-digit PIN.');
  }

  store.set('name', name);
  $('go').disabled = true;
  $('go').textContent = 'Connecting…';
  try {
    await enter(name, pin);
  } catch (e) {
    showError(errorText(e));
    $('go').disabled = false;
    $('go').textContent = roomIdFromUrl ? 'Join room' : 'Create room';
    if (net.ws && !roomId) net.close();
  }
};

// ------------------------------------------------------------ joining

function wireNet() {
  net.on('stream', (id, stream) => audio.addPeer(id, stream));
  net.on('peer-joined', (p) => addPerson(p));
  net.on('peer-left', (id) => removePerson(id));
  net.on('pose', (id, msg) => world?.setPose(id, msg));
  net.on('state', (id, isMuted) => {
    const p = people.get(id);
    if (p) p.muted = isMuted;
    world?.setMuted(id, isMuted);
    setRowMuted(id, isMuted);
  });
  net.on('conn', (id, state) => {
    conns.set(id, state);
  });
  net.on('closed', () => {
    showBanner('Lost the connection to the server. Reload the page to rejoin.');
  });
}

async function enter(name, pin) {
  // Everything audio-related has to start inside this click handler.
  audio.init();
  await audio.resume();

  try {
    micStream = await audio.openMic(store.get('micId', undefined));
  } catch (e) {
    throw new Error(micErrorText(e));
  }
  net.localStream = micStream;

  await net.loadIce();
  await net.connect();
  const res = await net.enter(
    roomIdFromUrl ? { type: 'join', room: roomIdFromUrl, name, pin } : { type: 'create', name, pin },
  );

  me = res.you;
  roomId = res.room;
  if (!roomIdFromUrl) history.replaceState(null, '', `/r/${roomId}`);

  world = new World({
    container: $('stage'),
    audio,
    onLocalPose: (pose) => net.sendPose(pose),
    onToggleMute: () => toggleMute(),
  });
  await world.loadKitchen('/models/kitchen.glb'); // falls back to the round hall on failure
  world.setSelf(me.slot, me.name);
  for (const p of people.values()) world.addPeer(p); // peers added before the world existed
  world.setBrightness(store.get('brightness', 1));

  $('roomCode').textContent = roomId;
  $('pinBadge').hidden = !res.hasPin;
  $('inviteLink').value = `${location.origin}/r/${roomId}`;
  for (const p of res.peers) addPerson(p);
  renderPeople();

  $('lobby').hidden = true;
  $('hud').hidden = false;

  setupSettings();
  populateMics();
  setupVr();
  setInterval(updateMeters, 80);
  setInterval(updateStats, 2000);
}

// ------------------------------------------------------------ people list

function addPerson(p) {
  people.set(p.id, { id: p.id, name: p.name, slot: p.slot, muted: !!p.muted });
  world?.addPeer(p);
  renderPeople();
}

function removePerson(id) {
  people.delete(id);
  audio.removePeer(id);
  world?.removePeer(id);
  renderPeople();
}

function renderPeople() {
  const root = $('people');
  root.textContent = '';
  rows.clear();
  const all = [{ id: 'me', name: `${me.name} (you)`, slot: me.slot, muted }, ...people.values()];
  for (const p of all) {
    const row = document.createElement('div');
    row.className = 'person';
    const dot = document.createElement('i');
    dot.className = 'dot';
    dot.style.background = SLOT_CSS[p.slot % 3];
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name; // textContent: names are user input
    const mic = document.createElement('span');
    mic.className = 'mic';
    name.appendChild(mic);
    const meter = document.createElement('span');
    meter.className = 'meter';
    const bar = document.createElement('i');
    meter.appendChild(bar);
    const stat = document.createElement('span');
    stat.className = 'pstat dim';
    stat.textContent = p.id === 'me' ? '' : 'connecting…';
    row.append(dot, name, meter, stat);
    root.appendChild(row);
    rows.set(p.id, { bar, stat, mic });
    setRowMuted(p.id, p.muted);
  }
}

function setRowMuted(id, isMuted) {
  const r = rows.get(id);
  if (r) r.mic.textContent = isMuted ? 'mic off' : '';
}

function levelToPercent(rms) {
  const db = 20 * Math.log10(rms + 1e-6);
  return Math.max(0, Math.min(1, (db + 60) / 45)) * 100;
}

function updateMeters() {
  const me_ = rows.get('me');
  if (me_) me_.bar.style.width = `${muted ? 0 : levelToPercent(audio.localLevel())}%`;
  for (const id of people.keys()) {
    const r = rows.get(id);
    if (r) r.bar.style.width = `${levelToPercent(audio.level(id))}%`;
  }
}

async function updateStats() {
  for (const id of people.keys()) {
    const r = rows.get(id);
    if (!r) continue;
    const s = await net.stats(id).catch(() => null);
    if (!s || (s.rtt == null && s.jitter == null)) {
      const c = conns.get(id);
      r.stat.textContent = c && c !== 'connected' ? `${c}…` : 'connecting…';
      continue;
    }
    const parts = [s.path];
    if (s.rtt != null) parts.push(`${s.rtt.toFixed(0)} ms rtt`);
    if (s.jitter != null) parts.push(`${s.jitter.toFixed(1)} ms jitter`);
    if (s.loss != null) parts.push(`${s.loss.toFixed(1)}% loss`);
    if (s.kbps != null) parts.push(`${s.kbps.toFixed(0)} kbps`);
    r.stat.textContent = parts.join(' · ');
  }
}

// ------------------------------------------------------------ mic / mute

function setMuted(next) {
  muted = next;
  for (const t of micStream.getAudioTracks()) t.enabled = !muted;
  net.send({ type: 'state', muted });
  world?.setSelfMuted(muted);
  audio.cue(muted ? 'off' : 'on');
  $('muteBtn').textContent = muted ? 'Mic off (M)' : 'Mic on (M)';
  $('muteBtn').classList.toggle('off', muted);
  setRowMuted('me', muted);
}

function toggleMute() {
  if (micStream) setMuted(!muted);
}

$('muteBtn').onclick = toggleMute;
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName || '')) toggleMute();
});

async function populateMics() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const sel = $('micSel');
    sel.textContent = '';
    const current = micStream.getAudioTracks()[0]?.getSettings().deviceId;
    devices.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Microphone ${i + 1}`;
      if (d.deviceId === current) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = async () => {
      try {
        const next = await audio.openMic(sel.value);
        const old = micStream;
        micStream = next;
        net.localStream = next;
        for (const t of next.getAudioTracks()) t.enabled = !muted;
        await net.replaceTrack(next.getAudioTracks()[0]);
        old.getTracks().forEach((t) => t.stop());
        store.set('micId', sel.value);
      } catch (e) {
        showBanner(micErrorText(e));
      }
    };
  } catch {}
}

// ------------------------------------------------------------ settings

function setupSettings() {
  const br = $('bright');
  br.value = store.get('brightness', 1);
  br.oninput = () => {
    world.setBrightness(Number(br.value));
    store.set('brightness', Number(br.value));
  };
  const saved = store.get('audioSettings', {});
  audio.set(saved);
  for (const el of document.querySelectorAll('#settings [data-key]')) {
    const key = el.dataset.key;
    const out = el.parentElement.querySelector('output');
    const show = () => {
      if (out) out.textContent = ` ${Number(audio.s[key]).toFixed(2)}`;
    };
    if (el.type === 'checkbox') {
      el.checked = !!audio.s[key];
      el.onchange = () => {
        audio.set({ [key]: el.checked });
        store.set('audioSettings', audio.s);
      };
    } else {
      el.value = audio.s[key];
      show();
      el.oninput = () => {
        audio.set({ [key]: Number(el.value) });
        show();
        store.set('audioSettings', audio.s);
      };
    }
  }
}

// ------------------------------------------------------------ misc UI

function showBanner(text) {
  $('banner').textContent = text;
  $('banner').hidden = false;
}

$('copyLink').onclick = async () => {
  const link = $('inviteLink').value;
  try {
    await navigator.clipboard.writeText(link);
    $('copyLink').textContent = 'Copied';
  } catch {
    $('inviteLink').select();
    $('copyLink').textContent = 'Select & copy';
  }
  setTimeout(() => ($('copyLink').textContent = 'Copy link'), 2000);
};
$('inviteLink').onclick = () => $('inviteLink').select();

async function setupVr() {
  if (!navigator.xr) {
    $('hint').textContent += ' · VR not available in this browser';
    return;
  }
  try {
    if (await navigator.xr.isSessionSupported('immersive-vr')) $('vrBtn').hidden = false;
  } catch {}
  $('vrBtn').onclick = async () => {
    try {
      await audio.resume();
      await world.enterVR();
    } catch (e) {
      showBanner(`Could not start VR: ${e.message}`);
    }
  };
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) audio.resume();
});

wireNet();
initLobby();
