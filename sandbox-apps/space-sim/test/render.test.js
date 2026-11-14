import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../js/sim.js';
import { render } from '../js/render.js';

// Minimal canvas stub that records fills and rejects NaN coordinates.
function stubCtx() {
  const calls = { fills: 0 };
  return {
    calls,
    fillStyle: '',
    fillRect(x, y, w, h) {
      assert.ok([x, y, w, h].every(Number.isFinite), `bad rect ${x},${y},${w},${h}`);
      calls.fills++;
    },
  };
}

test('render runs at every zoom, before and after a crash', () => {
  const sim = new Sim();
  const ctx = stubCtx();
  for (let z = 0; z < 10; z++) {
    sim.zoomIndex = z;
    sim.update(1 / 60, { turn: 1, thrust: 1 });
    render(ctx, sim, { focused: true, paused: false });
  }
  sim.explode(2);
  sim.update(1 / 60, { turn: 0, thrust: 0 });
  render(ctx, sim, { focused: false, paused: false });
  assert.ok(ctx.calls.fills > 100);
});
