# WebXR Meet (MVP)

A three-person virtual room with spatial voice. Works on Quest 2 / Quest 3 (Quest Browser) and on a desktop browser.

- Host enters a name, optionally sets a 4-digit PIN, and gets an invite link.
- Guests open the link, enter a name (and the PIN if there is one).
- Voice is peer-to-peer WebRTC (Opus, mono, ~64 kbps) played through Web Audio HRTF panners, so each voice comes from where that person's head is and moves as they move.
- Avatars are a head, a floating torso and two hands. People can upload their own (see "Custom avatars" below). The room is a low-poly model of the Fell Hill Farm kitchen (`public/models/kitchen.glb`); the three players start in the south, east and west chairs around the gateleg table. If the model fails to load, the app falls back to a plain round hall. Click any of the four chairs (or aim the screen centre / controller laser at one and pull the trigger) to move to it; a chair someone else is sitting in is ignored.

## Run it

Needs Node 18+.

```
npm install
npm start
```

The server prints two addresses, for example:

```
Desktop:  https://localhost:8443
Quest:    https://192.168.1.23:8443
```

The first run generates a self-signed certificate in `.certs/`. HTTPS is required because browsers only allow the microphone and WebXR on secure pages.

### Quest 2 / Quest 3

1. Put the headset on the same Wi-Fi as the PC (and make sure the router has no "client isolation").
2. In Quest Browser open the `Quest:` address. You will see a certificate warning: choose **Advanced**, then **Proceed**. Do this once.
3. Enter a name, tap **Create room** (or open the invite link and tap **Join room**), and allow the microphone.
4. Tap **Enter VR**.

If Windows asks, allow Node.js through the firewall for private networks.

### Controls

| | Desktop | Quest |
|---|---|---|
| Look | click the scene, then move the mouse | head |
| Move | WASD (Q/E or arrows to turn) | left thumbstick |
| Turn | | right thumbstick (30 degree snap turns) |
| Mute | M | Hold the A or X button for half a second (you hear a beep; the wrist panel on the left controller shows MIC ON / MIC OFF) |

On a headset (or any browser that can start VR) the create/join screen has a "Go straight into VR after joining" tick box, on by default on a Quest and remembered. A web page can only start VR from a click, so the Create / Join press is what starts it; the first time, the microphone question can take longer than the few seconds that click stays valid, and then you press **Enter VR** once. After that it goes straight in.

When you create a room, the invite link is copied to the clipboard automatically, ready to paste into an email or chat. If the browser refuses (it only allows copying right after a click), the next click anywhere copies it; the Copy link button always works. People who join by link do not copy anything.

Audio settings (desktop panel, bottom right) are saved in the browser, so tune them on the 2D page before entering VR: master volume, spatial on/off (for A/B comparison), distance falloff, full-volume radius, room reverb, voice directivity, and microphone choice. The people panel shows each link's path (direct or relay), RTT, jitter, packet loss and bitrate.

## Testing tips

- **Do not test with two headsets in the same room.** You will hear each other directly and get feedback. Use separate rooms, or one headset on and the other muted.
- Desktop: use headphones. Keep each desktop test in its own browser window, not background tabs, because browsers pause animation in hidden tabs (the avatar would freeze).
- Mic permission is remembered per site; if you blocked it once, re-allow it in the site settings.

## Testing from outside your network

Use a tunnel that provides HTTPS and run the server in plain HTTP mode:

```
npm run start:http
cloudflared tunnel --url http://localhost:8080
```

Send the tunnel link to your guests. Most connections work with the built-in public STUN servers; a strict network may need a TURN relay. If you have one:

```
TURN_URL=turn:your.server:3478 TURN_USER=name TURN_PASS=secret npm start
```

(`TURN_URL` can be a comma-separated list.)

## Files

- `server.js` - static hosting, rooms, PIN check with lockout (5 wrong tries locks the room for 2 minutes), WebRTC signalling and pose relay.
- `public/net.js` - WebSocket client and WebRTC mesh.
- `public/profile.js` and `tools/summarise-log.mjs` - the profiling log and its summary.
- `public/audio.js` - Web Audio spatial engine (HRTF panners, reverb, limiter, mic).
- `public/world.js` - three.js room, avatars, locomotion, WebXR session.
- `public/app.js` - lobby, HUD, settings.
- `test/signalling.test.js` - `npm test` runs the server checks.

