// Tiny 3x5 pixel font. Each glyph is 5 rows of 3 bits (MSB = left pixel).
const GLYPHS = {
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6],
  E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4], G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5],
  I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5], N: [6, 5, 5, 5, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4],
  Q: [2, 5, 5, 6, 3], R: [6, 5, 6, 5, 5], S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7],
  0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [6, 1, 2, 4, 7], 3: [6, 1, 2, 1, 6],
  4: [5, 5, 7, 1, 1], 5: [7, 4, 6, 1, 6], 6: [3, 4, 7, 5, 7], 7: [7, 1, 2, 2, 2],
  8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 6],
  '.': [0, 0, 0, 0, 2], ':': [0, 2, 0, 2, 0], '-': [0, 0, 7, 0, 0], '+': [0, 2, 7, 2, 0],
  '/': [1, 1, 2, 4, 4], '%': [5, 1, 2, 4, 5], ',': [0, 0, 0, 2, 4], '!': [2, 2, 2, 0, 2],
  '?': [6, 1, 2, 0, 2], '=': [0, 7, 0, 7, 0], '<': [1, 2, 4, 2, 1], '>': [4, 2, 1, 2, 4],
  ' ': [0, 0, 0, 0, 0],
};

export const GLYPH_H = 5;

/** Width in logical pixels of `text` at the given integer scale. */
export function textWidth(text, scale = 1) {
  return text.length === 0 ? 0 : (text.length * 4 - 1) * scale;
}

/** Draw `text` with its top-left corner at (x, y). Unknown characters render as '?'. */
export function drawText(ctx, text, x, y, color, scale = 1) {
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const rows = GLYPHS[ch] || GLYPHS['?'];
    for (let r = 0; r < GLYPH_H; r++) {
      const bits = rows[r];
      for (let c = 0; c < 3; c++) {
        if (bits & (4 >> c)) ctx.fillRect(cx + c * scale, y + r * scale, scale, scale);
      }
    }
    cx += 4 * scale;
  }
}
