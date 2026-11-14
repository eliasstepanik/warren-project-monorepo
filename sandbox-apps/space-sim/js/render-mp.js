// Multiplayer rendering: same low-res look as render.js, reusing its helpers.
// The camera follows the predicted own ship; remote ships and shots come from
// MpClient.interpolated(); bodies are placed at the interpolated server time.
import { PAL, SHIP_COLORS } from './palette.js';
import { drawText, textWidth } from './font.js';
import { BODIES, HOME, makePositions, positionsAt, predict } from './physics.js';
import { ZOOMS, START_ZOOM } from './sim.js';
import {
  W, H, SHIP_SHAPE, px, drawStars, toScreen, drawOrbitPaths, drawBody, drawPrediction, panel,
} from './render.js';

const PREDICT_EVERY_MS = 200; // trajectory refresh interval
const PREDICT_STEPS = 240;
const EXPLOSION_MS = 1500;
const EXPLOSION_PARTS = 32;
const MAX_EXPLOSIONS = 16;
const ARROW_INSET = 7;
const ARROW_SHAPE = [[2, 0], [1, -1], [1, 0], [1, 1], [0, -2], [0, -1], [0, 0], [0, 1], [0, 2]];
const FEED_LINES = 3;
const FEED_COLORS = { kill: 'yellow', crash: 'orange', respawn: 'lightGrey' };

const shipColor = (id) => SHIP_COLORS[((id % 4) + 4) % 4];

/** Per-view state that is not part of the network client: zoom, camera, explosions. */
export function createMpView() {
  return {
    zoomIndex: START_ZOOM,
    cam: null, // last camera centre, kept while the own ship is dead
    lastPos: new Map(), // ship id -> last known {x, y, vx, vy}
    explosions: [], // { x, y, vx, vy, at, seed }
    pred: null,
    predAt: -Infinity,
    input: null, // controls currently held (for the engine flame)
    pos: makePositions(),
    predPos: makePositions(),
  };
}

export function changeMpZoom(view, d) {
  view.zoomIndex = Math.max(0, Math.min(ZOOMS.length - 1, view.zoomIndex + d));
}

/** Start an explosion at the victim's last known position for kill and crash events. */
export function addExplosion(view, msg, nowMs) {
  const id = msg.type === 'kill' ? msg.victim : msg.type === 'crash' ? msg.id : null;
  const p = id === null ? null : view.lastPos.get(id);
  if (!p) return;
  view.explosions.push({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, at: nowMs, seed: (nowMs | 0) + id * 7919 });
  if (view.explosions.length > MAX_EXPLOSIONS) view.explosions.shift();
}

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function drawMpShip(ctx, cam, s, id, thrusting, nowMs) {
  if (s.inv > 0 && Math.floor(nowMs / 100) % 2 === 1) return; // blink while invulnerable
  const [sx, sy] = toScreen(cam, s.x, s.y);
  const c = Math.cos(s.angle);
  const sn = Math.sin(s.angle);
  const plot = (x, y, color) => px(ctx, sx + x * c - y * sn, sy + x * sn + y * c, color);
  if (thrusting > 0) {
    const len = 2 + ((nowMs / 60) & 1);
    for (let k = 0; k < len + 1; k++) plot(-3 - k, 0, k < 2 ? 'yellow' : 'orange');
  } else if (thrusting < 0) {
    plot(3, 1, 'white');
    plot(3, -1, 'white');
  }
  const body = shipColor(id);
  for (const [x, y] of SHIP_SHAPE) plot(x, y, x > 1 ? 'white' : body);
  plot(2, 0, body);
}

function drawTag(ctx, cam, s, text, id) {
  const [sx, sy] = toScreen(cam, s.x, s.y);
  drawText(ctx, text, Math.round(sx - textWidth(text) / 2), Math.round(sy) + 6, PAL[shipColor(id)]);
}

