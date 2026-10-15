// Who controls the arcade machine: node test/arcade-controls.test.mjs
import assert from 'node:assert/strict';
import { ArcadeControlMap, packJoy, unpackJoy, BITS, ALL_BITS, joyFromKeys, joyFromGamepad, joyFromXr, mergeJoy } from '../public/emu/arcade-controls.js';

// packing
assert.equal(packJoy({}), 0);
assert.equal(packJoy({ up: true, b1: true, coin: true }), BITS.up | BITS.b1 | BITS.coin);
const everything = Object.fromEntries(Object.keys(BITS).map((k) => [k, true]));
assert.equal(packJoy(everything), ALL_BITS);
assert.deepEqual(unpackJoy(packJoy({ left: true, b6: true, start: true })), { ...Object.fromEntries(Object.keys(BITS).map((k) => [k, false])), left: true, b6: true, start: true });
for (const bad of [-1, ALL_BITS + 1, 1.5, NaN, '3', null, undefined, {}, Infinity]) assert.deepEqual(unpackJoy(bad), unpackJoy(0), `bad input ${String(bad)} means nothing pressed`);
console.log('ok  arcade bits pack, unpack and reject nonsense');

// players 2 and 3 are the guests; there is no port 1 for a guest
const m = new ArcadeControlMap();
assert.deepEqual(m.devices(), {}, 'no devices to plug in');
assert.equal(m.join('bo'), 2);
assert.equal(m.join('cy'), 3);
assert.equal(m.join('bo'), 2, 'asking twice changes nothing');
assert.equal(m.join('dee'), null, 'a third guest waits');
assert.equal(m.route('bo'), 2);
assert.equal(m.route('cy'), 3);
assert.equal(m.route('nobody'), null);
assert.equal(m.leave('bo'), 2);
assert.equal(m.route('dee'), 2, 'the one waiting takes the freed player slot');
assert.equal(m.leave('ghost'), null);
assert.equal(m.assign(1, 'cy'), false, 'the host is always player 1');
assert.equal(m.assign(3, null), true);
assert.equal(m.route('cy'), null);
m.clear();
assert.equal(m.route('dee'), null);
console.log('ok  guests are players 2 and 3, a waiting guest takes a freed slot');

// controls
assert.equal(joyFromKeys(new Set(['ArrowLeft', 'KeyZ', 'Digit5'])).left, true);
const k = joyFromKeys(new Set(['KeyZ', 'KeyX', 'KeyC', 'KeyA', 'KeyS', 'KeyD', 'Enter', 'Digit5', 'ArrowUp']));
for (const n of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'start', 'coin', 'up']) assert.equal(k[n], true, n);
assert.equal(k.down, false);
const pad = (pressed, axes = [0, 0]) => ({ connected: true, axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })) });
assert.equal(joyFromGamepad(pad([14])).left, true);
assert.equal(joyFromGamepad(pad([], [0.9, 0])).right, true);
assert.equal(joyFromGamepad(pad([], [0.1, 0.2])).right, false, 'stick dead zone');
assert.equal(joyFromGamepad(pad([9])).start, true);
assert.equal(joyFromGamepad(pad([8])).coin, true);
assert.equal(packJoy(joyFromGamepad(null)), 0);
assert.equal(packJoy(joyFromGamepad({ connected: false })), 0);
const src = (handedness, pressed, axes = [0, 0, 0, 0]) => ({ handedness, gamepad: { axes, buttons: Array.from({ length: 7 }, (_, i) => ({ pressed: pressed.includes(i) })) } });
let x = joyFromXr([src('right', [0]), src('left', [], [0, 0, 1, 0])]);
assert.equal(x.joy.b1, true);
assert.equal(x.joy.right, false, 'the left stick walks you around unless the grip is held');
assert.equal(x.steering, false);
x = joyFromXr([src('left', [1], [0, 0, 1, 0])]);
assert.equal(x.joy.right, true);
assert.equal(x.steering, true);
x = joyFromXr([src('left', [4, 5])]);
assert.equal(x.joy.coin, true);
assert.equal(x.joy.start, true);
assert.equal(mergeJoy({ up: true }, null, { b1: true }).b1, true);
console.log('ok  keyboard, gamepad and VR controllers map to stick, buttons, start and coin');
