// Client-side multiplayer logic: own-ship prediction with reconciliation,
// remote-ship interpolation, kill feed and scoreboard. Pure module: no DOM, no
// canvas, no clock of its own (callers pass `nowMs`).
//
// Prediction model. The client steps its own ship at the fixed STEP with the
// same `stepShip` the server uses, so given the same state and inputs it
// reproduces the server exactly. The server state in a snapshot is `rtt` old
// (downlink) and does not yet contain inputs the server has not received
// (uplink), so on every snapshot the client re-simulates `rtt` worth of steps
// from it, feeding each step the input that was held at that local step. The
// result is where the ship would be "now, plus the uplink delay", which is also
// what the next snapshot will confirm. If the new position differs from what
// was on screen by less than SNAP_DISTANCE, the difference is kept as a
// render offset that fades out linearly over OFFSET_FADE seconds (no jump);
// a bigger gap (respawn, collision, huge lag) snaps. The heading is not
// smoothed; it is replayed exactly, so it only differs when the inputs did.
// Without an rtt estimate the replay falls back to the inputs not yet acked.
import { STEP, makeStepCache } from './physics.js';
import { stepShip, sanitizeInput, RESPAWN_DELAY } from './mp-sim.js';

export const BUFFER_SIZE = 10; // snapshots kept
export const INTERP_DELAY = 100; // ms: remote ships are drawn this far in the past
export const MAX_EXTRAPOLATE = 0.25; // s: how long to extrapolate past the last snapshot
export const SNAP_DISTANCE = 15; // du: larger prediction errors are not smoothed
export const OFFSET_FADE = 0.1; // s: smoothing time for a correction
export const FEED_LIFETIME = 4000; // ms
const MAX_PENDING = 600;
const MAX_REPLAY = 60; // steps (0.5 s)
const MAX_FRAME = 0.25; // s of dt stepLocal accepts at once
const EPS = 1e-9;
const TWO_PI = Math.PI * 2;

const NEUTRAL = Object.freeze(sanitizeInput(null));

/** Signed shortest angular difference b - a, in (-PI, PI]. */
function angleDiff(a, b) {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d <= -Math.PI) d += TWO_PI;
  return d;
}

export class MpClient {
  constructor() {
    this.myId = null;
    this.room = null;
    this.players = new Map(); // id -> { id, name, color }
    this.rtt = null; // ms; assign from Net.rtt
    this.snaps = []; // { snap, at } oldest first
    this.events = []; // { text, type, at } kill feed, oldest first
    this.pending = []; // { seq, input, start } start = local step index it began
    this.stepCount = 0; // local steps taken so far
    this.time = 0; // simulation time of the local ship state
    this.local = null; // { x, y, vx, vy, angle, cache } or null (unknown/dead)
    this.crashed = false; // predicted a collision; frozen until the next snapshot
    this.offset = { x: 0, y: 0 };
    this.offsetAge = 0;
    this.acc = 0;
    this.deadSince = null; // server time my ship was first seen dead
  }

  onWelcome(msg) {
    this.myId = msg.id;
    this.room = msg.room;
    this.onPlayers(msg.players ?? []);
  }

  onPlayers(list) {
    const l = Array.isArray(list) ? list : list?.list ?? [];
    this.players = new Map(l.map((p) => [p.id, p]));
  }

  // --- snapshots, prediction ------------------------------------------------

  onSnapshot(snap, nowMs) {
    this.snaps.push({ snap, at: nowMs });
    if (this.snaps.length > BUFFER_SIZE) this.snaps.shift();
    this.pruneFeed(nowMs);
    const mine = snap.ships.find((s) => s.id === this.myId);
    if (!mine) return;
    if (mine.alive) this.deadSince = null;
    else if (this.deadSince === null) this.deadSince = snap.time;
    this.reconcile(mine, snap.time);
  }

  /** Record the controls now in effect, tagged with the seq `Net.sendInput` returned. */
  applyLocalInput(input, seq) {
    this.pending.push({ seq, input: sanitizeInput(input), start: this.stepCount });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
  }

