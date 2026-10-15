// Lobby, HUD and glue between audio, network and the 3D world.

import { SpatialAudio } from './audio.js';
import { Net } from './net.js';
import { World, SLOT_CSS } from './world.js';
import { checkAvatar, buildAvatar, saveAvatar, loadSavedAvatar, clearSavedAvatar } from './avatar.js';
import { AvatarPreview, disposeParts } from './avatar-preview.js';
import { Profiler } from './profile.js';
import { AmigaSession, PLAY_KEY } from './emu/amiga-session.js';
import { ArcadeSession } from './emu/arcade-session.js';

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
let joinInfo = null;
let rejoining = false;
let camStream = null; // my webcam (desktop only), or null
let camAllowed = false; // true on a desktop without VR
let vrSupported = false; // this browser can start an immersive VR session
const STANDALONE_HEADSET = /OculusBrowser|Quest|Pico|Wolvic/i.test(navigator.userAgent);
// Everyone without an uploaded avatar gets a random colour, chosen on their own device and shared with the room.
const myColor = (() => {
  const h = Math.random();
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const l = 0.6;
    const a = 0.65 * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
})();
const peerColor = new Map(); // id -> their colour
const peerVideo = new Map(); // id -> <video> element playing their webcam
const camOn = new Map(); // id -> true while they are sending it
const preview = new AvatarPreview($('avatarPreview'));
const prof = new Profiler(); // does nothing unless the server was started with `npm run profile`
let myAvatar = null; // { name, buf } once it has passed the checks
let avatarCheck = Promise.resolve(); // resolves when the current upload check has finished
const peerParts = new Map(); // id -> built avatar parts, held until the 3D world exists
const avatarSeen = new Set(); // peers whose avatar we have already handled (one per person)
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
  // Ask the server whether profiling is on (npm run profile). If so, start logging straight away.
  net.loadIce().then(() => {
    if (net.profileOn) {
      prof.start({ net, audio });
      prof.event('lobby-open', { room: roomIdFromUrl });
    }
  });

  $('name').value = store.get('name', '');

  if (!window.isSecureContext || !navigator.mediaDevices) {
    showError('This page needs HTTPS (or localhost) for microphone and VR access. Open the https:// address printed by the server.');
    $('go').disabled = true;
  }

  $('usePin').onchange = () => {
    $('pin').hidden = !$('usePin').checked;
    if (!$('pin').hidden) $('pin').focus();
  };

  // The webcam head is for desktop users only. Anyone whose browser can start VR (a Quest) never sees it.
  try {
    const vr = navigator.xr ? await navigator.xr.isSessionSupported('immersive-vr') : false;
    camAllowed = !vr && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
    vrSupported = !!vr;
  } catch {
    camAllowed = !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
  }
  $('camBox').hidden = !camAllowed;
  // "Go straight into VR": on by default on a headset, off on a PC that merely has a headset plugged in.
  $('vrBox').hidden = !vrSupported;
  $('autoVr').checked = store.get('autoVr', STANDALONE_HEADSET);
  $('autoVr').onchange = () => store.set('autoVr', $('autoVr').checked);

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

// ---- webcam head (desktop). Small and low frame rate on purpose: the voice always has priority.

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 20 }, facingMode: 'user' },
    audio: false,
  });
  camStream = stream;
  const t = stream.getVideoTracks()[0];
  if (t) t.onended = () => { if (camStream === stream) camStream = null; };
  return t;
}

function stopCamera() {
  if (camStream) for (const t of camStream.getTracks()) t.stop();
  camStream = null;
}

function camErrorText(e) {
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) return 'Camera access was blocked. Allow it in the browser site settings.';
  if (e && e.name === 'NotFoundError') return 'No camera was found.';
  return `Could not open the camera: ${e && e.message ? e.message : e}`;
}

$('useCam').onchange = async () => {
  const st = $('camStatus');
  st.className = 'small dim';
  st.textContent = '';
  if ($('useCam').checked) {
    try {
      await startCamera();
      $('camPreview').srcObject = camStream;
      $('camPreview').hidden = false;
      st.textContent = 'Others will see this square in place of your head.';
    } catch (e) {
      $('useCam').checked = false;
      st.className = 'small err';
      st.textContent = camErrorText(e);
    }
  } else {
    stopCamera();
    $('camPreview').srcObject = null;
    $('camPreview').hidden = true;
  }
};

async function toggleCamera() {
  prof.event('camera', { on: !camStream });
  try {
    if (camStream) {
      net.setCamera(null); // stop sending first, then release the camera light
      stopCamera();
    } else {
      net.setCamera(await startCamera());
    }
  } catch (e) {
    showBanner(camErrorText(e));
  }
  syncCamButton();
}