## The kitchen model

- Source: `kitchen_lowpoly.blend` in `Fell_Hill_Farm/kitchen/webxr/` (editable parts: Shell, Units_South, Units_East, Dresser, Doors_Trim, Poster, Table_Chairs, Pendant). Export `kitchen_lowpoly.glb` and copy it to `public/models/kitchen.glb`.
- Budget: about 2,950 triangles, 6 draw calls (one palette texture for every flat colour, plus floor tile, wall tile, window, glow and poster), about 4 MB of GPU textures, 275 KB file. Walls are single-sided quads.
- The room sits at x 0..3.11, z -5.1..0 (glTF metres). Seat positions, walkable bounds and furniture collision rectangles are constants at the top of `public/world.js`; update them if you move things.
- The loader swaps every material for `MeshLambertMaterial` (cheapest lit shader on Quest 2). Lights: one hemisphere light and one point light at the pendant. There is a "Scene brightness" slider in the audio panel because the lighting has not been tuned on a headset yet.
- Not baked yet: ambient occlusion or lightmaps (the loader now accepts them, see below). Baking them into the palette/atlas is the biggest visual upgrade left.

## Custom avatars

- On the create/join screen a user can pick a `.glb`. It is checked in their browser, remembered on that device (IndexedDB), and sent to the other people over the WebRTC data channel when they connect. The server never sees or stores it.
- Every receiver runs the same checks again before decoding anything, then builds it with the cheap Lambert shader. A file that fails is ignored and that person keeps the default avatar, so a bad file cannot break the room.
- The rules are in `public/avatar-limits.json` and enforced by `public/avatar-check.js` (pure JSON/header inspection: sizes, triangle counts, names, pivots, texture dimensions read from the PNG/JPEG header). The Blender-side checker uses the same numbers.
- Four parts, named exactly `Head`, `Torso`, `HandL`, `HandR`; each part's origin is its pivot (head centre, torso centre, where the controller is held). Face the normal Blender front view (-Y); the app turns it to face forward. Head 1000 tris, torso 800, hands 300 each, 2400 total, 2 materials, 2 textures at most 512x512, 1 MB file. No rigging, shape keys, animation or transparency.
- `public/avatar-kit/` holds the Blender template (`avatar_template.blend`), the checker/exporter script (`avatar_kit.py`: sidebar tab "Avatar" with Check and Export buttons), a sample `.glb` and instructions. The create/join screen links to them.
- `npm test` includes `test/avatar.test.mjs` (sample passes; truncated, oversize, renamed, rigged, compressed, out-of-range and external-texture files are rejected).

## Webcam head (desktop only)

- On the create/join screen, a desktop browser that cannot start VR shows "Show my webcam as my head" (a Quest never sees it). There is also a Camera button in the room to switch it on and off.
- Others see a square cutout of the camera (320x240, 15 fps, capped at about 200 kbps) in place of the head, with a frame in that person's colour that lights up when they speak. Turning it off puts the normal head back.
- Every room connection offers one video line from the start, so switching the camera on or off is only a track swap: no renegotiation, and the voice link is never touched. Video is marked very low priority and voice high priority.
- Not done: touch controls, so an iPhone or iPad can join (Safari supports the voice and camera parts) but can only stand still and listen. FaceTime itself cannot be used; it is a separate Apple service.

## Colours and preview

- A person without an uploaded avatar gets the default avatar in a random colour, picked on their own device and shared over the data channel.
- Once an avatar file is accepted, the create/join screen shows a small turntable preview of it. The preview releases its WebGL context when you join.

## Profiling log (local testing)

Start the server with `npm run profile` (or `npm run profile:http`). Every browser that opens the page, including the Quest, then sends measurements to the server, which writes them to `logs/` as JSON lines:

