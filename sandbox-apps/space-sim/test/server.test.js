import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createGameServer, Lobby, sanitizeName, MAX_PLAYERS } from '../server/server.js';
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
  const s = await start();
  try {
    for (const p of [
      '/../package.json', '/%2e%2e/package.json', '/js/../../package.json', '/..%2fpackage.json',
      '/%2e%2e%2f%2e%2e%2fetc/passwd', '/js/%2e%2e/%2e%2e/package.json', '/%00', '/..\\package.json',
      '/server/server.js', '/test/ws.test.js',
    ]) {
      const r = await get(s.port, p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.body, /"name": "space-sim"|createGameServer/, p);
    }
    assert.equal((await get(s.port, '/package.json')).status, 200); // inside the root: allowed
  } finally {
    await s.close();
  }
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

test('upgrade is refused on other paths and when headers are wrong', async () => {
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
  assert.equal(sanitizeName('  <b>Hello</b> World, how are you  '), 'bHellobWorld');
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
  const lobby = new Lobby({ loop: false });
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
  assert.ok(c.out.every((m) => m.t === 'error' || m.t === 'welcome'));
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
  const s = await start();
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
  const s = await start({ idleMs: 200 });
  const c = await TestClient.connect(s.port);
  try {
    c.send({ t: 'create', name: 'Idle' });
    await c.next((m) => m.t === 'welcome');
    await c.closed;
    assert.equal(c.closeCode, 1001);
    assert.equal(s.lobby.rooms.size, 0);
  } finally {
    await s.close();
  }
});