  /** The input in effect at local step j. */
  inputAt(j) {
    const p = this.pending;
    if (!p.length) return NEUTRAL;
    let found = null;
    for (const e of p) {
      if (e.start <= j) found = e;
      else break;
    }
    return found ? found.input : p[0].input;
  }

  reconcile(mine, serverTime) {
    // Inputs the server has already applied are no longer needed. The entry
    // with seq == ack is kept: it is still the server's held input.
    while (this.pending.length > 1 && this.pending[1].seq <= mine.seq) this.pending.shift();
    const wasShown = this.local ? this.predicted() : null;
    if (!mine.alive) {
      this.local = null;
      this.pending.length = 0;
      this.offset.x = this.offset.y = 0;
      return;
    }
    let steps;
    if (typeof this.rtt === 'number' && this.rtt >= 0) steps = Math.round(this.rtt / 1000 / STEP);
    else {
      const next = this.pending.find((e) => e.seq > mine.seq);
      steps = next ? this.stepCount - next.start : 0;
    }
    steps = Math.min(steps, MAX_REPLAY);
    const ship = {
      x: mine.x, y: mine.y, vx: mine.vx, vy: mine.vy, angle: mine.a, cache: makeStepCache(),
    };
    let t = Math.round(serverTime / STEP) * STEP; // snapshots round time to 1 ms
    let hit = -1;
    for (let i = 0; i < steps && hit < 0; i++) {
      hit = stepShip(ship, t, this.inputAt(this.stepCount - steps + i));
      t += STEP;
    }
    this.local = ship;
    this.time = t;
    this.crashed = hit >= 0;
    this.offset.x = this.offset.y = 0;
    this.offsetAge = 0;
    if (wasShown) {
      const ox = wasShown.x - ship.x;
      const oy = wasShown.y - ship.y;
      if (Math.hypot(ox, oy) < SNAP_DISTANCE) {
        this.offset.x = ox;
        this.offset.y = oy;
      }
    }
  }

  /** Advance the predicted ship by `dt` seconds of frame time (fixed STEPs). */
  stepLocal(dt) {
    this.offsetAge += dt;
    this.acc = Math.min(this.acc + dt, MAX_FRAME);
    while (this.acc >= STEP - EPS) {
      this.acc -= STEP;
      if (this.local && !this.crashed) {
        const input = this.inputAt(this.stepCount);
        this.crashed = stepShip(this.local, this.time, input) >= 0;
      }
      this.time += STEP;
      this.stepCount++;
    }
  }

  /** The predicted own ship as it should be drawn, or null if unknown or dead. */
  predicted() {
    const s = this.local;
    if (!s) return null;
    const f = Math.max(0, 1 - this.offsetAge / OFFSET_FADE);
    return {
      x: s.x + this.offset.x * f, y: s.y + this.offset.y * f,
      vx: s.vx, vy: s.vy, angle: s.angle,
    };
  }

  // --- interpolation --------------------------------------------------------

