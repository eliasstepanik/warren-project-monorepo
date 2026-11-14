// Space-sim server: static files, WebSocket game rooms. No dependencies.
// Run: node server/server.js   (PORT env var, default 8080). See PROTOCOL.md.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptUpgrade } from './ws.js';
import { MpSim, MAX_SHIPS } from '../js/mp-sim.js';
import { STEP } from '../js/physics.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_NAME = 12;
export const MAX_PLAYERS = MAX_SHIPS;
export const SNAPSHOT_EVERY = 6; // steps between snapshots: 120 / 6 = 20 Hz
export const INPUT_RATE = 60; // inputs per second per client
export const MESSAGE_RATE = 100; // messages per second per client, all types (inputs: INPUT_RATE)
export const IDLE_MS = 30000; // a client silent for this long is dropped; the server pings at a third of it
export const MAX_CONNECTIONS = 256; // WebSocket connections; more are refused with 503
export const MAX_ROOMS = 64; // each room runs a 120 Hz loop; `create` fails with 'server full'
export const MAX_PER_IP = 16; // connections per remote address; more are refused with 429
export const ROOM_GRACE_MS = 10000; // an emptied room survives this long (page reloads, rejoin)
export const MAX_JOIN_FAILS = 5; // failed joins per connection before it is closed
const TICK_MS = 8; // loop timer period; steps are taken at STEP regardless
const MAX_CATCHUP = 0.1; // s of simulation time a single loop run may catch up

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
// Not served: server code, tests, dotfiles.
const HIDDEN = /^(server|test|node_modules)$|^\./i;

/** Printable-ASCII name of at most MAX_NAME characters. */
export function sanitizeName(raw) {
  const s = (typeof raw === 'string' ? raw : '').replace(/[^A-Za-z0-9 _.-]/g, '').trim().slice(0, MAX_NAME).trim();
  return s || 'PILOT';
}

/** One game room: a simulation, its players and a fixed-step loop. */
export class Room {
  constructor(code, { loop = true } = {}) {
    this.code = code;
    this.sim = new MpSim();
    this.players = new Map(); // id -> client
    this.acc = 0;
    this.steps = 0;
    this.last = performance.now();
    this.timer = null;
    this.expiry = null; // pending deletion of an empty room (see Lobby.leave)
    this.loop = loop;
    this.start();
  }

  /** Start the fixed-step loop (not for rooms made with loop: false). */
  start() {
    if (!this.loop || this.timer) return;
    this.acc = 0;
    this.last = performance.now();
    this.timer = setInterval(() => this.run(), TICK_MS);
    this.timer.unref();
  }

  get full() {
    return this.players.size >= MAX_PLAYERS;
  }

  list() {
    return [...this.players.values()].map((c) => ({ id: c.id, name: c.name, color: c.id }));
  }

  add(client) {
    let id = 0;
    while (this.players.has(id)) id++;
    client.id = id;
    client.room = this;
    this.players.set(id, client);
    this.sim.add(id, client.name, id);
    clearTimeout(this.expiry);
    this.expiry = null;
    this.start();
  }

  remove(client) {
    this.players.delete(client.id);
    this.sim.remove(client.id);
    client.room = null;
  }

  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const c of this.players.values()) c.sendText(text);
  }

  /** Catch the simulation up to the wall clock in whole STEPs. */
  run(now = performance.now()) {
    this.acc = Math.min(MAX_CATCHUP, this.acc + (now - this.last) / 1000);
    this.last = now;
    let stepped = false;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      for (const e of this.sim.step()) this.broadcast({ t: 'event', ...e });
      stepped = true;
      if (++this.steps % SNAPSHOT_EVERY === 0) this.broadcast({ t: 'snap', ...this.sim.snapshot() });
    }
    return stepped;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Token bucket `name` of `client`: `rate` tokens per second, burst of `rate`.
 * Returns false (drop the message) when it is empty.
 */
export function allow(client, name, rate, now = performance.now()) {
  const b = (client.buckets ??= {})[name] ??= { tokens: rate, at: now };
  b.tokens = Math.min(rate, b.tokens + ((now - b.at) / 1000) * rate);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens--;
  return true;
}

/**
 * Room registry and message handling. A client is any object with
 * `send(obj)`; it gets `id`, `name` and `room` assigned here.
 */
