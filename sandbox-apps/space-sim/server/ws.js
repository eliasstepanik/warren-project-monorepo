// Minimal WebSocket (RFC 6455) server side, built on node:http and node:crypto.
// Supports text messages (fragmented or not), ping/pong and close. Binary
// messages are refused. The frame encoder and decoder are pure functions.
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE = 4096; // bytes; larger messages close the socket with 1009
export const MAX_FRAGMENTS = 64; // frames per message; more close the socket with 1009
export const MAX_BUFFERED = 256 * 1024; // bytes queued for a slow reader before it is dropped
export const OP = { CONT: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 };

/** Close codes a peer may send (RFC 6455 7.4): 1000-1003, 1007-1014 and 3000-4999. */
export function validCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

export class WsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // WebSocket close code to send
  }
}

/** Value of the Sec-WebSocket-Accept header for a client key. */
export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * Encode one frame. `payload` is a string or Buffer. Servers send unmasked
 * frames; pass { mask: true } (and optionally a 4-byte `maskKey`) to build a
 * client frame.
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = false, fin = true, maskKey } = {}) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len <= 0xffff) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (!mask) return Buffer.concat([head, data]);
  const key = maskKey || randomBytes(4);
  head[1] |= 0x80;
  const out = Buffer.alloc(head.length + 4 + len);
  head.copy(out);
  key.copy(out, head.length);
  for (let i = 0; i < len; i++) out[head.length + 4 + i] = data[i] ^ key[i & 3];
  return out;
}

/**
 * Decode the first frame in `buf`. Returns null if the buffer does not hold a
 * whole frame yet, otherwise { fin, opcode, masked, payload, length } where
 * `length` is the number of bytes consumed and `payload` is unmasked. Throws
 * WsError (1002 protocol error, 1009 too big). A too-large length is rejected
 * from the header alone, before the payload has arrived.
 */
export function decodeFrame(buf, { maxPayload = MAX_MESSAGE } = {}) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  if (b0 & 0x70) throw new WsError(1002, 'reserved bits set');
  const opcode = b0 & 0x0f;
  const fin = (b0 & 0x80) !== 0;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  if (len > maxPayload) throw new WsError(1009, 'message too big');
  if (opcode >= 8 && (!fin || len > 125)) throw new WsError(1002, 'bad control frame');
  const total = off + (masked ? 4 : 0) + len;
  if (buf.length < total) return null;
  const payload = Buffer.from(buf.subarray(total - len, total));
  if (masked) {
    const key = buf.subarray(off, off + 4);
    for (let i = 0; i < len; i++) payload[i] ^= key[i & 3];
  }
  return { fin, opcode, masked, payload, length: total };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * One server-side WebSocket. Events: 'message' (string), 'close'.
 * `lastActivity` is the time (ms) of the last frame received.
 */
export class WsConnection extends EventEmitter {
  constructor(socket, head = Buffer.alloc(0), { maxMessage = MAX_MESSAGE, maxBuffered = MAX_BUFFERED } = {}) {
    super();
    this.socket = socket;
    this.maxMessage = maxMessage;
    this.maxBuffered = maxBuffered;
    this.buf = head;
    this.frag = null; // { chunks, size } of a fragmented text message
    this.closeSent = false;
    this.closed = false;
    this.lastActivity = Date.now();
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => socket.destroy());
    socket.on('end', () => this.terminate());
    socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
    });
    // Bytes that arrived with the upgrade request: process them once the
    // caller has attached its 'message' listener.
    if (head.length) process.nextTick(() => this.onData(Buffer.alloc(0)));
  }

  get open() {
    return !this.closed && !this.closeSent;
  }

  send(text) {
    if (!this.open) return false;
    this.socket.write(encodeFrame(OP.TEXT, text));
    return true;
  }

  ping(payload = '') {
    if (this.open) this.socket.write(encodeFrame(OP.PING, payload));
  }

  /** Send a close frame, then end the socket (destroyed after 1 s at the latest). */
  close(code = 1000, reason = '') {
    if (this.closed || this.closeSent) return;
    this.closeSent = true;
    const r = Buffer.from(reason, 'utf8').subarray(0, 100);
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(code, 0);
    r.copy(body, 2);
    this.socket.write(encodeFrame(OP.CLOSE, body));
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  terminate() {
    this.closeSent = true;
    this.socket.destroy();
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      for (;;) {
        if (this.closeSent) {
          this.buf = Buffer.alloc(0);
          return;
        }
        const f = decodeFrame(this.buf, { maxPayload: this.maxMessage });
        if (!f) return;
        this.buf = this.buf.subarray(f.length);
        this.lastActivity = Date.now();
        this.onFrame(f);
      }
    } catch (e) {
      this.buf = Buffer.alloc(0);
      if (e instanceof WsError) this.close(e.code, e.message);
      else this.terminate();
    }
  }

  onFrame(f) {
    if (!f.masked) throw new WsError(1002, 'client frames must be masked');
    switch (f.opcode) {
      case OP.PING:
        this.socket.write(encodeFrame(OP.PONG, f.payload));
        return;
      case OP.PONG:
        return;
      case OP.CLOSE:
        this.close(f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1000);
        return;
      case OP.TEXT:
        if (this.frag) throw new WsError(1002, 'unexpected text frame');
        this.frag = { chunks: [], size: 0 };
        break;
      case OP.CONT:
        if (!this.frag) throw new WsError(1002, 'unexpected continuation');
        break;
      case OP.BINARY:
        throw new WsError(1003, 'binary not supported');
      default:
        throw new WsError(1002, 'unknown opcode');
    }
    this.frag.chunks.push(f.payload);
    this.frag.size += f.payload.length;
    if (this.frag.size > this.maxMessage) throw new WsError(1009, 'message too big');
    if (!f.fin) return;
    const data = Buffer.concat(this.frag.chunks);
    this.frag = null;
    let text;
    try {
      text = utf8.decode(data);
    } catch {
      throw new WsError(1007, 'invalid utf-8');
    }
    this.emit('message', text);
  }
}

/**
 * Complete the opening handshake for an 'upgrade' event. Returns a
 * WsConnection, or null after answering 400 and closing the socket.
 */
export function acceptUpgrade(req, socket, head, options) {
  const key = req.headers['sec-websocket-key'];
  const ok = req.method === 'GET'
    && String(req.headers.upgrade || '').toLowerCase() === 'websocket'
    && /(^|,)\s*upgrade\s*(,|$)/i.test(String(req.headers.connection || ''))
    && req.headers['sec-websocket-version'] === '13'
    && typeof key === 'string'
    && Buffer.from(key, 'base64').length === 16;
  if (!ok) {
    socket.end('HTTP/1.1 400 Bad Request\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  return new WsConnection(socket, head, options);
}
