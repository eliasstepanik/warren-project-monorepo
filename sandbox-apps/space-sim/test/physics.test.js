import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BODIES, HOME, STEP, positionsAt, stepState, circularOrbit, predict, solveKepler, bodyVelocity,
} from '../js/physics.js';
import { Sim } from '../js/sim.js';

/** Ship position/velocity relative to body i at time t. */
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
  assert.ok(!sim.crash, 'starting orbit should survive a minute at 64x');
  assert.ok(relative(sim.ship, HOME, sim.t) < 60);
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

test('thrust accelerates along heading; retro decelerates', () => {
  const sim = new Sim();
  const a0 = sim.ship.angle;
  const v0 = Math.hypot(sim.ship.vx, sim.ship.vy);
  for (let f = 0; f < 30; f++) sim.update(1 / 60, { turn: 0, thrust: 1 });
  assert.equal(sim.ship.angle, a0);
  assert.ok(Math.hypot(sim.ship.vx, sim.ship.vy) > v0);
  const sim2 = new Sim();
  for (let f = 0; f < 30; f++) sim2.update(1 / 60, { turn: 0, thrust: -1 });
  assert.ok(Math.hypot(sim2.ship.vx, sim2.ship.vy) < v0);
});