export class Lobby {
  constructor(options = {}) {
    this.options = options;
    this.maxRooms = options.maxRooms ?? MAX_ROOMS;
    this.graceMs = options.graceMs ?? ROOM_GRACE_MS;
    this.maxJoinFails = options.maxJoinFails ?? MAX_JOIN_FAILS;
    this.rooms = new Map();
  }

  newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += String.fromCharCode(65 + Math.floor(Math.random() * 26));
      if (!this.rooms.has(code)) return code;
    }
  }

  /** Delete the room that has been empty (in its grace period) the longest. False if there is none. */
  evictGraceRoom() {
    let oldest = null;
    for (const room of this.rooms.values()) {
      if (room.players.size === 0 && (!oldest || room.emptyAt < oldest.emptyAt)) oldest = room;
    }
    if (!oldest) return false;
    clearTimeout(oldest.expiry);
    oldest.expiry = null;
    this.rooms.delete(oldest.code);
    return true;
  }

  create(client, name) {
    if (this.closed) return undefined;
    if (client.room) return client.send({ t: 'error', msg: 'already in a room' });
    if (this.rooms.size >= this.maxRooms && !this.evictGraceRoom()) return client.send({ t: 'error', msg: 'server full' });
    const room = new Room(this.newCode(), this.options);
    this.rooms.set(room.code, room);
    return this.enter(client, room, name);
  }

  /** A failed join. After maxJoinFails of them the connection is closed (code guessing). */
  joinFailed(client, msg) {
    client.send({ t: 'error', msg });
    client.fails = (client.fails ?? 0) + 1;
    if (client.fails >= this.maxJoinFails) client.close?.(1008, 'too many failed joins');
  }

  join(client, code, name) {
    if (this.closed) return undefined;
    if (client.room) return client.send({ t: 'error', msg: 'already in a room' });
    const key = typeof code === 'string' ? code.trim().toUpperCase() : '';
    if (!/^[A-Z]{4}$/.test(key)) return this.joinFailed(client, 'invalid room code');
    const room = this.rooms.get(key);
    if (!room) return this.joinFailed(client, `room ${key} not found`);
    if (room.full) return this.joinFailed(client, `room ${key} is full`);
    return this.enter(client, room, name);
  }

  enter(client, room, name) {
    client.name = sanitizeName(name);
    room.add(client);
    client.send({ t: 'welcome', id: client.id, room: room.code, players: room.list() });
    room.broadcast({ t: 'players', list: room.list() });
  }

  /**
   * Remove a client from its room. An empty room stops simulating at once and
   * is deleted after the grace period, so a player who reloads the page (the
   * old socket closes while the new one joins) can come back to it.
   */
  leave(client) {
    if (this.closed) return;
    const room = client.room;
    if (!room) return;
    room.remove(client);
    if (room.players.size > 0) {
      room.broadcast({ t: 'players', list: room.list() });
      return;
    }
    room.stop();
    const drop = () => {
      if (this.rooms.get(room.code) === room && room.players.size === 0) this.rooms.delete(room.code);
    };
    if (this.graceMs <= 0) drop();
    else {
      room.emptyAt = performance.now();
      room.expiry = setTimeout(drop, this.graceMs);
      room.expiry.unref();
    }
  }

  /** Handle one raw text message. Never throws. */
  handle(client, text) {
    try {
      if (!allow(client, 'any', MESSAGE_RATE)) return undefined; // flooding: drop
      const msg = JSON.parse(text);
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
        return client.send({ t: 'error', msg: 'bad message' });
      }
      switch (msg.t) {
        case 'input': {
          if (!client.room) return client.send({ t: 'error', msg: 'not in a room' });
          if (!allow(client, 'input', INPUT_RATE)) return undefined; // over the rate limit: drop
          return client.room.sim.setInput(client.id, msg);
        }
        case 'ping':
          return client.send({ t: 'pong', c: typeof msg.c === 'number' && Number.isFinite(msg.c) ? msg.c : 0 });
        case 'create':
          return this.create(client, msg.name);
        case 'join':
          return this.join(client, msg.room, msg.name);
        default:
          return client.send({ t: 'error', msg: `unknown message type` });
      }
    } catch {
      try {
        client.send({ t: 'error', msg: 'bad message' });
      } catch { /* the client is gone */ }
      return undefined;
    }
  }

  close() {
    this.closed = true;
    for (const room of this.rooms.values()) {
      room.stop();
      clearTimeout(room.expiry);
    }
    this.rooms.clear();
  }
}

