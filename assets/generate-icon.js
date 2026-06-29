'use strict';

// Generates assets/icon.png (1024×1024) — a deep-space app icon with a glowing
// planet and sparkles. Pure Node (zlib only), no native deps. Run: node assets/generate-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 1024;
const buf = Buffer.alloc(S * S * 4); // RGBA, starts fully transparent

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

function blend(x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
  const i = (y * S + x) * 4;
  const ba = buf[i + 3] / 255;
  const oa = a + ba * (1 - a);
  for (let k = 0; k < 3; k++) {
    buf[i + k] = Math.round((rgb[k] * a + buf[i + k] * ba * (1 - a)) / (oa || 1));
  }
  buf[i + 3] = Math.round(oa * 255);
}

// Rounded-rect superellipse mask (macOS-ish squircle)
function inIcon(x, y) {
  const m = 70; // margin
  const r = 230; // corner radius
  const nx = clamp(x - m, 0, S - 2 * m);
  const ny = clamp(y - m, 0, S - 2 * m);
  const w = S - 2 * m;
  const dx = Math.max(0, Math.abs(nx - w / 2) - (w / 2 - r));
  const dy = Math.max(0, Math.abs(ny - w / 2) - (w / 2 - r));
  const inside = x >= m && x <= S - m && y >= m && y <= S - m;
  const corner = Math.hypot(dx, dy) <= r;
  return inside && corner;
}

const TOP = hex('#2a1a63');
const BOT = hex('#05060f');
const ACCENT = hex('#8b5cff');
const PLANET_LIT = hex('#d9c9ff');
const PLANET_DARK = hex('#3d1f86');

// Background gradient + accent glow
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inIcon(x, y)) continue;
    const t = y / S;
    let c = mix(TOP, BOT, Math.pow(t, 0.9));
    // accent glow near upper area
    const gx = (x - S * 0.5) / S, gy = (y - S * 0.32) / S;
    const gd = Math.hypot(gx, gy);
    const glow = clamp(1 - gd / 0.55, 0, 1);
    c = mix(c, ACCENT, glow * 0.45);
    blend(x, y, c, 1);
  }
}

// Scattered stars
const stars = [];
let seed = 1337;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let i = 0; i < 90; i++) stars.push({ x: 120 + rand() * (S - 240), y: 120 + rand() * (S - 240), r: 0.6 + rand() * 1.8, a: 0.4 + rand() * 0.6 });
for (const s of stars) {
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const d = Math.hypot(dx, dy);
    const a = clamp(1 - d / (s.r + 1.2), 0, 1) * s.a;
    if (a > 0 && inIcon(s.x + dx | 0, s.y + dy | 0)) blend((s.x + dx) | 0, (s.y + dy) | 0, [255, 255, 255], a);
  }
}

// Planet
const PCX = 512, PCY = 588, PR = 232;
const light = [-0.5, -0.6];
const ll = Math.hypot(light[0], light[1]);
light[0] /= ll; light[1] /= ll;
for (let y = PCY - PR - 4; y <= PCY + PR + 4; y++) {
  for (let x = PCX - PR - 4; x <= PCX + PR + 4; x++) {
    if (!inIcon(x, y)) continue;
    const dx = (x - PCX) / PR, dy = (y - PCY) / PR;
    const d = Math.hypot(dx, dy);
    if (d <= 1) {
      const nx = dx, ny = dy;
      const shade = clamp(-(nx * light[0] + ny * light[1]) * 0.5 + 0.5, 0, 1);
      const c = mix(PLANET_DARK, PLANET_LIT, Math.pow(shade, 1.2));
      const edge = clamp((1 - d) / 0.06, 0, 1); // antialias edge
      blend(x, y, c, edge);
    } else if (d <= 1.14) {
      // outer rim glow
      const a = clamp((1.14 - d) / 0.14, 0, 1) * 0.6;
      blend(x, y, ACCENT, a);
    }
  }
}

// Sparkles (4-point stars)
function sparkle(cx, cy, len, thin, col, alpha) {
  for (let y = cy - len; y <= cy + len; y++) {
    for (let x = cx - len; x <= cx + len; x++) {
      const dx = x - cx, dy = y - cy;
      const n1 = clamp(1 - Math.abs(dx) / thin, 0, 1) * clamp(1 - Math.abs(dy) / len, 0, 1);
      const n2 = clamp(1 - Math.abs(dy) / thin, 0, 1) * clamp(1 - Math.abs(dx) / len, 0, 1);
      const a = Math.max(n1, n2) * alpha;
      if (a > 0.02 && inIcon(x, y)) blend(x, y, col, a);
    }
  }
}
sparkle(720, 360, 120, 10, [255, 255, 255], 0.95);
sparkle(360, 300, 70, 7, [231, 219, 255], 0.85);
sparkle(640, 720, 50, 5, [231, 219, 255], 0.7);

// --- PNG encode ---
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);
const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
