// Browser glue: canvas scaling, keyboard input (only while focused), game loop.
import { Sim } from './sim.js';
import { render, W, H } from './render.js';
import { PAL } from './palette.js';
import { drawText, textWidth } from './font.js';

// Movement keys are matched on e.code (physical position, so WASD works on any
// layout). Zoom, warp, reset and pause are matched on e.key (the typed
// character), which is what `,` `.` `+` `-` produce reliably.
const CODE_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
]);
const WARP_DOWN = new Set([',', '<', 'q']);
const WARP_UP = new Set(['.', '>', 'e']);
const ZOOM_IN = new Set(['+', '=']);
const ZOOM_OUT = new Set(['-', '_']);
const ACTION_KEYS = new Set([...WARP_DOWN, ...WARP_UP, ...ZOOM_IN, ...ZOOM_OUT, 'r', 'p', 'f', 'f11', 'b']);

const TOAST_MS = 1000;

const WHEEL_THRESHOLD = 100; // accumulated deltaY per zoom level
const MIN_INTEGER_WIDTH = 320; // below this, fall back to fluid scaling

export function start(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const sim = new Sim();
  const keys = new Set();
  const ui = { focused: false, paused: false };
  let last = performance.now();
  let raf = 0;
  let wheel = 0;
  let mp = null; // { net, client, view, ui, off: [unsubscribe...] } while in multiplayer

  canvas.width = W;
  canvas.height = H;
  canvas.tabIndex = 0;
  // Resizing a canvas resets its context state, so set this afterwards.
  ctx.imageSmoothingEnabled = false;

  /**
   * Integer scale: the largest whole multiple of W x H (in device pixels) that
   * fits the parent's content box. The canvas uses content-box sizing, so its
   * own border is subtracted from the space available.
   */
  function resize() {
    const parent = canvas.parentElement;
    const ps = getComputedStyle(parent);
    const cs = getComputedStyle(canvas);
    const inner = parent.clientWidth - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight);
    let avail = inner - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    if (document.body.classList.contains('immersive')) {
      // The viewport has a fixed height, so the width alone may be too generous.
      const innerH = parent.clientHeight - parseFloat(ps.paddingTop) - parseFloat(ps.paddingBottom);
      const availH = innerH - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
      avail = Math.min(avail, (availH * W) / H);
    }
    if (!(avail >= MIN_INTEGER_WIDTH)) {
      canvas.classList.add('fluid');
      canvas.style.width = '';
      canvas.style.height = '';
      return;
    }
    canvas.classList.remove('fluid');
    const dpr = window.devicePixelRatio || 1;
    let scale = Math.floor((avail * dpr) / W) / dpr;
    // A fractional dpr can round the device-pixel scale far below the space we
    // have; fall back to the CSS-integer scale (or fluid) when it is much smaller.
    const cssScale = Math.floor(avail / W);
    if (W * scale < MIN_INTEGER_WIDTH || W * scale < W * cssScale) {
      if (cssScale < 1) {
        canvas.classList.add('fluid');
        canvas.style.width = '';
        canvas.style.height = '';
        return;
      }
      scale = cssScale;
    }
    canvas.style.width = `${W * scale}px`;
    canvas.style.height = `${H * scale}px`;
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas.parentElement);
  window.addEventListener('resize', resize); // also catches devicePixelRatio changes
  resize();

  function setFocused(v) {
    ui.focused = v;
    canvas.classList.toggle('focused', v);
    if (!v) {
      keys.clear();
      wheel = 0;
      if (mp) mp.ui.tab = false;
    }
  }
  canvas.addEventListener('focus', () => setFocused(true));
  canvas.addEventListener('blur', () => setFocused(false));
  canvas.addEventListener('mousedown', () => canvas.focus());

  // Display modes: browser fullscreen (F / F11) and immersive (B), where the
  // game fills the whole viewport. A short message confirms each change.
  function showToast(text) {
    ui.toast = { text, until: performance.now() + TOAST_MS };
  }
  function modeToast() {
    showToast(document.fullscreenElement ? 'FULLSCREEN'
      : document.body.classList.contains('immersive') ? 'IMMERSIVE' : 'NORMAL');
  }
  // Leaving immersive collapses the fixed layout, so remember where the page was.
  let savedScroll = 0;
  // True when fullscreen (not the B key) turned immersive on, so leaving
  // fullscreen turns it off again.
  let immersiveFromFullscreen = false;
  function setImmersive(on) {
    if (on === document.body.classList.contains('immersive')) return;
    if (on) savedScroll = window.scrollY;
    document.body.classList.toggle('immersive', on);
    resize();
    if (!on) window.scrollTo(0, savedScroll);
  }
  function toggleFullscreen() {
    if (!document.fullscreenEnabled) {
      showToast('NO FULLSCREEN');
      return;
    }
    const p = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    // refused by the browser: stay as we are
    if (p) p.catch(() => showToast('NO FULLSCREEN'));
  }
  function toggleImmersive() {
    immersiveFromFullscreen = false; // an explicit choice now
    setImmersive(!document.body.classList.contains('immersive'));
    modeToast();
  }
  // Also fires when the user leaves fullscreen with Esc.
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
      immersiveFromFullscreen = !document.body.classList.contains('immersive');
      setImmersive(true);
    } else {
      if (immersiveFromFullscreen) setImmersive(false);
      immersiveFromFullscreen = false;
    }
    resize();
    modeToast();
  });

  canvas.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (mp) {
      mpKeydown(e, k);
      return;
    }
    const handled = CODE_KEYS.has(e.code) || ACTION_KEYS.has(k);
    if (handled) e.preventDefault();
    if (e.repeat) return;
    if (CODE_KEYS.has(e.code)) keys.add(e.code);
    if (WARP_DOWN.has(k)) sim.changeWarp(-1);
    else if (WARP_UP.has(k)) sim.changeWarp(1);
    else if (ZOOM_IN.has(k)) sim.changeZoom(1);
    else if (ZOOM_OUT.has(k)) sim.changeZoom(-1);
    else if (k === 'f' || k === 'f11') toggleFullscreen();
    else if (k === 'b') toggleImmersive();
    else if (k === 'r') sim.reset();
    else if (k === 'p') {
      ui.paused = !ui.paused;
      if (ui.paused) { // the frozen frame must not keep a flame or the warp message
        sim.thrusting = 0;
        sim.noThrustAtWarp = false;
      }
    }
  });
  // Multiplayer keys: fire is Space or F, Tab shows the scoreboard, warp only
  // flashes a notice, P and R do nothing. Shift+Tab still leaves the canvas.
  function mpKeydown(e, k) {
    if (e.key === 'Tab') {
      if (e.shiftKey) return;
      e.preventDefault();
      mp.ui.tab = true;
      return;
    }
    const code = CODE_KEYS.has(e.code) || e.code === 'KeyF';
    if (code || ACTION_KEYS.has(k)) e.preventDefault();
    if (e.repeat) return;
    if (code) keys.add(e.code);
    if (WARP_DOWN.has(k) || WARP_UP.has(k)) mp.ui.flashUntil = performance.now() + FLASH_MS;
    else if (ZOOM_IN.has(k)) changeMpZoom(mp.view, 1);
    else if (ZOOM_OUT.has(k)) changeMpZoom(mp.view, -1);
  }
  canvas.addEventListener('keyup', (e) => {
    keys.delete(e.code);
    if (e.key === 'Tab' && mp) mp.ui.tab = false;
    if (CODE_KEYS.has(e.code) || ACTION_KEYS.has(e.key.toLowerCase())) e.preventDefault();
  });

  // Only capture the wheel while focused so the page can still scroll. Trackpads
  // send many small deltas, so accumulate them and zoom one level per threshold.
  canvas.addEventListener('wheel', (e) => {
    if (document.activeElement !== canvas) return;
    e.preventDefault();
    wheel += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    while (Math.abs(wheel) >= WHEEL_THRESHOLD) {
      if (mp) changeMpZoom(mp.view, wheel < 0 ? 1 : -1);
      else sim.changeZoom(wheel < 0 ? 1 : -1);
      wheel -= Math.sign(wheel) * WHEEL_THRESHOLD;
    }
  }, { passive: false });

  function down(...codes) {
    return codes.some((c) => keys.has(c));
  }

  function mpFrame(now, dt) {
    const { net, client, view } = mp;
    const input = {
      rot: (down('KeyD', 'ArrowRight') ? 1 : 0) - (down('KeyA', 'ArrowLeft') ? 1 : 0),
      thrust: down('KeyW', 'ArrowUp') ? 1 : 0,
      retro: down('KeyS', 'ArrowDown') ? 1 : 0,
      fire: down('Space', 'KeyF') ? 1 : 0,
    };
    const seq = net.sendInput(input, now);
    if (seq !== null) client.applyLocalInput(input, seq);
    view.input = input;
    client.stepLocal(dt);
    client.rtt = net.rtt;
    mp.ui.focused = ui.focused;
    renderMp(ctx, client, mp.ui, view, now);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    // Clamp so a long stall (breakpoint, slow frame) cannot explode the step
    // count, and so the delta is never negative.
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    if (mp) {
      mpFrame(now, dt);
      return;
    }
    if (!ui.paused) {
      sim.update(dt, {
        turn: (down('KeyD', 'ArrowRight') ? 1 : 0) - (down('KeyA', 'ArrowLeft') ? 1 : 0),
        thrust: (down('KeyW', 'ArrowUp') ? 1 : 0) - (down('KeyS', 'ArrowDown') ? 1 : 0),
      });
    }
    render(ctx, sim, ui);
    drawToast(now);
  }

  /** Mode message, centred near the top; fades out over its last half second. */
  function drawToast(now) {
    const t = ui.toast;
    if (!t || now >= t.until) return;
    ctx.globalAlpha = Math.min(1, (t.until - now) / (TOAST_MS / 2));
    const x = Math.round((W - textWidth(t.text, 2)) / 2);
    ctx.fillStyle = PAL.night;
    ctx.fillRect(x - 4, 20, textWidth(t.text, 2) + 8, 16);
    drawText(ctx, t.text, x, 24, PAL.yellow, 2);
    ctx.globalAlpha = 1;
  }

  // Run the loop only while the canvas is on screen and the tab is visible;
  // resume without a time jump.
  let onScreen = true;
  function syncLoop() {
    if (onScreen && !document.hidden) {
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    } else {
      cancelAnimationFrame(raf);
      raf = 0;
      keys.clear();
      sendNeutral(2);
    }
  }

  // While hidden the network keeps running (Net pings on its own timer), but
  // the ship must not keep thrusting or firing, so tell the server we let go.
  function sendNeutral(tries) {
    if (!mp || raf) return;
    const seq = mp.net.sendInput(NEUTRAL, performance.now());
    if (seq !== null) mp.client.applyLocalInput(NEUTRAL, seq);
    else if (tries > 0) setTimeout(() => sendNeutral(tries - 1), 20); // rate-limited
  }

  /** Switch the canvas to multiplayer. `net` is a Net, `client` an MpClient that has had onWelcome. */
  function startMultiplayer(net, client) {
    stopMultiplayer();
    const view = createMpView();
    const now = () => net.now();
    mp = {
      net, client, view, ui: { focused: ui.focused, tab: false, disconnected: false, flashUntil: 0 },
      off: [],
    };
    const m = mp;
    m.off.push(
      net.on('players', (msg) => client.onPlayers(msg)),
      net.on('snap', (msg) => client.onSnapshot(msg, now())),
      net.on('event', (msg) => {
        client.onEvent(msg, now());
        addExplosion(view, msg, now());
      }),
      net.on('close', () => { m.ui.disconnected = true; }),
    );
    keys.clear();
    last = performance.now();
  }

  function stopMultiplayer() {
    if (!mp) return;
    for (const off of mp.off) off();
    mp = null;
    keys.clear();
    last = performance.now();
  }
  document.addEventListener('visibilitychange', syncLoop);
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1].isIntersecting;
      syncLoop();
    }).observe(canvas);
  }

  syncLoop();
  return {
    canvas, sim, ui, setFocused, startMultiplayer, stopMultiplayer,
    get mode() { return mp ? 'multiplayer' : 'singleplayer'; },
  };
}
