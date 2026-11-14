import { test } from 'node:test';
import assert from 'node:assert/strict';

// Just enough DOM for main.js: a canvas with listeners, document, window, rAF.
function setup() {
  const listeners = {};
  const sent = [];
  const frames = [];
  const fills = { n: 0 };
  const ctx = { fillRect() { fills.n++; }, set fillStyle(v) {}, get fillStyle() { return ''; } };
  const canvas = {
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    parentElement: { clientWidth: 1000 },
    getContext: () => ctx,
    addEventListener: (t, f) => { listeners[t] = f; },
    focus() {},
  };
  const docListeners = {};
  globalThis.document = { hidden: false, addEventListener: (t, f) => { docListeners[t] = f; }, activeElement: canvas };
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
  globalThis.getComputedStyle = () => ({ paddingLeft: '0', paddingRight: '0', borderLeftWidth: '0', borderRightWidth: '0' });
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  globalThis.cancelAnimationFrame = () => {};
  const key = (type, code, k = code, extra = {}) => {
    const e = { code, key: k, repeat: false, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
    listeners[type](e);
    return e;
  };
  const net = {
    handlers: {}, rtt: 33, now: () => 1000,
    on(t, f) { this.handlers[t] = f; return () => { delete this.handlers[t]; }; },
    sendInput(input) { sent.push(input); return sent.length; },
  };
  const applied = [];
  const client = {
    rtt: null, myId: 0, room: 'ABCD', crashed: false, time: 0, players: new Map(),
    applyLocalInput(i, s) { applied.push([i, s]); }, stepLocal() {}, predicted: () => null,
    interpolated: () => ({ serverTime: 0, ships: [], shots: [] }), feed: () => [], scoreboard: () => [],
    me: () => ({ alive: true, respawnIn: 0, invuln: 0, kills: 0, deaths: 0 }), latest: () => null,
    tag: () => 'XX', onPlayers() {}, onSnapshot() {}, onEvent() {},
  };
  return { canvas, key, net, client, sent, applied, frames, fills, docListeners };
}

test('main.js switches between singleplayer and multiplayer', async () => {
  const t = setup();
  const { start } = await import('../js/main.js');
  const game = start(t.canvas);
  assert.equal(game.mode, 'singleplayer');

  // singleplayer: Tab is not captured, P pauses
  assert.equal(t.key('keydown', 'Tab', 'Tab').prevented, false);
  t.key('keydown', 'KeyP', 'p');
  assert.equal(game.ui.paused, true);
  t.key('keydown', 'KeyP', 'p');

  game.startMultiplayer(t.net, t.client);
  assert.equal(game.mode, 'multiplayer');
  game.setFocused(true);

  // multiplayer: P/R ignored, Tab captured, warp does not change the sim
  t.key('keydown', 'KeyP', 'p');
  assert.equal(game.ui.paused, false);
  assert.equal(t.key('keydown', 'Tab', 'Tab').prevented, true);
  assert.equal(t.key('keydown', 'Tab', 'Tab', { shiftKey: true }).prevented, false);
  t.key('keydown', 'KeyE', 'e');
  assert.equal(game.sim.warpIndex, 0);

  // a frame sends the held controls, with fire on Space or F
  t.key('keydown', 'KeyW', 'w');
  t.key('keydown', 'KeyD', 'd');
  t.key('keydown', 'KeyF', 'f');
  t.frames.shift()(16);
  assert.deepEqual(t.sent.at(-1), { rot: 1, thrust: 1, retro: 0, fire: 1 });
  assert.equal(t.applied.length, 1);
  assert.equal(t.applied[0][1], 1);
  assert.equal(t.client.rtt, 33);
  assert.ok(t.net.handlers.snap && t.net.handlers.close);

  game.stopMultiplayer();
  assert.equal(game.mode, 'singleplayer');
  assert.equal(t.net.handlers.snap, undefined);
  t.key('keyup', 'KeyW', 'w');
  t.key('keyup', 'KeyD', 'd');
  t.key('keyup', 'KeyF', 'f');
  // singleplayer works again: R resets, warp changes
  t.key('keydown', 'KeyE', 'e');
  assert.equal(game.sim.warpIndex, 1);
});
