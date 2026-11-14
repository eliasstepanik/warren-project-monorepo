import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  acceptKey, encodeFrame, decodeFrame, OP, WsError, WsConnection, MAX_MESSAGE, MAX_FRAGMENTS, MAX_BUFFERED,
} from '../server/ws.js';

test('accept key matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('encodes and decodes unmasked text frames at the length boundaries', () => {
  for (const n of [0, 5, 125, 126, 65535, 70000]) {
    const text = 'x'.repeat(n);
    const frame = encodeFrame(OP.TEXT, text);
    const head = n < 126 ? 2 : n <= 65535 ? 4 : 10;
    assert.equal(frame.length, head + n, `size for ${n}`);
    assert.equal(frame[1] & 0x7f, n < 126 ? n : n <= 65535 ? 126 : 127);
    const f = decodeFrame(frame, { maxPayload: 100000 });
    assert.equal(f.length, frame.length);
    assert.equal(f.opcode, OP.TEXT);
    assert.equal(f.fin, true);
    assert.equal(f.masked, false);
    assert.equal(f.payload.toString(), text);
  }
});

test('masked client frames are unmasked on decode', () => {
  const key = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
  // RFC 6455 section 5.7: a single-frame masked text message "Hello"
  const rfc = Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
  assert.equal(decodeFrame(rfc).payload.toString(), 'Hello');
  assert.deepEqual(encodeFrame(OP.TEXT, 'Hello', { mask: true, maskKey: key }), rfc);

  for (const n of [125, 126, 65535, 70000]) {
    const text = 'ab\u00e9'.repeat(Math.ceil(n / 4)).slice(0, n);
    const frame = encodeFrame(OP.TEXT, text, { mask: true });
    const f = decodeFrame(frame, { maxPayload: 200000 });
    assert.equal(f.masked, true);
    assert.equal(f.length, frame.length);
    assert.equal(f.payload.toString(), text);
  }
});

test('decodeFrame waits for a complete frame and reports the bytes used', () => {
  const frame = encodeFrame(OP.TEXT, 'y'.repeat(300), { mask: true });
  for (const cut of [0, 1, 3, 5, frame.length - 1]) assert.equal(decodeFrame(frame.subarray(0, cut)), null);
  const two = Buffer.concat([frame, encodeFrame(OP.PING, 'p', { mask: true })]);
  const f = decodeFrame(two);
  assert.equal(f.length, frame.length);
  assert.equal(decodeFrame(two.subarray(f.length)).opcode, OP.PING);
});

test('decodeFrame rejects oversized and malformed frames', () => {
  const big = encodeFrame(OP.TEXT, 'z'.repeat(MAX_MESSAGE + 1), { mask: true });
  assert.throws(() => decodeFrame(big), (e) => e instanceof WsError && e.code === 1009);
  // The length alone is enough: a huge declared length is refused before its payload arrives.
  const head = Buffer.alloc(10);
  head[0] = 0x81;
  head[1] = 0xff;
  head.writeBigUInt64BE(2n ** 40n, 2);
  assert.throws(() => decodeFrame(head), (e) => e.code === 1009);
  assert.throws(() => decodeFrame(Buffer.from([0xc1, 0x80, 0, 0, 0, 0])), (e) => e.code === 1002);
  assert.throws(() => decodeFrame(encodeFrame(OP.PING, 'a'.repeat(126), { mask: true })), (e) => e.code === 1002);
  // exactly the limit is fine
  assert.equal(decodeFrame(encodeFrame(OP.TEXT, 'z'.repeat(MAX_MESSAGE), { mask: true })).payload.length, MAX_MESSAGE);
});

/** A socket stand-in that records what is written to it. */
function fakeSocket() {
  const s = new EventEmitter();
  s.written = [];
  s.writableLength = 0;
  s.destroyed = false;
  s.setNoDelay = () => {};
  s.write = (b) => { s.written.push(b); return true; };
  s.end = () => {};
  s.destroy = () => { s.destroyed = true; s.emit('close'); };
  return s;
}

const feed = (conn, opcode, payload = '', opts = {}) => conn.onData(encodeFrame(opcode, payload, { mask: true, ...opts }));
const closeCodeOf = (s) => {
  const f = s.written.map((b) => decodeFrame(b)).find((x) => x.opcode === OP.CLOSE);
  return f && f.payload.readUInt16BE(0);
};

test('endless empty continuation frames are refused with 1009', () => {
  const s = fakeSocket();
  const conn = new WsConnection(s);
  feed(conn, OP.TEXT, '', { fin: false });
  for (let i = 0; i < MAX_FRAGMENTS - 1; i++) feed(conn, OP.CONT, '', { fin: false });
  assert.equal(closeCodeOf(s), undefined, 'at the limit the message is still open');
  feed(conn, OP.CONT, '', { fin: false });
  assert.equal(closeCodeOf(s), 1009);
  assert.equal(conn.frag?.chunks.length ?? 0 <= MAX_FRAGMENTS, true);
});

test('a message split into a few frames is reassembled', () => {
  const s = fakeSocket();
  const conn = new WsConnection(s);
  const got = [];
  conn.on('message', (m) => got.push(m));
  feed(conn, OP.TEXT, 'ab', { fin: false });
  feed(conn, OP.CONT, 'cd', { fin: false });
  feed(conn, OP.CONT, 'ef');
  assert.deepEqual(got, ['abcdef']);
});

test('close frames: valid codes are echoed, bad ones get 1002', () => {
  const body = (code) => { const b = Buffer.alloc(2); b.writeUInt16BE(code); return b; };
  const reply = (payload) => {
    const s = fakeSocket();
    feed(new WsConnection(s), OP.CLOSE, payload);
    return closeCodeOf(s);
  };
  assert.equal(reply(Buffer.alloc(0)), 1000);
  for (const code of [1000, 1001, 1003, 1007, 1011, 3000, 4999]) assert.equal(reply(body(code)), code, String(code));
  for (const code of [0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000]) assert.equal(reply(body(code)), 1002, String(code));
  assert.equal(reply(Buffer.from([0x03])), 1002, 'one-byte payload');
});

test('a peer that stops reading is terminated by send, ping and the pong reply', () => {
  for (const act of [(c) => c.send('x'), (c) => c.ping(), (c) => feed(c, OP.PING, 'p')]) {
    const s = fakeSocket();
    const conn = new WsConnection(s);
    act(conn);
    assert.equal(s.destroyed, false, 'nothing queued: fine');
    s.writableLength = MAX_BUFFERED + 1;
    act(conn);
    assert.equal(s.destroyed, true);
    assert.equal(conn.send('y'), false);
  }
});

test('the socket ending terminates the connection', () => {
  const s = fakeSocket();
  const conn = new WsConnection(s);
  let closed = 0;
  conn.on('close', () => closed++);
  s.emit('end');
  assert.equal(s.destroyed, true);
  assert.equal(closed, 1);
});