function syncCamButton() {
  $('camBtn').textContent = camStream ? 'Camera on' : 'Camera off';
  $('camBtn').classList.toggle('off', !camStream);
}
$('camBtn').onclick = toggleCamera;

// ---- shared screen (desktop only). The sharer picks a browser tab (with its sound); everyone sees it on the hanging screen.
let screenFrom = null; // 'me', a peer id, or null: who is sharing right now
let screenEl = null; // <video> that feeds the hanging screen
let screenStreamIn = null; // the remote stream being shown (video + audio tracks arrive separately)
let localShare = null; // my display-capture stream

function showScreen(stream, from) {
  screenFrom = from;
  if (!screenEl) {
    screenEl = document.createElement('video');
    screenEl.muted = true; // the tab's sound goes through the audio engine, positioned at the screen
    screenEl.playsInline = true;
    screenEl.autoplay = true;
    $("vids").appendChild(screenEl);
  }
  screenEl.srcObject = stream;
  screenEl.play().catch(() => {});
  world?.setScreenVideo(screenEl);
  syncShareButton();
}

function clearScreen() {
  screenFrom = null;
  screenStreamIn = null;
  if (screenEl) {
    screenEl.srcObject = null;
    screenEl.remove();
    screenEl = null;
  }
  world?.setScreenVideo(null);
  audio.clearScreenAudio();
  syncShareButton();
}

function syncShareButton() {
  const b = $('shareBtn');
  const mine = screenFrom === 'me' && !anyHosting();
  b.textContent = mine ? 'Stop sharing' : 'Share tab';
  b.classList.toggle('off', !mine);
  b.disabled = !mine && screenFrom !== null; // someone else is sharing: wait for them to stop
  b.title = !mine && screenFrom !== null ? (screenFrom === 'me' ? 'Your emulator is on the screen' : `${people.get(screenFrom)?.name || 'Someone'} is sharing`) : '';
  if (typeof syncAmigaUi === 'function') syncAmigaUi();
}

async function startShare() {
  if (!world || world.layout !== 'kitchen') return showBanner('The shared screen needs the kitchen model.');
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: true, // the tab's own sound (tick "Also share tab audio" in the picker)
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'exclude',
    });
    localShare = stream;
    const vt = stream.getVideoTracks()[0];
    if (vt) vt.onended = () => stopShare();
    net.startScreen(stream);
    showScreen(new MediaStream(stream.getVideoTracks()), 'me');
    prof.event('screen-share', { on: true, audio: stream.getAudioTracks().length > 0 });
    if (!stream.getAudioTracks().length) showBanner('Sharing without sound. Pick a browser tab and tick "Also share tab audio" to play its sound in the room.');
  } catch (e) {
    if (e && e.name !== 'NotAllowedError') showBanner(`Could not share: ${e.message || e}`);
  }
}

function stopShare() {
  if (!localShare) return;
  for (const t of localShare.getTracks()) t.stop();
  localShare = null;
  net.stopScreen();
  clearScreen();
  prof.event('screen-share', { on: false });
}

$('shareBtn').onclick = () => (anyHosting() ? null : screenFrom === 'me' ? stopShare() : startShare());

// ---- the Amiga and the arcade machine (see emu/amiga-session.js and emu/arcade-session.js).
// Desktop hosts run one emulator at a time; everyone can play on a joystick / arcade stick.
let amiga = null;
let arcade = null;
let emuFrom = null; // id of the person whose shared screen is an emulator, or null
let emuKind = null; // which one: 'amiga' | 'arcade'

const hostIdOf = (kind) => () => (emuFrom && emuFrom !== 'me' && emuKind === kind ? emuFrom : null);
const amigaHostId = hostIdOf('amiga');
const arcadeHostId = hostIdOf('arcade');
const anyHosting = () => !!(amiga?.hosting || arcade?.hosting);

function makeSession(Cls, kind) {
  return new Cls({
    net,
    onChange: syncAmigaUi,
    banner: showBanner,
    onLocalStream: (stream) => {
      localShare = stream;
      emuFrom = 'me';
      emuKind = kind;
      showScreen(new MediaStream(stream.getVideoTracks()), 'me');
      const sp = world?.screenPose();
      if (sp) audio.setScreenAudio(stream, sp.pos, sp.nrm);
      prof.event(kind, { on: true });
    },
    onLocalEnd: () => {
      localShare = null;
      emuFrom = null;
      emuKind = null;
      clearScreen();
      prof.event(kind, { on: false });
    },
    getXrSources: () => {
      const s = world?.renderer?.xr?.getSession?.();
      return s ? [...s.inputSources] : [];
    },
    setSteering: (on) => {
      if (world) world.suppressMove = !!on;
    },
    hostId: kind === 'arcade' ? arcadeHostId : amigaHostId,
  });
}