- `client_<time>_<id>.jsonl`, one per browser session: device and GPU, then every second the fps, frame-time percentiles (p50/p95/p99/max), stutter count, and the CPU time split into update and render submit; draw calls, triangles, geometries and textures; every 5 s the JS heap, audio-engine state and latency, and for each person the link quality (round trip, voice jitter, jitter-buffer delay, concealed audio, bitrates, video fps/decode/encode time). It also records VR session start (refresh rate, foveation), main-thread stalls over 50 ms, console warnings/errors, and events (joined, kitchen loaded, avatar received, camera toggled, people joining and leaving).
- `server_<time>.jsonl`: server CPU, event-loop delay, memory and signalling traffic every 5 s.
- Press **L** on the keyboard, or **B / Y** on a Quest controller, to drop a marker in the log when you notice a stutter. On a desktop a small line at the bottom left shows live fps, p95 frame time, CPU time, draw calls and triangles.
- `npm run summary` prints a readable report for the newest client log (and server log), with the worst seconds, a CPU-bound / GPU-bound verdict and a timeline. Pass a file name to read an older one. You can also just ask for the log to be checked.
- Nothing is recorded or exposed unless the server was started with the profile flag, and `logs/` is git-ignored, so the hosted version never writes logs. The log contains device details and names of rooms, no audio or video.
- **GPU headroom test:** in profile mode the *Audio settings* panel shows two extra menus, "VR render resolution" (1.0 to 2.0) and "VR refresh rate". Pick a value, press Enter VR, stay about 20 seconds, leave VR, pick the next value. `npm run summary` then prints one line per VR session (resolution, buffer size, fps, slow seconds). The highest resolution that still holds the full frame rate shows how much GPU room the scene has.
- Notes on reading it: GPU time cannot be measured from a web page, so a slow frame with a small CPU time points at the GPU (fill rate, texture size, lights). The first few seconds include shader compiling and are reported separately. Numbers from a PC say little about the Quest 2, so profile on the headset.

## Blender environment checker

`tools/blender/kitchen_kit.py` checks a room scene against the Quest 2 budget and against what the viewer actually keeps. In Blender: Text Editor > Open > that file > Run Script, then press N in the 3D viewport and use the **Environment** tab. **Check environment** lists problems and warnings with fixes; **Check and export room .glb** exports to the path shown (default `public\models\kitchen.glb`) only when nothing fails. Headless: `blender -b room.blend -P kitchen_kit.py -- --check`.

It runs a real test export and reads the resulting file, so draw calls, triangles, UV sets, textures and extensions are what the app will load. Budgets (warning above the target, failure above the limit; they are rules of thumb, tune them from a profiling log on the headset):

| | target | limit |
|---|---|---|
| triangles (whole room) | 30,000 | 100,000 |
| draw calls (primitives in the file) | 30 | 60 |
| materials | 12 | 25 |
| textures | 8 | 16 |
| longest texture side | 2048 px | 4096 px |
| texture memory (RGBA8 + mips) | 64 MB | 128 MB |
| file size | 10 MB | 25 MB |

Also checked: at most 2 UV sets (UV0 colour, UV1 baked light) with UV1 inside 0..1 and not overlapping; textures saved or packed, PNG/JPEG, powers of two, base colour in sRGB; no Draco/meshopt/KTX2; floor at y = 0; geometry outside the room the seats and collision boxes were written for; flat-colour, double-sided, transparent and normal/roughness-mapped materials (they work, or are ignored, but cost or mislead); lights, curves and armatures.

What the loader keeps from each material (the rest is dropped for speed): base colour factor and texture, vertex colours, emissive, and an occlusion / light texture. To use a baked lightmap, put it on the material's occlusion input with the glTF Material Output node, unwrap UV1 for it, and the viewer reads it from the second UV set.

## The Amiga (ADF-meet)

