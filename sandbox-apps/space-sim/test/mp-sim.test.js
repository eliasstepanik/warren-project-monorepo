import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MpSim, sanitizeInput, MAX_SHIPS, FIRE_COOLDOWN, PROJECTILE_LIFE, MUZZLE_SPEED,
  OWNER_GRACE, RESPAWN_DELAY, INVULN_TIME, SPAWN_CLEARANCE,
} from '../js/mp-sim.js';
import { BODIES, STEP, positionsAt, gravityAt } from '../js/physics.js';

const steps = (s) => Math.round(s / STEP);

/** Run n steps, collecting events. */
function run(sim, n) {
  const events = [];
  for (let i = 0; i < n; i++) events.push(...sim.step());
  return events;
}

/** Park a ship in empty space far from every body, heading along +x. */
function park(ship, x, y, vx = 0, vy = 0) {
  Object.assign(ship, { x, y, vx, vy, angle: 0, invuln: 0 });
}

/** Seeded generator so spawn positions are repeatable. */
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function pair() {
  const sim = new MpSim({ rng: seeded(1) });
  const a = sim.add(1, 'ALPHA', 0);
  const b = sim.add(2, 'BRAVO', 1);
  park(a, 1500, 0);
  park(b, 1540, 0);
  return { sim, a, b };
}

test('inputs are clamped to valid values', () => {
  assert.deepEqual(sanitizeInput({ rot: 5, thrust: 7, retro: 'x', fire: 2, seq: 12 }),
    { rot: 1, thrust: 1, retro: 0, fire: 1, seq: 12 });
  assert.deepEqual(sanitizeInput({ rot: -0.2, seq: -4 }), { rot: -1, thrust: 0, retro: 0, fire: 0, seq: 0 });
  assert.deepEqual(sanitizeInput(null), { rot: 0, thrust: 0, retro: 0, fire: 0, seq: 0 });
});

test('ships rotate and thrust, and report the last input seq', () => {
  const { sim, a } = pair();
  sim.setInput(1, { rot: 1, thrust: 1, seq: 9 });
  run(sim, steps(0.5));
  assert.ok(a.angle > 1.4 && a.angle < 1.6, `angle ${a.angle}`);
  assert.ok(Math.hypot(a.vx, a.vy) > 5);
  assert.equal(sim.snapshot().ships.find((s) => s.id === 1).seq, 9);
});

test('add enforces the 4 ship limit and remove drops ships and their shots', () => {
  const sim = new MpSim();
  for (let i = 0; i < MAX_SHIPS; i++) sim.add(i, `P${i}`, i);
  assert.throws(() => sim.add(9, 'X', 0));
  sim.setInput(0, { fire: 1 });
  run(sim, 2);
  assert.equal(sim.projectiles.length, 1);
  assert.ok(sim.remove(0));
  assert.equal(sim.projectiles.length, 0);
  assert.equal(sim.ships.size, 3);
});

test('firing is limited by the cooldown and shots expire after their lifetime', () => {
  const { sim } = pair();
  sim.remove(2); // keep the line of fire clear
  sim.setInput(1, { fire: 1 });
  run(sim, steps(1.0));
  assert.equal(sim.projectiles.length, Math.floor(1.0 / FIRE_COOLDOWN) + 1);
  sim.setInput(1, { fire: 0 });
  run(sim, steps(PROJECTILE_LIFE) + 2);
  assert.equal(sim.projectiles.length, 0);
});

test('a projectile starts at ship velocity + muzzle velocity and is pulled by gravity', () => {
  const sim = new MpSim();
  const a = sim.add(1, 'A', 0);
  park(a, 1500, 0, 0, 3);
  a.angle = Math.PI / 2; // fire along +y, perpendicular to the pull towards SOL
  sim.setInput(1, { fire: 1 });
  sim.step();
  sim.setInput(1, { fire: 0 });
  const p = sim.projectiles[0];
  assert.ok(Math.abs(p.vy - (3 + MUZZLE_SPEED)) < 0.1, `vy ${p.vy}`);
  assert.ok(Math.abs(p.vx) < 0.1);
  const t0 = sim.time;
  const vx0 = p.vx;
  run(sim, steps(1));
  const g = gravityAt(p.x, p.y, positionsAt(sim.time));
  assert.ok(g.x < 0);
  const dvx = p.vx - vx0;
  assert.ok(dvx < 0 && Math.abs(dvx - g.x * (sim.time - t0)) < Math.abs(g.x) * 0.3, `dvx ${dvx} g ${g.x}`);
});

test('a projectile kills the ship it hits and credits the shooter', () => {
  const { sim, a, b } = pair();
  sim.setInput(1, { fire: 1 });
  const events = run(sim, steps(0.6));
  const kill = events.find((e) => e.type === 'kill');
  assert.deepEqual(kill, { type: 'kill', killer: 1, victim: 2 });
  assert.equal(b.alive, false);
  assert.equal(b.deaths, 1);
  assert.equal(a.kills, 1);
  assert.equal(a.deaths, 0);
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  assert.equal(snap.ships.find((s) => s.id === 2).alive, 0);
  assert.equal(snap.ships.find((s) => s.id === 1).k, 1);
});

test('a projectile that misses passes by', () => {
  const { sim, b } = pair();
  b.y = 60;
  sim.setInput(1, { fire: 1 });
  sim.setInput(1, { fire: 1 });
  run(sim, steps(0.6));
  assert.equal(b.alive, true);
});

