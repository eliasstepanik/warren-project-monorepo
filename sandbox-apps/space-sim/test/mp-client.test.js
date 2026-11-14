import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MpClient, FEED_LIFETIME, INTERP_DELAY, SNAP_DISTANCE } from '../js/mp-client.js';
import { MpSim } from '../js/mp-sim.js';
import { STEP, makeStepCache } from '../js/physics.js';

const ONE_WAY = 6; // steps: 50 ms each way, 100 ms round trip
const SNAP_EVERY = 6; // steps: 20 Hz

function snapOf(time, ships, shots = []) {
  return { time, ships, shots };
}
function ship(id, o = {}) {
  return { id, x: 0, y: 0, vx: 0, vy: 0, a: 0, alive: 1, inv: 0, k: 0, d: 0, seq: 0, ...o };
}
function welcomed(id = 0, players = []) {
  const c = new MpClient();
  c.onWelcome({ t: 'welcome', id, room: 'ABCD', players });
  return c;
}

/**
 * Server (MpSim) and client (MpClient) in one loop with a fixed one-way delay.
 * Each tick: the client takes its scripted input and sends it if it changed,
 * the server steps, snapshots go out at 20 Hz. `perturb(sim, tick)` may poke the
 * server. Returns per-tick predicted positions and server history.
 */
function simulate({ ticks, script, perturb, rtt = 2 * ONE_WAY * STEP * 1000 }) {
  const sim = new MpSim();
  const srv = sim.add(0, 'AL', 0);
  Object.assign(srv, { x: 1500, y: 0, vx: 0, vy: 0, angle: 0, invuln: 0, cache: makeStepCache() });
  const client = welcomed(0, [{ id: 0, name: 'AL', color: 0 }]);
  client.rtt = rtt;

  const up = []; // { at, input }
  const down = []; // { at, snap }
  const history = [{ x: srv.x, y: srv.y, vx: srv.vx, vy: srv.vy }]; // after server tick n
  const shown = [];
  let seq = 0;
  let last = null;
  for (let k = 0; k < ticks; k++) {
    const want = script(k);
    if (!last || ['rot', 'thrust', 'retro', 'fire'].some((f) => want[f] !== last[f])) {
      last = want;
      seq++;
      client.applyLocalInput(want, seq);
      up.push({ at: k + ONE_WAY, input: { ...want, seq } });
    }
    client.stepLocal(STEP);
    shown.push(client.predicted());

    while (up.length && up[0].at <= k) sim.setInput(0, up.shift().input);
    if (perturb) perturb(sim, k);
    sim.step();
    history.push({ x: srv.x, y: srv.y, vx: srv.vx, vy: srv.vy });
    if ((k + 1) % SNAP_EVERY === 0) down.push({ at: k + ONE_WAY, snap: sim.snapshot() });
    while (down.length && down[0].at <= k) client.onSnapshot(down.shift().snap, k * STEP * 1000);
  }
  return { client, shown, history };
}

const script = (k) => {
  if (k < 60) return { rot: 0, thrust: 1, retro: 0, fire: 0 };
  if (k < 120) return { rot: 1, thrust: 0, retro: 0, fire: 0 };
  if (k < 200) return { rot: 0, thrust: 1, retro: 0, fire: 0 };
  if (k < 260) return { rot: -1, thrust: 1, retro: 0, fire: 0 };
  if (k < 320) return { rot: 0, thrust: 0, retro: 1, fire: 0 };
  return { rot: 1, thrust: 1, retro: 0, fire: 0 };
};

test('prediction matches the server once inputs are acknowledged, without jumps', () => {
  const { shown, history } = simulate({ ticks: 600, script });
  // Local step c is what the server reaches ONE_WAY ticks later (history[n] is after n steps).
  let worst = 0;
  for (let c = 60; c < 590 - ONE_WAY; c++) {
    const s = history[c + 1 + ONE_WAY];
    worst = Math.max(worst, Math.hypot(shown[c].x - s.x, shown[c].y - s.y));
  }
  assert.ok(worst < 0.01, `worst error ${worst}`);

  let maxJump = 0;
  let maxSpeed = 0;
  for (let c = 1; c < shown.length; c++) {
    if (!shown[c] || !shown[c - 1]) continue;
    maxJump = Math.max(maxJump, Math.hypot(shown[c].x - shown[c - 1].x, shown[c].y - shown[c - 1].y));
    maxSpeed = Math.max(maxSpeed, Math.hypot(shown[c].vx, shown[c].vy) * STEP);
  }
  assert.ok(maxJump < maxSpeed * 1.1 + 0.01, `jump ${maxJump} vs step ${maxSpeed}`);
});

