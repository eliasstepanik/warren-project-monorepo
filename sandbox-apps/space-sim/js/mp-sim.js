// Multiplayer orbital combat simulation. Pure module: no DOM, no Node APIs, so
// the server (and later the browser client, for prediction) can share it.
//
// Everything advances in whole fixed steps (STEP = 1/120 s). Cooldowns and
// timers are counted in steps so they are exact; snapshots report seconds. Ships and projectiles use physics.stepState, so they feel the same
// N-body gravity and use the same segment collision as the single-player ship.
import {
  BODIES, STEP, THRUST, RETRO, TURN_RATE,
  stepState, makeStepCache, circularOrbit, predict,
} from './physics.js';

export const MAX_SHIPS = 4;
export const FIRE_COOLDOWN = 0.4; // s between shots
export const PROJECTILE_LIFE = 4; // s
export const MUZZLE_SPEED = 80; // du/s added to the ship's velocity
export const MUZZLE_OFFSET = 6; // du ahead of the ship centre
export const OWNER_GRACE = 0.3; // s before a projectile can hit its owner
export const HIT_RADIUS = 5; // du: ships are hit inside this radius
export const RESPAWN_DELAY = 3; // s from death to respawn
export const INVULN_TIME = 2; // s of invulnerability after a respawn
export const SPAWN_ALTITUDE = 14; // du above the surface of the planet
export const SPAWN_CLEARANCE = 40; // du kept to other ships when spawning

const ticks = (s) => Math.round(s / STEP);
const FIRE_TICKS = ticks(FIRE_COOLDOWN);
const LIFE_TICKS = ticks(PROJECTILE_LIFE);
const GRACE_TICKS = ticks(OWNER_GRACE);
const RESPAWN_TICKS = ticks(RESPAWN_DELAY);
const INVULN_TICKS = ticks(INVULN_TIME);
const PLANETS = BODIES.map((b, i) => i).filter((i) => BODIES[i].parent === 0);
const SPAWN_TRIES = 24;

const round = (v, n) => Math.round(v * n) / n;

/** Clamp an untrusted input to { rot: -1|0|1, thrust, retro, fire: 0|1, seq: int }. */
export function sanitizeInput(raw) {
  const i = raw && typeof raw === 'object' ? raw : {};
  const rot = Number(i.rot);
  const seq = Number(i.seq);
  return {
    rot: rot > 0 ? 1 : rot < 0 ? -1 : 0,
    thrust: Number(i.thrust) ? 1 : 0,
    retro: Number(i.retro) ? 1 : 0,
    fire: Number(i.fire) ? 1 : 0,
    seq: Number.isSafeInteger(seq) && seq >= 0 ? seq : 0,
  };
}

/** Smallest distance from the origin to the segment (ax, ay)-(bx, by). */
function segmentDistance(ax, ay, bx, by) {
  const sx = bx - ax;
  const sy = by - ay;
  const len2 = sx * sx + sy * sy;
  const u = len2 > 0 ? Math.max(0, Math.min(1, -(ax * sx + ay * sy) / len2)) : 0;
  return Math.hypot(ax + u * sx, ay + u * sy);
}

export class MpSim {
  /** `rng` returns a number in [0, 1); inject a seeded one in tests. */
  constructor({ rng = Math.random } = {}) {
    this.rng = rng;
    this.time = 0; // simulation time in seconds, advanced by exactly STEP per step
    this.ships = new Map(); // id -> ship
    this.projectiles = [];
    this.nextProjectile = 1;
  }

  /** Add a ship (spawned at once, invulnerable). Returns the ship. */
  add(id, name = '', color = 0) {
    if (this.ships.has(id)) throw new Error(`ship ${id} exists`);
    if (this.ships.size >= MAX_SHIPS) throw new Error('sim is full');
    const c = Number.isInteger(color) ? Math.max(0, Math.min(3, color)) : 0;
    const ship = {
      id, name: String(name).slice(0, 12), color: c,
      x: 0, y: 0, vx: 0, vy: 0, angle: 0, px: 0, py: 0,
      alive: false, invuln: 0, respawn: 0, cooldown: 0,
      kills: 0, deaths: 0,
      input: sanitizeInput(null), lastSeq: 0,
      cache: makeStepCache(),
    };
    this.ships.set(id, ship);
    this.spawn(ship);
    return ship;
  }

  /** Remove a ship and the projectiles it fired. */
  remove(id) {
    if (!this.ships.delete(id)) return false;
    this.projectiles = this.projectiles.filter((p) => p.owner !== id);
    return true;
  }

  /** Set the held controls of a ship. Input is clamped; unknown ids are ignored. */
  setInput(id, raw) {
    const ship = this.ships.get(id);
    if (!ship) return;
    ship.input = sanitizeInput(raw);
    ship.lastSeq = ship.input.seq;
  }