function ensureAmiga() {
  return amiga || (amiga = makeSession(AmigaSession, 'amiga'));
}

function ensureArcade() {
  return arcade || (arcade = makeSession(ArcadeSession, 'arcade'));
}

/** The session that is running here, or the one for the emulator on the wall; null when there is none. */
function activeEmu() {
  if (amiga?.hosting) return amiga;
  if (arcade?.hosting) return arcade;
  if (emuFrom && emuKind === 'arcade') return ensureArcade();
  if (emuFrom) return ensureAmiga();
  return null;
}

const EMU_NAMES = { amiga: 'Amiga', arcade: 'arcade machine' };

function syncAmigaUi() {
  const a = activeEmu();
  const play = $('playBtn');
  const bar = $('amigaBar');
  const hosting = !!a?.hosting;
  const watching = !!emuFrom && emuFrom !== 'me';
  const kitchen = !STANDALONE_HEADSET && !!(world && world.layout === 'kitchen');
  for (const [id, sess, label] of [['amigaBtn', amiga, 'Amiga'], ['arcadeBtn', arcade, 'Arcade']]) {
    const btn = $(id);
    const mine = !!sess?.hosting;
    btn.hidden = !kitchen || (!mine && (screenFrom !== null || anyHosting()));
    btn.textContent = mine ? `Stop ${label}` : label;
    btn.classList.toggle('off', !mine);
  }
  play.hidden = !(hosting || watching);
  const on = !!a?.playMode;
  play.textContent = hosting ? (on ? `Playing (${PLAY_KEY} to leave)` : `Play keyboard (${PLAY_KEY})`) : a?.joined ? (on ? `Playing (${PLAY_KEY} to leave)` : 'Joystick on') : 'Join as player';
  play.classList.toggle('off', !(on || a?.joined));
  const lines = [];
  const name = EMU_NAMES[emuKind] || 'Amiga';
  if (a?.hosting) {
    const arc = a === arcade;
    lines.push(a.state === 'loading' ? `Starting the ${name}…` : `${name[0].toUpperCase()}${name.slice(1)} running.`);
    for (const p of a.players()) lines.push(`${arc ? 'Player' : 'Port'} ${p.port}: ${people.get(p.id)?.name || 'player'}`);
    if (arc) {
      if (!a.players().some((p) => p.port === 1)) lines.push('Player 1: you (arrows, Z X C A S D, 1 = start, 5 = coin)');
    } else if (!a.players().some((p) => p.port === 1)) lines.push('Port 1: your mouse');
    if (a.stats?.fps) lines.push(`${Math.round(a.stats.fps)} fps`);
  } else if (a?.joined) {
    lines.push(
      a.port
        ? a === arcade
          ? `You are player ${a.port}. Arrows + Z X C A S D, 1 = start, 5 = coin in play mode, a gamepad, or in VR hold the left grip to steer and a trigger to fire.`
          : `You are on joystick port ${a.port}. Arrows + Space/Ctrl in play mode, a gamepad, or in VR hold the left grip to steer and a trigger to fire.`
        : 'Waiting for a joystick…',
    );
  }
  bar.hidden = !lines.length;
  bar.textContent = lines.join(' · ');
}

async function amigaStartFromDialog() {
  const err = $('amigaErr');
  err.hidden = true;
  const go = $('amigaGo');
  go.disabled = true;
  try {
    await ensureAmiga().startHost({
      model: $('amigaModel').value,
      disk: $('amigaDisk').files[0] || null,
      kickstart: $('amigaKick').files[0] || null,
    });
    $('amigaDlg').close();
    showBanner(`The Amiga is running on the screen over the hob. Press ${PLAY_KEY} or the Play button to give it your keyboard and mouse.`);
  } catch (e) {
    err.textContent = e.message || String(e);
    err.hidden = false;
  } finally {
    go.disabled = false;
  }
}

async function arcadeStartFromDialog() {
  const err = $('arcadeErr');
  err.hidden = true;
  const go = $('arcadeGo');
  go.disabled = true;
  go.textContent = 'Starting…';
  try {
    await ensureArcade().startHost({ core: $('arcadeCore').value, rom: $('arcadeRom').files[0] || null });
    $('arcadeDlg').close();
    showBanner(`The arcade machine is on the screen over the hob. Press 5 to insert a coin, 1 to start. Press ${PLAY_KEY} or the Play button to give it your keyboard.`);
  } catch (e) {
    err.textContent = e.message || String(e);
    err.hidden = false;
  } finally {
    go.disabled = false;
    go.textContent = 'Start';
  }
}

