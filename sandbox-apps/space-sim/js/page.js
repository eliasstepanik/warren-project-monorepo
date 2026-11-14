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
  const w = 200;
  const h = 120;
  canvas.width = w;
  canvas.height = h;
  const rnd = seeded(7);
  const stars = [];
  for (let i = 0; i < 170; i++) {
    stars.push({
      x: Math.floor(rnd() * w),
      y: Math.floor(rnd() * h),
      color: ['darkGrey', 'lavender', 'white', 'blue'][Math.floor(rnd() * 4)],
      phase: rnd() * 6,
    });
  }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function draw(now) {
    ctx.fillStyle = PAL.night;
    ctx.fillRect(0, 0, w, h);
    for (const s of stars) {
      const dim = !reduced && Math.sin(now / 700 + s.phase) > 0.92;
      ctx.fillStyle = PAL[dim ? 'darkBlue' : s.color];
      ctx.fillRect(s.x, s.y, 1, 1);
    }
    if (!reduced && !document.hidden) setTimeout(() => requestAnimationFrame(draw), 120);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) requestAnimationFrame(draw);
  });
  requestAnimationFrame(draw);
}

function title(canvas, text) {
  const ctx = canvas.getContext('2d');
  const scale = 2;
  canvas.width = textWidth(text, scale) + 4;
  canvas.height = 5 * scale + 4;
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
});
