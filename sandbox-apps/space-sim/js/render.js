// Low-res rendering. Everything is drawn with integer pixel coordinates onto a
// W x H canvas that the page scales up with nearest-neighbour filtering.
import { PAL } from './palette.js';
import { drawText, textWidth } from './font.js';
import { BODIES, STAR, orbitRel } from './physics.js';

export const W = 320;
export const H = 180;

const SHIP_SHAPE = [ // pixels in ship space, +x = nose
  [2, 0], [1, 0], [0, 0], [-1, 0],
  [0, -1], [-1, -1],
  [0, 1], [-1, 1],
];

function px(ctx, x, y, color) {
  ctx.fillStyle = PAL[color];
  ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
}

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Parallax starfield tiled over a 64x64 cell grid, deterministic by cell. */
function drawStars(ctx, cam) {
  const layers = [
    { f: 0.02, color: 'darkGrey', cell: 32 },
    { f: 0.05, color: 'lavender', cell: 48 },
    { f: 0.1, color: 'white', cell: 64 },
  ];
  for (const L of layers) {
    const ox = cam.x * L.f * cam.zoom;
    const oy = cam.y * L.f * cam.zoom;
    const x0 = Math.floor(ox / L.cell);
    const y0 = Math.floor(oy / L.cell);
    for (let cy = y0; cy <= y0 + Math.ceil(H / L.cell) + 1; cy++) {
      for (let cx = x0; cx <= x0 + Math.ceil(W / L.cell) + 1; cx++) {
        const h = hash(cx, cy + L.cell * 7);
        if (h % 3 === 0) continue;
        const sx = cx * L.cell + (h % L.cell) - ox;
        const sy = cy * L.cell + ((h >>> 8) % L.cell) - oy;
        px(ctx, sx, sy, L.color);
      }
    }
  }
}

function toScreen(cam, x, y) {
  return [W / 2 + (x - cam.x) * cam.zoom, H / 2 + (y - cam.y) * cam.zoom];
}

function drawOrbitPaths(ctx, sim, cam) {
  const rel = { x: 0, y: 0 };
  for (let i = 1; i < BODIES.length; i++) {
    const par = sim.pos[BODIES[i].parent];
    const steps = Math.max(48, Math.min(360, Math.round(BODIES[i].a * cam.zoom * 1.5)));
    for (let k = 0; k < steps; k += 2) {
      orbitRel(i, (k / steps) * Math.PI * 2, rel);
      const [sx, sy] = toScreen(cam, par.x + rel.x, par.y + rel.y);
      if (sx >= 0 && sx < W && sy >= 0 && sy < H) px(ctx, sx, sy, 'darkBlue');
    }
  }
}

function drawBody(ctx, sim, cam, i) {
  const b = BODIES[i];
  const [cx, cy] = toScreen(cam, sim.pos[i].x, sim.pos[i].y);
  const r = Math.max(1.5, b.radius * cam.zoom);
  if (cx + r < 0 || cx - r > W || cy + r < 0 || cy - r > H) return;
  // Light comes from the star: direction from body to star.
  const lx = i === STAR ? 0 : sim.pos[STAR].x - sim.pos[i].x;
  const ly = i === STAR ? 0 : sim.pos[STAR].y - sim.pos[i].y;
  const ll = Math.hypot(lx, ly) || 1;
  const ux = lx / ll;
  const uy = ly / ll;
  const lo = Math.floor(-r);
  const hi = Math.ceil(r);
  const icx = Math.round(cx);
  const icy = Math.round(cy);
  for (let y = lo; y <= hi; y++) {
    for (let x = lo; x <= hi; x++) {
      const d2 = x * x + y * y;
      if (d2 > r * r) continue;
      let color = b.color;
      if (i !== STAR) {
        const lit = (x * ux + y * uy) / r; // -1 (night side) .. 1 (day side)
        if (lit < -0.15) color = b.dark;
      }
      // dithered terminator
      if (i !== STAR && r > 4) {
        const lit = (x * ux + y * uy) / r;
        if (lit >= -0.15 && lit < 0.05 && (x + y) % 2 === 0) color = b.dark;
      }
      if (i === STAR && d2 > r * r * 0.6 && (x + y) % 2 === 0) color = b.dark;
      px(ctx, icx + x, icy + y, color);
    }
  }
  if (r > 5 && i !== STAR) {
    // A couple of surface details so rotation-free planets do not look flat.
    px(ctx, icx - Math.round(r * 0.3), icy - Math.round(r * 0.2), 'white');
  }
  if (cam.zoom < 0.5 || r < 4) {
    drawText(ctx, b.name, Math.round(cx - textWidth(b.name) / 2), Math.round(cy - r - 7), PAL.lightGrey);
  }
}

