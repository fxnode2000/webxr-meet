// Who controls the Amiga: node test/controls.test.mjs
import assert from 'node:assert/strict';
import { ControlMap, packJoy, unpackJoy, BITS } from '../public/emu/controls.js';

// packing
assert.equal(packJoy({}), 0);
assert.equal(packJoy({ up: true, fire: true }), BITS.up | BITS.fire);
assert.deepEqual(unpackJoy(packJoy({ left: true, button2: true })), { up: false, down: false, left: true, right: false, fire: false, button2: true });
for (const bad of [-1, 64, 1.5, NaN, '3', null, undefined, {}, Infinity]) assert.deepEqual(unpackJoy(bad), unpackJoy(0), `bad input ${String(bad)} means nothing pressed`);
console.log('ok  joystick bits pack, unpack and reject nonsense');

// three people: host + two guests
const m = new ControlMap();
assert.deepEqual(m.devices(), { 1: 'mouse', 2: 'none' }, 'host has the mouse, nobody on port 2');
assert.equal(m.join('bo'), 2);
assert.deepEqual(m.devices(), { 1: 'mouse', 2: 'joystick' });
assert.equal(m.join('cy'), 1, 'second guest takes port 1');
assert.deepEqual(m.devices(), { 1: 'joystick', 2: 'joystick' }, 'the host mouse gives way');
assert.equal(m.join('bo'), 2, 'asking twice changes nothing');
assert.equal(m.join('dee'), null, 'a fourth person (cannot happen in a 3-person room) gets nothing');
assert.equal(m.route('bo'), 2);
assert.equal(m.route('cy'), 1);
assert.equal(m.route('nobody'), null, 'strangers control nothing');
console.log('ok  three people play at once: host keyboard + two joysticks');

// someone leaves; the person waiting gets the port
assert.equal(m.leave('bo'), 2);
assert.equal(m.route('dee'), 2, 'the waiting person is placed on the freed port');
assert.equal(m.leave('cy'), 1);
assert.deepEqual(m.devices(), { 1: 'mouse', 2: 'joystick' }, 'mouse comes back when port 1 is freed');
assert.equal(m.leave('ghost'), null);
console.log('ok  leaving frees the port, the next waiting person takes it, the mouse returns');

// host reassigns
const n = new ControlMap();
n.join('bo');
n.join('cy'); // bo=2 cy=1
assert.equal(n.assign(2, 'cy'), true);
assert.equal(n.portOf('cy'), 2);
assert.equal(n.portOf('bo'), null, 'bo lost his port when cy was moved onto it');
assert.equal(n.owner[1], null, 'cy left port 1 when moved');
assert.equal(n.assign(1, 'stranger'), false, 'only people who asked to play can be assigned');
assert.equal(n.assign(3, 'bo'), false);
assert.equal(n.assign(2, null), true);
assert.deepEqual(n.devices(), { 1: 'mouse', 2: 'none' });
n.clear();
assert.equal(n.portOf('bo'), null);
console.log('ok  the host can move people between ports or free a port');

// input sources
import { joyFromKeys, joyFromGamepad, joyFromXr, mergeJoy } from '../public/emu/controls.js';
assert.deepEqual(joyFromKeys(new Set(['ArrowUp', 'Space'])), { up: true, down: false, left: false, right: false, fire: true, button2: false });
assert.equal(joyFromKeys(new Set(['KeyW'])).up, false, 'WASD keeps walking the avatar, it is not a joystick');
const pad = (o) => ({ connected: true, axes: o.axes || [0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: (o.btn || []).includes(i) })) });
assert.equal(joyFromGamepad(pad({ axes: [-0.9, 0] })).left, true);
assert.equal(joyFromGamepad(pad({ axes: [0.2, -0.2] })).up, false, 'dead zone');
assert.equal(joyFromGamepad(pad({ btn: [0, 15] })).fire, true);
assert.equal(joyFromGamepad(pad({ btn: [15] })).right, true);
assert.equal(joyFromGamepad(null).fire, false);
assert.equal(joyFromGamepad({ ...pad({ btn: [0] }), connected: false }).fire, false);
const xr = (hand, axes, btn) => ({ handedness: hand, gamepad: pad({ axes, btn }) });
let r = joyFromXr([xr('left', [0, 0, -1, 0], []), xr('right', [0, 0, 0, 0], [])]);
assert.equal(r.steering, false, 'stick alone only walks');
assert.equal(r.joy.left, false);
r = joyFromXr([xr('left', [0, 0, -1, 0], [1]), xr('right', [0, 0, 0, 0], [0, 1])]);
assert.equal(r.steering, true);
assert.equal(r.joy.left, true);
assert.equal(r.joy.fire, true);
assert.equal(r.joy.button2, true);
assert.deepEqual(joyFromXr([{ handedness: 'left' }]).joy, joyFromKeys(new Set()), 'hand tracking has no buttons');
assert.equal(mergeJoy({ up: true }, { fire: true }).fire, true);
console.log('ok  keyboard, gamepad and Quest controller sources map to joystick states');
