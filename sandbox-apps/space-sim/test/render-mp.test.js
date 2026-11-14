import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MpClient } from '../js/mp-client.js';
import { renderMp, createMpView, addExplosion, changeMpZoom } from '../js/render-mp.js';
import { circularOrbit, HOME } from '../js/physics.js';

// Canvas stub: rejects NaN coordinates and records fills and the colours used.
function stubCtx() {
  const calls = { fills: 0, colors: new Set() };
  return {
    calls,
    fillStyle: '',
    fillRect(x, y, w, h) {
      assert.ok([x, y, w, h].every(Number.isFinite), `bad rect ${x},${y},${w},${h}`);
      calls.fills++;
      calls.colors.add(this.fillStyle);
    },
  };
}

function ship(id, phase, over = {}) {
  const o = circularOrbit(HOME, 22 + id * 3, 0, phase);
  return { id, x: o.x, y: o.y, vx: o.vx, vy: o.vy, a: o.angle, alive: 1, inv: 0, k: id, d: 0, seq: 0, ...over };
}

function makeClient(ships, shots = []) {
  const c = new MpClient();
  c.onWelcome({
    id: 0, room: 'ABCD',
    players: ['ANN', 'BOB', 'CY', 'DI'].map((name, id) => ({ id, name, color: id })),
  });
  c.rtt = 40;
  c.onSnapshot({ time: 1, ships, shots }, 1000);
  c.onSnapshot({ time: 1.05, ships, shots }, 1050);
  return c;
}

const ui = (over = {}) => ({ focused: true, tab: false, disconnected: false, flashUntil: 0, ...over });

test('renderMp draws 4 ships, shots, kill feed and edge arrows', () => {
  const far = ship(3, 0, { x: 5000, y: -4000 }); // far off-screen: edge arrow
  const ships = [ship(0, 0), ship(1, 1), ship(2, 2), far];
  const shots = [{ id: 1, o: 1, x: ships[1].x + 5, y: ships[1].y, vx: 10, vy: 0 }];
  const client = makeClient(ships, shots);
  client.onEvent({ type: 'kill', killer: 1, victim: 2 }, 1060);
  client.onEvent({ type: 'crash', id: 3, body: 1 }, 1060);
  const view = createMpView();
  const ctx = stubCtx();
  client.stepLocal(1 / 60);
  renderMp(ctx, client, ui(), view, 1100);
  assert.ok(ctx.calls.fills > 200);
  assert.ok(view.lastPos.has(1) && view.lastPos.has(0));
  // every ship colour is used (own ship, two visible enemies, the arrow for ship 3)
  for (const c of ['#ff004d', '#00e436', '#29adff', '#ffec27']) assert.ok(ctx.calls.colors.has(c), c);
});

test('renderMp survives every zoom, explosions and invulnerable blinking', () => {
  const ships = [ship(0, 0, { inv: 1.5 }), ship(1, 1, { inv: 1.5 })];
  const client = makeClient(ships);
  const view = createMpView();
  const ctx = stubCtx();
  for (let z = 0; z < 12; z++) {
    changeMpZoom(view, z < 6 ? -1 : 1);
    client.stepLocal(1 / 60);
    renderMp(ctx, client, ui(), view, 1100 + z * 50);
  }
  addExplosion(view, { type: 'kill', killer: 0, victim: 1 }, 1700);
  addExplosion(view, { type: 'respawn', id: 1 }, 1700); // ignored
  assert.equal(view.explosions.length, 1);
  renderMp(ctx, client, ui(), view, 1800);
  renderMp(ctx, client, ui(), view, 1700 + 5000);
  assert.equal(view.explosions.length, 0);
});

test('renderMp draws the scoreboard overlay and the focus hint', () => {
  const client = makeClient([ship(0, 0), ship(1, 1)]);
  const ctx1 = stubCtx();
  renderMp(ctx1, client, ui(), createMpView(), 1100);
  const ctx2 = stubCtx();
  renderMp(ctx2, client, ui({ tab: true, focused: false, flashUntil: 5000 }), createMpView(), 1100);
  assert.ok(ctx2.calls.fills > ctx1.calls.fills);
});

test('renderMp handles dead, connecting and disconnected states', () => {
  const dead = makeClient([ship(0, 0, { alive: 0 }), ship(1, 1)]);
  const view = createMpView();
  const ctxDead = stubCtx();
  renderMp(ctxDead, dead, ui(), view, 1100);
  assert.ok(ctxDead.calls.fills > 100);
  assert.equal(dead.predicted(), null);

  const connecting = new MpClient();
  connecting.onWelcome({ id: 0, room: 'WXYZ', players: [] });
  const ctxConn = stubCtx();
  renderMp(ctxConn, connecting, ui(), createMpView(), 500); // no snapshot yet
  assert.ok(ctxConn.calls.fills > 50);

  const ctxOff = stubCtx();
  renderMp(ctxOff, makeClient([ship(0, 0)]), ui({ disconnected: true }), createMpView(), 1100);
  assert.ok(ctxOff.calls.fills > 100);
});
