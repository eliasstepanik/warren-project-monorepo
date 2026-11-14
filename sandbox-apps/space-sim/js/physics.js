// Orbital mechanics and ship dynamics. Pure module: no DOM access.
//
// Units: distance in "du" (1 du = 1 screen pixel at zoom 1), time in seconds.
// Bodies move on rails along Keplerian ellipses; the ship is a massless test
// particle that feels the gravity of every body (N-body) and is integrated
// with velocity Verlet at a fixed step.

export const STEP = 1 / 120; // fixed physics step (s)
export const THRUST = 14; // main engine acceleration (du/s^2)
export const RETRO = 7; // retro engine acceleration (du/s^2)
export const TURN_RATE = 3; // rad/s
const SOFTENING = 0.01; // avoids a singularity at r = 0

// parent: index of the body being orbited (-1 = fixed at origin).
// a: semi-major axis, e: eccentricity, w: argument of periapsis,
// m0: mean anomaly at t = 0, gm: gravitational parameter.
// Parents must be listed before their children.
const DEFS = [
  { name: 'SOL', parent: -1, a: 0, e: 0, w: 0, m0: 0, gm: 90000, radius: 16, color: 'yellow', dark: 'orange' },
  { name: 'EMBER', parent: 0, a: 200, e: 0.04, w: 0.6, m0: 1.0, gm: 1500, radius: 7, color: 'orange', dark: 'brown' },
  { name: 'TIDE', parent: 0, a: 400, e: 0.08, w: 2.2, m0: 3.4, gm: 8000, radius: 11, color: 'blue', dark: 'darkBlue' },
  { name: 'MOTE', parent: 2, a: 64, e: 0.02, w: 1.0, m0: 0.5, gm: 25, radius: 3, color: 'lightGrey', dark: 'darkGrey' },
  { name: 'RIME', parent: 0, a: 640, e: 0.18, w: 4.4, m0: 5.2, gm: 2500, radius: 8, color: 'lavender', dark: 'darkPurple' },
];

export const STAR = 0;
export const HOME = 2; // the planet the ship starts around
export const BODIES = DEFS.map((d) => ({
  ...d,
  n: d.parent >= 0 ? Math.sqrt(DEFS[d.parent].gm / (d.a * d.a * d.a)) : 0, // mean motion
  cw: Math.cos(d.w),
  sw: Math.sin(d.w),
}));

const TWO_PI = Math.PI * 2;

