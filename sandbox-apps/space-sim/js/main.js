// Browser glue: canvas scaling, keyboard input (only while focused), game loop.
import { Sim } from './sim.js';
import { render, W, H } from './render.js';

const CONTROL_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'Comma', 'Period', 'KeyQ', 'KeyE', 'KeyR', 'Equal', 'Minus',
  'NumpadAdd', 'NumpadSubtract',
]);

export function start(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false;
  const sim = new Sim();
  const keys = new Set();
  const ui = { focused: false, paused: false };
  let last = performance.now();

  canvas.width = W;
  canvas.height = H;
  canvas.tabIndex = 0;

  /** Integer scale: the largest whole multiple of W x H that fits the wrapper. */
  function resize() {
    const avail = canvas.parentElement.clientWidth;
    const scale = Math.max(1, Math.floor(avail / W));
    canvas.style.width = `${W * scale}px`;
    canvas.style.height = `${H * scale}px`;
  }
  window.addEventListener('resize', resize);
  resize();

  canvas.addEventListener('focus', () => { ui.focused = true; });
  canvas.addEventListener('blur', () => { ui.focused = false; keys.clear(); });
  canvas.addEventListener('mousedown', () => canvas.focus());

  canvas.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (CONTROL_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    switch (e.code) {
      case 'Comma': case 'KeyQ': sim.changeWarp(-1); break;
      case 'Period': case 'KeyE': sim.changeWarp(1); break;
      case 'Equal': case 'NumpadAdd': sim.changeZoom(1); break;
      case 'Minus': case 'NumpadSubtract': sim.changeZoom(-1); break;
      case 'KeyR': sim.reset(); break;
      default:
    }
  });
  canvas.addEventListener('keyup', (e) => {
    keys.delete(e.code);
    if (CONTROL_KEYS.has(e.code)) e.preventDefault();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    sim.changeZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  function down(...codes) {
    return codes.some((c) => keys.has(c));
  }

  function frame(now) {
    // Clamp so a long stall (breakpoint, slow frame) cannot explode the step count.
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!ui.paused) {
      sim.update(dt, {
        turn: (down('KeyD', 'ArrowRight') ? 1 : 0) - (down('KeyA', 'ArrowLeft') ? 1 : 0),
        thrust: (down('KeyW', 'ArrowUp') ? 1 : 0) - (down('KeyS', 'ArrowDown') ? 1 : 0),
      });
    }
    render(ctx, sim, ui);
    requestAnimationFrame(frame);
  }

  // Pause while the tab is hidden; resume without a time jump.
  document.addEventListener('visibilitychange', () => {
    ui.paused = document.hidden;
    last = performance.now();
    if (document.hidden) keys.clear();
  });

  requestAnimationFrame(frame);
  return { canvas, sim };
}