$('amigaGo').onclick = amigaStartFromDialog;
$('arcadeGo').onclick = arcadeStartFromDialog;
$('amigaBtn').onclick = () => {
  if (amiga?.hosting) return amiga.stopHost();
  if (!world || world.layout !== 'kitchen') return showBanner('The Amiga needs the kitchen model.');
  $('amigaErr').hidden = true;
  $('amigaDlg').showModal();
};
$('arcadeBtn').onclick = () => {
  if (arcade?.hosting) return arcade.stopHost();
  if (!world || world.layout !== 'kitchen') return showBanner('The arcade machine needs the kitchen model.');
  $('arcadeErr').hidden = true;
  $('arcadeDlg').showModal();
};
$('playBtn').onclick = () => {
  const a = activeEmu();
  if (!a) return;
  if (a.hosting) return a.setPlayMode(!a.playMode);
  if (!a.joined) return a.join(true);
  a.setPlayMode(!a.playMode);
};
window.addEventListener('keydown', (e) => {
  if (e.code !== PLAY_KEY || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || '')) return;
  const a = activeEmu();
  if (!a || a.playMode) return; // while playing, the session itself handles the key
  e.preventDefault();
  if (a.hosting || a.joined) a.setPlayMode(true);
  else if (emuFrom && emuFrom !== 'me') a.join(true);
});

function updatePeerVideo(id) {
  const el = peerVideo.get(id);
  world?.setPeerVideo(id, camOn.get(id) && el ? el : null);
}

// ---- avatar upload. A bad file can never reach the 3D world: it is rejected here and again on every receiver.