function drawShip(ctx, sim, cam) {
  const s = sim.ship;
  const [sx, sy] = toScreen(cam, s.x, s.y);
  const c = Math.cos(s.angle);
  const sn = Math.sin(s.angle);
  const rot = (x, y) => [Math.round(sx + x * c - y * sn), Math.round(sy + x * sn + y * c)];
  const plot = (x, y, color) => {
    const [rx, ry] = rot(x, y);
    px(ctx, rx, ry, color);
  };
  if (sim.thrusting > 0) {
    const len = 2 + ((performance.now() / 60) & 1);
    for (let k = 0; k < len; k++) plot(-2 - k, 0, k < 2 ? 'yellow' : 'orange');
    plot(-2, 1, 'orange');
    plot(-2, -1, 'orange');
  } else if (sim.thrusting < 0) {
    plot(2, 1, 'blue');
    plot(2, -1, 'blue');
    plot(3, 1, 'white');
    plot(3, -1, 'white');
  }
  for (const [x, y] of SHIP_SHAPE) plot(x, y, y === 0 ? 'lightGrey' : 'blue');
  plot(2, 0, 'red');
}

/**
 * Dotted 1px Bresenham line from (x0, y0) to (x1, y1). `dash.n` counts pixels
 * along the whole path so the dot spacing is the same at every warp.
 */
function dotLine(ctx, x0, y0, x1, y1, dash) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const xe = Math.round(x1);
  const ye = Math.round(y1);
  const dx = Math.abs(xe - x);
  const dy = -Math.abs(ye - y);
  const sx = x < xe ? 1 : -1;
  const sy = y < ye ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (dash.n++ % 3 === 0 && x >= 0 && x < W && y >= 0 && y < H) ctx.fillRect(x, y, 1, 1);
    if (x === xe && y === ye) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

function drawPrediction(ctx, sim, cam) {
  const p = sim.prediction;
  if (!p) return;
  // The path is relative to the reference body; it may be a few frames old, so
  // re-anchor it on the body's current position.
  const ref = sim.pos[p.ref];
  const ox = ref.x - p.rx;
  const oy = ref.y - p.ry;
  ctx.fillStyle = PAL[p.hit >= 0 ? 'pink' : 'green'];
  const dash = { n: 0 };
  let [ax, ay] = toScreen(cam, sim.ship.x, sim.ship.y);
  let lx = ax;
  let ly = ay;
  // Skip points the ship has already passed (the path can be a few frames old).
  const k0 = Math.max(0, Math.ceil((sim.t - p.t0) / p.dt) - 1);
  for (let k = k0; k < p.n; k++) {
    [lx, ly] = toScreen(cam, p.pts[k * 2] + ox, p.pts[k * 2 + 1] + oy);
    const offscreen = (ax < 0 && lx < 0) || (ax >= W && lx >= W) || (ay < 0 && ly < 0) || (ay >= H && ly >= H);
    if (offscreen) dash.n += Math.round(Math.max(Math.abs(lx - ax), Math.abs(ly - ay)));
    else dotLine(ctx, ax, ay, lx, ly, dash);
    ax = lx;
    ay = ly;
  }
  if (p.hit >= 0 && p.n > 0) {
    ctx.fillStyle = PAL.red;
    ctx.fillRect(Math.round(lx) - 1, Math.round(ly), 3, 1);
    ctx.fillRect(Math.round(lx), Math.round(ly) - 1, 1, 3);
  }
}