function drawShots(ctx, cam, shots) {
  for (const s of shots) {
    const [sx, sy] = toScreen(cam, s.x, s.y);
    if (sx < -2 || sx > W + 2 || sy < -2 || sy > H + 2) continue;
    px(ctx, sx, sy, 'white');
    px(ctx, sx + 1, sy, shipColor(s.o));
  }
}

function drawExplosions(ctx, cam, view, nowMs) {
  view.explosions = view.explosions.filter((e) => nowMs - e.at < EXPLOSION_MS);
  const colors = ['white', 'yellow', 'orange', 'red', 'lightGrey'];
  for (const e of view.explosions) {
    const age = (nowMs - e.at) / 1000;
    const life = EXPLOSION_MS / 1000;
    const rnd = seeded(e.seed);
    for (let i = 0; i < EXPLOSION_PARTS; i++) {
      const a = rnd() * Math.PI * 2;
      const sp = 10 + rnd() * 40;
      const d = sp * age * (1 - 0.3 * age);
      const [sx, sy] = toScreen(cam, e.x + e.vx * age * 0.1 + Math.cos(a) * d, e.y + e.vy * age * 0.1 + Math.sin(a) * d);
      const big = age < life * 0.4;
      ctx.fillStyle = PAL[age > life * 0.75 ? 'darkGrey' : colors[i % colors.length]];
      ctx.fillRect(Math.round(sx), Math.round(sy), big ? 2 : 1, big ? 2 : 1);
    }
  }
}

/** Arrows at the screen edge pointing to enemies that are off-screen. */
function drawEdgeArrows(ctx, cam, ships) {
  for (const s of ships) {
    if (!s.alive) continue;
    const [sx, sy] = toScreen(cam, s.x, s.y);
    if (sx >= 0 && sx < W && sy >= 0 && sy < H) continue;
    const dx = sx - W / 2;
    const dy = sy - H / 2;
    const k = Math.min((W / 2 - ARROW_INSET) / Math.abs(dx || 1e-9), (H / 2 - ARROW_INSET) / Math.abs(dy || 1e-9));
    const ax = W / 2 + dx * k;
    const ay = H / 2 + dy * k;
    const ang = Math.atan2(dy, dx);
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    for (const [x, y] of ARROW_SHAPE) px(ctx, ax + x * c - y * sn, ay + x * sn + y * c, shipColor(s.id));
  }
}

function drawFeed(ctx, client, nowMs) {
  const lines = client.feed(nowMs).slice(-FEED_LINES);
  lines.forEach((l, i) => {
    drawText(ctx, l.text, W - 4 - textWidth(l.text), 5 + i * 7, PAL[FEED_COLORS[l.type] ?? 'white']);
  });
}

function drawScoreboard(ctx, client) {
  const rows = client.scoreboard();
  const w = 140;
  const h = 18 + rows.length * 9;
  const x = Math.round((W - w) / 2);
  const y = Math.round((H - h) / 2);
  panel(ctx, x, y, w, h);
  drawText(ctx, 'NAME', x + 14, y + 5, PAL.lavender);
  drawText(ctx, 'K', x + w - 34, y + 5, PAL.lavender);
  drawText(ctx, 'D', x + w - 16, y + 5, PAL.lavender);
  rows.forEach((r, i) => {
    const ry = y + 14 + i * 9;
    const dim = r.alive ? null : PAL.darkGrey;
    ctx.fillStyle = dim ?? PAL[shipColor(r.color)];
    ctx.fillRect(x + 5, ry, 5, 5);
    const name = (r.name || `P${r.id + 1}`).slice(0, 12) + (r.me ? ' *' : '');
    drawText(ctx, name, x + 14, ry, dim ?? PAL.white);
    drawText(ctx, String(r.kills), x + w - 34, ry, dim ?? PAL.white);
    drawText(ctx, String(r.deaths), x + w - 16, ry, dim ?? PAL.white);
  });
}

