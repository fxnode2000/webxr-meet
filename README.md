# WebXR Meet (MVP)

A three-person virtual room with spatial voice. Works on Quest 2 / Quest 3 (Quest Browser) and on a desktop browser.

- Host enters a name, optionally sets a 4-digit PIN, and gets an invite link.
- Guests open the link, enter a name (and the PIN if there is one).
- Voice is peer-to-peer WebRTC (Opus, mono, ~64 kbps) played through Web Audio HRTF panners, so each voice comes from where that person's head is and moves as they move.
- Avatars are a head, a floating torso and two hands. The room is a low-poly model of the Fell Hill Farm kitchen (`public/models/kitchen.glb`); the three players start in the south, east and west chairs around the gateleg table. If the model fails to load, the app falls back to a plain round hall.

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
| Mute | M | A or X button (you hear a beep; the wrist panel on the left controller shows MIC ON / MIC OFF) |

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
- `public/audio.js` - Web Audio spatial engine (HRTF panners, reverb, limiter, mic).
- `public/world.js` - three.js room, avatars, locomotion, WebXR session.
- `public/app.js` - lobby, HUD, settings.
- `test/signalling.test.js` - `npm test` runs the server checks.

## The kitchen model

- Source: `kitchen_lowpoly.blend` in `Fell_Hill_Farm/kitchen/webxr/` (editable parts: Shell, Units_South, Units_East, Dresser, Doors_Trim, Poster, Table_Chairs, Pendant). Export `kitchen_lowpoly.glb` and copy it to `public/models/kitchen.glb`.
- Budget: about 2,950 triangles, 6 draw calls (one palette texture for every flat colour, plus floor tile, wall tile, window, glow and poster), about 4 MB of GPU textures, 275 KB file. Walls are single-sided quads.
- The room sits at x 0..3.11, z -5.1..0 (glTF metres). Seat positions, walkable bounds and furniture collision rectangles are constants at the top of `public/world.js`; update them if you move things.
- The loader swaps every material for `MeshLambertMaterial` (cheapest lit shader on Quest 2). Lights: one hemisphere light and one point light at the pendant. There is a "Scene brightness" slider in the audio panel because the lighting has not been tuned on a headset yet.
- Not baked: ambient occlusion or lightmaps. Baking them into the palette/atlas is the biggest visual upgrade left.

## Known limits of the MVP

- Three people maximum; a room disappears when the last person leaves.
- If the server connection drops you must reload and rejoin.
- A 4-digit PIN is casual privacy only. Rooms lock after repeated wrong guesses, but anyone with the link can try.
- Quest controller hands only (no hand tracking, no lip sync, no teleport).
- Avatars use the seat colour only; names are shown above the head.
