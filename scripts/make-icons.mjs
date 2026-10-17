// Draws the extension icon (a split-flap tile over a dashed underline) and writes PNGs to src/icons/.
// The PNGs are committed; run `npm run icons` after changing the drawing.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];
const SAMPLES = 4; // supersampling per axis

const INK = [29, 34, 48];
const CREAM = [251, 246, 230];
const AMBER = [242, 183, 5];
const SHADOW = [205, 196, 170];

// Signed distance functions, in a 128×128 design space.
function roundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = Math.abs(x - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(y - cy) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function segment(x, y, ax, ay, bx, by, halfWidth) {
  const px = x - ax;
  const py = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * t, py - dy * t) - halfWidth;
}

/** Colour at a design-space point, painting shapes back to front; null is transparent. */
function paint(x, y) {
  let color = null;
  if (roundedRect(x, y, 4, 4, 124, 124, 26) <= 0) color = INK;
  // The tile, with a slightly darker lower half like a real flap.
  if (roundedRect(x, y, 26, 18, 102, 96, 11) <= 0) color = y > 57 ? SHADOW : CREAM;
  // An "A" on the tile.
  if (segment(x, y, 64, 31, 44, 85, 6.5) <= 0 || segment(x, y, 64, 31, 84, 85, 6.5) <= 0 || segment(x, y, 51, 68, 77, 68, 5) <= 0) {
    color = INK;
  }
  // The split between the two flaps.
  if (Math.abs(y - 57) <= 1.6 && x > 26 && x < 102) color = INK;
  // The dashed underline that marks translated text.
  for (const [a, b] of [[26, 46], [56, 72], [82, 102]]) {
    if (segment(x, y, a, 108, b, 108, 4.5) <= 0) color = AMBER;
  }
  return color;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = 128 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = paint((px + (sx + 0.5) / SAMPLES) * scale, (py + (sy + 0.5) / SAMPLES) * scale);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        pixels[i] = Math.round(r / a);
        pixels[i + 1] = Math.round(g / a);
        pixels[i + 2] = Math.round(b / a);
        pixels[i + 3] = Math.round((255 * a) / (SAMPLES * SAMPLES));
      }
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outdir = join(root, 'src/icons');
await mkdir(outdir, { recursive: true });
for (const size of SIZES) {
  await writeFile(join(outdir, `icon-${size}.png`), png(size, render(size)));
}
console.log(`Wrote ${SIZES.map((s) => `icon-${s}.png`).join(', ')} to ${outdir}`);