function showAvatarStatus(kind, text, lines = []) {
  const box = $('avatarStatus');
  box.textContent = '';
  const p = document.createElement('div');
  p.className = kind === 'ok' ? 'okmsg' : kind === 'bad' ? 'badmsg' : 'dim';
  p.textContent = text;
  box.appendChild(p);
  if (lines.length) {
    const ul = document.createElement('ul');
    for (const l of lines.slice(0, 8)) {
      const li = document.createElement('li');
      li.textContent = l;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
}

async function acceptAvatar(name, buf, remember) {
  const tA = performance.now();
  const r = await checkAvatar(buf);
  prof.event('avatar-checked', { ok: r.ok, bytes: buf.byteLength, tris: r.info?.totalTris, took: Math.round(performance.now() - tA), errors: r.ok ? undefined : r.errors.slice(0, 3) });
  if (!r.ok) {
    myAvatar = null;
    preview.hide();
    showAvatarStatus('bad', `${name} can't be used. You will join with the default avatar until you fix:`, r.errors);
    $('avatarClear').hidden = false;
    return false;
  }
  // Build it too, so a file that passes the numbers but cannot be decoded is caught here, and show it in the preview.
  let parts;
  try {
    parts = await buildAvatar(buf.slice(0));
    preview.show(parts);
  } catch (e) {
    disposeParts(parts);
    preview.hide();
    myAvatar = null;
    showAvatarStatus('bad', `${name} could not be loaded (${e.message || 'unreadable file'}). The default avatar will be used.`);
    $('avatarClear').hidden = false;
    return false;
  }
  myAvatar = { name, buf };
  prof.event('avatar-ready', { took: Math.round(performance.now() - tA) });
  if (remember) saveAvatar(name, buf);
  showAvatarStatus('ok', `${name} is ready: ${r.info.totalTris} triangles.`, r.warnings);
  $('avatarClear').hidden = false;
  return true;
}

$('avatarFile').onchange = () => {
  const f = $('avatarFile').files[0];
  myAvatar = null;
  preview.hide();
  if (!f) {
    showAvatarStatus('', '');
    return;
  }
  showAvatarStatus('', 'Checking…');
  avatarCheck = (async () => {
    try {
      if (f.size > 1_100_000) {
        preview.hide();
        showAvatarStatus('bad', `${f.name} is ${(f.size / 1e6).toFixed(1)} MB, the limit is 1 MB. The default avatar will be used.`);
        return;
      }
      await acceptAvatar(f.name, await f.arrayBuffer(), true);
    } catch (e) {
      showAvatarStatus('bad', 'Could not read that file. The default avatar will be used.');
    }
  })();
};

$('avatarClear').onclick = () => {
  myAvatar = null;
  preview.hide();
  $('avatarFile').value = '';
  $('avatarClear').hidden = true;
  showAvatarStatus('', '');
  clearSavedAvatar();
};

async function restoreSavedAvatar() {
  const saved = await loadSavedAvatar();
  if (!saved || !saved.buf) return;
  avatarCheck = acceptAvatar(saved.name || 'Saved avatar', saved.buf, false).catch(() => {});
  await avatarCheck;
}

$('go').onclick = async () => {
  showError('');
  await avatarCheck; // never join halfway through checking a file
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

/** The exit sign in the kitchen: end the headset session, say goodbye to the room and go back to the start page. */
let leaving = false;
async function leaveRoom() {
  if (leaving) return;
  leaving = true;
  try {
    await world?.renderer.xr.getSession()?.end();
  } catch {}
  try {
    document.exitPointerLock?.();
  } catch {}
  try {
    net.close();
  } catch {}
  location.assign('/');
}

function wireNet() {
  net.on('stream', (id, stream) => audio.addPeer(id, stream));
  net.on('screen', (id, stream, kind, info) => {
    if (screenFrom === 'me') return; // I am the one sharing
    if (kind === 'video') {
      emuFrom = info && info.kind === 'emulator' ? id : null;
      emuKind = emuFrom ? (info.emu === 'arcade' ? 'arcade' : 'amiga') : null;
      const sess = activeEmu();
      // Headset players have no mouse or page buttons in VR: they join automatically.
      if (emuFrom && STANDALONE_HEADSET && !sess.joined) sess.join(true);
      screenStreamIn = stream;
      showScreen(new MediaStream(stream.getVideoTracks()), id);
      const sp = world?.screenPose();
      if (sp && stream.getAudioTracks().length) audio.setScreenAudio(stream, sp.pos, sp.nrm);
    } else if (kind === 'audio' && screenFrom === id) {
      const sp = world?.screenPose();
      if (sp) audio.setScreenAudio(stream, sp.pos, sp.nrm);
    }
    showBanner(emuFrom === id ? `${people.get(id)?.name || 'Someone'} started the ${EMU_NAMES[emuKind]}. Press ${PLAY_KEY} to join in. Watch the screen over the hob.` : `${people.get(id)?.name || 'Someone'} is sharing a tab. Watch the screen over the hob.`);
    syncAmigaUi();
  });
  net.on('screen-end', (id) => {
    if (screenFrom === id) {
      if (emuFrom === id) {
        const sess = activeEmu();
        emuFrom = null;
        emuKind = null;
        sess?.hostEnded();
      }
      clearScreen();
    }
    syncAmigaUi();
  });
  net.on('avatar', (id, buf) => receiveAvatar(id, buf));
  net.on('color', (id, c) => {
    peerColor.set(id, c);
    world?.setPeerColor(id, c);
    if (me) renderPeople();
  });
  net.on('video', (id, stream) => {
    let el = peerVideo.get(id);
    if (!el) {
      el = document.createElement('video');
      el.muted = true; // their voice comes through the audio engine, never through this element
      el.playsInline = true;
      el.autoplay = true;
      $('vids').appendChild(el); // kept in the page so the browser keeps decoding it
      peerVideo.set(id, el);
    }
    el.srcObject = stream;
    el.play().catch(() => {});
    updatePeerVideo(id);
  });
  net.on('cam', (id, on) => {
    camOn.set(id, on);
    updatePeerVideo(id);
  });
  net.on('peer-joined', (p) => {
    prof.event('peer-joined', { id: p.id, name: p.name });
    addPerson(p);
  });
  net.on('peer-left', (id) => {
    prof.event('peer-left', { id });
    amiga?.guestGone(id);
    arcade?.guestGone(id);
    removePerson(id);
  });
  net.on('pose', (id, msg) => world?.setPose(id, msg));
  net.on('state', (id, isMuted) => {
    const p = people.get(id);
    if (p) p.muted = isMuted;
    world?.setMuted(id, isMuted);
    setRowMuted(id, isMuted);
  });
  net.on('conn', (id, state) => {
    prof.event('peer-connection', { id, state });
    conns.set(id, state);
  });
  net.on('closed', () => {
    prof.event('ws-closed', { hidden: document.hidden });
    if (joinInfo) rejoin('socket-closed');
    else showBanner('Lost the connection to the server. Reload the page to rejoin.');
  });
}

/** Someone else's avatar arrived. Same checks as the upload, then a guarded build; anything wrong is ignored. */
async function receiveAvatar(id, buf) {
  if (avatarSeen.has(id)) return; // one avatar per person per visit
  avatarSeen.add(id);
  const tR = performance.now();
  try {
    const r = await checkAvatar(buf);
    if (!r.ok) {
      console.warn('Ignored an avatar that failed the checks:', r.errors);
      flashBanner(`${people.get(id)?.name || 'Someone'}'s avatar was not used (it failed the safety checks).`);
      return;
    }
    const parts = await buildAvatar(buf);
    prof.event('avatar-received', { id, bytes: buf.byteLength, took: Math.round(performance.now() - tR) });
    if (!people.has(id)) return; // they left while it was loading
    if (world) applyPeerParts(id, parts);
    else peerParts.set(id, parts);
  } catch (e) {
    console.warn('Could not load an avatar:', e);
  }
}

function applyPeerParts(id, parts) {
  try {
    world.setPeerAvatar(id, parts);
  } catch (e) {
    console.warn('Could not show an avatar, keeping the default:', e);
  }
}

async function enter(name, pin) {
  // Everything audio-related has to start inside this click handler.
  const goStraightToVr = vrSupported && $('autoVr').checked; // read now: the lobby is hidden later
  audio.init();
  await audio.resume();

  const tEnter = performance.now();
  try {
    micStream = await audio.openMic(store.get('micId', undefined));
  } catch (e) {
    prof.event('mic-failed', { err: String(e && e.name) });
    throw new Error(micErrorText(e));
  }
  prof.event('mic-open', { took: Math.round(performance.now() - tEnter) });
  net.localStream = micStream;
  watchMic(micStream);
  prof.micInfo = () => {
    const t = micStream && micStream.getAudioTracks()[0];
    const peak = micPeak;
    micPeak = 0;
    return t ? { state: t.readyState, muted: t.muted, enabled: t.enabled, peak: Math.round(peak * 1000) / 1000 } : null;
  };
  net.localAvatar = myAvatar ? myAvatar.buf : null;
  net.localColor = myColor;
  if (camStream && camAllowed) net.setCamera(camStream.getVideoTracks()[0]);

  await net.loadIce();
  const tConn = performance.now();
  await net.connect();
  prof.event('ws-connected', { took: Math.round(performance.now() - tConn) });
  const res = await net.enter(
    roomIdFromUrl ? { type: 'join', room: roomIdFromUrl, name, pin } : { type: 'create', name, pin },
  );

  me = res.you;
  roomId = res.room;
  joinInfo = { name, pin }; // kept in memory only, so a dropped connection can come straight back
  prof.event('joined', { room: roomId, slot: me.slot, others: res.peers.length, hasPin: !!res.hasPin, customAvatar: !!myAvatar, webcam: !!camStream });
  if (!roomIdFromUrl) history.replaceState(null, '', `/r/${roomId}`);

  world = new World({
    container: $('stage'),
    audio,
    onLocalPose: (pose) => net.sendPose(pose),
    onToggleMute: () => toggleMute(),
    onExit: () => leaveRoom(),
  });
  const tKitchen = performance.now();
  const kitchenOk = await world.loadKitchen('/models/kitchen.glb'); // falls back to the round hall on failure
  prof.event('kitchen-loaded', { took: Math.round(performance.now() - tKitchen), ok: kitchenOk !== false });
  world.prof = prof;
  prof.attachWorld(world);
  world.setSelf(me.slot, me.name);
  for (const p of people.values()) world.addPeer(p); // peers added before the world existed
  for (const [id, parts] of peerParts) applyPeerParts(id, parts);
  peerParts.clear();
  for (const id of peerVideo.keys()) updatePeerVideo(id);
  for (const [id, c] of peerColor) world.setPeerColor(id, c);
  world.setBrightness(store.get('brightness', 1));

  $('roomCode').textContent = roomId;
  $('pinBadge').hidden = !res.hasPin;
  $('inviteLink').value = `${location.origin}/r/${roomId}`;
  for (const p of res.peers) addPerson(p);
  renderPeople();

  $('lobby').hidden = true;
  $('hud').hidden = false;
  if (!roomIdFromUrl) autoCopyInvite(); // creators only: the people who join already have the link
  preview.dispose(); // give the WebGL context back before VR starts

  $('camBtn').hidden = !camAllowed;
  $('shareBtn').hidden = !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) || STANDALONE_HEADSET;
  syncCamButton();
  syncShareButton();
  syncAmigaUi();
  $('camPreview').srcObject = null;
  setupSettings();
  populateMics();
  setupVr().then(() => {
    // The click on Create / Join is what lets a page start VR, and that permission only lasts a few seconds. If the
    // microphone question took longer than that (first visit), this is refused and the Enter VR button is shown.
    if (goStraightToVr) startVr(true);
  });
  setInterval(updateMeters, 80);
  setInterval(updateStats, 2000);
  setInterval(() => ensureMic('watchdog'), 2000);
}

// ------------------------------------------------------------ people list

function addPerson(p) {
  people.set(p.id, { id: p.id, name: p.name, slot: p.slot, muted: !!p.muted });
  world?.addPeer(p);
  renderPeople();
}

function removePerson(id) {
  if (screenFrom === id) clearScreen();
  people.delete(id);
  peerParts.delete(id);
  avatarSeen.delete(id);
  camOn.delete(id);
  peerColor.delete(id);
  const pv = peerVideo.get(id);
  if (pv) {
    pv.srcObject = null;
    pv.remove();
    peerVideo.delete(id);
  }
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
    const c = p.id === 'me' ? myColor : peerColor.get(p.id);
    dot.style.background = c !== undefined ? '#' + c.toString(16).padStart(6, '0') : SLOT_CSS[p.slot % 3];
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

let micPeak = 0; // loudest mic level since the last profile sample (profile mode only)
function updateMeters() {
  micPeak = Math.max(micPeak, audio.localLevel());
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
  prof.event('mute', { muted: next });
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
  if (e.code === 'KeyL' && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName || '')) prof.mark('key');
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
        await swapMic(sel.value);
        store.set('micId', sel.value);
      } catch (e) {
        showBanner(micErrorText(e));
      }
    };
  } catch {}
}