  /**
   * Remote ships and shots for the render time (nowMs - INTERP_DELAY), and the
   * server time that corresponds to it (for positionsAt).
   * Returns { serverTime, ships: [{id, x, y, vx, vy, angle, alive, inv}],
   * shots: [{id, o, x, y, vx, vy}] }.
   */
  interpolated(nowMs) {
    const n = this.snaps.length;
    if (!n) return { serverTime: 0, ships: [], shots: [] };
    const render = nowMs - INTERP_DELAY;
    let i = 0;
    while (i + 1 < n && this.snaps[i + 1].at <= render) i++;
    const A = this.snaps[i];
    const B = this.snaps[i + 1];
    const a = A.snap;
    let f = 0;
    let ext = 0; // s extrapolated beyond snapshot a
    let serverTime;
    if (B) {
      f = Math.max(0, Math.min(1, (render - A.at) / (B.at - A.at)));
      serverTime = a.time + (B.snap.time - a.time) * f;
    } else {
      ext = Math.max(0, Math.min(MAX_EXTRAPOLATE, (render - A.at) / 1000));
      serverTime = a.time + ext;
    }
    const b = B ? B.snap : null;
    const ships = [];
    for (const s of a.ships) {
      if (s.id === this.myId) continue;
      const e = b ? b.ships.find((o) => o.id === s.id) : null;
      if (e && e.alive && s.alive) {
        ships.push({
          id: s.id, x: s.x + (e.x - s.x) * f, y: s.y + (e.y - s.y) * f,
          vx: s.vx + (e.vx - s.vx) * f, vy: s.vy + (e.vy - s.vy) * f,
          angle: s.a + angleDiff(s.a, e.a) * f, alive: 1, inv: s.inv + (e.inv - s.inv) * f,
        });
      } else {
        const src = e && f >= 0.5 ? e : s; // respawn/death: no blending
        const k = src.alive && !e ? ext : 0;
        ships.push({
          id: src.id, x: src.x + src.vx * k, y: src.y + src.vy * k, vx: src.vx, vy: src.vy,
          angle: src.a, alive: src.alive, inv: src.inv,
        });
      }
    }
    const dt = serverTime - a.time;
    const shots = a.shots.map((p) => ({
      id: p.id, o: p.o, x: p.x + p.vx * dt, y: p.y + p.vy * dt, vx: p.vx, vy: p.vy,
    }));
    return { serverTime, ships, shots };
  }

  // --- kill feed ------------------------------------------------------------

  tag(id) {
    const p = this.players.get(id);
    const name = p && typeof p.name === 'string' ? p.name.trim() : '';
    return name ? name.slice(0, 2).toUpperCase() : `P${id + 1}`;
  }

  /** Add a server `event` message to the feed. */
  onEvent(msg, nowMs) {
    let text = null;
    if (msg.type === 'kill') {
      text = msg.killer === msg.victim ? `${this.tag(msg.victim)} SELF-HIT` : `${this.tag(msg.killer)} > ${this.tag(msg.victim)}`;
    } else if (msg.type === 'crash') text = `${this.tag(msg.id)} CRASHED`;
    else if (msg.type === 'respawn') text = `${this.tag(msg.id)} RESPAWNED`;
    this.pruneFeed(nowMs);
    if (text) this.events.push({ text, type: msg.type, at: nowMs });
  }

  pruneFeed(nowMs) {
    while (this.events.length && nowMs - this.events[0].at >= FEED_LIFETIME) this.events.shift();
  }

  /** The feed lines still visible at nowMs: [{text, type, at}], oldest first. */
  feed(nowMs) {
    this.pruneFeed(nowMs);
    return this.events;
  }

  // --- accessors ------------------------------------------------------------

  latest() {
    return this.snaps.length ? this.snaps[this.snaps.length - 1] : null;
  }

  /** [{id, name, color, kills, deaths, alive, me}] sorted by kills (then fewer deaths). */
  scoreboard() {
    const last = this.latest();
    if (!last) return [];
    return last.snap.ships
      .map((s) => ({
        id: s.id, name: this.players.get(s.id)?.name ?? '', color: this.players.get(s.id)?.color ?? s.id,
        kills: s.k, deaths: s.d, alive: !!s.alive, me: s.id === this.myId,
      }))
      .sort((p, q) => q.kills - p.kills || p.deaths - q.deaths || p.id - q.id);
  }

  /** My status: { alive, respawnIn (s), invuln (s), kills, deaths }. */
  me(nowMs) {
    const last = this.latest();
    const s = last?.snap.ships.find((o) => o.id === this.myId);
    if (!s) return { alive: false, respawnIn: 0, invuln: 0, kills: 0, deaths: 0 };
    let respawnIn = 0;
    if (!s.alive) {
      const since = last.snap.time - this.deadSince + (nowMs === undefined ? 0 : (nowMs - last.at) / 1000);
      respawnIn = Math.max(0, RESPAWN_DELAY - since);
    }
    return { alive: !!s.alive, respawnIn, invuln: s.inv, kills: s.k, deaths: s.d };
  }
}