  /** Put the ship into a random safe circular orbit around a random planet. */
  spawn(ship) {
    let best = null;
    let bestClear = -1;
    for (let k = 0; k < SPAWN_TRIES; k++) {
      const body = PLANETS[Math.floor(this.rng() * PLANETS.length) % PLANETS.length];
      const phase = this.rng() * Math.PI * 2;
      const s = circularOrbit(body, BODIES[body].radius + SPAWN_ALTITUDE, this.t, phase);
      let clear = Infinity;
      for (const o of this.ships.values()) {
        if (o !== ship && o.alive) clear = Math.min(clear, Math.hypot(o.x - s.x, o.y - s.y));
      }
      if (clear > bestClear && predict(s, this.t, 50, 0.1).hit < 0) {
        best = s;
        bestClear = clear;
      }
      if (best === s && clear >= SPAWN_CLEARANCE) break;
    }
    if (!best) best = circularOrbit(PLANETS[0], BODIES[PLANETS[0]].radius + SPAWN_ALTITUDE, this.t, 0);
    Object.assign(ship, {
      x: best.x, y: best.y, vx: best.vx, vy: best.vy, angle: best.angle,
      px: best.x, py: best.y,
      alive: true, invuln: INVULN_TICKS, respawn: 0, cooldown: 0,
    });
    ship.cache = makeStepCache();
  }

  kill(ship, events, event) {
    ship.alive = false;
    ship.respawn = RESPAWN_TICKS;
    ship.invuln = 0;
    ship.deaths++;
    events.push(event);
  }

  /** Advance one fixed step. Returns the events (kill, crash, respawn) it produced. */
  step() {
    const events = [];
    const t = this.time; // the same float the step cache stored as t + STEP last step

    for (const ship of this.ships.values()) {
      if (!ship.alive) continue;
      const inp = ship.input;
      ship.angle += inp.rot * TURN_RATE * STEP;
      const thrust = inp.thrust ? THRUST : inp.retro ? -RETRO : 0;
      ship.px = ship.x;
      ship.py = ship.y;
      const hit = stepState(ship, t, STEP, thrust, ship.cache);
      if (hit >= 0) this.kill(ship, events, { type: 'crash', id: ship.id, body: hit });
    }

    this.projectiles = this.projectiles.filter((p) => {
      p.px = p.x;
      p.py = p.y;
      p.age++;
      if (stepState(p, t, STEP, 0, p.cache) >= 0 || p.age >= LIFE_TICKS) return false;
      for (const ship of this.ships.values()) {
        if (!ship.alive || ship.invuln > 0) continue;
        if (ship.id === p.owner && p.age < GRACE_TICKS) continue;
        // Ship and projectile both move: test the segment in the ship's frame.
        const d = segmentDistance(p.px - ship.px, p.py - ship.py, p.x - ship.x, p.y - ship.y);
        if (d >= HIT_RADIUS) continue;
        const owner = this.ships.get(p.owner);
        if (owner && owner !== ship) owner.kills++;
        this.kill(ship, events, { type: 'kill', killer: p.owner, victim: ship.id });
        return false;
      }
      return true;
    });

    for (const ship of this.ships.values()) {
      if (ship.alive) {
        if (ship.invuln > 0) ship.invuln--;
        if (ship.cooldown > 0) ship.cooldown--;
        if (ship.input.fire && ship.cooldown === 0) this.fire(ship);
      } else if (--ship.respawn <= 0) {
        this.spawn(ship);
        events.push({ type: 'respawn', id: ship.id });
      }
    }

    this.time = t + STEP;
    return events;
  }

  fire(ship) {
    const c = Math.cos(ship.angle);
    const s = Math.sin(ship.angle);
    const x = ship.x + c * MUZZLE_OFFSET;
    const y = ship.y + s * MUZZLE_OFFSET;
    ship.cooldown = FIRE_TICKS;
    this.projectiles.push({
      id: this.nextProjectile++, owner: ship.id,
      x, y, px: x, py: y,
      vx: ship.vx + c * MUZZLE_SPEED, vy: ship.vy + s * MUZZLE_SPEED,
      angle: 0, age: 0, cache: makeStepCache(),
    });
  }

  /** Compact JSON-safe state. Body positions follow from `t` (positionsAt). */
  snapshot() {
    const ships = [];
    for (const s of this.ships.values()) {
      ships.push({
        id: s.id,
        x: round(s.x, 100), y: round(s.y, 100),
        vx: round(s.vx, 100), vy: round(s.vy, 100),
        a: round(s.angle, 1000),
        alive: s.alive ? 1 : 0,
        inv: round(s.invuln * STEP, 100),
        k: s.kills, d: s.deaths,
        seq: s.lastSeq,
      });
    }
    return {
      t: round(this.time, 1000),
      ships,
      shots: this.projectiles.map((p) => ({
        id: p.id, o: p.owner,
        x: round(p.x, 100), y: round(p.y, 100),
        vx: round(p.vx, 100), vy: round(p.vy, 100),
      })),
    };
  }
}