function drawParticles(ctx, sim, cam) {
  if (!sim.crash) return;
  const b = sim.pos[sim.crash.body];
  for (const p of sim.particles) {
    const [sx, sy] = toScreen(cam, b.x + p.x, b.y + p.y);
    const big = p.age < p.life * 0.4;
    ctx.fillStyle = PAL[p.age > p.life * 0.75 ? 'darkGrey' : p.color];
    ctx.fillRect(Math.round(sx), Math.round(sy), big ? 2 : 1, big ? 2 : 1);
  }
}

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = PAL.night;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = PAL.lavender;
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillRect(x, y, 1, h);
  ctx.fillRect(x + w - 1, y, 1, h);
}

function fmt(v) {
  return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
}

function drawHud(ctx, sim, ui) {
  const tel = sim.telemetry();
  panel(ctx, 3, 3, 96, 38);
  drawText(ctx, `SPD ${fmt(tel.speed)}`, 8, 8, PAL.white);
  drawText(ctx, `ALT ${fmt(Math.max(0, tel.altitude))}`, 8, 16, PAL.white);
  drawText(ctx, `REF ${tel.name}`, 8, 24, PAL.blue);
  drawText(ctx, `WARP ${sim.warp}X`, 8, 32, sim.warp > 1 ? PAL.orange : PAL.green);

  const zt = `ZOOM ${sim.zoom}X`;
  drawText(ctx, zt, W - 4 - textWidth(zt), 5, PAL.lavender);
  const tt = `T ${Math.floor(sim.t)}S`;
  drawText(ctx, tt, W - 4 - textWidth(tt), 12, PAL.lavender);

  if (sim.noThrustAtWarp) {
    const m = 'NO THRUST WHILE WARPING';
    drawText(ctx, m, Math.round((W - textWidth(m)) / 2), H - 12, PAL.orange);
  }
  if (sim.crash) {
    const m = 'SHIP DESTROYED';
    const m2 = 'CRASHED - R TO RESET';
    const blink = Math.floor(performance.now() / 500) % 2 === 0;
    drawText(ctx, m, Math.round((W - textWidth(m, 2)) / 2), 60, PAL.red, 2);
    if (blink) drawText(ctx, m2, Math.round((W - textWidth(m2)) / 2), 76, PAL.white);
  }
  if (ui.paused) {
    const m = 'PAUSED';
    drawText(ctx, m, Math.round((W - textWidth(m, 2)) / 2), sim.crash ? 92 : 60, PAL.yellow, 2);
  }
  if (!ui.focused) {
    const m = 'CLICK TO FOCUS';
    panel(ctx, Math.round((W - textWidth(m)) / 2) - 6, H - 22, textWidth(m) + 12, 14);
    drawText(ctx, m, Math.round((W - textWidth(m)) / 2), H - 18, PAL.yellow);
  }
}

export function render(ctx, sim, ui) {
  const target = sim.cameraTarget();
  const cam = { x: target.x, y: target.y, zoom: sim.zoom };
  ctx.fillStyle = PAL.night;
  ctx.fillRect(0, 0, W, H);
  drawStars(ctx, cam);
  drawOrbitPaths(ctx, sim, cam);
  for (let i = 0; i < BODIES.length; i++) drawBody(ctx, sim, cam, i);
  drawPrediction(ctx, sim, cam);
  if (!sim.crash) drawShip(ctx, sim, cam);
  drawParticles(ctx, sim, cam);
  drawHud(ctx, sim, ui);
}
