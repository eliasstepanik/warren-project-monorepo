import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createGameServer, Lobby, envNumber, MAX_ROOMS } from '../server/server.js';
import { WsConnection, encodeFrame, decodeFrame, OP } from '../server/ws.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (m) => JSON.stringify(m);

async function start(options) {
  const app = createGameServer(options);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { ...app, port: app.server.address().port };
}

const upgrade = (path, extra = '') => `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${extra}\r\n`;
const goodKey = 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n';

/** Send `request`, wait for the first reply bytes, then reset the connection (RST). */
function requestThenReset(port, request) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => {});
    sock.once('data', (d) => {
      sock.resetAndDestroy();
      resolve(d.toString().split('\r\n')[0]);
    });
    sock.write(request);
  });
}

test('a peer reset on any refused upgrade does not crash the server', async () => {
  const errors = [];
  const onError = (e) => errors.push(e);
  process.on('uncaughtException', onError);
  const s = await start({ maxConnections: 1, maxPerIp: 0 });
  try {
    const holder = net.connect(s.port, '127.0.0.1'); // takes the only connection slot
    holder.on('error', () => {});
    holder.write(upgrade('/ws', goodKey));
    await new Promise((resolve) => holder.once('data', resolve));

    const seen = [];
    for (let i = 0; i < 5; i++) {
      seen.push(await requestThenReset(s.port, upgrade('/other', goodKey))); // 404
      seen.push(await requestThenReset(s.port, upgrade('/ws', goodKey))); // 503
    }
    holder.destroy();
    await sleep(100);
    const t = await start({ maxConnections: 4, maxPerIp: 0 });
    try {
      for (let i = 0; i < 5; i++) seen.push(await requestThenReset(t.port, upgrade('/ws', 'Sec-WebSocket-Version: 13\r\n'))); // 400
      const again = await requestThenReset(t.port, upgrade('/ws', goodKey));
      assert.match(again, /^HTTP\/1\.1 101/, 'a new connection is still accepted');
    } finally {
      await t.close();
    }
    const u = await start({ maxPerIp: 1 });
    try {
      const a = net.connect(u.port, '127.0.0.1');
      a.on('error', () => {});
      a.write(upgrade('/ws', goodKey));
      await new Promise((resolve) => a.once('data', resolve));
      for (let i = 0; i < 5; i++) seen.push(await requestThenReset(u.port, upgrade('/ws', goodKey))); // 429
      a.destroy();
    } finally {
      await u.close();
    }
    for (const code of ['404', '503', '400', '429']) {
      assert.ok(seen.some((l) => l.includes(` ${code} `)), `${code} path was exercised: ${seen}`);
    }
    await sleep(100);
    assert.deepEqual(errors, [], 'no uncaught exception');
  } finally {
    process.off('uncaughtException', onError);
    await s.close();
  }
});

/** Fake lobby client. */
function fake() {
  const c = { id: -1, name: '', room: null, out: [], send: (m) => c.out.push(m), sendText: (t) => c.out.push(JSON.parse(t)) };
  return c;
}

test('a full lobby evicts the oldest emptied (grace) room; only live rooms make it full', () => {
  const lobby = new Lobby({ loop: false, maxRooms: 2, graceMs: 60000 });
  const [a, b, c, d] = [fake(), fake(), fake(), fake()];
  lobby.handle(a, json({ t: 'create', name: 'A' }));
  lobby.handle(b, json({ t: 'create', name: 'B' }));
  const codeA = a.room.code;
  const codeB = b.room.code;
  lobby.leave(a); // A's room enters its grace period
  const roomA = lobby.rooms.get(codeA);
  lobby.leave(b); // B's too, later
  lobby.handle(c, json({ t: 'create', name: 'C' }));
  assert.equal(c.out.at(-2).t, 'welcome', 'create succeeds by evicting a grace room');
  assert.equal(lobby.rooms.size, 2);
  assert.ok(!lobby.rooms.has(codeA), 'the oldest empty room was evicted');
  assert.ok(lobby.rooms.has(codeB));
  assert.equal(roomA.expiry, null, 'its expiry was cleared');
  lobby.handle(d, json({ t: 'create', name: 'D' })); // evicts B's room
  assert.equal(d.out.at(-2).t, 'welcome');
  assert.ok(!lobby.rooms.has(codeB));
  const e = fake();
  lobby.handle(e, json({ t: 'create', name: 'E' }));
  assert.deepEqual(e.out, [{ t: 'error', msg: 'server full' }], 'every room has players');
  lobby.close();
});

