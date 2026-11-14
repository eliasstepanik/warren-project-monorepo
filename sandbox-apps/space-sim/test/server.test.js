import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGameServer, Lobby, sanitizeName, resolveStatic, MAX_PLAYERS, MESSAGE_RATE,
} from '../server/server.js';
import { acceptKey, encodeFrame, decodeFrame, OP } from '../server/ws.js';

/** Start a server on an ephemeral port. Returns { port, lobby, close }. */
async function start(options) {
  const app = createGameServer(options);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { ...app, port: app.server.address().port };
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    // `path` is sent as is: http.get would normalise nothing, which is what we want.
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
  });
}

/** Minimal WebSocket client over `net`: handshake, then JSON messages. */
class TestClient {
  static async connect(port, path = '/ws') {
    const c = new TestClient();
    c.key = randomBytes(16).toString('base64');
    c.socket = net.connect(port, '127.0.0.1');
    c.buf = Buffer.alloc(0);
    c.handshake = null;
    c.messages = [];
    c.waiters = [];
    c.closeCode = null;
    c.closed = new Promise((resolve) => c.socket.on('close', resolve));
    c.socket.on('error', () => {});
    c.socket.on('data', (d) => c.onData(d));
    c.socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${c.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    c.ready = new Promise((resolve) => { c.onReady = resolve; });
    await c.ready;
    return c;
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (!this.handshake) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      this.handshake = this.buf.subarray(0, end).toString();
      this.buf = this.buf.subarray(end + 4);
      this.onReady();
    }
    for (;;) {
      const f = decodeFrame(this.buf, { maxPayload: 1 << 20 });
      if (!f) return;
      this.buf = this.buf.subarray(f.length);
      if (f.opcode === OP.TEXT) {
        this.messages.push(JSON.parse(f.payload.toString()));
        this.waiters = this.waiters.filter((w) => !w());
      } else if (f.opcode === OP.CLOSE) {
        this.closeCode = f.payload.readUInt16BE(0);
      }
    }
  }

  send(obj) {
    this.socket.write(encodeFrame(OP.TEXT, typeof obj === 'string' ? obj : JSON.stringify(obj), { mask: true }));
  }

  /** Resolve with the first message (already received or future) matching `pred`. */
  next(pred, ms = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), ms);
      const check = () => {
        const m = this.messages.find(pred);
        if (!m) return false;
        clearTimeout(timer);
        resolve(m);
        return true;
      };
      if (!check()) this.waiters.push(check);
    });
  }

  async end() {
    this.socket.destroy();
    await this.closed;
  }
}

