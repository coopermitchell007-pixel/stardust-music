'use strict';

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

console.log('Stardust preload loaded at', location.href);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let settings = null;
let themeList = [];
let activeTheme = null; // full theme object incl. starfield/visualizer config
let discordAvailable = false;
let installed = { theme: [], font: [], animation: [], feature: [], audio: [] };
let extras = { font: [], animation: [], feature: [], audio: [] }; // payloads of installed extras
let panelEl = null;
let marketState = { items: [], filter: 'all', search: '' };

// Lazily create/cache our injected <style> sheets. Must be lazy: the preload
// runs before the DOM exists, so document.head is null at module load time.
const _sheets = {};
function sheet(id) {
  if (_sheets[id] && _sheets[id].isConnected) return _sheets[id];
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    (document.head || document.documentElement || document.body).appendChild(el);
  }
  _sheets[id] = el;
  return el;
}

// ---------------------------------------------------------------------------
// Starfield — animated parallax stars + occasional shooting stars.
// ---------------------------------------------------------------------------
const Starfield = (() => {
  let canvas, ctx, stars = [], shooting = [], raf = null, cfg = null, enabled = true, w = 0, h = 0;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'stardust-starfield';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  }

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function seed() {
    const count = Math.round((cfg.count || 180) * (settings.starfieldDensity || 1));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      z: Math.random() * 0.8 + 0.2, // depth -> parallax + size
      tw: Math.random() * Math.PI * 2
    }));
  }

  function configure(starCfg) {
    ensureCanvas();
    cfg = starCfg || { count: 180, color: '#cdbcff', speed: 0.25, size: 1.6, twinkle: true, shootingStars: true };
    enabled = settings.starfieldEnabled && cfg.enabled !== false;
    resize();
    seed();
    canvas.style.display = enabled ? 'block' : 'none';
    enabled ? start() : stop();
  }

  function maybeShoot() {
    if (!cfg.shootingStars) return;
    // Rare + short so they read as the occasional shooting star, not stray lines.
    if (Math.random() < 0.0012) {
      shooting.push({ x: Math.random() * w, y: Math.random() * h * 0.4, len: 0, vx: 4 + Math.random() * 4, vy: 1.5 + Math.random() * 2, life: 1 });
    }
  }

  function frame() {
    if (!enabled) return;
    ctx.clearRect(0, 0, w, h);
    const color = cfg.color || '#cdbcff';
    const base = cfg.size || 1.6;
    const speed = cfg.speed || 0.25;
    for (const s of stars) {
      s.y += speed * s.z;
      if (s.y > h) { s.y = 0; s.x = Math.random() * w; }
      s.tw += 0.02;
      const alpha = cfg.twinkle ? 0.4 + 0.6 * Math.abs(Math.sin(s.tw)) : 0.85;
      ctx.globalAlpha = alpha * s.z;
      ctx.fillStyle = color;
      const r = base * s.z;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // shooting stars
    maybeShoot();
    ctx.globalAlpha = 1;
    for (let i = shooting.length - 1; i >= 0; i--) {
      const sh = shooting[i];
      sh.x += sh.vx; sh.y += sh.vy; sh.life -= 0.03;
      const grad = ctx.createLinearGradient(sh.x, sh.y, sh.x - sh.vx * 3.5, sh.y - sh.vy * 3.5);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'transparent');
      ctx.strokeStyle = grad;
      ctx.globalAlpha = Math.max(0, sh.life) * 0.7;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sh.x, sh.y);
      ctx.lineTo(sh.x - sh.vx * 3.5, sh.y - sh.vy * 3.5);
      ctx.stroke();
      if (sh.life <= 0 || sh.x > w || sh.y > h) shooting.splice(i, 1);
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }

  function start() { if (enabled && !raf) raf = requestAnimationFrame(frame); }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } if (ctx) ctx.clearRect(0, 0, w, h); }

  return { configure };
})();

