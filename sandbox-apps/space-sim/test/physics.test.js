import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BODIES, HOME, STEP, positionsAt, stepState, circularOrbit, predict, solveKepler, bodyVelocity,
  segmentCollision,
} from '../js/physics.js';
import { Sim } from '../js/sim.js';

/** Distance between the ship and body i at time t. */
function relative(ship, i, t) {
  const p = positionsAt(t)[i];
  return Math.hypot(ship.x - p.x, ship.y - p.y);
}

test('Kepler solver satisfies M = E - e sin E', () => {
  for (const e of [0, 0.1, 0.5, 0.9]) {
    for (let M = 0; M < 6.28; M += 0.37) {
      const E = solveKepler(M, e);
      assert.ok(Math.abs(E - e * Math.sin(E) - M) < 1e-9);
    }
  }
});

test('planets stay on their ellipses (distance within [a(1-e), a(1+e)])', () => {
  for (let t = 0; t < 5000; t += 37) {
    const pos = positionsAt(t);
    BODIES.forEach((b, i) => {
      if (b.parent < 0) return;
      const d = Math.hypot(pos[i].x - pos[b.parent].x, pos[i].y - pos[b.parent].y);
      assert.ok(d >= b.a * (1 - b.e) - 1e-6 && d <= b.a * (1 + b.e) + 1e-6, `${b.name} t=${t}`);
    });
  }
});

test('starting circular orbit stays roughly circular for several orbits', () => {
  const r0 = 22;
  const ship = circularOrbit(HOME, r0, 0, -Math.PI / 2);
  const period = 2 * Math.PI * Math.sqrt((r0 ** 3) / BODIES[HOME].gm);
  const steps = Math.round((period * 5) / STEP);
  let t = 0;
  let rmin = Infinity;
  let rmax = 0;
  for (let k = 0; k < steps; k++) {
    assert.equal(stepState(ship, t, STEP, 0), -1, 'ship must not crash');
    t += STEP;
    const r = relative(ship, HOME, t);
    rmin = Math.min(rmin, r);
    rmax = Math.max(rmax, r);
  }
  // Other bodies perturb the orbit slightly; allow 15%.
  assert.ok(rmin > r0 * 0.85, `rmin ${rmin}`);
  assert.ok(rmax < r0 * 1.15, `rmax ${rmax}`);
});

test('prediction matches real flight and follows moving bodies', () => {
  const sim = new Sim();
  const p = predict(sim.ship, 0, 100, 0.1, 0.05);
  assert.equal(p.hit, -1);
  const ship = { ...sim.ship };
  let t = 0;
  for (let k = 0; k < Math.round(10 / STEP); k++) {
    stepState(ship, t, STEP, 0);
    t += STEP;
  }
  const rel = positionsAt(10)[p.ref];
  const last = p.n - 1;
  // Prediction points are relative to the reference body's start position.
  const start = positionsAt(0)[p.ref];
  const px = p.pts[last * 2] - start.x + rel.x;
  const py = p.pts[last * 2 + 1] - start.y + rel.y;
  assert.ok(Math.hypot(px - ship.x, py - ship.y) < 1, 'prediction drifted from real path');
});

test('energy-like stability at max warp: no NaN, orbit bounded', () => {
  const sim = new Sim();
  sim.warpIndex = 6; // 64x
  for (let f = 0; f < 60 * 15; f++) { // 15 s real time = 960 s simulated
    sim.update(1 / 60, { turn: 0, thrust: 0 });
    assert.ok(Number.isFinite(sim.ship.x) && Number.isFinite(sim.ship.vx));
    if (sim.crash) break;
  }
  assert.ok(!sim.crash, 'starting orbit should survive 15 s at 64x');
  assert.ok(relative(sim.ship, HOME, sim.t) < 40);
});

test('flying into a planet crashes; reset restores a live ship', () => {
  const sim = new Sim();
  // Cancel velocity relative to the planet so the ship falls straight in.
  const pos = positionsAt(0)[HOME];
  const bv = bodyVelocity(HOME, 0);
  sim.ship.vx = bv.x;
  sim.ship.vy = bv.y;
  sim.ship.x = pos.x;
  sim.ship.y = pos.y - 30;
  for (let f = 0; f < 60 * 10 && !sim.crash; f++) sim.update(1 / 60, { turn: 0, thrust: 0 });
  assert.ok(sim.crash, 'expected a crash');
  assert.ok(sim.particles.length > 0);
  sim.reset();
  assert.equal(sim.crash, null);
  assert.equal(sim.t, 0);
});