// ------------------------------------------------------------ keeping the microphone alive

/** Open the mic again (a different device, or the same one after the browser cut it) and give it to every voice link. */
async function swapMic(deviceId) {
  const next = await audio.openMic(deviceId);
  const old = micStream;
  micStream = next;
  net.localStream = next;
  for (const t of next.getAudioTracks()) t.enabled = !muted;
  watchMic(next);
  await net.replaceTrack(next.getAudioTracks()[0]);
  old?.getTracks().forEach((t) => t.stop());
}

function watchMic(stream) {
  for (const t of stream.getAudioTracks()) {
    t.onmute = () => prof.event('mic-track', { state: 'muted-by-browser' });
    t.onunmute = () => prof.event('mic-track', { state: 'unmuted' });
    t.onended = () => {
      prof.event('mic-track', { state: 'ended' });
      ensureMic('ended');
    };
  }
}

let reopeningMic = false;
let micBadChecks = 0;
/**
 * Headsets and phones sometimes cut the microphone when the page is frozen or backgrounded, and it does not always
 * come back by itself. If the track is dead (or stays muted by the browser while the page is visible), open it again.
 */
async function ensureMic(reason, force = false) {
  const t = micStream && micStream.getAudioTracks()[0];
  if (!t || reopeningMic || (document.hidden && !force)) return;
  const bad = t.readyState !== 'live' || t.muted;
  micBadChecks = bad ? micBadChecks + 1 : 0;
  // 'muted' can be a short blip right after waking: wait for three bad checks in a row, but an ended track is final.
  if (!bad || (t.readyState === 'live' && micBadChecks < 3 && !force)) return;
  reopeningMic = true;
  try {
    await swapMic(store.get('micId', undefined));
    micBadChecks = 0;
    prof.event('mic-reopen', { reason, ok: true });
  } catch (e) {
    prof.event('mic-reopen', { reason, ok: false, err: String(e && e.name) });
  } finally {
    reopeningMic = false;
  }
}