test('one client cannot lock others out by creating and leaving repeatedly', () => {
  const lobby = new Lobby({ loop: false, graceMs: 60000 });
  const abuser = fake();
  for (let i = 0; i < MAX_ROOMS * 2; i++) {
    lobby.handle(abuser, json({ t: 'create', name: 'X' }));
    lobby.leave(abuser);
  }
  assert.ok(lobby.rooms.size <= MAX_ROOMS);
  const honest = fake();
  lobby.handle(honest, json({ t: 'create', name: 'H' }));
  assert.equal(honest.out.at(-2).t, 'welcome');
  lobby.close();
});

test('a closed lobby ignores leave, create and join and arms no timer', () => {
  const lobby = new Lobby({ loop: false, graceMs: 60000 });
  const a = fake();
  lobby.handle(a, json({ t: 'create', name: 'A' }));
  const room = a.room;
  lobby.close();
  lobby.leave(a);
  assert.equal(room.expiry, null, 'no expiry timer after close');
  const b = fake();
  lobby.handle(b, json({ t: 'create', name: 'B' }));
  lobby.handle(b, json({ t: 'join', room: room.code, name: 'B' }));
  assert.equal(lobby.rooms.size, 0);
  assert.equal(b.room, null);
});

test('envNumber falls back for NaN, negative, infinite and empty values', () => {
  const get = (v) => envNumber('X', 7, { X: v });
  assert.equal(get(undefined), 7);
  assert.equal(get('abc'), 7);
  assert.equal(get(''), 7);
  assert.equal(get('-1'), 7);
  assert.equal(get('Infinity'), 7);
  assert.equal(get('0'), 0);
  assert.equal(get('12'), 12);
  assert.equal(envNumber('PORT', 8080, {}), 8080);
});

function fakeSocket() {
  const s = new EventEmitter();
  s.written = [];
  s.writableLength = 0;
  s.destroyed = false;
  s.ended = false;
  s.setNoDelay = () => {};
  s.write = (b) => { s.written.push(b); return true; };
  s.end = () => { s.ended = true; };
  s.destroy = () => { s.destroyed = true; s.emit('close'); };
  return s;
}

const closeFrame = (s) => s.written.map((b) => decodeFrame(b)).find((x) => x.opcode === OP.CLOSE);

test("'end' after our close frame does not destroy the socket at once", () => {
  const s = fakeSocket();
  const conn = new WsConnection(s);
  conn.close(1000);
  s.emit('end');
  assert.equal(s.destroyed, false, 'left to the destroy timer');
  assert.equal(closeFrame(s).payload.readUInt16BE(0), 1000);
  s.destroy();
});

test('a close reason that is not valid UTF-8 gets 1007; a valid one is echoed', () => {
  const body = (reason) => Buffer.concat([Buffer.from([0x03, 0xe8]), reason]);
  const reply = (reason) => {
    const s = fakeSocket();
    const conn = new WsConnection(s);
    conn.onData(encodeFrame(OP.CLOSE, body(reason), { mask: true }));
    s.destroy();
    return closeFrame(s).payload.readUInt16BE(0);
  };
  assert.equal(reply(Buffer.from([0xff, 0xfe])), 1007);
  assert.equal(reply(Buffer.from([0xc3])), 1007);
  assert.equal(reply(Buffer.from('bye \u00e9', 'utf8')), 1000);
  assert.equal(reply(Buffer.alloc(0)), 1000);
});