// ---------------------------------------------------------------------------
// Black hole — a real animated event horizon for the "Event Horizon" theme:
// a perfectly round dark core, a glowing accretion halo + photon ring, and
// stars/objects spiralling inward and getting swallowed.
// ---------------------------------------------------------------------------
function hexA(hex, a) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '#ff8c42');
  if (!m) return `rgba(255,140,66,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}
const BlackHole = (() => {
  let canvas, ctx, raf = null, cfg = {}, enabled = false, w = 0, h = 0, t = 0, parts = [];
  const SHAPES = ['planet', 'spark', 'shard', 'ring'];

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'stardust-blackhole';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : (enabled && start())));
  }
  function resize() {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const CX = () => w * 0.5, CY = () => h * 0.42, R = () => Math.max(52, Math.min(w, h) * 0.10);

  function spawn(outer) {
    const r = R();
    const isObj = Math.random() < 0.09;
    return {
      ang: Math.random() * Math.PI * 2,
      rad: r * (outer ? 7 + Math.random() * 4 : 1.4 + Math.random() * 9),
      spin: 0.5 + Math.random() * 0.7,
      vin: 0.7 + Math.random() * 1.3,
      size: isObj ? 5 + Math.random() * 6 : 1 + Math.random() * 1.8,
      rot: Math.random() * Math.PI,
      shape: isObj ? SHAPES[Math.floor(Math.random() * SHAPES.length)] : null
    };
  }

  function drawShape(p, x, y, color, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(p.rot + t * 2);
    ctx.globalAlpha = alpha;
    const s = p.size;
    if (p.shape === 'planet') {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = hexA('#ffffff', 0.7 * alpha); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(0, 0, s * 1.7, s * 0.55, 0.5, 0, Math.PI * 2); ctx.stroke();
    } else if (p.shape === 'spark') {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4;
      for (let i = 0; i < 4; i++) { ctx.rotate(Math.PI / 2); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -s * 1.6); ctx.stroke(); }
    } else if (p.shape === 'shard') {
      ctx.fillStyle = color; ctx.beginPath();
      ctx.moveTo(0, -s); ctx.lineTo(s * 0.7, 0); ctx.lineTo(0, s); ctx.lineTo(-s * 0.7, 0); ctx.closePath(); ctx.fill();
    } else { // ring
      ctx.strokeStyle = color; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  function seed() { parts = Array.from({ length: 190 }, () => spawn(false)); }

  function configure(bhCfg) {
    ensureCanvas();
    enabled = !!bhCfg && bhCfg.enabled !== false;
    cfg = bhCfg || {};
    resize();
    if (enabled) { seed(); canvas.style.display = 'block'; start(); }
    else { canvas.style.display = 'none'; stop(); }
  }

  function frame() {
    if (!enabled) return;
    t += 0.01;
    const cx = CX(), cy = CY(), r = R(), color = cfg.color || '#ff8c42';
    ctx.clearRect(0, 0, w, h);

    // accretion halo
    const g = ctx.createRadialGradient(cx, cy, r * 0.7, cx, cy, r * 5);
    g.addColorStop(0, hexA(color, 0.0));
    g.addColorStop(0.12, hexA(color, 0.55));
    g.addColorStop(0.32, hexA(color, 0.16));
    g.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // swirling accretion arcs
    for (let k = 0; k < 3; k++) {
      const rr = r * (1.5 + k * 0.55);
      ctx.beginPath();
      ctx.arc(cx, cy, rr, t * (1.2 - k * 0.25), t * (1.2 - k * 0.25) + Math.PI * 1.4);
      ctx.strokeStyle = hexA(color, 0.32 - k * 0.08);
      ctx.lineWidth = r * (0.5 - k * 0.12);
      ctx.stroke();
    }

    // particles + objects spiralling inward
    for (const p of parts) {
      p.ang += p.spin * 0.02 * (1 + r / Math.max(p.rad, r));
      p.rad -= p.vin * (0.5 + (r * 1.5) / Math.max(p.rad, 1));
      if (p.rad <= r * 0.96) Object.assign(p, spawn(true));
      const x = cx + Math.cos(p.ang) * p.rad, y = cy + Math.sin(p.ang) * p.rad;
      const fade = Math.min(1, (p.rad - r) / (r * 2.5));
      if (p.shape) {
        drawShape(p, x, y, cfg.color || '#ff8c42', fade);
      } else {
        // streak toward the hole for a "being pulled in" feel
        const tx = cx + Math.cos(p.ang - p.spin * 0.06) * (p.rad + p.vin * 6);
        const ty = cy + Math.sin(p.ang - p.spin * 0.06) * (p.rad + p.vin * 6);
        ctx.strokeStyle = hexA(color, 0.35 + 0.5 * fade);
        ctx.lineWidth = p.size;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, ty); ctx.stroke();
      }
    }

    // event horizon — perfectly round black core
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#000'; ctx.fill();
    // photon ring
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.04, 0, Math.PI * 2);
    ctx.lineWidth = 2.5; ctx.strokeStyle = hexA(color, 0.95);
    ctx.shadowBlur = 34; ctx.shadowColor = color; ctx.stroke(); ctx.shadowBlur = 0;

    raf = requestAnimationFrame(frame);
  }
  function start() { if (enabled && !raf) raf = requestAnimationFrame(frame); }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } if (ctx) ctx.clearRect(0, 0, w, h); }

  return { configure };
})();

// ---------------------------------------------------------------------------
// Background — rendered on a single canvas texture instead of a CSS gradient.
// A CSS gradient across the full page is rasterised in tiles by Chromium, and
// the tile seams show as faint horizontal "lines between sections". One canvas
// image composites as a single layer (no tile seams), and we bake in ±1 dither
// to kill 8-bit banding without any visible grain.
// ---------------------------------------------------------------------------
// Derive a canvas bg config ({base, blooms}) from a CSS `background` string so
// that themes which only ship a CSS gradient (old marketplace installs, future
// community themes) still render on the seam-free canvas instead of falling
// back to a tile-rasterized CSS gradient.
function cssToBg(background) {
  if (!background || typeof background !== 'string') return null;
  const blooms = [];
  // Each radial-gradient(...): capture "at X% Y%" and the first color hex.
  const rg = /radial-gradient\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi;
  let m;
  while ((m = rg.exec(background))) {
    const body = m[1];
    const pos = /at\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%/i.exec(body);
    const size = /(-?\d+(?:\.\d+)?)px/.exec(body);
    const color = /#([0-9a-f]{3,8})\b/i.exec(body);
    if (!color) continue;
    const x = pos ? parseFloat(pos[1]) / 100 : 0.5;
    const y = pos ? parseFloat(pos[2]) / 100 : 0.1;
    // Map the gradient's px radius onto a fraction of the larger viewport edge
    // (~1440px reference); clamp so it always covers a meaningful area.
    const r = size ? Math.min(1.1, Math.max(0.5, parseFloat(size[1]) / 1440)) : 0.85;
    blooms.push({ x, y, r, color: '#' + color[1], alpha: 0.55 });
  }
  // Base = the trailing solid color after the last gradient (", #rrggbb").
  const solids = background.match(/#([0-9a-f]{6})\b(?![^(]*\))/gi) || [];
  const base = solids.length ? solids[solids.length - 1] : '#05060f';
  return { base, blooms };
}

const BackgroundFX = (() => {
  let canvas, ctx, cfg = null;
  function ensure() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'stardust-bg';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    window.addEventListener('resize', draw);
  }
  function configure(bg) {
    cfg = bg || null;
    if (!cfg) { if (canvas) canvas.style.display = 'none'; return; }
    ensure(); canvas.style.display = 'block'; draw();
  }
  function draw() {
    if (!cfg) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = cfg.base || '#05060f';
    ctx.fillRect(0, 0, w, h);
    for (const b of (cfg.blooms || [])) {
      const cx = b.x * w, cy = b.y * h, r = Math.max(w, h) * (b.r || 0.6);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, hexA(b.color, b.alpha != null ? b.alpha : 0.5));
      g.addColorStop(1, hexA(b.color, 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
    dither(w * dpr, h * dpr);
  }
  function dither(pw, ph) {
    // ±1-level per-pixel noise — dithers the gradient so it can't band, but is
    // far below the threshold of visible grain.
    try {
      const img = ctx.getImageData(0, 0, pw, ph), d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const n = (Math.random() * 2 - 1) * 1.3;
        d[i] += n; d[i + 1] += n; d[i + 2] += n;
      }
      ctx.putImageData(img, 0, 0);
    } catch {}
  }
  return { configure };
})();

// ---------------------------------------------------------------------------
// Visualizer — real spectrum bars driven by the actual audio.
// YTM plays via MediaSource (blob: URLs are same-origin), so we *can* tap the
// page's media element with a Web Audio AnalyserNode: route
// mediaElement -> analyser -> destination and read getByteFrequencyData.
// If that ever yields silence (a tainted/cross-origin element), we fall back
// to a smooth simulation so the bars still move with play/pause.
// ---------------------------------------------------------------------------
const Visualizer = (() => {
  let canvas, ctx, raf = null, cfg = null, enabled = true, w = 0, h = 0;
  const BARS = 72;
  let levels = new Array(BARS).fill(0);
  let targets = new Array(BARS).fill(0);
  let playing = false;
  let phase = 0;

  // Web Audio + effects chain:
  //   source -> bass -> treble -> volume -> panner -> analyser -> destination
  //                                          panner -> reverb -> wet -> analyser
  let audioCtx = null, analyser = null, freq = null, attachedEl = null;
  let bass = null, treble = null, volume = null, panner = null, reverb = null, wet = null, lfo = null;
  let useReal = false;       // true once we get non-zero spectrum data
  let zeroFrames = 0;        // consecutive silent frames while playing -> tainted

  function makeImpulse(seconds, decay) {
    const rate = audioCtx.sampleRate, len = rate * seconds;
    const buf = audioCtx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'stardust-visualizer';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    window.addEventListener('resize', resize);
  }

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = 150;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    // Dock just above the real player bar, whatever its height is, so the
    // now-playing thumbnail/controls never sit on top of the bars.
    const bar = document.querySelector('ytmusic-player-bar');
    const barH = bar ? Math.round(bar.getBoundingClientRect().height) : 72;
    canvas.style.bottom = barH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Attempt to wire the analyser to the page's <video>/<audio>. Safe to call
  // repeatedly; only creates one MediaElementSource per element.
  function attachAudio() {
    const el = document.querySelector('video') || document.querySelector('audio');
    if (!el || el === attachedEl) return;
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AC();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.8;
        freq = new Uint8Array(analyser.frequencyBinCount);
        bass = audioCtx.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 220; bass.gain.value = 0;
        treble = audioCtx.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 3200; treble.gain.value = 0;
        volume = audioCtx.createGain(); volume.gain.value = 1;
        panner = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;
        reverb = audioCtx.createConvolver(); reverb.buffer = makeImpulse(2.4, 3.0);
        wet = audioCtx.createGain(); wet.gain.value = 0;
      }
      const src = audioCtx.createMediaElementSource(el);
      // dry chain
      src.connect(bass); bass.connect(treble); treble.connect(volume);
      const tail = panner || volume;
      if (panner) volume.connect(panner);
      tail.connect(analyser);
      // wet (reverb) send in parallel
      tail.connect(reverb); reverb.connect(wet); wet.connect(analyser);
      analyser.connect(audioCtx.destination); // keep audio audible
      attachedEl = el;
      zeroFrames = 0;
    } catch (e) {
      // createMediaElementSource throws if the element was already tapped by
      // someone else; in that case real sampling isn't available here.
      console.log('[Stardust] visualizer audio tap unavailable:', e.message);
    }
  }

  function resumeAudio() {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }

  function configure(visCfg) {
    ensureCanvas();
    cfg = visCfg || { color: '#8b5cff', style: 'bars' };
    enabled = settings.visualizerEnabled && cfg.enabled !== false;
    resize();
    canvas.style.display = enabled ? 'block' : 'none';
    if (enabled) { attachAudio(); start(); } else stop();
  }

  function setPlaying(p) {
    playing = p;
    if (p) { attachAudio(); resumeAudio(); }
  }

  // --- real spectrum: map FFT bins onto BARS with a perceptual (log) curve ---
  function realTargets() {
    analyser.getByteFrequencyData(freq);
    const bins = analyser.frequencyBinCount;
    let sum = 0;
    for (let i = 0; i < BARS; i++) {
      // log-spaced bin window so low/mid frequencies (where music lives) spread
      // across more bars and highs compress toward the edge.
      const f0 = Math.pow(i / BARS, 2.0);
      const f1 = Math.pow((i + 1) / BARS, 2.0);
      let lo = Math.floor(f0 * bins);
      let hi = Math.max(lo + 1, Math.floor(f1 * bins));
      let max = 0;
      for (let j = lo; j < hi && j < bins; j++) if (freq[j] > max) max = freq[j];
      const v = max / 255;
      sum += v;
      targets[i] = Math.min(1, Math.pow(v, 1.4) * 1.25);
    }
    return sum;
  }

  function simTargets() {
    for (let i = 0; i < BARS; i++) {
      const center = 1 - Math.abs(i - BARS / 2) / (BARS / 2);
      const base = playing ? 0.25 + 0.75 * center : 0.04;
      const wobble = playing ? (Math.sin(phase + i * 0.5) * 0.3 + Math.random() * 0.4) : 0;
      targets[i] = playing ? Math.max(0.04, Math.min(1, base * (0.6 + wobble))) : 0;
    }
  }

  let lastSimAt = 0;
  function frame(ts) {
    if (!enabled) return;

    if (analyser) {
      const sum = realTargets();
      if (playing && sum < 0.02) {
        if (++zeroFrames > 90) useReal = false; // ~1.5s of silence -> tainted
      } else if (sum >= 0.02) {
        zeroFrames = 0; useReal = true;
      }
    }
    if (!useReal) {
      if (ts - lastSimAt > 90) { phase += 0.35; simTargets(); lastSimAt = ts; }
      if (!playing) for (let i = 0; i < BARS; i++) targets[i] = 0;
    }

    ctx.clearRect(0, 0, w, h);
    const accent = settings.accentOverride || cfg.color || '#8b5cff';
    const gap = 2;
    const bw = (w / BARS) - gap;
    for (let i = 0; i < BARS; i++) {
      levels[i] += (targets[i] - levels[i]) * (useReal ? 0.35 : 0.18);
      const bh = levels[i] * (h - 20);
      if (bh < 2) continue;
      const x = i * (bw + gap);
      const y = h - bh;
      const grad = ctx.createLinearGradient(0, y, 0, h);
      grad.addColorStop(0, accent);
      grad.addColorStop(0.6, accent);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      // rounded-ish caps for a softer look
      ctx.fillRect(x, y, bw, bh);
    }
    raf = requestAnimationFrame(frame);
  }

  function start() { if (enabled && !raf) raf = requestAnimationFrame(frame); }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } if (ctx) ctx.clearRect(0, 0, w, h); }

  // --- audio effects (used by the Audio marketplace category) --------------
  function ensureAudio() { attachAudio(); resumeAudio(); }
  const fx = {
    bass: (on) => { ensureAudio(); if (bass) bass.gain.value = on ? 11 : 0; },
    treble: (on) => { ensureAudio(); if (treble) treble.gain.value = on ? 8 : 0; },
    volume: (on) => { ensureAudio(); if (volume) volume.gain.value = on ? 1.85 : 1; },
    spatial: (on) => {
      ensureAudio();
      if (!panner) return;
      if (on && !lfo) {
        lfo = audioCtx.createOscillator(); const d = audioCtx.createGain();
        lfo.frequency.value = 0.14; d.gain.value = 1;
        lfo.connect(d); d.connect(panner.pan); lfo.start();
      } else if (!on && lfo) {
        try { lfo.stop(); lfo.disconnect(); } catch {}
        lfo = null; panner.pan.value = 0;
      }
    },
    reverb: (on) => { ensureAudio(); if (wet) wet.gain.value = on ? 0.32 : 0; }
  };

  return { configure, setPlaying, resumeAudio, fx };
})();

// A user gesture is required before an AudioContext can produce sound/data.
window.addEventListener('pointerdown', () => Visualizer.resumeAudio(), { capture: true });

// ---------------------------------------------------------------------------
// Theme application
// ---------------------------------------------------------------------------
async function applyTheme(id) {
  const theme = await ipcRenderer.invoke('stardust:get-theme', id);
  if (!theme) return;
  activeTheme = theme;
  applyVars();
  sheet('stardust-theme').textContent = theme.css || '';
  BackgroundFX.configure(theme.bg || cssToBg(theme.background));
  Starfield.configure(theme.starfield);
  Visualizer.configure(theme.visualizer);
  BlackHole.configure(theme.blackhole);
}

function applyVars() {
  if (!activeTheme) return;
  const accent = settings.accentOverride || activeTheme.accent;
  const blur = settings.glassBlur != null ? settings.glassBlur : (activeTheme.glass && activeTheme.glass.blur) || 16;
  const glassOpacity = (activeTheme.glass && activeTheme.glass.opacity) != null ? activeTheme.glass.opacity : 0.5;
  sheet('stardust-vars').textContent = `:root {
  --stardust-accent: ${accent};
  --stardust-bg: ${activeTheme.background || 'radial-gradient(circle at 50% 0%, #1b1340, #05060f 70%)'};
  --stardust-glass-blur: ${settings.glassEnabled ? blur : 0}px;
  --stardust-glass-opacity: ${settings.glassEnabled ? glassOpacity : 0.92};
}`;
}

// ---------------------------------------------------------------------------
// Marketplace extras — inject the user's enabled font / animations / features.
// ---------------------------------------------------------------------------
function applyExtras() {
  // Font (single active)
  const font = (extras.font || []).find((f) => f.id === settings.activeFont);
  sheet('stardust-font').textContent = font && font.font ? font.font.css : '';

  // Animations (multiple)
  const anims = (extras.animation || [])
    .filter((a) => (settings.enabledAnimations || []).includes(a.id))
    .map((a) => `/* ${a.id} */\n${a.css || ''}`)
    .join('\n');
  sheet('stardust-animations').textContent = anims;

  // Features (multiple) — CSS side
  const feats = (extras.feature || [])
    .filter((f) => (settings.enabledFeatures || []).includes(f.id))
    .map((f) => `/* ${f.id} */\n${f.css || ''}`)
    .join('\n');
  sheet('stardust-features').textContent = feats;

  // Behaviours (audio effects + smart features) — JS side
  const desired = new Set([
    ...(settings.enabledFeatures || []),
    ...(settings.enabledAudio || [])
  ].filter((id) => BEHAVIORS[id]));
  reconcileBehaviors(desired);
}

// ---------------------------------------------------------------------------
// Behaviours — built-in JS effects toggled by marketplace items (audio effects
// and "smart" features). Keyed by item id so the catalog never ships raw code.
// ---------------------------------------------------------------------------
const activeBehaviors = new Set();
function reconcileBehaviors(desired) {
  for (const id of desired) if (!activeBehaviors.has(id)) { try { BEHAVIORS[id].on(); } catch (e) { console.error('[Stardust]', id, e); } activeBehaviors.add(id); }
  for (const id of [...activeBehaviors]) if (!desired.has(id)) { try { BEHAVIORS[id].off(); } catch {} activeBehaviors.delete(id); }
}

// playback-rate effects (nightcore / slowed) — enforced on every poll since
// YTM resets the rate on track changes.
let rateMode = null;
function enforceRate() {
  const v = q('video'); if (!v) return;
  const target = rateMode === 'nightcore' ? 1.2 : rateMode === 'slowed' ? 0.85 : 1;
  try { v.preservesPitch = v.mozPreservesPitch = v.webkitPreservesPitch = (target === 1); } catch {}
  if (Math.abs((v.playbackRate || 1) - target) > 0.001) { try { v.playbackRate = target; } catch {} }
}

const BEHAVIORS = {
  'audio-bass-boost':   { on: () => Visualizer.fx.bass(true),    off: () => Visualizer.fx.bass(false) },
  'audio-treble-boost': { on: () => Visualizer.fx.treble(true),  off: () => Visualizer.fx.treble(false) },
  'audio-volume-boost': { on: () => Visualizer.fx.volume(true),  off: () => Visualizer.fx.volume(false) },
  'audio-8d':           { on: () => Visualizer.fx.spatial(true), off: () => Visualizer.fx.spatial(false) },
  'audio-nightcore':    { on: () => { rateMode = 'nightcore'; enforceRate(); }, off: () => { if (rateMode === 'nightcore') { rateMode = null; enforceRate(); } } },
  'audio-slowed':       { on: () => { rateMode = 'slowed'; Visualizer.fx.reverb(true); enforceRate(); }, off: () => { if (rateMode === 'slowed') rateMode = null; Visualizer.fx.reverb(false); enforceRate(); } },
  'feat-sleep-timer':   { on: () => SleepTimer.show(),  off: () => SleepTimer.hide() },
  'feat-scroll-top':    { on: () => ScrollTop.show(),   off: () => ScrollTop.hide() },
  'feat-ambient-glow':  { on: () => AmbientGlow.enable(), off: () => AmbientGlow.disable() },
  'feat-lyrics':        { on: () => Lyrics.enable(),    off: () => Lyrics.disable() }
};

// --- Sleep timer: floating pill with 15/30/60-min presets ------------------
const SleepTimer = (() => {
  let el = null, tick = null, endAt = 0;
  function show() {
    if (el) return;
    const label = h('span', { class: 'stardust-sleep-label', text: '💤 Sleep' });
    const chips = [15, 30, 60].map((m) => { const b = h('button', { class: 'stardust-chip', text: m + 'm' }); b.addEventListener('click', () => start(m)); return b; });
    const x = h('button', { class: 'stardust-chip cancel', text: '✕' }); x.addEventListener('click', cancel);
    el = h('div', { id: 'stardust-sleep' }, [label, ...chips, x]);
    document.body.appendChild(el);
  }
  function start(min) {
    cancel(); endAt = Date.now() + min * 60000; el.classList.add('armed'); paint();
    tick = setInterval(() => {
      const r = endAt - Date.now();
      if (r <= 0) { const v = q('video'); if (v && !v.paused) doCommand('playpause'); cancel(); }
      else paint();
    }, 1000);
  }
  function paint() {
    const l = el && el.querySelector('.stardust-sleep-label'); if (!l) return;
    if (!endAt) { l.textContent = '💤 Sleep'; return; }
    const ms = Math.max(0, endAt - Date.now()), m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    l.textContent = '💤 ' + m + ':' + String(s).padStart(2, '0');
  }
  function cancel() { if (tick) { clearInterval(tick); tick = null; } endAt = 0; if (el) el.classList.remove('armed'); paint(); }
  function hide() { cancel(); if (el) { el.remove(); el = null; } }
  return { show, hide };
})();

// --- Scroll-to-top button --------------------------------------------------
const ScrollTop = (() => {
  let el = null;
  function show() {
    if (el) return;
    el = h('button', { id: 'stardust-scrolltop', title: 'Scroll to top', text: '↑' });
    el.addEventListener('click', () => {
      const cands = [
        document.querySelector('ytmusic-app-layout'),
        document.querySelector('#layout.ytmusic-app-layout'),
        document.querySelector('#content.ytmusic-app-layout'),
        document.querySelector('ytmusic-tab-renderer[role="tabpanel"]'),
        document.scrollingElement
      ];
      for (const c of cands) { if (!c) continue; try { c.scrollTo ? c.scrollTo({ top: 0, behavior: 'smooth' }) : (c.scrollTop = 0); } catch {} }
    });
    document.body.appendChild(el);
  }
  function hide() { if (el) { el.remove(); el = null; } }
  return { show, hide };
})();

// --- Ambient glow: tint the backdrop with the album-art colour -------------
const AmbientGlow = (() => {
  let el = null, active = false, last = '';
  function enable() { active = true; if (!el) { el = h('div', { id: 'stardust-ambient' }); document.body.appendChild(el); } update(readNowPlaying()); }
  function disable() { active = false; last = ''; if (el) { el.remove(); el = null; } }
  function onTrack(np) { if (active && np && np.art && np.art !== last) { last = np.art; update(np); } }
  function update(np) {
    if (!active || !el || !np || !np.art) return;
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 16;
        const cx = c.getContext('2d'); cx.drawImage(img, 0, 0, 16, 16);
        const d = cx.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
        r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
        el.style.background = `radial-gradient(1300px 820px at 50% -5%, rgba(${r},${g},${b},0.55), transparent 62%)`;
      } catch {}
    };
    img.src = np.art;
  }
  return { enable, disable, onTrack };
})();

// --- Synced lyrics — integrated into YTM's own Lyrics tab ------------------
// Un-greys the Lyrics tab (so it works on videos too) and renders time-synced
// lyrics from LRCLIB directly inside the player page's lyrics tab content,
// styled to look native rather than a bulky floating panel.
const Lyrics = (() => {
  let active = false, synced = [], plain = null, key = '', poll = null, raf = null;
  let box = null, body = null, lastIdx = -1, attempts = 0, np = null;
  let mode = 'off', host = null;                     // 'searching' | 'ours' | 'off'
  let curEl = null, curSpans = null, curEnhanced = false;

  function enable() {
    active = true;
    np = readNowPlaying(); fetchFor(np);
    // A light 300ms poll keeps the tab un-greyed and injects when the Lyrics tab
    // is open. The per-word highlight runs on rAF for a smooth karaoke sweep.
    poll = setInterval(() => { sync(); }, 300);
    startRAF();
    sync();
  }
  function disable() {
    active = false;
    if (poll) { clearInterval(poll); poll = null; }
    stopRAF();
    clearHost(); synced = []; plain = null; key = ''; mode = 'off';
  }
  function startRAF() {
    if (raf) return;
    const loop = () => { raf = requestAnimationFrame(loop); paint(); };
    raf = requestAnimationFrame(loop);
  }
  function stopRAF() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

  const lyricsTab = () => [...document.querySelectorAll('ytmusic-player-page tp-yt-paper-tab')]
    .find((t) => /lyric/i.test(t.textContent || ''));
  const tabHost = () => document.querySelector('ytmusic-player-page #tab-renderer');
  const nativeLyrics = () => document.querySelector('ytmusic-player-page ytmusic-description-shelf-renderer');
  const tabSelected = () => { const t = lyricsTab(); return !!t && (t.getAttribute('aria-selected') === 'true' || t.hasAttribute('selected')); };

  // Keep the Lyrics tab clickable even when YTM disables it (videos, etc.).
  function ungray() {
    const t = lyricsTab(); if (!t) return;
    if (t.hasAttribute('disabled') || t.getAttribute('aria-disabled') === 'true') {
      t.removeAttribute('disabled'); t.setAttribute('aria-disabled', 'false');
      t.classList.remove('disabled'); t.style.pointerEvents = 'auto'; t.style.opacity = '';
    }
  }

  function ensureBox() {
    if (!box) { body = h('div', { class: 'stardust-lyric-lines' }); box = h('div', { id: 'stardust-lyrics' }, [body]); }
    return box;
  }
  function clearHost() { if (host) { host.classList.remove('stardust-lyrics-on'); host = null; } if (box && box.parentElement) box.remove(); }

  // State machine (runs on a light poll, only mutates the DOM on change):
  //  - show OUR lyrics whenever LRCLIB gave us something (or we're still
  //    searching this track) and the Lyrics tab is open;
  //  - otherwise get out of the way and let YTM's own tab render.
  // A single class on the tab host hides YTM's content and shows our box, so it
  // survives YTM re-rendering the tab without any per-tick thrash.
  function sync() {
    if (!active) return;
    ungray();
    const h0 = tabHost();
    // Take over ONLY when we have a confident match for this track. While
    // searching or when nothing was found, we stay out and leave YTM's own
    // lyrics tab untouched — so the view never flickers between the two.
    const want = h0 && tabSelected() && mode === 'ours' && (synced.length || plain);
    if (want) {
      if (host && host !== h0) host.classList.remove('stardust-lyrics-on');
      host = h0;
      host.classList.add('stardust-lyrics-on');
      ensureBox();
      if (box.parentElement !== host) host.appendChild(box);
      if (!body.firstChild) render();
    } else {
      clearHost();
    }
  }

  const toSec = (mm, ss) => parseInt(mm, 10) * 60 + parseFloat(ss);
  function parseLRC(text) {
    const out = [];
    for (const line of (text || '').split('\n')) {
      const m = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
      if (!m) continue;
      const t = toSec(m[1], m[2]);
      let rest = m[3];
      // Enhanced LRC (A2): inline <mm:ss.xx> word timestamps → true per-word timing.
      const wordTags = [...rest.matchAll(/<(\d+):(\d+(?:\.\d+)?)>\s*([^<]*)/g)];
      let words;
      if (wordTags.length) {
        words = wordTags
          .map((w) => ({ text: w[3].trim(), time: toSec(w[1], w[2]) }))
          .filter((w) => w.text)
          .map((w) => ({ ...w, len: Math.max(w.text.length, 1) }));
        rest = words.map((w) => w.text).join(' ');
      } else {
        rest = rest.replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
        words = rest ? rest.split(/\s+/).map((t2) => ({ text: t2, len: Math.max(t2.length, 1), time: null })) : [];
      }
      out.push({ t, s: rest.trim(), words });
    }
    return out;
  }
  function render(status) {
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    if (status) { body.appendChild(h('div', { class: 'stardust-lyric-status', text: status })); return; }
    if (synced.length) {
      for (const l of synced) {
        const line = h('div', { class: 'stardust-lyric-line' });
        // Only split into per-word spans when we have REAL word timing
        // (enhanced LRC). Otherwise keep it as one line and sweep it smoothly —
        // faking per-word timing from line timing looks stuttery.
        const enhanced = l.words && l.words.length && l.words[0].time != null;
        if (enhanced) {
          line.classList.add('words');
          l.words.forEach((w, i) => {
            line.appendChild(h('span', { class: 'w', text: w.text }));
            if (i < l.words.length - 1) line.appendChild(document.createTextNode(' '));
          });
        } else { line.textContent = l.s || '♪'; }
        body.appendChild(line);
      }
    } else if (plain) {
      for (const l of plain.split('\n')) body.appendChild(h('div', { class: 'stardust-lyric-line plain', text: l || ' ' }));
    } else {
      body.appendChild(h('div', { class: 'stardust-lyric-status', text: 'No lyrics found for this track' }));
    }
    lastIdx = -1;
  }
  // Reset any highlighting on a line (when it stops being active).
  function clearWords(lineEl) {
    if (!lineEl) return;
    lineEl.classList.remove('sweep');
    lineEl.style.removeProperty('--wp');
    for (const s of lineEl.querySelectorAll('.w')) {
      if (s.className !== 'w') s.className = 'w';
      if (s.style.getPropertyValue('--wp')) s.style.removeProperty('--wp');
    }
  }

  function fetchFor(track) {
    if (!track || !track.title) return;
    const k = track.title + '|' + track.artist; if (k === key) return;
    key = k; np = track; synced = []; plain = null; attempts = 0; lastIdx = -1;
    mode = 'searching'; curEl = null; curSpans = null;
    clearHost();          // stay out until we have a confident match
    doFetch();
  }
  async function doFetch() {
    attempts++;
    const forKey = key;
    let res = null;
    try { res = await ipcRenderer.invoke('stardust:lyrics', { artist: np.artist, title: np.title, album: np.album, duration: np.duration }); } catch {}
    if (!active || key !== forKey) return;   // track changed while awaiting
    if (res && res.syncedLyrics) { synced = parseLRC(res.syncedLyrics); plain = null; mode = 'ours'; }
    else if (res && res.plainLyrics) { synced = []; plain = res.plainLyrics; mode = 'ours'; }
    else if (attempts < 3) { setTimeout(() => { if (active && key === forKey) doFetch(); }, 1800); return; } // duration may not be ready yet
    else { synced = []; plain = null; mode = 'off'; }
    lastIdx = -1; curEl = null; curSpans = null;
    render(); sync();
  }

  function paint() {
    if (!active || !synced.length || !box || !box.isConnected || !body) return;
    const v = q('video'); if (!v) return;
    const t = v.currentTime || 0;
    const kids = body.children;

    // Which line is current?
    let idx = -1;
    for (let i = 0; i < synced.length; i++) { if (synced[i].t <= t + 0.15) idx = i; else break; }

    // Line changed: move .active, reset the old line, scroll, and cache the new
    // one so per-frame work stays cheap.
    if (idx !== lastIdx) {
      if (curEl) { curEl.classList.remove('active'); curEl.style.removeProperty('--wp'); clearWords(curEl); }
      lastIdx = idx;
      curEl = idx >= 0 ? kids[idx] : null;
      if (curEl) {
        curEl.classList.add('active');
        curEnhanced = curEl.classList.contains('words');
        curSpans = curEnhanced ? curEl.querySelectorAll('.w') : null;
        curEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    if (!curEl) return;

    const line = synced[idx];
    const lineEnd = synced[idx + 1] ? synced[idx + 1].t
      : (isFinite(v.duration) && v.duration > line.t ? v.duration : line.t + Math.max(3, (line.s.length || 8) * 0.09));

    if (curEnhanced && curSpans && curSpans.length) {
      // Enhanced LRC: real per-word timing → discrete word highlight.
      for (let i = 0; i < curSpans.length; i++) {
        const w = line.words[i]; if (!w) continue;
        const ws = w.time, we = (line.words[i + 1] && line.words[i + 1].time != null) ? line.words[i + 1].time : lineEnd;
        if (t >= we) setWord(curSpans[i], 'sung');
        else if (t >= ws) setWord(curSpans[i], 'cur', we > ws ? (t - ws) / (we - ws) : 1);
        else setWord(curSpans[i], '');
      }
    } else {
      // Line-level timing → smooth continuous fill across the whole line.
      const dur = Math.max(lineEnd - line.t, 0.001);
      const p = Math.min(1, Math.max(0, (t - line.t) / dur));
      curEl.classList.add('sweep');
      const pct = (p * 100).toFixed(1) + '%';
      if (curEl.style.getPropertyValue('--wp') !== pct) curEl.style.setProperty('--wp', pct);
    }
  }
  // Set a word's state without redundant DOM writes.
  function setWord(el, state, wp) {
    const cls = state ? 'w ' + state : 'w';
    if (el.className !== cls) el.className = cls;
    if (state === 'cur') {
      const pct = Math.round(Math.min(1, Math.max(0, wp)) * 100) + '%';
      if (el.style.getPropertyValue('--wp') !== pct) el.style.setProperty('--wp', pct);
    } else if (el.style.getPropertyValue('--wp')) {
      el.style.removeProperty('--wp');
    }
  }

  function onTrack(track) { if (active) fetchFor(track); }
  return { enable, disable, onTrack };
})();

// ---------------------------------------------------------------------------
// Now playing + media commands
// ---------------------------------------------------------------------------
function q(sel) { return document.querySelector(sel); }

function readNowPlaying() {
  const video = q('video');
  const bar = q('ytmusic-player-bar');
  if (!video || !bar) return null;
  const title = (bar.querySelector('.title')?.textContent || '').trim();
  const byline = (bar.querySelector('.byline')?.textContent || '').trim();
  const parts = byline.split('•').map((s) => s.trim());
  const img = bar.querySelector('img');
  return {
    title: title || 'YouTube Music',
    artist: parts[0] || '',
    album: parts[1] || '',
    art: img ? img.src : '',
    playing: !video.paused && !video.ended,
    position: Math.floor(video.currentTime || 0),
    duration: Math.floor(video.duration || 0),
    accent: (settings && settings.accentOverride) || (activeTheme && activeTheme.accent) || '#8b5cff'
  };
}

let lastSig = '';
function pollNowPlaying() {
  const np = readNowPlaying();
  if (!np) return;
  Visualizer.setPlaying(np.playing);
  // Drives play-state-gated animations (e.g. Vinyl Spin).
  document.body.classList.toggle('stardust-playing', np.playing);
  if (rateMode) enforceRate();

  const track = `${np.title}|${np.artist}`;
  if (track !== lastTrack) {
    lastTrack = track;
    AmbientGlow.onTrack(np);
    Lyrics.onTrack(np);
  }

  const sig = `${track}|${np.playing}|${np.position}`;
  if (sig !== lastSig) {
    lastSig = sig;
    ipcRenderer.send('stardust:nowplaying', np);
  }
}
let lastTrack = '';

function doCommand(action) {
  const click = (sel) => { const el = q(sel); if (el) { el.click(); return true; } return false; };
  switch (action) {
    case 'playpause':
      if (!click('ytmusic-player-bar #play-pause-button')) {
        const v = q('video'); if (v) v.paused ? v.play() : v.pause();
      }
      break;
    case 'next':
      click('ytmusic-player-bar .next-button');
      break;
    case 'previous':
      click('ytmusic-player-bar .previous-button');
      break;
  }
  setTimeout(pollNowPlaying, 250);
}

ipcRenderer.on('stardust:command', (_e, { action }) => doCommand(action));

// ---------------------------------------------------------------------------
// In-page ad skipper — complements the network-level blocker. Clicks skip
// buttons, fast-forwards any ad that still plays, and dismisses upsell popups.
// ---------------------------------------------------------------------------
function skipAds() {
  if (settings && settings.adBlock === false) return;
  // Click any visible "Skip ad" button.
  const skip = document.querySelector(
    '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, tp-yt-paper-button.skip'
  );
  if (skip) { try { skip.click(); } catch {} }

  // If an ad is actually playing, jump to the end and mute it.
  const adShowing = document.querySelector(
    '.ad-showing, .ytp-ad-player-overlay, .ytp-ad-module :not(:empty), ytmusic-player[player-ui-state_="AD"]'
  );
  const v = document.querySelector('video');
  if (v && adShowing) {
    try { if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration; v.muted = true; } catch {}
  }

  // Dismiss Premium / "get YouTube Music Premium" upsell dialogs.
  const dismiss = document.querySelector(
    'ytmusic-mealbar-promo-renderer #dismiss-button button, tp-yt-paper-dialog #dismiss-button, .ytmusic-popup-container #dismiss-button button'
  );
  if (dismiss) { try { dismiss.click(); } catch {} }
}

// ---------------------------------------------------------------------------
// Control panel UI
// ---------------------------------------------------------------------------
// Tiny DOM builder — YouTube Music enforces Trusted Types, which forbids
// innerHTML, so the whole UI is built with createElement instead.
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) el.appendChild(c);
  return el;
}

function section(children) { return h('div', { class: 'stardust-section' }, children); }
function label(text) { return h('div', { class: 'stardust-label', text }); }
function miniBtn(act, text) { return h('button', { class: 'stardust-mini-btn', dataset: { act }, text }); }

function toggleRow(text, setting, id) {
  const input = h('input', { type: 'checkbox', dataset: { setting } });
  if (id) input.id = id;
  return h('div', { class: 'stardust-toggle-row' }, [h('label', { text }), input]);
}
function sliderRow(text, setting, attrs) {
  const input = h('input', Object.assign({ type: 'range', dataset: { setting } }, attrs));
  return h('div', { class: 'stardust-slider-row' }, [h('label', { text }), input]);
}

function buildUI() {
  if (document.getElementById('stardust-launcher')) return;

  const launcher = h('button', { id: 'stardust-launcher', title: 'Stardust themes' }, [
    h('span', { class: 'stardust-orbit', text: '✦' })
  ]);
  document.body.appendChild(launcher);

  const discordIdWrap = h('div', { class: 'stardust-discord-id', id: 'stardust-discord-id-wrap' }, [
    h('input', { type: 'text', id: 'stardust-discord-id', placeholder: 'Discord application Client ID' })
  ]);

  const panel = h('div', { id: 'stardust-panel' }, [
    h('div', { class: 'stardust-head' }, [
      h('span', { class: 'stardust-logo', text: '✦ Stardust' }),
      h('button', { class: 'stardust-x', dataset: { act: 'close' }, text: '✕' })
    ]),
    section([
      label('Theme'),
      h('div', { id: 'stardust-themes', class: 'stardust-themes' }),
      h('button', { id: 'stardust-open-market', class: 'stardust-market-cta', dataset: { act: 'open-market' }, text: '✦  Browse the Marketplace' }),
      h('div', { class: 'stardust-row' }, [miniBtn('open-themes', 'Open themes folder'), miniBtn('reload-themes', 'Reload')])
    ]),
    section([
      label('Accent'),
      h('div', { class: 'stardust-row' }, [
        h('input', { type: 'color', id: 'stardust-accent' }),
        miniBtn('reset-accent', 'Use theme accent')
      ])
    ]),
    section([
      toggleRow('Starfield', 'starfieldEnabled'),
      sliderRow('Star density', 'starfieldDensity', { min: '0.2', max: '2', step: '0.1' }),
      toggleRow('Visualizer', 'visualizerEnabled'),
      toggleRow('Glassmorphism', 'glassEnabled'),
      sliderRow('Glass blur', 'glassBlur', { min: '0', max: '40', step: '1' })
    ]),
    section([
      toggleRow('Ad blocker', 'adBlock'),
      toggleRow('Mini player', 'miniPlayer'),
      toggleRow('Global hotkeys', 'globalHotkeys'),
      toggleRow('Discord presence', 'discordRichPresence', 'stardust-discord'),
      discordIdWrap
    ]),
    h('div', { class: 'stardust-foot', text: 'Drop themes into the folder above • restart-free' })
  ]);
  document.body.appendChild(panel);

  launcher.addEventListener('click', () => panel.classList.toggle('open'));

  panelEl = panel;
  wirePanel(panel);
}

function wirePanel(panel) {
  // Theme grid
  renderThemes(panel);

  // Accent
  const accentInput = panel.querySelector('#stardust-accent');
  accentInput.value = settings.accentOverride || (activeTheme && activeTheme.accent) || '#8b5cff';
  accentInput.addEventListener('input', async (e) => {
    settings = await setSetting('accentOverride', e.target.value);
    applyVars();
  });

  // Generic settings inputs
  panel.querySelectorAll('[data-setting]').forEach((input) => {
    const key = input.dataset.setting;
    if (input.type === 'checkbox') {
      input.checked = !!settings[key];
      input.addEventListener('change', () => onSetting(key, input.checked));
    } else if (input.type === 'range') {
      input.value = settings[key] != null ? settings[key] : input.value;
      input.addEventListener('input', () => onSetting(key, parseFloat(input.value)));
    }
  });

  // Discord client id
  const discordIdWrap = panel.querySelector('#stardust-discord-id-wrap');
  const discordId = panel.querySelector('#stardust-discord-id');
  discordId.value = settings.discordClientId || '';
  discordIdWrap.style.display = settings.discordRichPresence ? 'block' : 'none';
  if (!discordAvailable) {
    const dc = panel.querySelector('#stardust-discord');
    dc.disabled = true;
    dc.parentElement.title = 'Install the discord-rpc package to enable';
  }
  discordId.addEventListener('change', () => onSetting('discordClientId', discordId.value.trim()));

  // Buttons
  panel.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      if (act === 'close') panel.classList.remove('open');
      if (act === 'reset-accent') {
        settings = await setSetting('accentOverride', null);
        accentInput.value = (activeTheme && activeTheme.accent) || '#8b5cff';
        applyVars();
      }
      if (act === 'open-themes') ipcRenderer.invoke('stardust:open-themes-folder');
      if (act === 'reload-themes') {
        themeList = await ipcRenderer.invoke('stardust:reload-themes');
        renderThemes(panel);
      }
      if (act === 'open-market') openMarket();
    });
  });
}

async function onSetting(key, value) {
  settings = await setSetting(key, value);
  // Visual settings re-apply immediately.
  if (key === 'starfieldEnabled' || key === 'starfieldDensity') Starfield.configure(activeTheme.starfield);
  if (key === 'visualizerEnabled') Visualizer.configure(activeTheme.visualizer);
  if (key === 'glassEnabled' || key === 'glassBlur') applyVars();
  if (key === 'discordRichPresence') {
    document.getElementById('stardust-discord-id-wrap').style.display = value ? 'block' : 'none';
  }
}

function renderThemes(panel) {
  const wrap = panel.querySelector('#stardust-themes');
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  for (const t of themeList) {
    const b = document.createElement('button');
    b.className = 'stardust-theme-btn' + (activeTheme && t.id === activeTheme.id ? ' active' : '');
    b.style.setProperty('--swatch', t.accent);
    const preview = h('div', { class: 'stardust-preview' });
    if (t.background) preview.style.background = t.background;
    b.appendChild(preview);
    b.appendChild(h('span', { class: 'stardust-tname', text: t.name }));
    if (t.source === 'user') b.appendChild(h('span', { class: 'stardust-badge', text: 'user' }));
    b.addEventListener('click', async () => {
      await setSetting('activeTheme', t.id);
      await applyTheme(t.id);
      renderThemes(panel);
      const ai = panel.querySelector('#stardust-accent');
      if (!settings.accentOverride) ai.value = activeTheme.accent;
    });
    wrap.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Marketplace modal
// ---------------------------------------------------------------------------
const TYPE_LABEL = { theme: 'Theme', font: 'Font', animation: 'Animation', feature: 'Feature', audio: 'Audio' };
const TAB_LABEL = { all: 'All', theme: 'Themes', font: 'Fonts', animation: 'Animations', feature: 'Features', audio: 'Audio' };

function isInstalled(item) { return (installed[item.type] || []).includes(item.id); }
function isEnabled(item) {
  if (item.type === 'font') return settings.activeFont === item.id;
  if (item.type === 'animation') return (settings.enabledAnimations || []).includes(item.id);
  if (item.type === 'feature') return (settings.enabledFeatures || []).includes(item.id);
  if (item.type === 'audio') return (settings.enabledAudio || []).includes(item.id);
  if (item.type === 'theme') return activeTheme && activeTheme.id === item.id;
  return false;
}

async function openMarket() {
  let modal = document.getElementById('stardust-market');
  if (!modal) modal = buildMarketShell();
  modal.classList.add('open');
  const grid = modal.querySelector('#stardust-market-grid');
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  grid.appendChild(h('div', { class: 'stardust-market-loading', text: 'Loading marketplace…' }));
  try {
    const data = await ipcRenderer.invoke('stardust:marketplace-catalog');
    marketState.items = data.items || [];
    installed = data.installed || installed;
  } catch (e) {
    marketState.items = [];
  }
  renderMarketGrid();
}

function buildMarketShell() {
  const tabs = ['all', 'theme', 'audio', 'font', 'animation', 'feature'].map((t) =>
    h('button', { class: 'stardust-market-tab' + (t === 'all' ? ' active' : ''), dataset: { tab: t },
      text: TAB_LABEL[t] })
  );

  const search = h('input', { id: 'stardust-market-search', type: 'text', placeholder: 'Search themes, fonts, animations…' });

  const modal = h('div', { id: 'stardust-market' }, [
    h('div', { class: 'stardust-market-card-shell' }, [
      h('div', { class: 'stardust-market-head' }, [
        h('div', { class: 'stardust-market-title' }, [
          h('span', { class: 'stardust-logo', text: '✦ Marketplace' }),
          h('span', { class: 'stardust-market-sub', text: 'Themes · Fonts · Animations · Features' })
        ]),
        h('button', { class: 'stardust-x', dataset: { mact: 'close' }, text: '✕' })
      ]),
      h('div', { class: 'stardust-market-toolbar' }, [
        h('div', { class: 'stardust-market-tabs' }, tabs),
        search
      ]),
      h('div', { id: 'stardust-market-grid', class: 'stardust-market-grid' })
    ])
  ]);
  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });
  modal.querySelector('[data-mact="close"]').addEventListener('click', () => modal.classList.remove('open'));
  tabs.forEach((tb) => tb.addEventListener('click', () => {
    marketState.filter = tb.dataset.tab;
    modal.querySelectorAll('.stardust-market-tab').forEach((x) => x.classList.toggle('active', x === tb));
    renderMarketGrid();
  }));
  search.addEventListener('input', () => { marketState.search = search.value.toLowerCase(); renderMarketGrid(); });
  return modal;
}

function renderMarketGrid() {
  const grid = document.getElementById('stardust-market-grid');
  if (!grid) return;
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  const items = marketState.items.filter((it) => {
    if (marketState.filter !== 'all' && it.type !== marketState.filter) return false;
    if (!marketState.search) return true;
    const hay = `${it.name} ${it.author} ${it.description} ${(it.tags || []).join(' ')} ${it.type}`.toLowerCase();
    return hay.includes(marketState.search);
  });
  if (!items.length) {
    grid.appendChild(h('div', { class: 'stardust-market-loading', text: 'No matches.' }));
    return;
  }
  for (const it of items) grid.appendChild(marketCard(it));
}

function marketCard(item) {
  const card = h('div', { class: 'stardust-market-item' });
  const preview = h('div', { class: 'stardust-market-preview' });
  if (item.preview) preview.style.background = item.preview;
  preview.appendChild(h('span', { class: 'stardust-market-type', text: TYPE_LABEL[item.type] || item.type }));
  card.appendChild(preview);

  card.appendChild(h('div', { class: 'stardust-market-name', text: item.name }));
  card.appendChild(h('div', { class: 'stardust-market-author', text: 'by ' + (item.author || 'community') }));
  if (item.description) card.appendChild(h('div', { class: 'stardust-market-desc', text: item.description }));

  const actions = h('div', { class: 'stardust-market-actions' });
  const inst = isInstalled(item);

  if (!inst) {
    const b = h('button', { class: 'stardust-market-btn primary', text: 'Install' });
    b.addEventListener('click', () => doInstall(item, b));
    actions.appendChild(b);
  } else {
    if (item.type === 'theme') {
      const sel = h('button', { class: 'stardust-market-btn' + (isEnabled(item) ? ' on' : ' primary'),
        text: isEnabled(item) ? 'Applied ✓' : 'Apply' });
      sel.addEventListener('click', async () => {
        await setSetting('activeTheme', item.id);
        await applyTheme(item.id);
        if (panelEl) renderThemes(panelEl);
        renderMarketGrid();
      });
      actions.appendChild(sel);
    } else {
      const on = isEnabled(item);
      const tog = h('button', { class: 'stardust-market-btn' + (on ? ' on' : ' primary'), text: on ? 'Enabled ✓' : 'Enable' });
      tog.addEventListener('click', () => toggleEnable(item));
      actions.appendChild(tog);
    }
    const rm = h('button', { class: 'stardust-market-btn ghost', title: 'Remove', text: 'Remove' });
    rm.addEventListener('click', () => doRemove(item));
    actions.appendChild(rm);
  }
  card.appendChild(actions);
  return card;
}

async function doInstall(item, btn) {
  if (btn) { btn.textContent = 'Installing…'; btn.disabled = true; }
  const r = await ipcRenderer.invoke('stardust:marketplace-install', item);
  installed = r.installed || installed;
  extras = r.extras || extras;
  themeList = r.themes || themeList;
  // Auto-enable non-theme extras on install so the effect is immediate.
  if (item.type === 'font') await setSetting('activeFont', item.id);
  else if (item.type === 'animation') await setSetting('enabledAnimations', uniqAdd(settings.enabledAnimations, item.id));
  else if (item.type === 'feature') await setSetting('enabledFeatures', uniqAdd(settings.enabledFeatures, item.id));
  else if (item.type === 'audio') await setSetting('enabledAudio', uniqAdd(settings.enabledAudio, item.id));
  applyExtras();
  if (panelEl) renderThemes(panelEl);
  renderMarketGrid();
}

async function doRemove(item) {
  // Turn it off first so nothing dangles, then delete.
  if (item.type === 'font' && settings.activeFont === item.id) await setSetting('activeFont', null);
  if (item.type === 'animation') await setSetting('enabledAnimations', without(settings.enabledAnimations, item.id));
  if (item.type === 'feature') await setSetting('enabledFeatures', without(settings.enabledFeatures, item.id));
  if (item.type === 'audio') await setSetting('enabledAudio', without(settings.enabledAudio, item.id));
  const r = await ipcRenderer.invoke('stardust:marketplace-remove', { type: item.type, id: item.id });
  installed = r.installed || installed;
  extras = r.extras || extras;
  themeList = r.themes || themeList;
  // If we removed the active theme, fall back to the first available one.
  if (item.type === 'theme' && activeTheme && activeTheme.id === item.id) {
    const fallback = (themeList[0] && themeList[0].id) || 'nebula';
    await setSetting('activeTheme', fallback);
    await applyTheme(fallback);
  }
  applyExtras();
  if (panelEl) renderThemes(panelEl);
  renderMarketGrid();
}

async function toggleEnable(item) {
  if (item.type === 'font') {
    await setSetting('activeFont', settings.activeFont === item.id ? null : item.id);
  } else if (item.type === 'animation') {
    const on = (settings.enabledAnimations || []).includes(item.id);
    await setSetting('enabledAnimations', on ? without(settings.enabledAnimations, item.id) : uniqAdd(settings.enabledAnimations, item.id));
  } else if (item.type === 'feature') {
    const on = (settings.enabledFeatures || []).includes(item.id);
    await setSetting('enabledFeatures', on ? without(settings.enabledFeatures, item.id) : uniqAdd(settings.enabledFeatures, item.id));
  } else if (item.type === 'audio') {
    const on = (settings.enabledAudio || []).includes(item.id);
    await setSetting('enabledAudio', on ? without(settings.enabledAudio, item.id) : uniqAdd(settings.enabledAudio, item.id));
  }
  applyExtras();
  renderMarketGrid();
}

function uniqAdd(arr, id) { return Array.from(new Set([...(arr || []), id])); }
function without(arr, id) { return (arr || []).filter((x) => x !== id); }

async function setSetting(key, value) {
  settings = await ipcRenderer.invoke('stardust:set-setting', { key, value });
  return settings;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  // Base structural CSS lives in overlay.css next to this preload.
  try {
    sheet('stardust-base').textContent = fs.readFileSync(path.join(__dirname, 'overlay', 'overlay.css'), 'utf8');
  } catch (e) {
    console.error('[Stardust] failed to load overlay.css', e.message);
  }

  const init = await ipcRenderer.invoke('stardust:init');
  settings = init.settings;
  themeList = init.themes;
  discordAvailable = init.discordAvailable;
  installed = init.installed || installed;
  extras = init.extras || extras;

  await applyTheme(settings.activeTheme || (themeList[0] && themeList[0].id));
  applyExtras();
  buildUI();

  setInterval(pollNowPlaying, 1000);
  setInterval(skipAds, 600);
}

function safeBoot() {
  // Only inject on the actual YTM app, not on Google sign-in pages.
  if (!location.hostname.includes('music.youtube.com')) {
    console.log('Stardust skipping injection on', location.hostname);
    return;
  }
  boot().catch((e) => console.error('Stardust boot failed:', e && e.stack || e));
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', safeBoot);
} else {
  safeBoot();
}
