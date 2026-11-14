// Game state and fixed-timestep update. Pure module: no DOM access, so the
// same code runs in the browser and in the headless physics test.
import {
  BODIES, HOME, STEP, THRUST, RETRO, TURN_RATE,
  makePositions, positionsAt, stepState, circularOrbit, predict,
  dominantBody, bodyVelocity,
} from './physics.js';

export const WARPS = [1, 2, 4, 8, 16, 32, 64];
export const ZOOMS = [0.125, 0.18, 0.25, 0.35, 0.5, 0.7, 1, 1.4, 2, 3];
export const START_ZOOM = 6; // index into ZOOMS (1x)
const START_RADIUS = 22;
const MAX_STEPS_PER_UPDATE = 512;

export class Sim {
  constructor() {
    this.pos = makePositions();
    this.reset();
  }

  reset() {
    this.t = 0;
    this.acc = 0;
    this.warpIndex = 0;
    this.zoomIndex = START_ZOOM;
    this.crash = null; // { body, rx, ry } crash site relative to the body hit
    this.particles = [];
    this.thrusting = 0; // -1 retro, 0 off, 1 main (for rendering)
    this.noThrustAtWarp = false;
    this.ship = circularOrbit(HOME, START_RADIUS, 0, -Math.PI / 2);
    this.prediction = null;
    positionsAt(this.t, this.pos);
    this.refreshPrediction();
  }

  get warp() { return WARPS[this.warpIndex]; }
  get zoom() { return ZOOMS[this.zoomIndex]; }

  changeWarp(d) {
    this.warpIndex = Math.max(0, Math.min(WARPS.length - 1, this.warpIndex + d));
  }

  changeZoom(d) {
    this.zoomIndex = Math.max(0, Math.min(ZOOMS.length - 1, this.zoomIndex + d));
  }

  /** World position the camera should centre on. */
  cameraTarget() {
    if (this.crash) {
      const b = this.pos[this.crash.body];
      return { x: b.x + this.crash.rx, y: b.y + this.crash.ry };
    }
    return { x: this.ship.x, y: this.ship.y };
  }

  refreshPrediction() {
    if (this.crash) {
      this.prediction = null;
      return;
    }
    // Look further ahead when warping, but keep the cost bounded.
    const dt = 0.1 * Math.min(this.warp, 8);
    this.prediction = predict(this.ship, this.t, 400, dt, 0.05);
  }

  /**
   * Advance by `dt` real seconds. input = { turn: -1..1, thrust: -1..1 }.
   * Returns nothing; read this.crash to see whether the ship was destroyed.
   */
  update(dt, input) {
    const warp = this.warp;
    const ship = this.ship;
    this.thrusting = 0;
    this.noThrustAtWarp = false;

    if (!this.crash) {
      ship.angle += input.turn * TURN_RATE * dt;
      if (input.thrust !== 0) {
        if (warp === 1) this.thrusting = input.thrust;
        else this.noThrustAtWarp = true;
      }
    }

    this.acc += dt * warp;
    let n = Math.min(MAX_STEPS_PER_UPDATE, Math.floor(this.acc / STEP));
    this.acc -= n * STEP;
    if (this.acc > STEP) this.acc = 0; // dropped steps: do not build a backlog
    const thrust = this.thrusting > 0 ? THRUST : this.thrusting < 0 ? -RETRO : 0;
    for (; n > 0; n--) {
      if (!this.crash) {
        const hit = stepState(ship, this.t, STEP, thrust);
        this.t += STEP;
        if (hit >= 0) {
          positionsAt(this.t, this.pos);
          this.explode(hit);
        }
      } else {
        this.t += STEP;
      }
    }
    positionsAt(this.t, this.pos);
    this.updateParticles(dt);
    this.refreshPrediction();
  }

  explode(body) {
    const ship = this.ship;
    const b = this.pos[body];
    this.crash = { body, rx: ship.x - b.x, ry: ship.y - b.y };
    const bv = bodyVelocity(body, this.t);
    const colors = ['white', 'yellow', 'orange', 'red', 'lightGrey'];
    // Particles live in body-relative coordinates so they ride along with the body.
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2 + Math.random();
      const sp = 8 + Math.random() * 40;
      this.particles.push({
        x: this.crash.rx, y: this.crash.ry,
        vx: Math.cos(a) * sp + (ship.vx - bv.x) * 0.1,
        vy: Math.sin(a) * sp + (ship.vy - bv.y) * 0.1,
        life: 0.6 + Math.random() * 1.2,
        age: 0,
        color: colors[(Math.random() * colors.length) | 0],
      });
    }
  }

  updateParticles(dt) {
    for (const p of this.particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 0.8 * dt;
      p.vy *= 1 - 0.8 * dt;
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
  }

  /** Dominant body index and ship state relative to it, for the HUD. */
  telemetry() {
    const s = this.ship;
    const i = dominantBody(s.x, s.y, this.pos);
    const bv = bodyVelocity(i, this.t);
    const dx = s.x - this.pos[i].x;
    const dy = s.y - this.pos[i].y;
    return {
      body: i,
      name: BODIES[i].name,
      speed: Math.hypot(s.vx - bv.x, s.vy - bv.y),
      altitude: Math.hypot(dx, dy) - BODIES[i].radius,
    };
  }
}