A desktop user can run an Amiga in the room. It plays on the kitchen TV (west wall), with its sound coming from the TV, and everyone in the room sees and hears it. Up to **three people play at once**: the host on the keyboard (and mouse), and two friends on joysticks (Amiga port 2, then port 1; port 1 is the host's mouse until a second friend joins).

The emulator is [Copperline](https://github.com/CopperlineHQ/Copperline) (GPL-3.0-or-later), pinned to release **v1.0.0** and built from source. It runs in the host's browser; its picture and sound travel to the others exactly like a shared screen, over the same peer-to-peer connections, so hosting costs the same as plain WebXR Meet.

### Build it once

You need git and [Rust](https://rustup.rs/) (and internet access to github.com and crates.io):

    npm run emu:build     # fetches v1.0.0, checks the commit, builds, copies into public/emu/vendor/copperline/
    npm run emu:check     # boots the free AROS ROM on an A500 and A1200 in Node and checks picture, sound and input

`emu:build` refuses to build if the tag does not point at the expected commit. `public/emu/vendor/copperline/VERSION.json` records what was built and its hashes. `emu:build` runs `emu:check` at the end.

### Use it

1. Open the room on a desktop browser (Chrome or Edge), click **Amiga**, pick a disk image (`.adf`, `.adz`, `.dms`; floppy disks only, no hard-disk images) and **Start**.
2. **Play keyboard (F8)** gives the Amiga your keyboard and mouse; F8 gives them back. While playing, your avatar does not walk.
3. A guest clicks **Join as player** (or presses F8). Their joystick is the arrow keys + Space/Ctrl in play mode, any gamepad, or in a Quest headset: hold the left grip and use the left stick, trigger to fire, right grip for the second button. Headset users join automatically.
4. Without your own Kickstart file, the free AROS replacement ROM is used. It runs many games but not all. Do not share ROMs or games you have no right to share.

If the emulator ever fails, it comes off the TV with a message saying why, and everything held down is released.

## The arcade machine (ADF-meet)

Next to **Amiga** there is an **Arcade** button. It runs a classic arcade game in the host's browser with [EmulatorJS](https://emulatorjs.org) (MAME 2003-Plus, or FinalBurn Neo) and puts it on the same kitchen TV, picture and sound, for everyone in the room. Only the host runs the game; guests send their controls through the same data channel as the Amiga's joystick, so there is nothing extra to open on the network. Up to **three people play at once**: the host is player 1 on the keyboard, two friends are players 2 and 3.

### Set up once

    npm run emu:fetch-arcade     # downloads EmulatorJS 4.2.3 and the two cores (about 30 MB) into public/emu/vendor/ejs

The deploy build does this too (see `render.yaml`). The files are not committed. **No games are included.** Use ROM zips you own or that are freely distributable.

### Use it

1. Desktop Chrome or Edge, click **Arcade**, pick the game's `.zip` (leave it zipped; the file name is the game's name, e.g. `pacman.zip`), pick the emulator and **Start**. If the picture stays black, the zip does not match that emulator's version of the game: try the other emulator.
2. Keep the tab visible while the game runs. Browsers pause hidden tabs, which pauses the game.
3. Controls: arrows, `Z X C` and `A S D` are buttons 1 to 6, `1` = Start, `5` = insert coin. Gamepads work (A/X/Y/B and the shoulders, Menu = Start, View = Coin). In a Quest headset: right trigger and grip, A, B are buttons 1 to 4; left trigger button 5; hold the left grip and use the left stick to steer; left X = Coin, left Y = Start. F8 is play mode, as for the Amiga.
4. Games that need a separate BIOS zip (the Neo Geo) are not supported unless the BIOS is inside the game's zip.

### Tests

    npm test            # logic tests (no browser)
    npm run test:e2e    # real Chromium: screen share, the Amiga host, the Amiga and arcade three-player sessions (needs playwright)

The browser tests use a stand-in for the WebAssembly emulator with the same API; `npm run emu:check` is the check against the real bundle.

### Licence

Copperline is GPL-3.0-or-later. The code in `public/emu/`, `tools/`, and the sharing code in `public/net.js` that drives it are released under the same licence. If you publish this app, publish its source. See `public/emu/NOTICE.md`.

## Known limits of the MVP

- VR needs controllers: hand tracking has no way to move, turn or mute yet.
- Three people maximum; a room stays open for 2 minutes after the last person leaves, then disappears.
- If the connection drops (headset taken off, Wi-Fi blip) the page reconnects by itself and joins the same room again as the same person, after a short "Reconnecting…" banner. The server waits about a minute for a silent headset before dropping it. If the room has closed, or the PIN no longer works, you need to reload.
- A 4-digit PIN is casual privacy only. Rooms lock after repeated wrong guesses, but anyone with the link can try.
- Quest controller hands only (no hand tracking, no lip sync, no teleport).
- The default avatars use the seat colour only; names are shown above the head.
- Custom avatars and your own webcam are not shown to yourself (you only see the others).