test('a small server-side correction is smoothed, a large one snaps', () => {
  const nudge = (dx, at) => (sim, k) => {
    if (k === at) sim.ships.get(0).x += dx;
  };
  const small = simulate({ ticks: 400, script, perturb: nudge(3, 200) });
  let maxStep = 0;
  for (let c = 1; c < 400; c++) {
    maxStep = Math.max(maxStep, Math.hypot(small.shown[c].x - small.shown[c - 1].x, small.shown[c].y - small.shown[c - 1].y));
  }
  assert.ok(maxStep < 1, `smoothed step ${maxStep}`);
  const end = small.shown[399];
  const srv = small.history[400 + 1 - 1];
  assert.ok(Math.abs(end.x - srv.x) < 3 * 2, 'converged to the corrected track');

  const big = simulate({ ticks: 400, script, perturb: nudge(SNAP_DISTANCE * 3, 200) });
  let biggest = 0;
  for (let c = 1; c < 400; c++) biggest = Math.max(biggest, Math.abs(big.shown[c].x - big.shown[c - 1].x));
  assert.ok(biggest > SNAP_DISTANCE, `snap jump ${biggest}`);
});

test('without an rtt estimate it replays the inputs the server has not seen', () => {
  const c = welcomed(0);
  c.applyLocalInput({ rot: 0, thrust: 1 }, 1);
  c.stepLocal(STEP * 10);
  c.applyLocalInput({ rot: 0, thrust: 0 }, 2);
  c.stepLocal(STEP * 5);
  c.onSnapshot(snapOf(1, [ship(0, { x: 1500, y: 0, seq: 1 })]), 0);
  // 5 steps coasting from the server state: nothing was accelerated yet by seq 2
  const p = c.predicted();
  assert.ok(p && p.x > 1499 && p.x < 1501 && p.vx > 0);
});

test('a dead ship has no prediction until it respawns', () => {
  const c = welcomed(0);
  c.onSnapshot(snapOf(1, [ship(0, { alive: 0, d: 1 })]), 0);
  assert.equal(c.predicted(), null);
  c.stepLocal(STEP * 3);
  assert.equal(c.predicted(), null);
  c.onSnapshot(snapOf(5, [ship(0, { x: 1500, inv: 2 })]), 100);
  assert.equal(c.predicted().x, 1500);
});

test('snapshot buffer keeps the last 10', () => {
  const c = welcomed(0);
  for (let i = 0; i < 15; i++) c.onSnapshot(snapOf(i, [ship(0)]), i * 50);
  assert.equal(c.snaps.length, 10);
  assert.equal(c.snaps[0].snap.time, 5);
});

test('interpolation lerps remote ships 100 ms in the past and reports server time', () => {
  const c = welcomed(0);
  c.onSnapshot(snapOf(10, [ship(0), ship(1, { x: 0, y: 10, vx: 10 })]), 1000);
  c.onSnapshot(snapOf(10.05, [ship(0), ship(1, { x: 10, y: 20, vx: 10 })]), 1050);
  const r = c.interpolated(1000 + INTERP_DELAY + 25); // render time 1025: halfway
  assert.equal(r.ships.length, 1, 'own ship is not included');
  assert.equal(r.ships[0].id, 1);
  assert.ok(Math.abs(r.ships[0].x - 5) < 1e-9 && Math.abs(r.ships[0].y - 15) < 1e-9);
  assert.ok(Math.abs(r.serverTime - 10.025) < 1e-9);
  // before the first and after the last: clamped / extrapolated
  assert.ok(Math.abs(c.interpolated(1000).ships[0].x - 0) < 1e-9);
});