/** Ship speed relative to HOME, whose own velocity must not count. */
function homeSpeed(sim) {
  const bv = bodyVelocity(HOME, sim.t);
  return Math.hypot(sim.ship.vx - bv.x, sim.ship.vy - bv.y);
}

test('thrust accelerates along heading; retro decelerates', () => {
  const sim = new Sim();
  const a0 = sim.ship.angle;
  const v0 = homeSpeed(sim);
  for (let f = 0; f < 30; f++) sim.update(1 / 60, { turn: 0, thrust: 1 });
  assert.equal(sim.ship.angle, a0);
  assert.ok(homeSpeed(sim) > v0);
  const sim2 = new Sim();
  for (let f = 0; f < 30; f++) sim2.update(1 / 60, { turn: 0, thrust: -1 });
  assert.ok(homeSpeed(sim2) < v0);
});

test('segmentCollision catches a fast pass through a small body', () => {
  const pos = positionsAt(0);
  const mote = BODIES.findIndex((b) => b.name === 'MOTE');
  const { x, y } = pos[mote];
  // Both endpoints are outside MOTE (r=3) but the segment crosses it.
  assert.equal(segmentCollision(x - 20, y, x + 20, y, pos), mote);
  assert.equal(segmentCollision(x - 20, y + 10, x + 20, y + 10, pos), -1);
});

test('segmentCollision accounts for the body moving during the step', () => {
  const pos0 = positionsAt(0);
  const mote = BODIES.findIndex((b) => b.name === 'MOTE');
  const { x, y } = pos0[mote];
  // MOTE sweeps 40 du across a stationary ship; both endpoints are outside it.
  const pos1 = pos0.map((p, i) => (i === mote ? { x: x + 40, y } : { x: p.x, y: p.y }));
  const start = { x: x + 20, y };
  assert.equal(segmentCollision(start.x, start.y, start.x, start.y, pos0, pos1), mote);
  // Against the end positions alone the ship is 20 du away and nothing is hit.
  assert.equal(segmentCollision(start.x, start.y, start.x, start.y, pos1), -1);
});

test('prediction detects a collision with MOTE that endpoint checks would miss', () => {
  const t = 0;
  const pos = positionsAt(t);
  const mote = BODIES.findIndex((b) => b.name === 'MOTE');
  const bv = bodyVelocity(mote, t);
  // Fly through MOTE's centre at 400 du/s relative to it: 8 du per 0.02 s step (endpoints land at -4 and +4).
  const ship = { x: pos[mote].x - 44, y: pos[mote].y, vx: bv.x + 400, vy: bv.y };
  const p = predict(ship, t, 20, 0.02, 0.02);
  assert.equal(p.hit, mote);
});

test('crash freezes the HUD telemetry at ALT 0 / SPD 0 on the body hit', () => {
  const sim = new Sim();
  sim.explode(HOME);
  sim.update(1 / 60, { turn: 0, thrust: 0 });
  const tel = sim.telemetry();
  assert.equal(tel.body, HOME);
  assert.equal(tel.altitude, 0);
  assert.equal(tel.speed, 0);
});

test('prediction is throttled while coasting but refreshed on warp change', () => {
  const sim = new Sim();
  const first = sim.prediction;
  sim.update(1 / 60, { turn: 0, thrust: 0 });
  assert.equal(sim.prediction, first, 'coasting frame should reuse the prediction');
  sim.changeWarp(1);
  sim.update(1 / 60, { turn: 0, thrust: 0 });
  assert.notEqual(sim.prediction, first, 'warp change should refresh immediately');
  const second = sim.prediction;
  sim.update(1 / 60, { turn: 0, thrust: 1 }); // thrust is ignored at warp, so no refresh needed
  for (let f = 0; f < 4; f++) sim.update(1 / 60, { turn: 0, thrust: 0 });
  assert.notEqual(sim.prediction, second, 'prediction should refresh every few frames');
});

test('bodyVelocity is a central difference matching the analytic orbit speed', () => {
  // EMBER is nearly circular: speed relative to the star ~ sqrt(gm/a).
  const v = bodyVelocity(1, 0);
  const b = BODIES[1];
  const expect = Math.sqrt(BODIES[0].gm / b.a);
  assert.ok(Math.abs(Math.hypot(v.x, v.y) - expect) / expect < 0.15);
});
