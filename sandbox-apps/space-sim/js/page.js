// Landing-page glue: starfield backdrop, pixel-font title, Play button.
import { PAL } from './palette.js';
import { drawText, textWidth } from './font.js';
import { start } from './main.js';

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function starfield(canvas) {
  const ctx = canvas.getContext('2d');
  const h = 120;
  let w = 0;
  let stars = [];
  // Match the viewport's aspect ratio so the pixels stay square.
  function build() {
    w = Math.max(1, Math.round((h * window.innerWidth) / Math.max(1, window.innerHeight)));
    canvas.width = w;
    canvas.height = h;
    const rnd = seeded(7);
    stars = [];
    for (let i = 0; i < Math.round((w * h) / 140); i++) {
      stars.push({
        x: Math.floor(rnd() * w),
        y: Math.floor(rnd() * h),
        color: ['darkGrey', 'lavender', 'white', 'blue'][Math.floor(rnd() * 4)],
        phase: rnd() * 6,
      });
    }
  }
  build();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let timer = 0; // single pending timeout / rAF handle, cancelled before rescheduling
  let raf = 0;
  function schedule(delay) {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    timer = setTimeout(() => { raf = requestAnimationFrame(draw); }, delay);
  }
  function draw(now) {
    ctx.fillStyle = PAL.night;
    ctx.fillRect(0, 0, w, h);
    for (const s of stars) {
      const dim = !reduced && Math.sin(now / 700 + s.phase) > 0.92;
      ctx.fillStyle = PAL[dim ? 'darkBlue' : s.color];
      ctx.fillRect(s.x, s.y, 1, 1);
    }
    if (!reduced && !document.hidden) schedule(120);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    } else {
      schedule(0);
    }
  });
  window.addEventListener('resize', () => {
    build(); // resizing the canvas clears it, so redraw straight away
    if (!document.hidden) schedule(0);
  });
  schedule(0);
}

function title(canvas, text) {
  const ctx = canvas.getContext('2d');
  const scale = 2;
  canvas.width = textWidth(text, scale) + 4;
  canvas.height = 5 * scale + 4;
  // Show it at a whole-number multiple of its pixel size (CSS sizes it fluidly).
  const fit = () => {
    const avail = Math.min(window.innerWidth * 0.92, 720);
    const k = Math.max(1, Math.floor(avail / canvas.width));
    canvas.style.width = `${canvas.width * k}px`;
  };
  fit();
  window.addEventListener('resize', fit);
  drawText(ctx, text, 3, 3, PAL.darkPurple, scale); // hard drop shadow
  drawText(ctx, text, 2, 2, PAL.orange, scale);
  drawText(ctx, text, 2, 1, PAL.yellow, scale);
}

starfield(document.getElementById('bg'));
title(document.getElementById('title-art'), 'LONE ORBIT');

const game = start(document.getElementById('game'));

document.getElementById('play').addEventListener('click', (e) => {
  e.preventDefault();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.getElementById('demo').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  game.canvas.focus({ preventScroll: true });
  game.setFocused(document.activeElement === game.canvas); // focus events may not fire if the window is not active
});
