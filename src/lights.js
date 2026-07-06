'use strict';

// Room lighting sync — the visualizer's beat energy + the track's colour,
// pushed to real lights on the LAN. Four ecosystems:
//   wled     — UDP 21324, DRGB realtime protocol (fastest, no token)
//   govee    — UDP 4003 LAN API (enable "LAN control" in the Govee app)
//   hue      — bridge REST (needs the bridge "username" token)
//   nanoleaf — REST :16021 (needs an auth token)
// UDP paths run at full frame rate; REST paths are self-throttled — Hue
// bridges brown out past ~5 req/s.
const dgram = require('dgram');
const http = require('http');

let udp = null;
const sock = () => (udp || (udp = dgram.createSocket('udp4')));

let lastRest = 0, restBusy = false;
let lastState = null;

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

// frame: { r, g, b, intensity 0..1 } — called ~10x/s by the renderer.
function frame(cfg, f) {
  if (!cfg || !cfg.host || !f) return;
  const r = Math.round(f.r || 0), g = Math.round(f.g || 0), b = Math.round(f.b || 0);
  const level = Math.max(0.06, Math.min(1, f.intensity || 0)); // never fully dark
  lastState = { r, g, b, level };
  try {
    if (cfg.protocol === 'wled') {
      // DRGB: [2, timeout, r,g,b × count] — all LEDs one beat-scaled colour.
      const n = Math.max(1, Math.min(1000, cfg.count || 120));
      const buf = Buffer.alloc(2 + n * 3);
      buf[0] = 2; buf[1] = 2; // protocol DRGB, 2s revert timeout
      for (let i = 0; i < n; i++) {
        buf[2 + i * 3] = Math.round(r * level);
        buf[3 + i * 3] = Math.round(g * level);
        buf[4 + i * 3] = Math.round(b * level);
      }
      sock().send(buf, 21324, cfg.host, () => {});
    } else if (cfg.protocol === 'govee') {
      const msg = Buffer.from(JSON.stringify({
        msg: { cmd: 'colorwc', data: { color: { r: Math.round(r * level), g: Math.round(g * level), b: Math.round(b * level) }, colorTemInKelvin: 0 } }
      }));
      sock().send(msg, 4003, cfg.host, () => {});
    } else {
      // REST ecosystems: at most ~4 updates/s, skip when one is in flight.
      const now = Date.now();
      if (restBusy || now - lastRest < 250) return;
      restBusy = true; lastRest = now;
      const done = () => { restBusy = false; };
      if (cfg.protocol === 'hue' && cfg.token) {
        put(cfg.host, '/api/' + cfg.token + '/groups/0/action', {
          on: true, bri: Math.round(level * 254), xy: rgbToXY(r, g, b), transitiontime: 1
        }).then(done, done);
      } else if (cfg.protocol === 'nanoleaf' && cfg.token) {
        const hs = rgbToHS(r, g, b);
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
  frame(cfg, { r: 255, g: 255, b: 255, intensity: 1 });
  await new Promise((res) => setTimeout(res, 450));
  frame(cfg, { r: 139, g: 92, b: 255, intensity: 0.6 });
  return true;
}

module.exports = { frame, test };
