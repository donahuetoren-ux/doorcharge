// Draws the extension icons (rounded square with a check mark) without any
// image libraries: `node tools/make-icons.js`.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const SAMPLES = 4; // supersampling per axis for smooth edges
const TOP = [99, 102, 241]; // gradient colours
const BOTTOM = [147, 51, 234];
const CHECK = [
  [0.27, 0.53],
  [0.44, 0.7],
  [0.75, 0.33],
];
const STROKE = 0.085; // half width of the check mark, relative to the icon size

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function insideRoundedSquare(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const u = (x + (sx + 0.5) / SAMPLES) / size;
          const v = (y + (sy + 0.5) / SAMPLES) / size;
          if (!insideRoundedSquare(u, v, 0.22)) continue;
          const onCheck =
            Math.min(distanceToSegment(u, v, CHECK[0], CHECK[1]), distanceToSegment(u, v, CHECK[1], CHECK[2])) <= STROKE;
          const color = onCheck ? [255, 255, 255] : TOP.map((c, i) => c + (BOTTOM[i] - c) * v);
          r += color[0];
          g += color[1];
          b += color[2];
          covered++;
        }
      }
      const o = (y * size + x) * 4;
      if (covered) {
        rgba[o] = Math.round(r / covered);
        rgba[o + 1] = Math.round(g / covered);
        rgba[o + 2] = Math.round(b / covered);
        rgba[o + 3] = Math.round((255 * covered) / (SAMPLES * SAMPLES));
      }
    }
  }
  return encodePng(size, rgba);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  fs.writeFileSync(path.join(OUT, `icon${size}.png`), draw(size));
  console.log(`wrote icons/icon${size}.png`);
}