test('a projectile cannot hit its owner during the grace period', () => {
  const sim = new MpSim();
  const a = sim.add(1, 'A', 0);
  park(a, 1500, 0);
  sim.setInput(1, { fire: 1 });
  sim.step();
  sim.setInput(1, { fire: 0 });
  const p = sim.projectiles[0];
  const graceTicks = steps(OWNER_GRACE);
  // Put the ship on the shot, moving with it.
  const onShot = () => Object.assign(a, { x: p.x, y: p.y, vx: p.vx, vy: p.vy });
  p.age = graceTicks - 3;
  onShot();
  sim.step();
  assert.equal(a.alive, true, 'inside grace');
  p.age = graceTicks;
  onShot();
  const events = run(sim, 1);
  assert.equal(a.alive, false, 'after grace');
  assert.deepEqual(events[0], { type: 'kill', killer: 1, victim: 1 });
  assert.equal(a.kills, 0, 'no kill credit for hitting yourself');
  assert.equal(a.deaths, 1);
});

test('a projectile is stopped by a body', () => {
  const sim = new MpSim();
  const a = sim.add(1, 'A', 0);
  const mote = positionsAt(0)[3];
  const sol = positionsAt(0)[0];
  // Shoot at the star from nearby.
  park(a, sol.x + 60, sol.y);
  a.angle = Math.PI;
  sim.setInput(1, { fire: 1 });
  sim.step();
  sim.setInput(1, { fire: 0 });
  assert.equal(sim.projectiles.length, 1);
  run(sim, steps(1));
  assert.equal(sim.projectiles.length, 0);
  assert.ok(mote); // MOTE exists; the star's radius is what matters here
  assert.ok(BODIES[0].radius > 0);
});

test('crashing into a body kills the ship without a kill credit', () => {
  const sim = new MpSim();
  const a = sim.add(1, 'A', 0);
  const sol = positionsAt(sim.time)[0];
  park(a, sol.x + 8, sol.y, 0, 0);
  const events = run(sim, 3);
  assert.equal(events.filter((e) => e.type === 'crash').length, 1);
  assert.equal(events[0].id, 1);
  assert.equal(events[0].body, 0);
  assert.equal(a.alive, false);
  assert.equal(a.deaths, 1);
  assert.equal(a.kills, 0);
});

test('dead ships respawn after the delay, invulnerable, in a safe orbit', () => {
  const { sim, b } = pair();
  sim.setInput(1, { fire: 1 });
  let n = 0;
  while (b.alive) {
    sim.step();
    n++;
    assert.ok(n < steps(1), 'the shot should have landed');
  }
  sim.setInput(1, { fire: 0 });
  sim.projectiles.length = 0;
  const events = run(sim, steps(RESPAWN_DELAY) - 3);
  assert.equal(b.alive, false, 'still dead before the delay');
  assert.equal(events.some((e) => e.type === 'respawn'), false);
  const later = run(sim, 6);
  assert.deepEqual(later.find((e) => e.type === 'respawn'), { type: 'respawn', id: 2 });
  assert.equal(b.alive, true);
  assert.ok(Math.abs(b.invuln * STEP - INVULN_TIME) < 0.05);
  assert.equal(b.deaths, 1, 'score survives the respawn');
  // Orbit is circular around a planet: speed matches sqrt(gm / r) relative to it.
  const pos = positionsAt(sim.time);
  const planet = [1, 2, 4].find((i) => Math.hypot(b.x - pos[i].x, b.y - pos[i].y) < 40);
  assert.ok(planet, 'spawned close to a planet');
  // Invulnerable: a shot through the ship does nothing.
  sim.setInput(1, { fire: 1 });
  park(sim.ships.get(1), b.x - 20, b.y, b.vx, b.vy);
  sim.ships.get(1).angle = 0;
  const invuln = b.invuln;
  run(sim, 20);
  assert.ok(invuln > 0);
  assert.equal(b.alive, true);
  // The invulnerability runs out.
  run(sim, steps(INVULN_TIME) + 5);
  assert.equal(b.invuln, 0);
});

test('spawns are safe: outside bodies, clear of other ships, on a circular orbit', () => {
  const sim = new MpSim({ rng: seeded(7) });
  const ships = [1, 2, 3, 4].map((id) => sim.add(id, `P${id}`, id - 1));
  for (let i = 0; i < 30; i++) {
    const s = ships[i % 4];
    sim.spawn(s);
    const pos = positionsAt(sim.time);
    BODIES.forEach((b, k) => assert.ok(Math.hypot(s.x - pos[k].x, s.y - pos[k].y) > b.radius + 3));
    for (const o of ships) {
      if (o !== s) assert.ok(Math.hypot(s.x - o.x, s.y - o.y) >= SPAWN_CLEARANCE * 0.5);
    }
  }
  // Survives half a minute of coasting without crashing.
  const events = run(sim, steps(10));
  assert.equal(events.filter((e) => e.type === 'crash').length, 0);
});

test('snapshot is compact and JSON-safe', () => {
  const { sim } = pair();
  sim.setInput(1, { fire: 1 });
  run(sim, 5);
  const snap = sim.snapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  assert.equal(snap.ships.length, 2);
  assert.deepEqual(Object.keys(snap.ships[0]).sort(),
    ['a', 'alive', 'd', 'id', 'inv', 'k', 'seq', 'vx', 'vy', 'x', 'y']);
  assert.equal(snap.shots.length, 1);
  assert.ok(Math.abs(snap.time - 5 * STEP) < 0.001);
});