/** Solve Kepler's equation M = E - e sin E for E. */
export function solveKepler(M, e) {
  M = ((M % TWO_PI) + TWO_PI) % TWO_PI;
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 8; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

/** Position of body `i` relative to its parent at eccentric anomaly E. */
export function orbitRel(i, E, out = { x: 0, y: 0 }) {
  const b = BODIES[i];
  const px = b.a * (Math.cos(E) - b.e);
  const py = b.a * Math.sqrt(1 - b.e * b.e) * Math.sin(E);
  out.x = px * b.cw - py * b.sw;
  out.y = px * b.sw + py * b.cw;
  return out;
}

export function makePositions() {
  return BODIES.map(() => ({ x: 0, y: 0 }));
}

const REL = { x: 0, y: 0 };

/** Fill `out` with every body's world position at time t. */
export function positionsAt(t, out = makePositions()) {
  for (let i = 0; i < BODIES.length; i++) {
    const b = BODIES[i];
    const o = out[i];
    if (b.parent < 0) {
      o.x = 0;
      o.y = 0;
      continue;
    }
    orbitRel(i, solveKepler(b.m0 + b.n * t, b.e), REL);
    o.x = out[b.parent].x + REL.x;
    o.y = out[b.parent].y + REL.y;
  }
  return out;
}

/** Gravitational acceleration at (x, y) from all bodies at `pos`. */
export function gravityAt(x, y, pos, out = { x: 0, y: 0 }) {
  let ax = 0;
  let ay = 0;
  for (let i = 0; i < BODIES.length; i++) {
    const dx = pos[i].x - x;
    const dy = pos[i].y - y;
    const r2 = dx * dx + dy * dy + SOFTENING;
    const k = BODIES[i].gm / (r2 * Math.sqrt(r2));
    ax += dx * k;
    ay += dy * k;
  }
  out.x = ax;
  out.y = ay;
  return out;
}

/** Index of the body whose surface the point is inside, or -1. */
export function collisionAt(x, y, pos) {
  for (let i = 0; i < BODIES.length; i++) {
    const dx = pos[i].x - x;
    const dy = pos[i].y - y;
    if (dx * dx + dy * dy < BODIES[i].radius * BODIES[i].radius) return i;
  }
  return -1;
}

/** Body exerting the strongest pull on (x, y). */
export function dominantBody(x, y, pos) {
  let best = 0;
  let bestA = -1;
  for (let i = 0; i < BODIES.length; i++) {
    const dx = pos[i].x - x;
    const dy = pos[i].y - y;
    const a = BODIES[i].gm / (dx * dx + dy * dy + SOFTENING);
    if (a > bestA) {
      bestA = a;
      best = i;
    }
  }
  return best;
}

/**
 * Index of the first body whose disc the segment (x0, y0)-(x1, y1) touches, or
 * -1. Testing the whole segment, not just its end, keeps fast ships from
 * tunnelling through small bodies such as MOTE.
 */
export function segmentCollision(x0, y0, x1, y1, pos) {
  const sx = x1 - x0;
  const sy = y1 - y0;
  const len2 = sx * sx + sy * sy;
  for (let i = 0; i < BODIES.length; i++) {
    const dx = pos[i].x - x0;
    const dy = pos[i].y - y0;
    const u = len2 > 0 ? Math.max(0, Math.min(1, (dx * sx + dy * sy) / len2)) : 0;
    const cx = dx - u * sx;
    const cy = dy - u * sy;
    if (cx * cx + cy * cy < BODIES[i].radius * BODIES[i].radius) return i;
  }
  return -1;
}

/**
 * Cache of the gravitational acceleration at the end of the last step. The next
 * step starts exactly there, so it can skip one positionsAt + gravityAt.
 */
export function makeStepCache() {
  return { t: NaN, x: NaN, y: NaN, ax: 0, ay: 0 };
}

const P0 = makePositions();
const P1 = makePositions();
const A0 = { x: 0, y: 0 };
const A1 = { x: 0, y: 0 };

/**
 * Advance ship state `s` ({x, y, vx, vy, angle}) from time t by h with velocity
 * Verlet. `thrust` is the engine acceleration along the ship's heading (may be
 * negative). Pass the same `cache` (from makeStepCache) to consecutive steps to
 * reuse the end-of-step acceleration; it is only used if the ship is exactly
 * where the previous step left it. Returns the index of a body hit anywhere
 * along the step (checked against the bodies' positions at t + h), or -1.
 */
export function stepState(s, t, h, thrust = 0, cache = null) {
  const x0 = s.x;
  const y0 = s.y;
  if (cache && cache.t === t && cache.x === x0 && cache.y === y0) {
    A0.x = cache.ax;
    A0.y = cache.ay;
  } else {
    positionsAt(t, P0);
    gravityAt(x0, y0, P0, A0);
  }
  const tx = Math.cos(s.angle) * thrust;
  const ty = Math.sin(s.angle) * thrust;
  const ax = A0.x + tx;
  const ay = A0.y + ty;
  s.x += s.vx * h + 0.5 * ax * h * h;
  s.y += s.vy * h + 0.5 * ay * h * h;
  positionsAt(t + h, P1);
  gravityAt(s.x, s.y, P1, A1);
  s.vx += 0.5 * (ax + A1.x + tx) * h;
  s.vy += 0.5 * (ay + A1.y + ty) * h;
  if (cache) {
    cache.t = t + h;
    cache.x = s.x;
    cache.y = s.y;
    cache.ax = A1.x;
    cache.ay = A1.y;
  }
  return segmentCollision(x0, y0, s.x, s.y, P1);
}

const V0 = makePositions();
const V1 = makePositions();

/** Velocity of body `i` at time t (central difference of the rails). */
export function bodyVelocity(i, t, out = { x: 0, y: 0 }) {
  const e = 0.005;
  positionsAt(t - e, V0);
  positionsAt(t + e, V1);
  out.x = (V1[i].x - V0[i].x) / (2 * e);
  out.y = (V1[i].y - V0[i].y) / (2 * e);
  return out;
}

/**
 * Ship state in a circular orbit of radius r around body `i` at time t.
 * `phase` is the angle (rad) of the ship as seen from the body. The ship
 * heads along its (body-relative) velocity.
 */
export function circularOrbit(i, r, t, phase) {
  const pos = positionsAt(t);
  const bv = bodyVelocity(i, t);
  const v = Math.sqrt(BODIES[i].gm / r);
  const tx = -Math.sin(phase);
  const ty = Math.cos(phase);
  return {
    x: pos[i].x + Math.cos(phase) * r,
    y: pos[i].y + Math.sin(phase) * r,
    vx: bv.x + tx * v,
    vy: bv.y + ty * v,
    angle: Math.atan2(ty, tx),
  };
}

const Q = makePositions();

/**
 * Coast (no thrust) `steps` samples ahead, spaced `dt` apart, integrating with
 * sub-steps of at most `hMax`. Moving bodies are evaluated at each future
 * time. Points are expressed relative to the body that dominates gravity at
 * the start, so an orbit around a moving planet draws as a closed curve.
 * Point k is the state at time t + (k + 1) * dt. The path is only valid while
 * coasting. Collisions are tested along every sub-step segment.
 * Returns { pts: Float32Array(x,y pairs), n, hit, ref, end, t0, dt, rx, ry }
 * where (rx, ry) is the reference body's position at t0.
 */
export function predict(ship, t, steps = 400, dt = 0.1, hMax = 0.05) {
  const s = { x: ship.x, y: ship.y, vx: ship.vx, vy: ship.vy, angle: 0 };
  const pts = new Float32Array(steps * 2);
  positionsAt(t, Q);
  const ref = dominantBody(s.x, s.y, Q);
  const rx = Q[ref].x;
  const ry = Q[ref].y;
  const sub = Math.ceil(dt / hMax - 1e-9);
  const h = dt / sub;
  const cache = makeStepCache();
  let hit = -1;
  let n = 0;
  let tt = t;
  for (let k = 0; k < steps && hit < 0; k++) {
    for (let j = 0; j < sub && hit < 0; j++) {
      hit = stepState(s, tt, h, 0, cache);
      tt += h;
    }
    positionsAt(t + (k + 1) * dt, Q);
    pts[n * 2] = s.x - Q[ref].x + rx;
    pts[n * 2 + 1] = s.y - Q[ref].y + ry;
    n++;
  }
  return { pts, n, hit, ref, end: s, t0: t, dt, rx, ry };
}
