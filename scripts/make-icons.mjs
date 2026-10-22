// Renders the PWA PNG icons (three overlapping circles) without any image library.
// Usage: node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public');
const BG = [15, 17, 21];
const CIRCLES = [
  { x: 256, y: 176, r: 88, c: [232, 130, 58] },
  { x: 186, y: 304, r: 88, c: [63, 179, 127] },
  { x: 326, y: 304, r: 88, c: [79, 143, 247] },
];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function render(size) {
  const s = size / 512;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let [r, g, b] = BG;
      const px = (x + 0.5) / s, py = (y + 0.5) / s;
      for (const c of CIRCLES) {
        const d = Math.hypot(px - c.x, py - c.y);
        const a = Math.max(0, Math.min(1, c.r - d + 0.5)) * 0.92;
        r = r * (1 - a) + c.c[0] * a; g = g * (1 - a) + c.c[1] * a; b = b * (1 - a) + c.c[2] * a;
      }
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [180, 192, 512]) fs.writeFileSync(path.join(out, `icon-${size}.png`), render(size));
console.log('icons written to', out);