/** Resolve a request path to a file under `root`, or null if it escapes or is hidden. */
export function resolveStatic(root, urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (p.includes('\0') || p.includes('\\')) return null;
  const file = path.resolve(root, `.${p}`);
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (rel.split(path.sep).some((seg) => HIDDEN.test(seg))) return null;
  return file;
}

function notFound(res, code = 404, text = 'Not found') {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function serveStatic(root, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res, 405, 'Method not allowed');
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return notFound(res, 400, 'Bad request');
  }
  let file = resolveStatic(root, pathname);
  if (!file) return notFound(res);
  if (pathname.endsWith('/')) file = path.join(file, 'index.html');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    return stream.pipe(res);
  });
  return undefined;
}

/** Non-negative number from the environment variable `name`; `fallback` if unset or invalid. */
export function envNumber(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Build (but do not start) the server. Returns { server, lobby, close }.
 * Options: root, idleMs, loop (false disables room timers, for tests),
 * maxConnections, maxPerIp (0 = no cap), maxRooms, graceMs, maxJoinFails.
 */
export function createGameServer({
  root = ROOT, idleMs = IDLE_MS, loop = true, maxConnections = MAX_CONNECTIONS, maxPerIp = MAX_PER_IP,
  maxRooms = MAX_ROOMS, graceMs = ROOM_GRACE_MS, maxJoinFails = MAX_JOIN_FAILS,
} = {}) {
  const lobby = new Lobby({ loop, maxRooms, graceMs, maxJoinFails });
  const clients = new Set();
  const perIp = new Map(); // remote address -> open connections
  const server = http.createServer((req, res) => {
    try {
      serveStatic(root, req, res);
    } catch {
      notFound(res, 500, 'Server error');
    }
  });

  function refuse(socket, line) {
    socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    setTimeout(() => socket.destroy(), 1000).unref();
  }

  server.on('upgrade', (req, socket, head) => {
    // Node removes its own error handling from the socket on 'upgrade'; without
    // a listener a peer reset (ECONNRESET) would be an uncaught exception.
    socket.on('error', () => socket.destroy());
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws') return refuse(socket, '404 Not Found');
      const ip = socket.remoteAddress ?? '';
      if (clients.size >= maxConnections) return refuse(socket, '503 Service Unavailable');
      if (maxPerIp > 0 && (perIp.get(ip) ?? 0) >= maxPerIp) return refuse(socket, '429 Too Many Requests');
      const conn = acceptUpgrade(req, socket, head);
      if (!conn) return;
      const client = {
        id: -1, name: '', room: null,
        send: (obj) => conn.send(JSON.stringify(obj)),
        sendText: (text) => conn.send(text),
        close: (code, reason) => conn.close(code, reason),
      };
      clients.add(conn);
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      conn.on('message', (text) => lobby.handle(client, text));
      conn.on('close', () => {
        clients.delete(conn);
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n > 0) perIp.set(ip, n);
        else perIp.delete(ip);
        lobby.leave(client);
      });
    } catch {
      socket.destroy();
    }
    return undefined;
  });

  // Any received frame counts as activity (WsConnection.lastActivity). The
  // server also pings, and browsers answer pings even from a hidden tab whose
  // timers are throttled, so a quiet but alive client is never dropped.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const conn of clients) if (now - conn.lastActivity > idleMs) conn.close(1001, 'timeout');
  }, Math.min(1000, Math.max(10, idleMs / 4)));
  sweep.unref();
  const pinger = setInterval(() => {
    for (const conn of clients) conn.ping();
  }, Math.max(10, idleMs / 3));
  pinger.unref();

  function close() {
    clearInterval(sweep);
    clearInterval(pinger);
    for (const conn of clients) conn.terminate();
    lobby.close();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return { server, lobby, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = envNumber('PORT', 8080);
  const { server } = createGameServer({
    maxConnections: envNumber('MAX_CONNECTIONS', MAX_CONNECTIONS),
    maxPerIp: envNumber('MAX_PER_IP', MAX_PER_IP),
    maxRooms: envNumber('MAX_ROOMS', MAX_ROOMS),
  });
  server.listen(port, () => console.log(`space-sim server on http://localhost:${port}/`));
}