// ------------------------------------------------------------ settings

function setupSettings() {
  $('stressBox').hidden = !prof.enabled; // GPU test controls, only when the server runs in profile mode
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

function flashBanner(text, ms = 7000) {
  showBanner(text);
  setTimeout(() => {
    if ($('banner').textContent === text) $('banner').hidden = true;
  }, ms);
}

/** Put the invite link on the clipboard. Returns false if the browser refused (it wants a recent click or key press). */
async function copyInviteLink() {
  const link = $('inviteLink').value;
  try {
    await navigator.clipboard.writeText(link);
    return true;
  } catch {}
  try {
    const el = $('inviteLink');
    el.select();
    if (document.execCommand('copy')) return true; // older browsers
  } catch {}
  return false;
}

$('copyLink').onclick = async () => {
  const ok = await copyInviteLink();
  if (!ok) $('inviteLink').select();
  $('copyLink').textContent = ok ? 'Copied' : 'Select & copy';
  setTimeout(() => ($('copyLink').textContent = 'Copy link'), 2000);
};

/** The person who creates a room is about to send the link to someone: copy it for them. */
async function autoCopyInvite() {
  if (await copyInviteLink()) {
    prof.event('invite-copied', { auto: true });
    flashBanner('Room created. The invite link is copied: paste it into an email or chat.', 9000);
    return;
  }
  // The browser only allows copying right after a click or key press, and starting the mic can take longer than
  // that. So copy on the very next click or key press anywhere on the page.
  showBanner('Room created. Click anywhere to copy the invite link.');
  const again = async () => {
    window.removeEventListener('pointerdown', again, true);
    window.removeEventListener('keydown', again, true);
    if (await copyInviteLink()) {
      prof.event('invite-copied', { auto: false });
      flashBanner('Invite link copied: paste it into an email or chat.', 6000);
    } else {
      $('banner').hidden = true;
    }
  };
  window.addEventListener('pointerdown', again, true);
  window.addEventListener('keydown', again, true);
}
$('inviteLink').onclick = () => $('inviteLink').select();

async function setupVr() {
  if (!navigator.xr) {
    $('hint').textContent += ' · VR not available in this browser';
    return;
  }
  try {
    if (await navigator.xr.isSessionSupported('immersive-vr')) $('vrBtn').hidden = false;
  } catch {}
  $('vrBtn').onclick = () => startVr(false);
}

async function startVr(auto) {
  try {
    await audio.resume();
    await world.enterVR(prof.enabled ? { scale: $('xrScale').value, hz: $('xrHz').value } : {});
    prof.event('vr-entered', { auto });
  } catch (e) {
    if (auto) {
      prof.event('auto-vr-failed', { err: String(e && e.name) });
      // a moment later than the invite-link message, so this (the one that needs action) is the one left showing
      setTimeout(() => flashBanner('Press "Enter VR" to put the headset on.', 9000), 1500);
    } else {
      showBanner(`Could not start VR: ${e.message}`);
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  audio.resume();
  setTimeout(() => ensureMic('woke-up'), 1500);
  // Headset back on: if the server dropped us while the page was frozen, come back in.
  if (joinInfo && !rejoining && (!net.ws || net.ws.readyState > 1)) rejoin('woke-up');
});

// ------------------------------------------------------------ coming back after a drop

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REJOIN_FATAL = new Set(['no-room', 'bad-pin', 'locked', 'bad-name', 'bad-pin-format']);

/**
 * The server dropped us (headset taken off, Wi-Fi blip, laptop lid). Open a fresh socket, join the same room as the
 * same person, and rebuild every voice link. Everyone else sees us leave and arrive again, which is exactly what
 * happened. Gives up after two minutes.
 */
async function rejoin(reason) {
  if (rejoining || !joinInfo || !roomId) return;
  rejoining = true;
  const t0 = performance.now();
  prof.event('rejoin-start', { reason });
  showBanner('Reconnecting…');
  for (const id of [...people.keys()]) removePerson(id);
  net.dropAllPeers();
  let delay = 400;
  let tries = 0;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (document.hidden) {
      await new Promise((r) => document.addEventListener('visibilitychange', r, { once: true }));
      continue;
    }
    tries++;
    try {
      await net.connect();
      const res = await Promise.race([
        net.enter({ type: 'join', room: roomId, name: joinInfo.name, pin: joinInfo.pin }),
        sleep(8000).then(() => {
          net.pending = null;
          throw new Error('timeout');
        }),
      ]);
      me = res.you;
      world?.setSelf(me.slot, me.name);
      for (const p of res.peers) addPerson(p);
      renderPeople();
      $('banner').hidden = true;
      prof.event('rejoin-ok', { reason, tries, took: Math.round(performance.now() - t0), others: res.peers.length });
      rejoining = false;
      return;
    } catch (e) {
      if (e && REJOIN_FATAL.has(e.code)) {
        prof.event('rejoin-failed', { reason, code: e.code });
        showBanner(e.code === 'no-room' ? 'The room has closed. Make a new one.' : 'Could not rejoin. Reload the page.');
        rejoining = false;
        return;
      }
      // 'full' (our old seat is not released yet), network down, or the server restarting: try again shortly
      await sleep(delay);
      delay = Math.min(delay * 1.6, 4000);
    }
  }
  prof.event('rejoin-failed', { reason, code: 'timeout', tries });
  showBanner('Could not reconnect. Reload the page to rejoin.');
  rejoining = false;
}

// Read-only handle for tests and debugging in the console.
window.__meet = { get world() { return world; }, people, net, peerVideo, camOn, prof, audio };

wireNet();
initLobby();
restoreSavedAvatar();
