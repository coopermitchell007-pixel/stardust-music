'use strict';

// Room lighting sync — the visualizer's beat energy + the track's colour,
// pushed to real lights on the LAN. Four ecosystems:
//   wled     — UDP 21324, DRGB realtime protocol (fastest, no token)
//   govee    — UDP 4003 LAN API (enable "LAN control" in the Govee app);
//              segmented devices (Hexa panels / DreamView strips) get true
//              per-panel colour through the razer streaming protocol
//   hue      — bridge REST (needs the bridge "username" token)
//   nanoleaf — REST :16021 (needs an auth token)
// UDP paths run at full frame rate; REST paths are self-throttled — Hue
// bridges brown out past ~5 req/s.
//
// The renderer sends whole FRAMES: { colors: [[r,g,b]×N], intensity } —
// N spectrum-mapped colours the driver spreads across whatever segments the
// device has (single-zone devices just get colors[0]).
const dgram = require('dgram');
const http = require('http');

let udp = null;
const sock = () => (udp || (udp = dgram.createSocket('udp4')));

let lastRest = 0, restBusy = false;
let razerOn = false, razerAt = 0;

function put(host, pathName, body, port) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: host, port: port || 80, path: pathName, method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 1500
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(); });
    req.write(data); req.end();
  });
}

// RGB → CIE xy (Hue speaks colour space, not RGB).
function rgbToXY(r, g, b) {
  const f = (c) => { c /= 255; return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92; };
  const R = f(r), G = f(g), B = f(b);
  const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
  const sum = X + Y + Z;
  return sum > 0 ? [X / sum, Y / sum] : [0.33, 0.33];
}

function rgbToHS(r, g, b) {
  const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
  const d = mx - mn;
  let hCol = 0;
  if (d > 0) {
    if (mx === r / 255) hCol = ((g - b) / 255 / d) % 6;
    else if (mx === g / 255) hCol = (b - r) / 255 / d + 2;
    else hCol = (r - g) / 255 / d + 4;
  }
  return { h: Math.round(((hCol * 60) + 360) % 360), s: Math.round(mx ? (d / mx) * 100 : 0) };
}

const scale = (c, k) => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];

// ---- Govee razer (DreamView) streaming: per-segment colours ------------------
// Community-documented LAN protocol: cmd "razer" with base64 packets.
//   enable:  bb 00 01 b1 01  + xor-checksum
//   colours: bb 00 <len> b0 01 <n> [r g b]×n + xor-checksum
// Segmented devices (Hexa panels, DreamView strips) render each triplet on a
// segment; if the device rejects razer we fall back to whole-device colorwc.
function goveePacket(bytes) {
  let x = 0;
  for (const b of bytes) x ^= b;
  return Buffer.from([...bytes, x]).toString('base64');
}
function goveeRazer(host, colors) {
  const now = Date.now();
  if (!razerOn || now - razerAt > 4000) {
    // (Re)assert streaming mode — it times out quietly on the device.
    const on = { msg: { cmd: 'razer', data: { pt: goveePacket([0xbb, 0x00, 0x01, 0xb1, 0x01]) } } };
    sock().send(Buffer.from(JSON.stringify(on)), 4003, host, () => {});
    razerOn = true; razerAt = now;
  }
  const n = Math.min(colors.length, 30);
  const bytes = [0xbb, 0x00, 2 + 3 * n, 0xb0, 0x01, n];
  for (let i = 0; i < n; i++) bytes.push(colors[i][0], colors[i][1], colors[i][2]);
  const msg = { msg: { cmd: 'razer', data: { pt: goveePacket(bytes) } } };
  sock().send(Buffer.from(JSON.stringify(msg)), 4003, host, () => {});
}
function goveeSolid(host, c) {
  const msg = Buffer.from(JSON.stringify({
    msg: { cmd: 'colorwc', data: { color: { r: c[0], g: c[1], b: c[2] }, colorTemInKelvin: 0 } }
  }));
  sock().send(msg, 4003, host, () => {});
}

// frame: { colors: [[r,g,b]...], intensity: 0..1 } — ~10x/s from the renderer.
function frame(cfg, f) {
  if (!cfg || !cfg.host || !f) return;
  const colors = (f.colors && f.colors.length ? f.colors : [[139, 92, 255]])
    .map((c) => [c[0] | 0, c[1] | 0, c[2] | 0]);
  const level = Math.max(0.05, Math.min(1, f.intensity || 0)); // never fully dark
  const main = scale(colors[0], level);
  try {
    if (cfg.protocol === 'wled') {
      // DRGB — spread the colour bands across the strip.
      const n = Math.max(1, Math.min(1000, cfg.count || 120));
      const buf = Buffer.alloc(2 + n * 3);
      buf[0] = 2; buf[1] = 2;
      for (let i = 0; i < n; i++) {
        const c = scale(colors[Math.floor(i / n * colors.length)] || colors[0], level);
        buf[2 + i * 3] = c[0]; buf[3 + i * 3] = c[1]; buf[4 + i * 3] = c[2];
      }
      sock().send(buf, 21324, cfg.host, () => {});
    } else if (cfg.protocol === 'govee') {
      if (cfg.segments) goveeRazer(cfg.host, colors.map((c) => scale(c, level)));
      else goveeSolid(cfg.host, main);
    } else {
      const now = Date.now();
      if (restBusy || now - lastRest < 250) return;
      restBusy = true; lastRest = now;
      const done = () => { restBusy = false; };
      if (cfg.protocol === 'hue' && cfg.token) {
        put(cfg.host, '/api/' + cfg.token + '/groups/0/action', {
          on: true, bri: Math.round(level * 254), xy: rgbToXY(colors[0][0], colors[0][1], colors[0][2]), transitiontime: 1
        }).then(done, done);
      } else if (cfg.protocol === 'nanoleaf' && cfg.token) {
        const hs = rgbToHS(colors[0][0], colors[0][1], colors[0][2]);
        put(cfg.host, '/api/v1/' + cfg.token + '/state', {
          on: { value: true },
          brightness: { value: Math.round(level * 100), duration: 0 },
          hue: { value: hs.h }, sat: { value: hs.s }
        }, 16021).then(done, done);
      } else { restBusy = false; }
    }
  } catch {}
}

// One bright pulse so the user can confirm the config reaches the device.
async function test(cfg) {
  if (!cfg || !cfg.host) return false;
  frame(cfg, { colors: [[255, 255, 255]], intensity: 1 });
  await new Promise((res) => setTimeout(res, 450));
  frame(cfg, { colors: [[139, 92, 255], [255, 80, 180], [80, 200, 255]], intensity: 0.7 });
  return true;
}

module.exports = { frame, test };