test('GET / serves index.html; unknown files give 404', async () => {
  const s = await start();
  try {
    const r = await get(s.port, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.match(r.body, /<html/i);
    const js = await get(s.port, '/js/physics.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /^text\/javascript/);
    assert.equal((await get(s.port, '/style.css')).headers['content-type'].split(';')[0], 'text/css');
    assert.equal((await get(s.port, '/nope.html')).status, 404);
    assert.equal((await get(s.port, '/js/')).status, 404);
  } finally {
    await s.close();
  }
});

test('path traversal is blocked', async () => {
  const base = mkdtempSync(join(tmpdir(), 'space-sim-'));
  const root = join(base, 'root');
  mkdirSync(join(root, 'server'), { recursive: true });
  writeFileSync(join(base, 'secret.txt'), 'TOP-SECRET');
  writeFileSync(join(root, 'index.html'), '<html>ok</html>');
  writeFileSync(join(root, 'server', 'x.js'), 'SERVER-CODE');
  writeFileSync(join(root, '.env'), 'DOTFILE');
  const s = await start({ root });
  try {
    for (const p of [
      '/../secret.txt', '/%2e%2e/secret.txt', '/a/../../secret.txt', '/..%2fsecret.txt',
      '/%2e%2e%2fsecret.txt', '/%2e%2e/%2e%2e/secret.txt', '/%00', '/..\\secret.txt',
      '/server/x.js', '/.env', '/%2eenv',
    ]) {
      const r = await get(s.port, p);
      assert.doesNotMatch(r.body, /TOP-SECRET|SERVER-CODE|DOTFILE/, p);
      assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
    }
    assert.equal((await get(s.port, '/')).status, 200);
    // The URL parser may collapse ".." before it reaches us; that must stay inside the root.
    assert.equal((await get(s.port, '/../index.html')).body, '<html>ok</html>');
  } finally {
    await s.close();
    rmSync(base, { recursive: true, force: true });
  }
  // The resolver itself, with raw paths that bypass URL normalisation.
  for (const p of ['/../secret.txt', '/a/../../x', '/%2e%2e/x', '/a\\..\\x', '/x%00', '/%']) {
    assert.equal(resolveStatic(root, p), null, p);
  }
  assert.equal(resolveStatic(root, '/js/a.js'), join(root, 'js', 'a.js'));
});

test('WebSocket handshake answers 101 with the correct accept key', async () => {
  const s = await start();
  try {
    const c = await TestClient.connect(s.port);
    const [status] = c.handshake.split('\r\n');
    assert.equal(status, 'HTTP/1.1 101 Switching Protocols');
    assert.ok(c.handshake.includes(`Sec-WebSocket-Accept: ${acceptKey(c.key)}`));
    assert.match(c.handshake, /Upgrade: websocket/i);
    await c.end();
  } finally {
    await s.close();
  }
});

test('upgrade is refused on other paths', async () => {
  const s = await start();
  try {
    const c = await TestClient.connect(s.port, '/other');
    assert.equal(c.handshake.split('\r\n')[0], 'HTTP/1.1 404 Not Found');
    await c.closed;
  } finally {
    await s.close();
  }
});

test('oversized messages close the socket with 1009; ping gets a pong', async () => {
  const s = await start();
  try {
    const c = await TestClient.connect(s.port);
    c.socket.write(encodeFrame(OP.PING, 'hi', { mask: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    c.send({ t: 'ping', c: 3 });
    assert.deepEqual(await c.next((m) => m.t === 'pong'), { t: 'pong', c: 3 });
    c.send(`{"t":"input","pad":"${'x'.repeat(4100)}"}`);
    await c.closed;
    assert.equal(c.closeCode, 1009);
  } finally {
    await s.close();
  }
});

test('names are sanitised to 12 characters', () => {
  assert.equal(sanitizeName('  <b>Hello</b> World, how are you  '), 'bHellob Worl');
  assert.equal(sanitizeName('x'.repeat(40)).length, 12);
  assert.equal(sanitizeName(''), 'PILOT');
  assert.equal(sanitizeName({}), 'PILOT');
  assert.equal(sanitizeName(null), 'PILOT');
});

/** Fake client for lobby tests. */
function fake() {
  const c = { id: -1, name: '', room: null, out: [], send: (m) => c.out.push(m), sendText: (t) => c.out.push(JSON.parse(t)) };
  return c;
}

test('rooms: create, join, reject the 5th player and unknown rooms, delete when empty', () => {
  const lobby = new Lobby({ loop: false, graceMs: 0 });
  const host = fake();
  lobby.handle(host, JSON.stringify({ t: 'create', name: 'Host' }));
  const welcome = host.out.find((m) => m.t === 'welcome');
  assert.match(welcome.room, /^[A-Z]{4}$/);
  assert.equal(welcome.id, 0);
  assert.deepEqual(welcome.players, [{ id: 0, name: 'Host', color: 0 }]);

  const others = [];
  for (let i = 1; i < MAX_PLAYERS; i++) {
    const c = fake();
    others.push(c);
    lobby.handle(c, JSON.stringify({ t: 'join', room: welcome.room.toLowerCase(), name: `P${i}` }));
    assert.equal(c.out[0].t, 'welcome');
    assert.equal(c.out[0].id, i);
  }
  assert.equal(host.out.filter((m) => m.t === 'players').at(-1).list.length, 4);

  const fifth = fake();
  lobby.handle(fifth, JSON.stringify({ t: 'join', room: welcome.room, name: 'Late' }));
  assert.equal(fifth.out[0].t, 'error');
  assert.match(fifth.out[0].msg, /full/);
  assert.equal(fifth.room, null);

  const lost = fake();
  lobby.handle(lost, JSON.stringify({ t: 'join', room: 'ZZZZ', name: 'X' }));
  assert.match(lost.out[0].msg, /not found/);
  lobby.handle(lost, JSON.stringify({ t: 'join', room: 'a1', name: 'X' }));
  assert.match(lost.out[1].msg, /invalid/);

  // A freed slot is reused.
  lobby.leave(others[0]);
  lobby.handle(fifth, JSON.stringify({ t: 'join', room: welcome.room, name: 'Late' }));
  assert.equal(fifth.out.at(-2).t, 'welcome');
  assert.equal(fifth.out.at(-2).id, 1);

  assert.equal(lobby.rooms.size, 1);
  for (const c of [host, ...others.slice(1), fifth]) lobby.leave(c);
  assert.equal(lobby.rooms.size, 0, 'empty room deleted');
  lobby.close();
});

test('malformed messages never throw and get an error reply', () => {
  const lobby = new Lobby({ loop: false });
  const c = fake();
  for (const bad of ['', 'nope', '{', 'null', '[]', '42', '{"t":5}', '{"t":"zzz"}', '{"t":"input"}',
    '{"t":"join"}', '{"t":"join","room":{}}', '{"t":"create","name":{"a":1}}']) {
    assert.doesNotThrow(() => lobby.handle(c, bad), bad);
  }
  assert.ok(c.out.every((m) => ['error', 'welcome', 'players'].includes(m.t)));
  lobby.handle(c, '{"t":"input","rot":"x","thrust":{},"fire":[1],"seq":1e99}');
  lobby.handle(c, '{"t":"input","rot":1e99,"seq":-5}');
  assert.doesNotThrow(() => lobby.handle(c, '{"t":"ping","c":"x"}'));
  assert.deepEqual(c.out.at(-1), { t: 'pong', c: 0 });
  lobby.close();
});

test('inputs are rate limited to about 60 per second', () => {
  const lobby = new Lobby({ loop: false });
  const c = fake();
  lobby.handle(c, '{"t":"create","name":"R"}');
  for (let i = 1; i <= 500; i++) lobby.handle(c, JSON.stringify({ t: 'input', rot: 1, seq: i }));
  const seq = c.room.sim.ships.get(0).lastSeq;
  assert.ok(seq >= 55 && seq <= 80, `accepted up to seq ${seq}`);
  lobby.leave(c);
  lobby.close();
});

test('end to end: two clients in one room get 2-ship snapshots and one fires', async () => {
  const s = await start({ graceMs: 0 });
  const a = await TestClient.connect(s.port);
  const b = await TestClient.connect(s.port);
  try {
    a.send({ t: 'create', name: 'Ann' });
    const wa = await a.next((m) => m.t === 'welcome');
    assert.equal(wa.id, 0);
    b.send({ t: 'join', room: wa.room, name: 'Bob' });
    const wb = await b.next((m) => m.t === 'welcome');
    assert.equal(wb.id, 1);
    assert.deepEqual(wb.players.map((p) => p.name), ['Ann', 'Bob']);
    await a.next((m) => m.t === 'players' && m.list.length === 2);

    for (const c of [a, b]) {
      const snap = await c.next((m) => m.t === 'snap' && m.ships.length === 2);
      assert.deepEqual(snap.ships.map((x) => x.id), [0, 1]);
      assert.ok(snap.ships.every((x) => x.alive === 1));
    }

    a.send({ t: 'input', rot: 0, thrust: 0, retro: 0, fire: 1, seq: 5 });
    const shot = await b.next((m) => m.t === 'snap' && m.shots.length > 0);
    assert.equal(shot.shots[0].o, 0);
    const mine = await a.next((m) => m.t === 'snap' && m.ships[0].seq === 5);
    assert.equal(mine.ships[0].seq, 5);

    b.send({ t: 'ping', c: 11 });
    assert.deepEqual(await b.next((m) => m.t === 'pong'), { t: 'pong', c: 11 });

    // Snapshots arrive at about 20 Hz.
    const n0 = a.messages.filter((m) => m.t === 'snap').length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const rate = (a.messages.filter((m) => m.t === 'snap').length - n0) / 0.5;
    assert.ok(rate > 10 && rate < 30, `snapshot rate ${rate}`);

    // Disconnecting removes the player and tells the others.
    await b.end();
    const left = await a.next((m) => m.t === 'players' && m.list.length === 1);
    assert.equal(left.list[0].name, 'Ann');
    await a.next((m) => m.t === 'snap' && m.ships.length === 1);
    await a.end();
    for (let i = 0; i < 50 && s.lobby.rooms.size; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(s.lobby.rooms.size, 0, 'room cleaned up after everyone left');
  } finally {
    await a.end();
    await b.end();
    await s.close();
  }
});

test('silent clients are dropped after the idle timeout', async () => {
  const s = await start({ idleMs: 200, graceMs: 0 });
  const c = await TestClient.connect(s.port);
  try {
    c.send({ t: 'create', name: 'Idle' });
    await c.next((m) => m.t === 'welcome');
    await c.closed;
    assert.equal(c.closeCode, 1001);
    for (let i = 0; i < 50 && s.lobby.rooms.size; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(s.lobby.rooms.size, 0);
  } finally {
    await s.close();
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (m) => JSON.stringify(m);

test('hidden paths are matched case-insensitively', () => {
  const root = '/srv/app';
  for (const p of ['/Server/server.js', '/SERVER/ws.js', '/Test/x.js', '/.ENV', '/Node_Modules/a']) {
    assert.equal(resolveStatic(root, p), null, p);
  }
});

test('names may contain an underscore, and the font can draw it', async () => {
  assert.equal(sanitizeName('a_b'), 'a_b');
  const { drawText } = await import('../js/font.js');
  let rects = 0;
  drawText({ fillRect: () => rects++ }, '_', 0, 0, '#fff');
  assert.equal(rects, 3);
});

test('end to end: A creates, B joins by code, both see both names; A leaves, B sees only B', async () => {
  const s = await start({ graceMs: 0 });
  const a = await TestClient.connect(s.port);
  const b = await TestClient.connect(s.port);
  try {
    a.send({ t: 'create', name: 'Ann' });
    const wa = await a.next((m) => m.t === 'welcome');
    b.send({ t: 'join', room: wa.room, name: 'Bob' });
    const names = (m) => m.list.map((p) => p.name).sort();
    for (const c of [a, b]) {
      const both = await c.next((m) => m.t === 'players' && m.list.length === 2);
      assert.deepEqual(names(both), ['Ann', 'Bob']);
    }
    a.send({ t: 'ping', c: 1 }); // still alive, then leave by closing
    await a.next((m) => m.t === 'pong');
    a.socket.write(encodeFrame(OP.CLOSE, Buffer.from([0x03, 0xe8]), { mask: true }));
    await a.closed;
    assert.equal(a.closeCode, 1000);
    const left = await b.next((m) => m.t === 'players' && m.list.length === 1);
    assert.deepEqual(left.list.map((p) => p.name), ['Bob']);
    assert.deepEqual(s.lobby.rooms.get(wa.room).list().map((p) => p.name), ['Bob']);
  } finally {
    await a.end();
    await b.end();
    await s.close();
  }
});

test('reload: an emptied room survives the grace period, so the new socket can rejoin; then it is deleted', async () => {
  const s = await start({ graceMs: 150 });
  try {
    const a = await TestClient.connect(s.port);
    a.send({ t: 'create', name: 'alice' });
    const { room } = await a.next((m) => m.t === 'welcome');
    await a.end(); // the old page goes away ...
    await sleep(30);
    assert.ok(s.lobby.rooms.has(room), 'room still there right after the last player left');
    assert.equal(s.lobby.rooms.get(room).timer, null, 'but it no longer simulates');
    const b = await TestClient.connect(s.port); // ... the reloaded page joins
    b.send({ t: 'join', room, name: 'alice' });
    const w = await b.next((m) => m.t === 'welcome');
    assert.equal(w.id, 0);
    assert.ok(s.lobby.rooms.get(room).timer, 'simulating again');
    await sleep(250); // the cancelled expiry must not delete a room that has players
    assert.ok(s.lobby.rooms.has(room));
    await b.next((m) => m.t === 'snap');
    await b.end();
    for (let i = 0; i < 50 && s.lobby.rooms.size; i++) await sleep(20);
    assert.equal(s.lobby.rooms.size, 0, 'deleted after the grace period');
  } finally {
    await s.close();
  }
});

test('connection limits: 503 over MAX_CONNECTIONS, 429 over the per-IP cap, slots are freed', async () => {
  const s = await start({ maxConnections: 2, maxPerIp: 0 });
  try {
    const a = await TestClient.connect(s.port);
    const b = await TestClient.connect(s.port);
    const c = await TestClient.connect(s.port);
    assert.equal(c.handshake.split('\r\n')[0], 'HTTP/1.1 503 Service Unavailable');
    await c.closed;
    await a.end();
    for (let i = 0; i < 50; i++) {
      const d = await TestClient.connect(s.port);
      if (d.handshake.startsWith('HTTP/1.1 101')) {
        await d.end();
        break;
      }
      assert.ok(i < 49, 'a slot was never freed');
      await sleep(20);
    }
    await b.end();
  } finally {
    await s.close();
  }
  const t = await start({ maxPerIp: 2 });
  try {
    const a = await TestClient.connect(t.port);
    const b = await TestClient.connect(t.port);
    const c = await TestClient.connect(t.port);
    assert.equal(c.handshake.split('\r\n')[0], 'HTTP/1.1 429 Too Many Requests');
    await a.end();
    await b.end();
  } finally {
    await t.close();
  }
});

test('room limit: create answers server full, join still works', () => {
  const lobby = new Lobby({ loop: false, maxRooms: 2, graceMs: 0 });
  const [a, b, c] = [fake(), fake(), fake()];
  lobby.handle(a, json({ t: 'create', name: 'A' }));
  lobby.handle(b, json({ t: 'create', name: 'B' }));
  lobby.handle(c, json({ t: 'create', name: 'C' }));
  assert.deepEqual(c.out, [{ t: 'error', msg: 'server full' }]);
  assert.equal(lobby.rooms.size, 2);
  lobby.handle(c, json({ t: 'join', room: a.room.code, name: 'C' }));
  assert.equal(c.out.at(-2).t, 'welcome');
  lobby.leave(a);
  lobby.leave(c);
  lobby.handle(a, json({ t: 'create', name: 'A' }));
  assert.equal(a.out.at(-2).t, 'welcome', 'a freed room slot can be used again');
  lobby.close();
});

test('every message type is rate limited, inputs separately', () => {
  const lobby = new Lobby({ loop: false });
  const c = fake();
  for (let i = 0; i < 1000; i++) lobby.handle(c, '{"t":"ping","c":1}');
  const pongs = c.out.filter((m) => m.t === 'pong').length;
  assert.ok(pongs >= MESSAGE_RATE - 5 && pongs <= MESSAGE_RATE + 30, `pongs ${pongs}`);
  const d = fake();
  for (let i = 0; i < 1000; i++) lobby.handle(d, 'junk');
  assert.ok(d.out.length <= MESSAGE_RATE + 30, `errors ${d.out.length}`);
  lobby.close();
});

test('create/join work once per connection; failed joins are capped', () => {
  const lobby = new Lobby({ loop: false, graceMs: 0 });
  const host = fake();
  lobby.handle(host, json({ t: 'create', name: 'H' }));
  const code = host.room.code;
  lobby.handle(host, json({ t: 'create', name: 'H' }));
  lobby.handle(host, json({ t: 'join', room: code, name: 'H' }));
  assert.deepEqual(host.out.slice(-2), [{ t: 'error', msg: 'already in a room' }, { t: 'error', msg: 'already in a room' }]);
  assert.equal(host.room.players.size, 1);

  let closed = null;
  const guesser = fake();
  guesser.close = (c) => { closed = c; };
  for (let i = 0; i < 4; i++) lobby.handle(guesser, json({ t: 'join', room: 'ZZZZ', name: 'G' }));
  assert.equal(closed, null, 'four failures are tolerated');
  assert.match(guesser.out[3].msg, /not found/);
  lobby.handle(guesser, json({ t: 'join', room: 'ZZZZ', name: 'G' }));
  assert.equal(closed, 1008, 'the fifth closes the connection');
  lobby.leave(host);
  lobby.close();
});

test('a guessing client is closed with 1008 over a real socket', async () => {
  const s = await start();
  try {
    const c = await TestClient.connect(s.port);
    for (let i = 0; i < 5; i++) c.send({ t: 'join', room: 'QQQQ', name: 'G' });
    await c.closed;
    assert.equal(c.closeCode, 1008);
  } finally {
    await s.close();
  }
});

test('any received frame, a WebSocket pong included, keeps a quiet client alive; the server pings', async () => {
  const s = await start({ idleMs: 300, graceMs: 0 });
  const c = await TestClient.connect(s.port);
  try {
    c.send({ t: 'create', name: 'Quiet' });
    await c.next((m) => m.t === 'welcome');
    c.socket.on('data', () => {}); // keep reading
    let pings = 0;
    const origOnData = c.onData.bind(c);
    c.onData = (d) => { if (d.includes(Buffer.from([0x89, 0x00]))) pings++; origOnData(d); };
    c.socket.removeAllListeners('data');
    c.socket.on('data', (d) => c.onData(d));
    for (let i = 0; i < 10; i++) { // 1 s, over three idle timeouts
      await sleep(100);
      c.socket.write(encodeFrame(OP.PONG, '', { mask: true }));
    }
    assert.equal(c.closeCode, null, 'still connected');
    assert.ok(pings >= 1, `server pings seen: ${pings}`);
  } finally {
    await c.end();
    await s.close();
  }
});
