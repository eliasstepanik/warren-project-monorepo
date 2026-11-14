// WebSocket client for the multiplayer server (see server/PROTOCOL.md). No DOM
// access besides `location`; the WebSocket constructor, location and clock are
// injectable so it can be tested with a fake socket.
//
// Events (net.on(type, fn)): 'open', 'welcome', 'players', 'snap', 'event',
// 'error', 'close'. Each handler gets the parsed server message ('open' gets
// nothing, 'close' gets { code }, a socket failure gives { t: 'error', msg }).
import { sanitizeInput } from './mp-sim.js';

export const PING_INTERVAL = 2000; // ms
export const KEEPALIVE = 100; // ms: resend an unchanged input after this long
export const MAX_INPUT_RATE = 60; // inputs/s
const MIN_GAP = 1000 / MAX_INPUT_RATE;
const OPEN = 1; // WebSocket.OPEN

const same = (a, b) => a.rot === b.rot && a.thrust === b.thrust && a.retro === b.retro && a.fire === b.fire;

export class Net {
  constructor({
    WebSocket = globalThis.WebSocket,
    location = globalThis.location,
    now = () => globalThis.performance.now(),
  } = {}) {
    this.WebSocket = WebSocket;
    this.location = location;
    this.now = now;
    this.ws = null;
    this.rtt = null; // ms, from the latest pong
    this.seq = 0; // last input seq used
    this.handlers = new Map();
    this.pingTimer = null;
    this.lastInput = null; // last input actually sent
    this.lastSent = -Infinity; // time of the last input sent
  }

  /** ws://host/ws, or wss:// when the page is served over https. */
  get url() {
    const { protocol, host } = this.location;
    return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/ws`;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === OPEN;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this.handlers.get(type)?.delete(fn);
  }

  emit(type, msg) {
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn(msg);
  }

  create(name) {
    this.connect({ t: 'create', name });
  }

  join(room, name) {
    this.connect({ t: 'join', room, name });
  }

  connect(first) {
    this.close();
    const ws = new this.WebSocket(this.url);
    this.ws = ws;
    this.rtt = null;
    this.seq = 0;
    this.lastInput = null;
    this.lastSent = -Infinity;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.send(first);
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL);
      this.emit('open');
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'pong') this.rtt = Math.max(0, this.now() - msg.c);
      else this.emit(msg.t, msg);
    };
    ws.onerror = () => {
      if (this.ws === ws) this.emit('error', { t: 'error', msg: 'connection error' });
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.stop();
      this.emit('close', { code: ev?.code });
    };
  }

  send(obj) {
    if (!this.connected) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  ping() {
    this.send({ t: 'ping', c: this.now() });
  }

  /**
   * Send the held controls if they changed, or as a keepalive after 100 ms,
   * and never more than 60 times a second. Returns the seq used, or null if
   * nothing was sent. Call it every frame.
   */
  sendInput(input, nowMs = this.now()) {
    if (!this.connected) return null;
    const inp = sanitizeInput(input);
    const age = nowMs - this.lastSent;
    if (age < MIN_GAP) return null;
    if (this.lastInput && same(inp, this.lastInput) && age < KEEPALIVE) return null;
    const seq = ++this.seq;
    this.send({ t: 'input', rot: inp.rot, thrust: inp.thrust, retro: inp.retro, fire: inp.fire, seq });
    this.lastInput = inp;
    this.lastSent = nowMs;
    return seq;
  }

  stop() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Close the connection (no 'close' event is emitted for a deliberate close). */
  close() {
    this.stop();
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.close();
  }
}
