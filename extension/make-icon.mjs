// Generates extension/media/icon.png — the Marketplace icon, which must be a PNG (that
// field will not take an SVG, unlike the activity-bar icon beside it).
//
// Written by hand rather than pulled from a package: node has zlib, a PNG is a CRC'd
// header plus one deflate stream, and this repo has no runtime dependencies anywhere
// else either. Run: node extension/make-icon.mjs
import { deflateSync } from "node:zlib";
import { writeFile, mkdir } from "node:fs/promises";

const SIZE = 128;
const SS = 4;                       // supersampling factor, for edges that aren't jagged
const BG = [13, 17, 23];            // --bg   #0d1117, the app's own background
const LAYERS = [                    // bottom to top, so the top one overlaps
  { cy: 88, fill: [29, 78, 216] },  // #1d4ed8
  { cy: 64, fill: [37, 99, 235] },  // #2563eb  --accent
  { cy: 40, fill: [88, 166, 255] }, // #58a6ff  --accent2
];
const RX = 40, RY = 15, RADIUS = 28;

const inRounded = (x, y, s, r) =>
  // Distance to the rounded-rect's inner box: only the corners need the circle test.
  Math.hypot(Math.max(r - x, 0, x - (s - r)), Math.max(r - y, 0, y - (s - r))) <= r;

const inEllipse = (x, y, cx, cy, rx, ry) =>
  ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

// --- rasterise, supersampled -------------------------------------------------
const px = new Uint8Array(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const fx = x + (sx + 0.5) / SS;
        const fy = y + (sy + 0.5) / SS;
        if (!inRounded(fx, fy, SIZE, RADIUS)) continue;   // outside the badge: transparent
        let c = BG;
        for (const l of LAYERS) if (inEllipse(fx, fy, SIZE / 2, l.cy, RX, RY)) c = l.fill;
        r += c[0]; g += c[1]; b += c[2]; a += 255;
      }
    }
    const n = SS * SS, i = (y * SIZE + x) * 4;
    // Un-premultiply: the colour is the average over COVERED samples, alpha is the coverage.
    const cov = a / 255;
    px[i] = cov ? Math.round(r / cov) : 0;
    px[i + 1] = cov ? Math.round(g / cov) : 0;
    px[i + 2] = cov ? Math.round(b / cov) : 0;
    px[i + 3] = Math.round(a / n);
  }
}

// --- encode ------------------------------------------------------------------
// Each scanline is prefixed with its filter type; 0 means "none", which costs a little
// size and saves implementing the filters.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return buf => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;    // 8 bits per channel
ihdr[9] = 6;    // truecolour with alpha
// 10..12: deflate, adaptive filtering, no interlace — all zero.

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = new URL("./media/", import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL("./icon.png", out), png);
console.log(`wrote extension/media/icon.png (${SIZE}x${SIZE}, ${png.length} bytes)`);