function drawMpHud(ctx, client, ui, view, nowMs) {
  const me = client.me(nowMs);
  const ping = typeof client.rtt === 'number' ? `${Math.round(client.rtt)}MS` : '--';
  panel(ctx, 3, 3, 78, 30);
  drawText(ctx, `MP ${client.room ?? '----'}`, 8, 8, PAL.yellow);
  drawText(ctx, `PING ${ping}`, 8, 16, PAL.white);
  drawText(ctx, `K ${me.kills} D ${me.deaths}`, 8, 24, PAL.green);
  drawFeed(ctx, client, nowMs);

  const zt = `ZOOM ${ZOOMS[view.zoomIndex]}X`;
  drawText(ctx, zt, W - 4 - textWidth(zt), H - 9, PAL.lavender);

  const center = (m, y, color, scale = 1) => drawText(ctx, m, Math.round((W - textWidth(m, scale)) / 2), y, PAL[color], scale);
  if (ui.disconnected) {
    center('DISCONNECTED', 60, 'red', 2);
    center('LEAVE TO RETURN TO SINGLEPLAYER', 76, 'white');
  } else if (!client.latest()) {
    center('CONNECTING...', 60, 'yellow', 2);
  } else if (!me.alive) {
    center(`RESPAWN ${Math.ceil(me.respawnIn)}..`, 60, 'red', 2);
  }
  if (ui.flashUntil > nowMs) center('NO WARP IN MP', H - 22, 'orange');
  if (ui.tab) drawScoreboard(ctx, client);
  if (!ui.focused) {
    const m = 'CLICK TO FOCUS';
    panel(ctx, Math.round((W - textWidth(m)) / 2) - 6, H - 22, textWidth(m) + 12, 14);
    drawText(ctx, m, Math.round((W - textWidth(m)) / 2), H - 18, PAL.yellow);
  }
}

/**
 * Draw one multiplayer frame. `ui` = { focused, tab, disconnected, flashUntil },
 * `view` comes from createMpView(), `nowMs` is the same clock as the client's.
 */
export function renderMp(ctx, client, ui, view, nowMs) {
  const it = client.interpolated(nowMs);
  const mine = client.predicted();
  positionsAt(it.serverTime, view.pos);
  if (mine) view.cam = { x: mine.x, y: mine.y };
  else if (!view.cam) view.cam = { x: view.pos[HOME].x, y: view.pos[HOME].y };
  const cam = { x: view.cam.x, y: view.cam.y, zoom: ZOOMS[view.zoomIndex] };
  const scene = { pos: view.pos };

  if (mine) view.lastPos.set(client.myId, mine);
  for (const s of it.ships) if (s.alive) view.lastPos.set(s.id, s);

  ctx.fillStyle = PAL.night;
  ctx.fillRect(0, 0, W, H);
  drawStars(ctx, cam);
  drawOrbitPaths(ctx, scene, cam);
  for (let i = 0; i < BODIES.length; i++) drawBody(ctx, scene, cam, i);

  if (mine && !client.crashed) {
    if (!view.pred || nowMs - view.predAt >= PREDICT_EVERY_MS) {
      view.pred = predict(mine, client.time, PREDICT_STEPS, 0.1, 0.05);
      view.predAt = nowMs;
    }
    positionsAt(client.time, view.predPos);
    drawPrediction(ctx, { pos: view.predPos, ship: mine, t: client.time, prediction: view.pred }, cam);
  } else {
    view.pred = null;
  }

  for (const s of it.ships) {
    if (!s.alive) continue;
    drawMpShip(ctx, cam, s, s.id, 0, nowMs);
    drawTag(ctx, cam, s, client.tag(s.id), s.id);
  }
  if (mine) {
    const inv = client.me(nowMs).invuln;
    const held = view.input;
    drawMpShip(ctx, cam, { ...mine, inv }, client.myId, held ? (held.thrust ? 1 : held.retro ? -1 : 0) : 0, nowMs);
    drawTag(ctx, cam, mine, client.tag(client.myId), client.myId);
  }
  drawShots(ctx, cam, it.shots);
  drawExplosions(ctx, cam, view, nowMs);
  drawEdgeArrows(ctx, cam, it.ships);
  drawMpHud(ctx, client, ui, view, nowMs);
}
