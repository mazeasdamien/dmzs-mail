/**
 * Draws every app icon from one description of the mark.
 *
 *   node scripts/make-icons.mjs
 *
 * Rendered from signed distance fields rather than resampled from a single
 * bitmap, so the stroke is the same weight relative to the canvas at 180px as
 * at 512px instead of going soft at the small sizes. No image library: the
 * shapes are distances and the PNG is a zlib stream, both of which Node has.
 *
 * Two families come out of it, and the difference matters:
 *
 *   any       — rounded corners, mark at full size. Used where the icon is
 *               shown exactly as given (browser tab, Windows taskbar).
 *   maskable  — square, edge to edge, mark pulled into the middle. Android
 *               applies its own mask, so it needs paint in every corner and
 *               the mark inside the safe circle (80% of the canvas). Handing
 *               a launcher the rounded version gets it rounded twice, or
 *               shrunk into a white circle with the artwork floating in it.
 *
 * apple-touch-icon is square and opaque for the same reason: iOS masks it
 * itself and composites transparency onto black.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const BG = [0x09, 0x09, 0x0b];
const INK = [0x5a, 0xa7, 0xf0];

/* ── distance fields ── */

const len = (x, y) => Math.hypot(x, y);

/** Distance from a point to a rounded rectangle, negative inside. */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + len(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

/** Distance from a point to a line segment — the flap, with round joins. */
function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return len(wx - t * vx, wy - t * vy);
}

/** Distance -> coverage, smoothed across one pixel. This is the antialiasing. */
const cover = (d) => Math.max(0, Math.min(1, 0.5 - d));

/** Straight "over" compositing into an RGBA buffer. */
function paint(buf, i, rgb, a) {
  if (a <= 0) return;
  const dst = buf[i + 3] / 255;
  const out = a + dst * (1 - a);
  for (let k = 0; k < 3; k++) {
    buf[i + k] = Math.round((rgb[k] * a + buf[i + k] * dst * (1 - a)) / out);
  }
  buf[i + 3] = Math.round(out * 255);
}

function render(size, { full = false, scale = 1 } = {}) {
  const u = size / 64; // the artwork is described in 64 units
  const buf = new Uint8Array(size * size * 4);

  // The mark, scaled about the centre so a circular crop cannot clip it.
  const at = (p) => (p - size / 2) / scale + size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const px = x + 0.5, py = y + 0.5;

      // Background: the whole square when something else will mask it.
      const dBg = full ? -1 : sdRoundRect(px, py, size / 2, size / 2, size / 2, size / 2, 14 * u);
      paint(buf, i, BG, cover(dBg));

      const mx = at(px), my = at(py);
      const half = 2 * u; // half of the 4-unit stroke

      // Envelope body: the ring around a rounded rectangle.
      const dBody = Math.abs(sdRoundRect(mx, my, 32 * u, 32 * u, 20 * u, 14 * u, 5 * u)) - half;
      // Flap: two segments, round joined by taking the nearer.
      const dFlap =
        Math.min(
          sdSegment(mx, my, 14 * u, 22 * u, 32 * u, 36 * u),
          sdSegment(mx, my, 32 * u, 36 * u, 50 * u, 22 * u)
        ) - half;

      paint(buf, i, INK, cover(Math.min(dBody, dFlap) * scale));
    }
  }
  return buf;
}

/* ── PNG ── */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(CRC(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  // Each scanline is prefixed with its filter type; 0 is "none", which costs
  // nothing to write and compresses well on flat artwork like this.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ── the set ── */

const ICONS = [
  ["public/icon-192.png", 192, {}],
  ["public/icon-512.png", 512, {}],
  ["public/icon-192-maskable.png", 192, { full: true, scale: 0.72 }],
  ["public/icon-512-maskable.png", 512, { full: true, scale: 0.72 }],
  ["public/apple-touch-icon.png", 180, { full: true }],
];

for (const [path, size, opts] of ICONS) {
  const bytes = png(size, render(size, opts));
  writeFileSync(path, bytes);
  console.log(`  ${path.padEnd(34)} ${size}x${size}  ${bytes.length} bytes`);
}
console.log("\nicons written");
