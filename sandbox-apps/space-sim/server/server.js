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
export const IDLE_MS = 10000; // a client silent for this long is dropped
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
const HIDDEN = /^(server|test|node_modules)$|^\./;

/** Printable-ASCII name of at most MAX_NAME characters. */
export function sanitizeName(raw) {
  const s = String(raw ?? '').replace(/[^A-Za-z0-9 _.-]/g, '').trim().slice(0, MAX_NAME).trim();
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
    if (loop) {
      this.timer = setInterval(() => this.run(), TICK_MS);
      this.timer.unref();
    }
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
  }
}

/**
 * Room registry and message handling. A client is any object with
 * `send(obj)`; it gets `id`, `name` and `room` assigned here.
 */
export class Lobby {
  constructor(options = {}) {
    this.options = options;
    this.rooms = new Map();
  }

  newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += String.fromCharCode(65 + Math.floor(Math.random() * 26));
      if (!this.rooms.has(code)) return code;
    }
  }

  create(client, name) {
    if (client.room) return client.send({ t: 'error', msg: 'already in a room' });
    const room = new Room(this.newCode(), this.options);
    this.rooms.set(room.code, room);
    this.enter(client, room, name);
  }

  join(client, code, name) {
    if (client.room) return client.send({ t: 'error', msg: 'already in a room' });
    const key = typeof code === 'string' ? code.trim().toUpperCase() : '';
    if (!/^[A-Z]{4}$/.test(key)) return client.send({ t: 'error', msg: 'invalid room code' });
    const room = this.rooms.get(key);
    if (!room) return client.send({ t: 'error', msg: `room ${key} not found` });
    if (room.full) return client.send({ t: 'error', msg: `room ${key} is full` });
    this.enter(client, room, name);
  }

  enter(client, room, name) {
    client.name = sanitizeName(name);
    room.add(client);
    client.send({ t: 'welcome', id: client.id, room: room.code, players: room.list() });
    room.broadcast({ t: 'players', list: room.list() });
  }

  /** Remove a client from its room; empty rooms are deleted. */
  leave(client) {
    const room = client.room;
    if (!room) return;
    room.remove(client);
    if (room.players.size === 0) {
      room.stop();
      this.rooms.delete(room.code);
    } else {
      room.broadcast({ t: 'players', list: room.list() });
    }
  }

  /** Handle one raw text message. Never throws. */
  handle(client, text) {
    try {
      const msg = JSON.parse(text);
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
        return client.send({ t: 'error', msg: 'bad message' });
      }
      switch (msg.t) {
        case 'input': {
          if (!client.room) return client.send({ t: 'error', msg: 'not in a room' });
          const now = performance.now();
          client.tokens = Math.min(INPUT_RATE, (client.tokens ?? INPUT_RATE)
            + ((now - (client.tokensAt ?? now)) / 1000) * INPUT_RATE);
          client.tokensAt = now;
          if (client.tokens < 1) return undefined; // over the rate limit: drop
          client.tokens--;
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
    for (const room of this.rooms.values()) room.stop();
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

/**
 * Build (but do not start) the server. Returns { server, lobby, close }.
 * Options: root, idleMs, loop (false disables room timers, for tests).
 */
export function createGameServer({ root = ROOT, idleMs = IDLE_MS, loop = true } = {}) {
  const lobby = new Lobby({ loop });
  const clients = new Set();
  const server = http.createServer((req, res) => {
    try {
      serveStatic(root, req, res);
    } catch {
      notFound(res, 500, 'Server error');
    }
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const conn = acceptUpgrade(req, socket, head);
      if (!conn) return;
      const client = {
        id: -1, name: '', room: null,
        send: (obj) => conn.send(JSON.stringify(obj)),
        sendText: (text) => conn.send(text),
      };
      clients.add({ client, conn });
      const entry = [...clients].find((e) => e.client === client);
      conn.on('message', (text) => lobby.handle(client, text));
      conn.on('close', () => {
        clients.delete(entry);
        lobby.leave(client);
      });
    } catch {
      socket.destroy();
    }
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const { conn } of clients) if (now - conn.lastActivity > idleMs) conn.close(1001, 'timeout');
  }, Math.min(1000, Math.max(10, idleMs / 4)));
  sweep.unref();

  function close() {
    clearInterval(sweep);
    for (const { conn } of clients) conn.terminate();
    lobby.close();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return { server, lobby, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  const { server } = createGameServer();
  server.listen(port, () => console.log(`space-sim server on http://localhost:${port}/`));
}
