import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptKey, encodeFrame, decodeFrame, OP, WsError, MAX_MESSAGE } from '../server/ws.js';

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
