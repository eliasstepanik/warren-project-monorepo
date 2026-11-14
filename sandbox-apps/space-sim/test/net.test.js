import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Net, PING_INTERVAL } from '../js/net.js';

class FakeWS {
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    FakeWS.last = this;
  }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen(); }
  receive(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
}

function make(protocol = 'http:', host = 'example.com:8080') {
  const clock = { t: 1000 };
  const net = new Net({ WebSocket: FakeWS, location: { protocol, host }, now: () => clock.t });
  return { net, clock };
}

const IDLE = { rot: 0, thrust: 0, retro: 0, fire: 0 };

test('url uses ws: for http and wss: for https', () => {
  assert.equal(make('http:', 'a.b:3000').net.url, 'ws://a.b:3000/ws');
  assert.equal(make('https:', 'a.b').net.url, 'wss://a.b/ws');
  const { net } = make();
  net.create('x');
  assert.equal(FakeWS.last.url, 'ws://example.com:8080/ws');
});

test('create and join send their message once the socket opens', () => {
  const { net } = make();
  net.create('AL');
  assert.deepEqual(FakeWS.last.sent, []);
  FakeWS.last.open();
  assert.deepEqual(FakeWS.last.sent[0], { t: 'create', name: 'AL' });
  net.join('abcd', 'BO');
  FakeWS.last.open();
  assert.deepEqual(FakeWS.last.sent[0], { t: 'join', room: 'abcd', name: 'BO' });
  net.close();
});

test('server messages reach their handlers; close and error too', () => {
  const { net } = make();
  const got = [];
  for (const t of ['welcome', 'players', 'snap', 'event', 'error', 'close']) net.on(t, (m) => got.push([t, m]));
  net.create('AL');
  const ws = FakeWS.last;
  ws.open();
  ws.receive({ t: 'welcome', id: 1, room: 'ABCD', players: [] });
  ws.receive({ t: 'snap', time: 1, ships: [], shots: [] });
  ws.receive({ t: 'event', type: 'respawn', id: 1 });
  ws.receive({ t: 'error', msg: 'full' });
  ws.onmessage({ data: 'not json' }); // ignored
  ws.onclose({ code: 1001 });
  assert.deepEqual(got.map((g) => g[0]), ['welcome', 'snap', 'event', 'error', 'close']);
  assert.equal(got[0][1].room, 'ABCD');
  assert.equal(got[4][1].code, 1001);
});

test('ping every 2 s and rtt from the pong', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const { net, clock } = make();
    net.create('AL');
    const ws = FakeWS.last;
    ws.open();
    const pings = () => ws.sent.filter((m) => m.t === 'ping');
    assert.equal(pings().length, 1);
    assert.equal(net.rtt, null);
    clock.t += 37;
    ws.receive({ t: 'pong', c: pings()[0].c });
    assert.equal(net.rtt, 37);
    clock.t += PING_INTERVAL;
    mock.timers.tick(PING_INTERVAL);
    assert.equal(pings().length, 2);
    clock.t += 55;
    ws.receive({ t: 'pong', c: pings()[1].c });
    assert.equal(net.rtt, 55);
    net.close();
    mock.timers.tick(PING_INTERVAL * 3);
    assert.equal(pings().length, 2);
    assert.ok(ws.closed);
  } finally {
    mock.timers.reset();
  }
});

test('sendInput sends on change, keeps alive after 100 ms and is capped at 60/s', () => {
  const { net } = make();
  net.create('AL');
  const ws = FakeWS.last;
  assert.equal(net.sendInput(IDLE, 0), null, 'not connected yet');
  ws.open();
  const inputs = () => ws.sent.filter((m) => m.t === 'input');

  assert.equal(net.sendInput(IDLE, 0), 1);
  assert.equal(net.sendInput(IDLE, 20), null, 'unchanged');
  assert.equal(net.sendInput(IDLE, 99), null, 'unchanged, no keepalive yet');
  assert.equal(net.sendInput(IDLE, 100), 2, 'keepalive');
  assert.equal(net.sendInput({ ...IDLE, thrust: 1 }, 105), null, 'rate limited');
  assert.equal(net.sendInput({ ...IDLE, thrust: 1 }, 117), 3, 'changed');
  assert.equal(net.sendInput({ ...IDLE, thrust: 1, rot: -1 }, 120), null, 'rate limited');
  assert.equal(net.sendInput({ ...IDLE, thrust: 1, rot: -1 }, 134), 4);
  assert.deepEqual(inputs().map((m) => m.seq), [1, 2, 3, 4]);
  assert.deepEqual(inputs()[3], { t: 'input', rot: -1, thrust: 1, retro: 0, fire: 0, seq: 4 });

  // hammering with a different input every millisecond for a second: at most 60
  const before = inputs().length;
  for (let ms = 1000; ms < 2000; ms++) net.sendInput({ ...IDLE, rot: ms % 2 ? 1 : -1 }, ms);
  assert.ok(inputs().length - before <= 60, `sent ${inputs().length - before}`);
  assert.ok(inputs().length - before >= 55);
  net.close();
});