test('interpolation takes the shortest arc across the +-PI wrap', () => {
  const c = welcomed(0);
  c.onSnapshot(snapOf(1, [ship(1, { a: 3.0 })]), 0);
  c.onSnapshot(snapOf(1.05, [ship(1, { a: -3.0 })]), 50);
  const a = c.interpolated(INTERP_DELAY + 25).ships[0].angle;
  const wrapped = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  assert.ok(Math.abs(wrapped - Math.PI) < 1e-9, `angle ${a}`);
  // quarter of the way: 3.0 + 0.25 * (2 * PI - 6)
  const q = c.interpolated(INTERP_DELAY + 12.5).ships[0].angle;
  assert.ok(Math.abs(q - (3.0 + 0.25 * (2 * Math.PI - 6))) < 1e-9);
});

test('shots are extrapolated by their velocity and dead ships are not blended', () => {
  const c = welcomed(0);
  const shot = { id: 7, o: 1, x: 100, y: 0, vx: 80, vy: -40 };
  c.onSnapshot(snapOf(2, [ship(1, { x: 5 })], [shot]), 0);
  c.onSnapshot(snapOf(2.05, [ship(1, { x: 900, alive: 0 })], []), 50);
  const r = c.interpolated(INTERP_DELAY + 25);
  assert.equal(r.shots.length, 1);
  assert.ok(Math.abs(r.shots[0].x - (100 + 80 * 0.025)) < 1e-9);
  assert.ok(Math.abs(r.shots[0].y + 1) < 1e-9);
  assert.equal(r.ships[0].alive, 0);
  assert.ok(r.ships[0].x === 5 || r.ships[0].x === 900, 'no blend across death');
  assert.deepEqual(new MpClient().interpolated(0), { serverTime: 0, ships: [], shots: [] });
});

test('kill feed formats events and expires lines after 4 s', () => {
  const c = welcomed(0, [
    { id: 0, name: 'Alice', color: 0 }, { id: 1, name: 'bob', color: 1 }, { id: 2, name: 'Cy', color: 2 },
  ]);
  c.onEvent({ t: 'event', type: 'kill', killer: 0, victim: 1 }, 1000);
  c.onEvent({ t: 'event', type: 'crash', id: 2, body: 0 }, 2000);
  c.onEvent({ t: 'event', type: 'respawn', id: 1 }, 3000);
  c.onEvent({ t: 'event', type: 'kill', killer: 2, victim: 2 }, 3500);
  c.onEvent({ t: 'event', type: 'bogus' }, 3500);
  assert.deepEqual(c.feed(3500).map((l) => l.text), ['AL > BO', 'CY CRASHED', 'BO RESPAWNED', 'CY SELF-HIT']);
  assert.equal(c.feed(3500)[0].at, 1000);
  assert.deepEqual(c.feed(1000 + FEED_LIFETIME - 1).length, 4);
  assert.deepEqual(c.feed(1000 + FEED_LIFETIME).map((l) => l.text), ['CY CRASHED', 'BO RESPAWNED', 'CY SELF-HIT']);
  assert.equal(c.feed(2000 + FEED_LIFETIME + 10).length, 2);
  assert.equal(c.feed(10000).length, 0);
});

test('scoreboard is sorted by kills and me() reports my status', () => {
  const c = welcomed(1, [{ id: 0, name: 'AL', color: 0 }, { id: 1, name: 'BO', color: 1 }, { id: 2, name: 'CY', color: 2 }]);
  assert.deepEqual(c.scoreboard(), []);
  assert.deepEqual(c.me(0), { alive: false, respawnIn: 0, invuln: 0, kills: 0, deaths: 0 });
  c.onSnapshot(snapOf(5, [
    ship(0, { k: 1, d: 2 }), ship(1, { k: 3, d: 1, inv: 1.5 }), ship(2, { k: 3, d: 0 }),
  ]), 0);
  assert.deepEqual(c.scoreboard().map((s) => s.id), [2, 1, 0]);
  assert.equal(c.scoreboard().find((s) => s.me).id, 1);
  assert.deepEqual(c.me(0), { alive: true, respawnIn: 0, invuln: 1.5, kills: 3, deaths: 1 });

  c.onSnapshot(snapOf(6, [ship(1, { alive: 0, k: 3, d: 2 })]), 1000);
  assert.equal(c.me(1000).alive, false);
  assert.ok(Math.abs(c.me(1000).respawnIn - 3) < 1e-9);
  c.onSnapshot(snapOf(7, [ship(1, { alive: 0, k: 3, d: 2 })]), 2000);
  assert.ok(Math.abs(c.me(2500).respawnIn - 1.5) < 1e-9);
});
