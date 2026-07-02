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
let appVersion = '';
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
  let ovColor = null; // reactive-theming colour override
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
    const cx = CX(), cy = CY(), r = R(), color = ovColor || cfg.color || '#ff8c42';
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
        drawShape(p, x, y, color, fade);
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
  function setColor(c) { ovColor = c || null; }

  return { configure, setColor };
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
  let bass = null, treble = null, volume = null, panner = null, reverb = null, wet = null, lfo = null, fade = null;
  let karOn = false, karNodes = null; // karaoke (center-vocal cancel) rewiring
  let useReal = false;       // true once we get non-zero spectrum data
  let zeroFrames = 0;        // consecutive silent frames while playing -> tainted
  let reactiveColor = null;  // per-track reactive theming override

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
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : (enabled && start())));
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
        fade = audioCtx.createGain(); fade.gain.value = 1; // crossfade/transition
      }
      const src = audioCtx.createMediaElementSource(el);
      // dry chain
      src.connect(bass); bass.connect(treble); treble.connect(volume);
      const tail = panner || volume;
      if (panner) volume.connect(panner);
      tail.connect(analyser);
      // wet (reverb) send in parallel
      tail.connect(reverb); reverb.connect(wet); wet.connect(analyser);
      // fade node sits only on the audible path, so transitions don't dip the
      // visualizer (which reads the analyser upstream of the fade).
      analyser.connect(fade); fade.connect(audioCtx.destination);
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
  const gradCache = []; let gradKey = '';
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
    const accent = reactiveColor || settings.accentOverride || cfg.color || '#8b5cff';
    if (gradKey !== accent + '|' + h) { gradCache.length = 0; gradKey = accent + '|' + h; }
    const gap = 2;
    const bw = (w / BARS) - gap;
    for (let i = 0; i < BARS; i++) {
      levels[i] += (targets[i] - levels[i]) * (useReal ? 0.35 : 0.18);
      const bh = levels[i] * (h - 20);
      if (bh < 2) continue;
      const x = i * (bw + gap);
      // Gradients bucketed by height (8px) and cached — building 72 fresh
      // gradients every frame was measurable main-thread work.
      const bucket = bh >> 3;
      let grad = gradCache[bucket];
      if (!grad) {
        grad = ctx.createLinearGradient(0, h - ((bucket + 1) << 3), 0, h);
        grad.addColorStop(0, accent);
        grad.addColorStop(0.6, accent);
        grad.addColorStop(1, 'transparent');
        gradCache[bucket] = grad;
      }
      ctx.fillStyle = grad;
      ctx.fillRect(x, h - bh, bw, bh);
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
    reverb: (on) => { ensureAudio(); if (wet) wet.gain.value = on ? 0.32 : 0; },
    // Center-channel cancel (L−R): vocals sit dead-center in most stereo
    // mixes, so subtracting the channels removes them and leaves the band.
    karaoke: (on) => {
      ensureAudio();
      if (!audioCtx || !treble || !volume) return;
      if (on && !karOn) {
        if (!karNodes) {
          const split = audioCtx.createChannelSplitter(2);
          const l = audioCtx.createGain(); l.gain.value = 0.7;
          const r = audioCtx.createGain(); r.gain.value = -0.7;
          const sum = audioCtx.createGain(); sum.gain.value = 1;
          split.connect(l, 0); split.connect(r, 1);
          l.connect(sum); r.connect(sum);
          karNodes = { split, sum };
        }
        try { treble.disconnect(); } catch {}
        treble.connect(karNodes.split);
        karNodes.sum.connect(volume);
        karOn = true;
      } else if (!on && karOn) {
        try { treble.disconnect(); } catch {}
        try { karNodes.sum.disconnect(); } catch {}
        treble.connect(volume);
        karOn = false;
      }
    },
    // Smoothly ramp the audible level (for crossfade/fade transitions).
    fade: (target, seconds) => {
      ensureAudio();
      if (!fade || !audioCtx) return;
      const now = audioCtx.currentTime;
      try {
        fade.gain.cancelScheduledValues(now);
        fade.gain.setValueAtTime(Math.max(0.0001, fade.gain.value), now);
        fade.gain.linearRampToValueAtTime(Math.max(0.0001, target), now + Math.max(0.05, seconds));
      } catch {}
    }
  };

  // Downsampled bar levels (0..1) for the mini-player visualizer. Sample the
  // analyser LIVE here (not the smoothed `levels`) so the mini keeps animating
  // even when the main window's rAF is throttled because it's in the background.
  function getBars(n) {
    const out = new Array(n).fill(0);
    ensureAudio();
    if (analyser && freq && useReal) {
      analyser.getByteFrequencyData(freq);
      const bins = analyser.frequencyBinCount;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const f0 = Math.pow(i / n, 2.0), f1 = Math.pow((i + 1) / n, 2.0);
        let lo = Math.floor(f0 * bins), hi = Math.max(lo + 1, Math.floor(f1 * bins)), max = 0;
        for (let j = lo; j < hi && j < bins; j++) if (freq[j] > max) max = freq[j];
        out[i] = Math.min(1, Math.pow(max / 255, 1.4) * 1.25);
        sum += out[i];
      }
      if (sum > 0.02) return out;
    }
    // Fallback: a simple simulation keyed to play state (tainted/silent audio).
    for (let i = 0; i < n; i++) {
      const center = 1 - Math.abs(i - n / 2) / (n / 2);
      out[i] = playing ? Math.max(0.05, Math.min(1, (0.3 + 0.7 * center) * (0.6 + Math.random() * 0.5))) : 0;
    }
    return out;
  }
  function setReactiveColor(c) { reactiveColor = c || null; }

  // Smoothed energy in the vocal band (~200Hz–4kHz), 0..1, plus that band's
  // share of the TOTAL spectral energy (bass-drop/percussion-only passages have
  // energy but a low mid share, so the share helps reject them as "voice").
  // e is -1 when real audio can't be read.
  let veSmooth = 0, vrSmooth = 0.5;
  function vocalEnergy() {
    ensureAudio(); // tap the audio even if the visualizer is disabled
    if (!analyser || !freq || !useReal) return { e: -1, ratio: 0 };
    analyser.getByteFrequencyData(freq);
    const bins = analyser.frequencyBinCount;
    const sr = audioCtx ? audioCtx.sampleRate : 44100;
    const lo = Math.max(1, Math.floor(200 / (sr / 2) * bins));
    const hi = Math.min(bins, Math.floor(4000 / (sr / 2) * bins));
    let sum = 0, n = 0, all = 0;
    for (let i = 1; i < bins; i++) {
      all += freq[i];
      if (i >= lo && i < hi) { sum += freq[i]; n++; }
    }
    const e = n ? (sum / n) / 255 : 0;
    veSmooth += (e - veSmooth) * 0.4; // light smoothing
    vrSmooth += ((all > 0 ? sum / all : 0) - vrSmooth) * 0.3;
    return { e: veSmooth, ratio: vrSmooth };
  }

  // Onset detector: positive spectral flux in the vocal band (sum of frame-to-
  // frame energy INCREASES) marks a syllable/word attack. Returns the onset
  // strength (0 when none), with a refractory gap so one attack fires once.
  let fluxPrev = null, fluxAvg = 0, lastOnsetAt = 0;
  function vocalOnset() {
    ensureAudio();
    if (!analyser || !freq || !useReal) return 0;
    analyser.getByteFrequencyData(freq);
    const bins = analyser.frequencyBinCount;
    const sr = audioCtx ? audioCtx.sampleRate : 44100;
    const lo = Math.max(1, Math.floor(300 / (sr / 2) * bins));  // focus on the vocal
    const hi = Math.min(bins, Math.floor(3400 / (sr / 2) * bins)); // range, less drums
    if (!fluxPrev || fluxPrev.length !== bins) fluxPrev = new Float32Array(bins);
    let flux = 0;
    for (let i = lo; i < hi; i++) { const d = freq[i] - fluxPrev[i]; if (d > 0) flux += d; fluxPrev[i] = freq[i]; }
    flux /= ((hi - lo) * 255) || 1;
    fluxAvg += (flux - fluxAvg) * 0.12;
    const now = performance.now();
    if (flux > fluxAvg * 1.5 && flux > 0.03 && now - lastOnsetAt > 110) {
      lastOnsetAt = now;
      return Math.min(1, flux * 6);
    }
    return 0;
  }

  // --- audio capture (for "transcribe this song") -------------------------
  let capDest = null, recorder = null, capChunks = [];
  function captureStart() {
    ensureAudio();
    if (!audioCtx || !analyser) return false;
    try {
      if (!capDest) capDest = audioCtx.createMediaStreamDestination();
      analyser.connect(capDest);
      capChunks = [];
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      recorder = new MediaRecorder(capDest.stream, { mimeType: mime, audioBitsPerSecond: 96000 });
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) capChunks.push(e.data); };
      recorder.start(1000);
      return true;
    } catch (e) { console.warn('[Stardust] capture start failed:', e.message); return false; }
  }
  function captureStop() {
    return new Promise((resolve) => {
      if (!recorder) return resolve(null);
      recorder.onstop = () => {
        const blob = new Blob(capChunks, { type: 'audio/webm' });
        try { analyser.disconnect(capDest); } catch {}
        recorder = null;
        resolve(blob);
      };
      try { recorder.stop(); } catch { resolve(null); }
    });
  }

  return { configure, setPlaying, resumeAudio, fx, getBars, setReactiveColor, vocalEnergy, vocalOnset, captureStart, captureStop };
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

  // Behaviours (audio effects + smart features + JS-driven animations) — JS side
  const desired = new Set([
    ...(settings.enabledFeatures || []),
    ...(settings.enabledAudio || []),
    ...(settings.enabledAnimations || [])
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
  'feat-lyrics':        { on: () => Lyrics.enable(),    off: () => Lyrics.disable() },
  'feat-quick-actions': { on: () => QuickActions.show(), off: () => QuickActions.hide() },
  'feat-auto-dj':       { on: () => AutoDJ.enable(),    off: () => AutoDJ.disable() },
  'feat-reactive-theme':{ on: () => ReactiveTheme.enable(), off: () => ReactiveTheme.disable() },
  'feat-crossfade':     { on: () => Crossfade.enable(), off: () => Crossfade.disable() },
  'feat-playlist-tools':{ on: () => PlaylistTools.show(), off: () => PlaylistTools.hide() },
  'anim-vinyl-spin':    { on: () => VinylSpin.on(), off: () => VinylSpin.off() },
  'anim-prism-accent':  { on: () => PrismAccent.on(), off: () => PrismAccent.off() },
  'audio-karaoke':      { on: () => Visualizer.fx.karaoke(true), off: () => Visualizer.fx.karaoke(false) }
};

// --- Vinyl Spin: find the actual artwork <img> at runtime (YTM class names are
// unreliable) and tag it + its wrapper, then style our own classes via CSS. ---
const VinylSpin = (() => {
  let timer = null;
  function markWrap(img) {
    // Walk up to (and including) the player bar / player page, clearing every
    // wrapper's background inline (beats YTM's inline styles) so no gray box
    // shows around the circular art. Stop at the container to avoid over-reach.
    let p = img.parentElement;
    for (let i = 0; i < 6 && p; i++) {
      p.classList.add('stardust-vinyl-wrap');
      try { p.style.background = 'transparent'; p.style.backgroundColor = 'transparent'; p.style.overflow = 'visible'; } catch {}
      const tag = (p.tagName || '').toLowerCase();
      if (tag === 'ytmusic-player-bar' || tag === 'ytmusic-player-page') break;
      p = p.parentElement;
    }
    try { img.style.background = 'transparent'; img.style.backgroundColor = 'transparent'; } catch {}
  }
  function tagBar() {
    const bar = document.querySelector('ytmusic-player-bar');
    const img = bar && bar.querySelector('img');
    if (img) { img.classList.add('stardust-vinyl', 'sd-mini'); markWrap(img); }
  }
  // The big record is our OWN centered overlay (not YTM's img), so an ancestor
  // transform can't offset it. We mirror the album art into it and hide YTM's.
  let overlay = null, hiddenOrig = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'stardust-vinyl-big';
    document.body.appendChild(overlay);
    return overlay;
  }
  // Is the immersive now-playing page actually open (not just present in DOM)?
  function playerOpen() {
    const layout = document.querySelector('ytmusic-app-layout');
    if (layout && (layout.hasAttribute('player-page-open_') || layout.getAttribute('player-page-open_') === 'true')) return true;
    const page = document.querySelector('ytmusic-player-page');
    if (!page || page.hasAttribute('hidden')) return false;
    const r = page.getBoundingClientRect();
    return r.height > window.innerHeight * 0.5 && r.top < window.innerHeight * 0.4;
  }
  function tagPage() {
    const page = document.querySelector('ytmusic-player-page');
    let big = null, area = 0;
    // Only consider the art open when the player page is actually up AND the img
    // is visible on screen — otherwise the overlay lingers after you exit.
    if (page && playerOpen()) {
      for (const im of page.querySelectorAll('img')) {
        if (im.offsetParent === null) continue; // not rendered
        const r = im.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) continue; // off screen
        const a = r.width * r.height;
        if (a > area) { area = a; big = im; }
      }
    }
    const qualifies = big && area > 30000;
    if (qualifies) {
      const src = big.currentSrc || big.src;
      if (src) {
        const r = big.getBoundingClientRect();
        const size = Math.min(r.width, r.height);   // fit a circle to the art
        ensureOverlay();
        overlay.style.backgroundImage = `url("${src}")`;
        // Center the record exactly where YTM's art is (i.e. centered in the
        // left art column), and size it to the art so it covers any gray box.
        overlay.style.width = overlay.style.height = size + 'px';
        overlay.style.left = (r.left + r.width / 2 - size / 2) + 'px';
        overlay.style.top = (r.top + r.height / 2 - size / 2) + 'px';
        overlay.style.display = 'block';
        if (hiddenOrig && hiddenOrig !== big) revealOrig(hiddenOrig);
        big.classList.add('sd-orig-hidden'); clearBgUp(big); hiddenOrig = big;
      }
    } else {
      if (overlay) overlay.style.display = 'none';
      if (hiddenOrig) { revealOrig(hiddenOrig); hiddenOrig = null; }
    }
  }
  // Clear the gray background off the art's wrappers (inline beats YTM's CSS).
  function clearBgUp(img) {
    let p = img.parentElement;
    for (let i = 0; i < 5 && p; i++) {
      p.classList.add('sd-cleared-bg');
      try { p.style.background = 'transparent'; p.style.backgroundColor = 'transparent'; } catch {}
      const tag = (p.tagName || '').toLowerCase();
      if (tag === 'ytmusic-player-page') break;
      p = p.parentElement;
    }
  }
  function revealOrig(img) {
    img.classList.remove('sd-orig-hidden');
    let p = img.parentElement;
    for (let i = 0; i < 5 && p; i++) {
      if (p.classList.contains('sd-cleared-bg')) { p.classList.remove('sd-cleared-bg'); p.style.background = ''; p.style.backgroundColor = ''; }
      p = p.parentElement;
    }
  }
  function scan() { try { tagBar(); tagPage(); } catch {} }
  function on() { if (timer) return; scan(); timer = setInterval(scan, 1200); }
  function off() {
    if (timer) { clearInterval(timer); timer = null; }
    document.querySelectorAll('.stardust-vinyl').forEach((e) => { e.classList.remove('stardust-vinyl', 'sd-mini', 'sd-big'); e.style.background = ''; });
    document.querySelectorAll('.stardust-vinyl-wrap').forEach((e) => {
      e.classList.remove('stardust-vinyl-wrap');
      e.style.background = ''; e.style.backgroundColor = ''; e.style.overflow = '';
    });
    if (overlay) { overlay.remove(); overlay = null; }
    if (hiddenOrig) { hiddenOrig.classList.remove('sd-orig-hidden'); hiddenOrig = null; }
  }
  return { on, off };
})();

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

// --- Quick actions: a floating bar of one-tap controls ---------------------
const QuickActions = (() => {
  let el = null;
  const BTNS = [
    ['👍', 'like', 'Like'],
    ['👎', 'dislike', 'Dislike'],
    ['🔀', 'shuffle', 'Shuffle'],
    ['🔗', 'copy-link', 'Copy song link'],
    ['➕', 'add-playlist', 'Save to playlist']
  ];
  function show() {
    if (el) return;
    el = h('div', { id: 'stardust-quickbar' }, BTNS.map(([icon, act, title]) => {
      const b = h('button', { class: 'stardust-qa', title, text: icon });
      b.addEventListener('click', () => doCommand(act));
      return b;
    }));
    document.body.appendChild(el);
  }
  function hide() { if (el) { el.remove(); el = null; } }
  return { show, hide };
})();

// --- Auto-DJ: keep the music going by enabling autoplay/radio near the end --
const AutoDJ = (() => {
  let timer = null;
  function enable() {
    if (timer) return;
    tick();
    timer = setInterval(tick, 5000);
  }
  function disable() { if (timer) { clearInterval(timer); timer = null; } }
  function tick() {
    const v = q('video'); if (!v || !isFinite(v.duration) || v.duration <= 0) return;
    // Within the last 25s of the final queued track, kick off a radio so the
    // session never dead-ends. Best-effort against YTM's DOM.
    const items = document.querySelectorAll('ytmusic-player-queue-item');
    const sel = document.querySelector('ytmusic-player-queue-item[selected]');
    const isLast = items.length && sel === items[items.length - 1];
    if (isLast && (v.duration - v.currentTime) < 25) {
      // Turn on the built-in Autoplay toggle if it's exposed.
      const toggle = document.querySelector('ytmusic-player-bar tp-yt-paper-toggle-button, #autoplay tp-yt-paper-toggle-button');
      if (toggle && toggle.getAttribute('aria-pressed') === 'false') { try { toggle.click(); } catch {} }
    }
  }
  return { enable, disable };
})();

// --- Prism Accent: the accent colour slowly cycles hue (CSS relative color) --
const PrismAccent = (() => {
  let timer = null, deg = 0;
  const base = () => reactiveAccent || (settings && settings.accentOverride) || (activeTheme && activeTheme.accent) || '#8b5cff';
  function on() {
    if (timer) return;
    timer = setInterval(() => {
      deg = (deg + 1.4) % 360;
      document.documentElement.style.setProperty('--stardust-accent', `hsl(from ${base()} calc(h + ${deg.toFixed(0)}) s l)`);
    }, 120);
  }
  function off() {
    if (timer) { clearInterval(timer); timer = null; }
    if (reactiveAccent) document.documentElement.style.setProperty('--stardust-accent', reactiveAccent);
    else document.documentElement.style.removeProperty('--stardust-accent');
  }
  return { on, off };
})();

// Pull a vibrant colour out of album art (bright + saturated pixel, else avg).
function extractColor(artUrl, cb) {
  const img = new Image(); img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 24;
      const cx = c.getContext('2d'); cx.drawImage(img, 0, 0, 24, 24);
      const d = cx.getImageData(0, 0, 24, 24).data;
      let best = null, bestScore = -1, ar = 0, ag = 0, ab = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        ar += r; ag += g; ab += b; n++;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        const val = mx / 255;
        const score = sat * 1.4 + val * 0.6; // favour colourful but not too dark
        if (val > 0.25 && score > bestScore) { bestScore = score; best = [r, g, b]; }
      }
      if (!best) best = [Math.round(ar / n), Math.round(ag / n), Math.round(ab / n)];
      const hex = '#' + best.map((x) => Math.min(255, Math.max(0, x)).toString(16).padStart(2, '0')).join('');
      cb(hex);
    } catch { cb(null); }
  };
  img.onerror = () => cb(null);
  img.src = artUrl;
}

// Current per-track reactive colour (also fed to the mini player via np.accent).
let reactiveAccent = null;

// --- Reactive theming: tint accent/visualizer/black-hole from album art ----
const ReactiveTheme = (() => {
  let active = false, last = '';
  function enable() { active = true; last = ''; onTrack(readNowPlaying()); }
  function disable() {
    active = false; last = ''; reactiveAccent = null;
    document.documentElement.style.removeProperty('--stardust-accent');
    Visualizer.setReactiveColor(null); BlackHole.setColor(null);
  }
  function onTrack(np) {
    if (!active || !np || !np.art || np.art === last) return;
    last = np.art;
    extractColor(np.art, (hex) => {
      if (!active || !hex) return;
      reactiveAccent = hex;
      document.documentElement.style.setProperty('--stardust-accent', hex);
      Visualizer.setReactiveColor(hex); BlackHole.setColor(hex);
      // Push the new colour to the mini player immediately.
      try { const np2 = readNowPlaying(); if (np2) ipcRenderer.send('stardust:nowplaying', np2); } catch {}
    });
  }
  return { enable, disable, onTrack };
})();

// --- Crossfade: fade transitions between tracks (single-element approximation)
const Crossfade = (() => {
  let timer = null, active = false, faded = false;
  const OUT = 3, IN = 1.4;
  function enable() { if (active) return; active = true; faded = false; Visualizer.fx.fade(1, 0.2); timer = setInterval(tick, 300); }
  function disable() { active = false; if (timer) { clearInterval(timer); timer = null; } Visualizer.fx.fade(1, 0.3); }
  // Fade IN the moment a real track change is detected (driven by pollNowPlaying,
  // so there's no silent gap while a poll catches up). Guarded by `active`.
  function onTrack() { if (!active) return; faded = false; Visualizer.fx.fade(0.0001, 0.01); Visualizer.fx.fade(1, IN); }
  // Fade OUT over the last few seconds of the current track.
  function tick() {
    if (!active) return;
    const v = q('video'); if (!v) return;
    const np = readNowPlaying();
    if (!np || np.isAd || !np.isTrack) return;   // never fade on ad interstitials
    if (isFinite(v.duration) && v.duration > 0) {
      const left = v.duration - v.currentTime;
      if (!faded && left > 0 && left <= OUT) { faded = true; Visualizer.fx.fade(0.0001, left); }
    }
  }
  return { enable, disable, onTrack };
})();

// --- Smart playlist tools: a floating bar of queue/playlist shortcuts -------
const PlaylistTools = (() => {
  let el = null;
  const BTNS = [
    ['📻', 'radio', 'Start radio from this song'],
    ['👤', 'goto-artist', 'Go to artist'],
    ['💿', 'goto-album', 'Go to album'],
    ['🎲', 'random-library', 'Play something random'],
    ['💾', 'save-queue', 'Save queue to a playlist']
  ];
  function show() {
    if (el) return;
    el = h('div', { id: 'stardust-plbar' }, BTNS.map(([icon, act, title]) => {
      const b = h('button', { class: 'stardust-qa', title, text: icon });
      b.addEventListener('click', () => doCommand(act));
      return b;
    }));
    document.body.appendChild(el);
  }
  function hide() { if (el) { el.remove(); el = null; } }
  return { show, hide };
})();

// --- Synced lyrics — integrated into YTM's own Lyrics tab ------------------
// Un-greys the Lyrics tab (so it works on videos too) and renders time-synced
// lyrics from LRCLIB directly inside the player page's lyrics tab content,
// styled to look native rather than a bulky floating panel.
const Lyrics = (() => {
  let active = false, synced = [], plain = null, key = '', poll = null, raf = null;
  let box = null, body = null, lastIdx = -1, attempts = 0, np = null;
  let mode = 'off', host = null;                     // 'searching' | 'ours' | 'off'
  let curEl = null, curSpans = null, curTiming = null;
  let curMode = 'est', curSungDur = 1, lastCT = 0;
  let synthMode = false, lineSyl = null, cumSyl = null, totalSyl = 1, secSyl = null;
  let curSyl = null, curSylTotal = 1, sylPtr = 0;
  let floor = 0, sylAcc = 0;                 // adaptive vocal noise-floor + syllables-sung accumulator
  let transcribing = false;
  let offset = 0, barEl = null, offEl = null, srcEl = null, alignBtn = null, mineBtn = null; // sync-offset (s) + toolbar els
  let lastLrcText = '';                      // raw LRC of the current lyrics (for ⚡ alignment)
  let stampsReal = false;                    // line stamps are human-made (lrclib/KuGou/NetEase)
  let animBase = null;                       // wall-clock base of the scheduled word animations
  let localTranscript = null;                // this song's own transcription (never deleted)
  let microOff = 0;                          // live onset phase-lock correction (s)
  let syncing = false;                       // a background word-sync is in flight
  const autoTried = new Set();               // one auto-transcribe attempt per song per session
  const autoRetries = new Map();             // transient auto-sync failures retry with backoff
  let userScrollUntil = 0;                   // pause auto-scroll while the user scrolls
  const SYL_RATE = 3.6;                      // starting syllables/sec — refined per song
  const LOOKAHEAD = 0.12;                    // s — highlight leads the audio slightly (a
                                             // mathematically exact highlight reads as late)

  // Everything we've HEARD of the current track so far. Fed on every tick (even
  // with the lyrics tab closed) so the model doesn't lose time:
  //   voiced/elapsed → how much of the song actually has singing,
  //   silent/resumed → section boundaries (voice returning after a long gap),
  //   rate           → the song's sung-syllable pace, learned from real
  //                    line timestamps as lines complete.
  let hear = null;
  function resetHear() {
    hear = { lastT: 0, voiced: 0, elapsed: 0, silent: 0, prevVoice: false, resumed: false, rate: SYL_RATE, eAvg: 0.35 };
    floor = 0; sylAcc = 0;
  }
  resetHear();

  // "Hear" the song this frame: vocal energy, whether a VOICE is present (above
  // an adaptive noise floor AND mid-heavy in spectrum), and whether a syllable
  // ONSET just fired.
  // The flag must not be called `active`: destructuring that name inside paint()
  // shadows the module-level enabled flag (TDZ → paint throws every frame).
  function listen() {
    const { e, ratio } = Visualizer.vocalEnergy();
    const onset = Visualizer.vocalOnset();
    if (e < 0) return { e: -1, voice: true, onset: 0 }; // can't read audio → behave like time
    // Noise floor falls fast toward quiet, rises slowly — so it tracks the gaps.
    floor += (e - floor) * (e < floor ? 0.25 : 0.01);
    const voice = (e > floor + 0.06 || e > floor * 1.7) && ratio > 0.35;
    return { e, voice, onset };
  }

  function enable() {
    active = true;
    np = readNowPlaying(); fetchFor(np);
    // A light 300ms poll keeps the tab un-greyed and injects when the Lyrics tab
    // is open. The per-word highlight runs on its own faster tick.
    poll = setInterval(sync, 300);
    startRAF();
    sync();
  }
  function disable() {
    active = false;
    if (poll) { clearInterval(poll); poll = null; }
    stopRAF();
    clearHost(); synced = []; plain = null; key = ''; mode = 'off';
  }
  // Drive the highlight on a setInterval, NOT requestAnimationFrame: rAF is
  // paused by Chromium when the window is throttled/occluded, which froze the
  // lyrics (paint never ran → idx stuck at -1). ~40ms ≈ 25fps; the CSS --wp
  // transition smooths the fill between ticks.
  // A swallowed exception here once hid a total freeze — log the first one.
  function startRAF() {
    if (raf) return;
    raf = setInterval(() => {
      try { tick(); } catch (e) {
        if (!startRAF._err) { startRAF._err = true; console.error('[Stardust] lyrics tick failed:', e); }
      }
    }, 32);
  }
  // The <video> element YTM is actually playing (prefer a playing one; some
  // pages have a stale/hidden extra video whose time never moves).
  let pvEl = null, pvAt = 0;
  function playingVideo() {
    const now = Date.now();
    if (pvEl && now - pvAt < 1000 && pvEl.isConnected) return pvEl;
    const vids = document.querySelectorAll('video');
    if (!vids.length) { pvEl = null; return null; }
    let best = null;
    for (const vd of vids) {
      if (!vd.paused && vd.currentTime > 0) { best = vd; break; }
      if (!best || (vd.currentTime || 0) > (best.currentTime || 0)) best = vd;
    }
    pvEl = best || vids[0]; pvAt = now;
    return pvEl;
  }
  function stopRAF() { if (raf) { clearInterval(raf); raf = null; } }

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
    if (!box) {
      body = h('div', { class: 'stardust-lyric-lines' });
      box = h('div', { id: 'stardust-lyrics' }, [buildTools(), body]);
      // The user scrolling the lyrics pauses auto-centering for a few seconds.
      const bump = () => { userScrollUntil = Date.now() + 4000; };
      box.addEventListener('wheel', bump, { passive: true });
      box.addEventListener('touchmove', bump, { passive: true });
    }
    return box;
  }
  // Slim toolbar over the lyrics: nudge the sync offset, copy the words,
  // re-transcribe by choice, and show where these lyrics came from.
  function buildTools() {
    const minus = h('button', { class: 'stardust-lyr-tool', title: 'Highlight running ahead of the singing? Delay it', text: '−0.5s' });
    const plus = h('button', { class: 'stardust-lyr-tool', title: 'Highlight lagging behind the singing? Advance it', text: '+0.5s' });
    offEl = h('button', { class: 'stardust-lyr-tool sd-off', title: 'Sync offset — click to reset', text: '0.0s' });
    const copy = h('button', { class: 'stardust-lyr-tool', title: 'Copy the lyrics to the clipboard', text: '⧉ Copy' });
    const re = h('button', { class: 'stardust-lyr-tool', title: 'Transcribe this song yourself — listens once and replaces these lyrics with word-timed ones (needs a Groq key)', text: '🎙' });
    const again = h('button', { class: 'stardust-lyr-tool', title: 'Search the lyric databases again — skips transcriptions, and replaces yours if something is found', text: '🔎' });
    alignBtn = h('button', { class: 'stardust-lyr-tool', title: 'Word-sync: listens to the song once and aligns these exact lyrics to the audio — near-perfect per-word timing (needs a Groq key)', text: '⚡' });
    mineBtn = h('button', { class: 'stardust-lyr-tool', title: 'Use MY transcription instead — lyric databases sometimes carry the wrong words. Sticky for this song; 🔎 switches back.', text: '🎙★' });
    srcEl = h('span', { class: 'stardust-lyr-src', text: '' });
    minus.addEventListener('click', () => nudge(-0.5));
    plus.addEventListener('click', () => nudge(0.5));
    offEl.addEventListener('click', () => nudge(0));
    copy.addEventListener('click', copyLyrics);
    re.addEventListener('click', reTranscribe);
    again.addEventListener('click', searchAgain);
    alignBtn.addEventListener('click', startAlign);
    mineBtn.addEventListener('click', useMyTranscript);
    barEl = h('div', { class: 'stardust-lyr-tools' }, [minus, offEl, plus, copy, re, again, alignBtn, mineBtn, srcEl]);
    return barEl;
  }
  const SRC_LABEL = { musixmatch: 'Musixmatch', lrclib: 'LRCLIB', netease: 'NetEase', kugou: 'KuGou', genius: 'Genius', transcript: 'transcribed', community: 'community', aligned: 'word-synced ⚡' };
  let lastSource = null, lastMeta = null;
  // The badge tells the WHOLE story: which provider, and whether the word
  // timing is real (human richsync / audio-derived) or estimated — so a badly
  // synced song can be blamed on the right thing at a glance.
  function setSourceLabel(source, meta) {
    lastSource = source; lastMeta = meta || null;
    if (!srcEl) return;
    if (!source) { srcEl.textContent = ''; srcEl.className = 'stardust-lyr-src'; srcEl.title = ''; return; }
    const kind = meta && meta.kind;
    const alignedV2 = !!(meta && meta.syncedLyrics && meta.syncedLyrics.includes('stardust-aligned-v2'));
    let txt, cls;
    if (source === 'musixmatch') { txt = kind === 'word' ? 'Musixmatch richsync · word-perfect' : 'Musixmatch · line sync'; cls = kind === 'word' ? 'good' : 'mid'; }
    else if (source === 'netease') { txt = kind === 'word' ? 'NetEase karaoke · word sync' : 'NetEase · line sync'; cls = kind === 'word' ? 'good' : 'mid'; }
    else if (source === 'lrclib' || source === 'kugou') { txt = SRC_LABEL[source] + ' · line sync'; cls = 'mid'; }
    else if (source === 'community') { txt = alignedV2 ? 'community · word-synced ⚡' : 'community transcript 🎙'; cls = alignedV2 ? 'good' : 'mid'; }
    else if (source === 'transcript') { txt = 'your transcription 🎙 · word-timed'; cls = 'good'; }
    else if (source === 'aligned') { txt = 'word-synced ⚡ · Whisper timing'; cls = 'good'; }
    else if (source === 'genius') { txt = 'Genius · estimated timing'; cls = 'est'; }
    else { txt = SRC_LABEL[source] || source; cls = 'mid'; }
    srcEl.textContent = 'via ' + txt;
    srcEl.className = 'stardust-lyr-src ' + cls;
    srcEl.title = cls === 'good' ? 'Word timings are real (human-synced or derived from this audio)'
      : cls === 'mid' ? 'Line timing is real; word positions are estimated (⚡ word-sync upgrades this)'
        : 'All timing is estimated from listening';
  }
  // Use MY transcription for this song (sticky): database text can be plain
  // wrong — the user's own transcription of the actual audio wins on words.
  let curSourceIsTranscript = false;
  function useMyTranscript() {
    if (!localTranscript || transcribing || syncing) return;
    try { ipcRenderer.invoke('stardust:transcript-pref', { title: np.title, artist: np.artist, pref: 'transcript' }); } catch {}
    applySynced(localTranscript);
    stampsReal = false;
    curSourceIsTranscript = true;
    setSourceLabel('transcript');
    render(); sync();
    toast('🎙 Using your transcription for this song');
  }

  // "Search again": re-run the provider search SKIPPING transcription sources.
  // If the databases have something, it replaces the transcription (and the
  // local transcript cache is forgotten so the choice sticks on replay).
  function searchAgain() {
    if (transcribing || mode === 'searching' || !np) return;
    synced = []; plain = null; synthMode = false; mode = 'searching';
    setSourceLabel(null);
    render('Searching lyrics…'); sync();
    doFetch(true);
  }
  // Even when lyrics were found, the user can choose to transcribe the actual
  // audio instead (their words may be a cover/remix the databases don't have).
  function reTranscribe() {
    if (transcribing) return;
    synced = []; plain = null; synthMode = false; mode = 'searching';
    setSourceLabel(null);
    render('🎙 Preparing to listen…'); sync();
    startTranscribe(null);
  }
  function nudge(d) {
    offset = d ? Math.round((offset + d) * 10) / 10 : 0;
    if (offEl) {
      offEl.textContent = (offset > 0 ? '+' : '') + offset.toFixed(1) + 's';
      offEl.classList.toggle('nonzero', offset !== 0);
    }
  }
  function copyLyrics() {
    const text = synced.length
      ? synced.map((l) => (l.s || '') + (l.ad ? ' (' + l.ad + ')' : '')).map((x) => x.trim()).filter(Boolean).join('\n')
      : (plain || '');
    if (!text) { toast('No lyrics to copy'); return; }
    navigator.clipboard.writeText(text).then(() => toast('📋 Lyrics copied'), () => toast('Copy failed'));
  }
  // Click a line to play from there (offset-corrected so the click lands on
  // the words you clicked, not where the nudged highlight would be).
  function seekTo(sec) {
    const v = playingVideo(); if (!v) return;
    try {
      v.currentTime = Math.max(0, sec - offset + 0.01);
      if (v.paused) doCommand('playpause');
    } catch {}
  }
  function clearHost() { if (host) { host.classList.remove('stardust-lyrics-on'); host = null; } if (box && box.parentElement) box.remove(); }

  function statusText() {
    if (mode === 'searching') return 'Searching lyrics…';
    if (mode === 'off') return 'Lyrics not available — searched: "' + ((np && np.title) || '?') + '" · ' + ((np && np.artist) || '?');
    return undefined; // 'ours' → render the lyrics
  }
  // Render INTO YouTube's own Lyrics tab whenever it's open (Stardust owns it,
  // never flickers to YTM's). Falls out of the way when the tab isn't selected.
  function sync() {
    if (!active) return;
    ungray();
    const h0 = tabHost();
    const want = h0 && tabSelected();
    if (want) {
      if (host && host !== h0) host.classList.remove('stardust-lyrics-on');
      host = h0;
      host.classList.add('stardust-lyrics-on');
      ensureBox();
      if (box.parentElement !== host) host.appendChild(box);
      if (!body.firstChild) render(statusText());
    } else {
      clearHost();
    }
  }

  const toSec = (mm, ss) => parseInt(mm, 10) * 60 + parseFloat(ss);
  const estWords = (s) => s ? s.split(/\s+/).map((t2) => ({ text: t2, len: Math.max(t2.length, 1), time: null })) : [];
  function parseLRC(text) {
    const out = [];
    for (const line of (text || '').split('\n')) {
      // One line can carry SEVERAL leading [mm:ss.xx] stamps (repeated chorus) —
      // expand each into its own entry, or the extra stamps leak into the text.
      const m = line.match(/^((?:\s*\[\d+:\d+(?:\.\d+)?\])+)([^]*)$/);
      if (!m) continue;
      const times = [...m[1].matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)].map((x) => toSec(x[1], x[2]));
      let rest = m[2];
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
        words = estWords(rest);
      }
      rest = rest.trim();
      for (const t of times) {
        // Real word times only belong to the first stamp; repeats get estimates.
        out.push({ t, s: rest, words: t === times[0] ? words : estWords(rest) });
      }
    }
    // The current-line search assumes chronological order; repeated-stamp lines
    // (and some providers) come out of order.
    out.sort((a, b) => a.t - b.t);
    return out;
  }
  const hasWordTiming = () => synced.some((l) => l.words && l.words.length && l.words[0].time != null);
  function refreshMineBtn() {
    if (mineBtn) mineBtn.style.display = (localTranscript && !curSourceIsTranscript && mode === 'ours') ? '' : 'none';
  }
  function render(status) {
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    if (barEl) barEl.style.display = status ? 'none' : 'flex';
    if (alignBtn) alignBtn.style.display = (!status && synced.length) ? '' : 'none';
    refreshMineBtn();
    if (status) {
      body.appendChild(h('div', { class: 'stardust-lyric-status', text: status }));
      // No lyrics anywhere → offer to transcribe from the audio.
      if (mode === 'off') {
        const btn = h('button', { class: 'stardust-market-btn primary', id: 'stardust-transcribe-btn', text: '🎙 Transcribe from the song' });
        btn.addEventListener('click', () => startTranscribe(btn));
        body.appendChild(btn);
        body.appendChild(h('div', { class: 'stardust-hint', text: 'Restarts the track and listens once to build word-timed lyrics. Needs a free Groq API key in the Stardust panel → Settings.' }));
      }
      return;
    }
    if (synced.length) {
      for (const l of synced) {
        const line = h('div', { class: 'stardust-lyric-line words' + (l.adOnly ? ' adlib-line' : ''), title: 'Play from here' });
        // Always split into per-word spans so we can highlight word-by-word.
        // Real timing when the line has it (enhanced LRC / NetEase yrc),
        // estimated (by word length across the line) otherwise.
        if (l.words && l.words.length) {
          l.words.forEach((w, i) => {
            line.appendChild(h('span', { class: 'w', text: w.text }));
            if (i < l.words.length - 1) line.appendChild(document.createTextNode(' '));
          });
        } else { line.textContent = l.s || '♪'; }
        // Adlibs split out of the line render as their own smaller sub-line,
        // with their own word spans: they sit after the main words in the
        // line's fill sequence, so they light word-by-word as they're sung
        // (echo adlibs follow the phrase they echo).
        if (l.ad && l.adWords && l.adWords.length) {
          const sub = h('div', { class: 'stardust-lyric-adlib' });
          sub.appendChild(document.createTextNode('('));
          l.adWords.forEach((w, i) => {
            sub.appendChild(h('span', { class: 'w', text: w.text }));
            if (i < l.adWords.length - 1) sub.appendChild(document.createTextNode(' '));
          });
          sub.appendChild(document.createTextNode(')'));
          line.appendChild(sub);
        }
        line.addEventListener('click', () => seekTo(l.t));
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
    lineEl.classList.remove('sweep', 'gap');
    lineEl.style.removeProperty('--wp');
    for (const s of lineEl.querySelectorAll('.w')) {
      if (s.className !== 'w') s.className = 'w';
      if (s.style.getPropertyValue('--wp')) s.style.removeProperty('--wp');
      s.style.removeProperty('--wd'); s.style.removeProperty('--wdel');
      s._wp = null;
    }
  }

  // Drop non-lyric bloat: the song-title line, "N Contributors"/"Translations"
  // headers, "<Title> Lyrics", "You might also like", trailing "Embed", and any
  // "(Official Music Video)"-style tag that leaked into a line.
  const alnum = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  // `scraped` = the text came from a scraped lyrics PAGE (Genius), which leaks
  // headers ("Title Lyrics", "247 Contributors") into the words. Synced
  // sources carry no headers — and a line equal to the title there IS the
  // song's hook ("Everybody needs a best friend"), never bloat.
  function isBloatLine(text, idx, titleN, scraped) {
    const s = (text || '').trim();
    if (!s) return true;
    // Credit lines (support both ':' and full-width '：', and CJK credit words).
    if (/^(lyric|lyrics|music|composed|composer|compose|arrang|produc|written|writer|words|作词|作曲|编曲|制作|词|曲|演唱|歌手|翻译|出品)\w*\s*(by)?\s*[:：]/i.test(s)) return true;
    // CJK source/credit notes, incl. parenthesized ones with no colon
    // (e.g. "（歌词来源网络）" = "lyrics source: internet").
    if (/歌词来源|歌詞來源|字幕来源|来源网络|來源網絡|上传者|后期制作|後期製作|由.{0,10}整理|翻譯|监制/.test(s)) return true;
    if (/^[（(][\s\S]{0,40}[)）]$/.test(s) && /[㐀-鿿]/.test(s)) return true; // short parenthesized CJK note
    if (!scraped) return false;
    // --- scraped-page junk only below this line ---
    const n = alnum(s);
    if (titleN && idx < 3 && (n === titleN || n === titleN + 'lyrics')) return true;
    if (/^\d+\s*contributors?\b/i.test(s)) return true;
    if (/^translations?\b/i.test(s)) return true;
    if (/you might also like/i.test(s)) return true;
    if (/\d*\s*embed$/i.test(s)) return true;          // "…123Embed"
    if (/\bget tickets\b/i.test(s)) return true;       // concert promo
    if (/^see .+ live/i.test(s)) return true;
    if (idx < 3 && /\blyrics$/i.test(s)) return true; // "Song Lyrics" header near top
    // "Title - Artist" header near the top (any dash/en-dash/full-width dash).
    if (titleN && idx < 3 && n.startsWith(titleN) && n !== titleN && n.length <= titleN.length + 30) return true;
    return false;
  }
  const stripTag = (s) => (s || '').replace(/\s*[([][^)\]]*(?:official|music\s*video|lyric|audio|visuali[sz]er|remaster|sped\s*up|slowed|reverb|extended|\bhd\b|\b4k\b|\blive\b)[^)\]]*[)\]]/gi, '').trim();

  // Split "(...)" adlibs out of a line: the main words carry the timing, the
  // adlib renders as its own smaller sub-line. Only for lines WITHOUT real
  // per-word timestamps (adlibs live in Genius/plain text; yrc timing is exact
  // and must not be re-segmented).
  function splitAdlib(l) {
    if (l.words && l.words.length && l.words[0].time != null) return;
    const s = l.s || '';
    if (!/[()（）]/.test(s)) return;
    const ads = [];
    const main = s.replace(/[（(]([^)）]{1,60})[)）]/g, (_, inner) => { ads.push(inner.trim()); return ' '; })
      .replace(/\s+/g, ' ').trim();
    if (!ads.filter(Boolean).length) return;
    if (!main) { l.adOnly = true; return; }  // the whole line IS an adlib
    l.s = main; l.words = estWords(main);
    l.ad = ads.filter(Boolean).join(' ');
    l.adWords = estWords(l.ad);              // word-filled like the main words
  }

  // Turn an LRC string into de-bloated synced lines and switch to 'ours'.
  function applySynced(text, scraped) {
    lastLrcText = text || '';
    const titleN = alnum(stripTag(np && np.title));
    // Section headers ("[Chorus]", "[Verse 2]") aren't sung — drop them from
    // the lines but keep them as STRUCTURE: the line after a header starts a
    // section, the strongest snap target when singing re-enters after a break.
    const parsed = parseLRC(text);
    const kept = [];
    let secNext = true; // the first line always starts a section
    for (const l of parsed) {
      if (/^\[[^\][]{1,40}\]$/.test((l.s || '').trim())) { secNext = true; continue; }
      if (secNext) { l.sec = true; secNext = false; }
      kept.push(l);
    }
    synced = kept.filter((l, i) => !isBloatLine(l.s, i, titleN, scraped));
    for (const l of synced) {
      const s2 = stripTag(l.s);
      // The words spans are what actually render — rebuild them if a tag came
      // off, or the stripped text would still show word by word.
      if (s2 !== l.s) { l.s = s2; l.words = estWords(s2); }
      splitAdlib(l);
    }
    plain = null; mode = 'ours'; synthMode = false;
    lastIdx = -1; curEl = null; curSpans = null;
  }

  // Record the song once (restart → listen to the end → pause), shared by
  // transcription and ⚡ word-sync. Resolves to a Uint8Array, or null.
  async function captureSong(setStatus, forKey, icon) {
    const v = playingVideo();
    if (!Visualizer.captureStart()) { setStatus('Audio capture unavailable'); return null; }
    try { if (v) { v.currentTime = 0; if (v.paused) doCommand('playpause'); } } catch {}
    const fmtT = (s) => { s = Math.max(0, s | 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    // Stop ~1.2s before the end and PAUSE, so autoplay never advances to the next
    // song (which would contaminate the recording and switch the view away).
    const endAt = (v && isFinite(v.duration) && v.duration > 2) ? v.duration - 1.2 : 240;
    await new Promise((res) => {
      const iv = setInterval(() => {
        if (!active || key !== forKey || (v && v.ended)) { clearInterval(iv); return res(); }
        const cur = v ? v.currentTime : 0;
        setStatus(icon + ' Listening… ' + fmtT(cur) + ' / ' + fmtT(endAt + 1.2));
        if (cur >= endAt) { clearInterval(iv); res(); }
      }, 400);
    });
    try { if (v && !v.paused) doCommand('playpause'); } catch {} // pause → block autoplay
    const blob = await Visualizer.captureStop();
    if (!blob || blob.size < 12000) { setStatus('Not enough audio captured — replay from the start and try again'); return null; }
    return new Uint8Array(await blob.arrayBuffer());
  }

  // Async resolution: DOM first, then the main process's network sniffer —
  // which sees every /player request and therefore always knows the id.
  async function resolveVideoId() {
    const v1 = videoIdOf();
    if (v1) return v1;
    try { return await ipcRenderer.invoke('stardust:current-videoid'); } catch { return null; }
  }
  const videoIdOf = () => {
    // 1) The player element carries the id directly on most builds.
    const pl = document.querySelector('ytmusic-player');
    const attr = pl && (pl.getAttribute('video-id') || pl.getAttribute('videoid'));
    if (attr && /^[\w-]{6,20}$/.test(attr)) return attr;
    // 2) Video thumbnails embed it: i.ytimg.com/vi/<id>/…
    const art = np && np.art;
    const am = art && art.match(/\/vi\/([\w-]{6,20})\//);
    if (am) return am[1];
    // 3) Queue anchor / page URL (only present on some pages).
    const u = currentTrackUrl();
    const m = u && u.match(/[?&]v=([\w-]+)/);
    return m ? m[1] : null;
  };

  // Background word-sync: the main process fetches the song's audio DIRECTLY
  // (no playback, takes ~1s), Whisper stamps it, and the known lyrics are
  // force-aligned — the music never stops, the timing hot-swaps in when ready.
  // Returns 'ok' | 'download' (fallback to listening) | 'fatal' (told the user).
  async function remoteWordSync(silent) {
    if (syncing || transcribing || !synced.length || !lastLrcText) return 'fatal';
    if (silent && hasWordTiming()) return 'fatal'; // manual ⚡ may re-align word-timed songs
    const vid = await resolveVideoId();
    console.log('[Stardust] word-sync start: silent=' + !!silent, 'vid=' + (vid || 'NONE'), 'realStamps=' + stampsReal);
    if (!vid && !silent) return 'download'; // silent no-id flows into the retry/badge path below
    syncing = true;
    const forKey = key;
    const savedSrc = srcEl ? srcEl.textContent : '';
    if (srcEl) srcEl.textContent = '⚡ word-syncing…';
    let res = null;
    try {
      if (vid) res = await ipcRenderer.invoke('stardust:wordsync', {
        videoId: vid, title: np.title, artist: np.artist, album: np.album,
        duration: np.duration, lyrics: lastLrcText, realStamps: stampsReal
      });
    } catch {}
    syncing = false;
    console.log('[Stardust] word-sync result:', res ? (res.error || ('ok coverage=' + Math.round((res.coverage || 0) * 100) + '%')) : 'no-response');
    if (!active || key !== forKey) return 'ok'; // track changed — result is cached for replay
    if (res && res.syncedLyrics) {
      applySynced(res.syncedLyrics);
      setSourceLabel('aligned');
      render(); sync();
      toast('⚡ Word-synced — ' + Math.round((res.coverage || 0) * 100) + '% of words matched');
      return 'ok';
    }
    if (srcEl) srcEl.textContent = savedSrc;
    const e2 = res && res.error;
    if (e2 === 'download' && !silent) return 'download'; // manual ⚡ falls back to listening
    // Lyrics that won't align to the audio → transcribe instead; Whisper's
    // words become the lyrics, word-timed. For line-stamped sources this only
    // happens when the match was DIRE (<35% — the database has the wrong
    // words, common on KuGou English entries); Genius text falls back always.
    const cov = (res && res.coverage) || 0;
    if (e2 === 'align-failed' && (!stampsReal || cov < 0.35) && !autoTried.has(forKey)) {
      autoTried.add(forKey);
      setTimeout(() => autoTranscribe(forKey, false), 800);
      return 'fatal';
    }
    if (silent) {
      // Auto-sync must never fail INVISIBLY again: transient errors retry with
      // backoff (Groq's per-hour limit gets a longer one), and the badge says
      // what happened either way.
      const transient = e2 === 'download' || e2 === 'network' || e2 === 'engine' || e2 === 'rate' || !e2;
      const tries = autoRetries.get(forKey) || 0;
      if (transient && tries < 2) {
        autoRetries.set(forKey, tries + 1);
        const delay = e2 === 'rate' ? 70000 : 20000;
        setTimeout(() => { if (active && key === forKey && !hasWordTiming() && !syncing && !transcribing) remoteWordSync(true); }, delay);
        if (srcEl) srcEl.textContent = savedSrc + ' · ⚡ retrying…';
      } else if (srcEl) {
        srcEl.textContent = savedSrc + ' · ⚡ ' + (
          e2 === 'align-failed' ? "couldn't match the audio"
            : e2 === 'download' ? 'audio fetch failed — press ⚡ to listen-sync'
              : e2 === 'rate' ? 'Groq limit reached — press ⚡ later'
                : e2 === 'no-key' || e2 === 'bad-key' ? 'needs a Groq key'
                  : 'sync failed — press ⚡ to retry');
      }
      return e2 === 'align-failed' || e2 === 'no-key' || e2 === 'bad-key' ? 'fatal' : 'download';
    }
    if (!silent) {
      toast(e2 === 'no-key' ? 'Add a free Groq API key in the Stardust panel first'
        : e2 === 'bad-key' ? 'That Groq API key was rejected — check Settings'
          : e2 === 'align-failed' ? 'Could not match these lyrics to this audio (different version?)'
            : e2 === 'rate' ? 'Groq hourly limit reached — try again in a bit'
              : e2 === 'network' ? 'Network error reaching the transcription service'
                : 'Word-sync failed — try again');
    }
    return e2 === 'align-failed' || e2 === 'no-key' || e2 === 'bad-key' ? 'fatal' : 'download';
  }

  // ⚡ Word-sync button: instant background sync first; only if the direct
  // audio fetch is unavailable does it fall back to listening once.
  async function startAlign() {
    const r = await remoteWordSync(false);
    if (r !== 'download') return;
    toast('Direct audio fetch unavailable — listening once instead');
    alignByListening();
  }

  // Fallback: force-align by playing the song through once (original flow).
  async function alignByListening() {
    if (transcribing || !synced.length || !lastLrcText) return;
    transcribing = true;
    const forKey = key;
    const trackTitle = np && np.title, trackArtist = np && np.artist, trackAlbum = np && np.album, trackDur = np && np.duration;
    const savedLrc = lastLrcText;
    synced = []; plain = null; synthMode = false; mode = 'searching';
    render('⚡ Preparing to listen…'); sync();
    const setStatus = (s2) => { const el = body && body.querySelector('.stardust-lyric-status'); if (el) el.textContent = s2; };
    const audio = await captureSong(setStatus, forKey, '⚡');
    transcribing = false;
    const restore = () => { if (active && key === forKey) { applySynced(savedLrc); render(); sync(); } };
    if (!audio) { restore(); return; }
    setStatus('⚡ Aligning the words to the audio… (10–30s)');
    let res = null;
    try { res = await ipcRenderer.invoke('stardust:align', { title: trackTitle, artist: trackArtist, album: trackAlbum, duration: trackDur, audio, lyrics: savedLrc, realStamps: stampsReal }); } catch {}
    if (res && res.syncedLyrics) {
      const nowSame = active && key === forKey;
      if (nowSame) {
        applySynced(res.syncedLyrics);
        setSourceLabel('aligned');
        // Restart from 0 and play so the word-synced karaoke actually runs.
        try { const vv = playingVideo(); if (vv) { vv.currentTime = 0; if (vv.paused) doCommand('playpause'); } } catch {}
        render(); sync();
      }
      toast('⚡ Word-synced — ' + Math.round((res.coverage || 0) * 100) + '% of words matched' + (res.shared ? ' · shared with the community' : ''));
    } else {
      const e2 = res && res.error;
      toast(e2 === 'no-key' ? 'Add a free Groq API key in the Stardust panel first'
        : e2 === 'bad-key' ? 'That Groq API key was rejected — check Settings'
          : e2 === 'align-failed' ? 'Could not match these lyrics to this audio (different version?)'
            : e2 === 'network' ? 'Network error reaching the transcription service'
              : 'Word-sync failed — try again');
      restore();
    }
  }

  // Record the song once and transcribe it into word-timed lyrics — but try
  // the DIRECT audio fetch first, so there's usually nothing to sit through.
  async function startTranscribe(btn) {
    if (transcribing || syncing) return;
    transcribing = true; if (btn) btn.disabled = true;
    const forKey = key;
    // Snapshot the song NOW — np gets reassigned to the next track if autoplay
    // advances, and we must save the transcript under THIS song.
    const trackTitle = np && np.title, trackArtist = np && np.artist, trackAlbum = np && np.album, trackDur = np && np.duration;
    const setStatus = (s2) => { const el = body && body.querySelector('.stardust-lyric-status'); if (el) el.textContent = s2; };
    let res = null, captured = false;
    const vid = await resolveVideoId();
    if (vid) {
      setStatus('🎙 Fetching the song audio…');
      try { res = await ipcRenderer.invoke('stardust:wordsync', { videoId: vid, title: trackTitle, artist: trackArtist, album: trackAlbum, duration: trackDur }); } catch {}
      if (res && res.error === 'download') res = null; // direct fetch failed → listen
    }
    if (!res) {
      captured = true;
      const audio = await captureSong(setStatus, forKey, '🎙');
      if (!audio) { transcribing = false; reEnableBtn(); return; }
      setStatus('Transcribing… (about 10–30s)');
      try {
        res = await ipcRenderer.invoke('stardust:transcribe', { title: trackTitle, artist: trackArtist, album: trackAlbum, duration: trackDur, audio });
      } catch {}
    }
    transcribing = false;
    if (res && (res.syncedLyrics || res.plainLyrics)) {
      // Show now if we're still on that song.
      const nowSame = active && key === forKey;
      if (nowSame) {
        if (res.syncedLyrics) { applySynced(res.syncedLyrics); localTranscript = res.syncedLyrics; }
        else { synced = []; plain = res.plainLyrics; mode = 'ours'; }
        curSourceIsTranscript = true;
        // Deliberately transcribed → this song prefers the transcription.
        try { ipcRenderer.invoke('stardust:transcript-pref', { title: trackTitle, artist: trackArtist, pref: 'transcript' }); } catch {}
        setSourceLabel('transcript');
        // Only the LISTEN path pauses near the end (to stop autoplay) — after
        // it, restart from 0 and play so the karaoke actually runs. The direct
        // path never touched playback.
        if (captured) { try { const vv = playingVideo(); if (vv) { vv.currentTime = 0; if (vv.paused) doCommand('playpause'); } } catch {} }
        render(); sync();
      }
      const shared = res.shared ? ' · shared with the community' : '';
      toast(nowSame ? '✓ Lyrics transcribed — playing' + shared : '✓ Transcribed "' + (trackTitle || 'song') + '"' + shared);
    } else {
      const e = res && res.error;
      const msg = (e === 'no-key') ? 'Add a free Groq API key in the Stardust panel to transcribe'
        : (e === 'bad-key') ? 'That Groq API key was rejected — check it in Settings'
          : (e === 'empty') ? 'Could not make out the vocals on this track'
            : (e === 'network') ? 'Network error reaching the transcription service'
              : 'Transcription failed — try again';
      if (active && key === forKey) setStatus(msg); else toast(msg);
      reEnableBtn();
    }
  }
  function reEnableBtn() { const b = body && body.querySelector('#stardust-transcribe-btn'); if (b) b.disabled = false; }

  function fetchFor(track) {
    if (!track || !track.title) return;
    const k = track.title + '|' + track.artist; if (k === key) return;
    key = k; np = track; synced = []; plain = null; attempts = 0; lastIdx = -1;
    mode = 'searching'; curEl = null; curSpans = null;
    nudge(0);    // the sync offset is per-song
    resetHear(); // fresh hearing model per song (voiced fraction, pace, floor)
    stampsReal = false; microOff = 0; localTranscript = null; curSourceIsTranscript = false;
    setSourceLabel(null);
    render('Searching lyrics…'); sync(); doFetch();
  }
  async function doFetch(skipTranscript) {
    attempts++;
    const forKey = key;
    const hadDuration = np.duration > 0;
    let res = null;
    try { res = await ipcRenderer.invoke('stardust:lyrics', { artist: np.artist, title: np.title, album: np.album, duration: np.duration, skipTranscript: !!skipTranscript }); } catch {}
    if (!active || key !== forKey) return;   // track changed while awaiting
    if (skipTranscript) {
      if (res && (res.syncedLyrics || res.plainLyrics)) {
        // The user prefers these database lyrics — remember that, but KEEP the
        // transcription (🎙★ switches back; database words can be wrong too).
        try { ipcRenderer.invoke('stardust:transcript-pref', { title: np.title, artist: np.artist, pref: 'db' }); } catch {}
        toast('✓ Found database lyrics — 🎙★ switches back to yours');
      } else {
        // Nothing better out there — put the transcription back.
        toast('No database lyrics found — keeping the transcription');
        doFetch(false);
        return;
      }
    }
    const titleN = alnum(stripTag(np.title));
    let synthed = false;
    curSourceIsTranscript = !!(res && res.source === 'transcript');
    // Know whether this song has its own transcription (shows the 🎙★ switch).
    ipcRenderer.invoke('stardust:transcript-get', { title: np.title, artist: np.artist })
      .then((lrc) => { if (key === forKey) { localTranscript = lrc || null; refreshMineBtn(); } })
      .catch(() => {});
    const scraped = !!(res && res.source === 'genius');
    if (res && res.syncedLyrics) {
      applySynced(res.syncedLyrics, scraped);
      stampsReal = res.kind === 'line' || res.kind === 'word'; // human timing → alignment may trust it
    } else if (res && res.plainLyrics) {
      const clean = res.plainLyrics.split('\n').filter((l, i) => !isBloatLine(l, i, titleN, scraped)).map(stripTag).join('\n');
      // Give plain lyrics timing too: synthesize line timestamps so they get
      // line + word highlighting (energy-driven), instead of sitting still.
      const lrc = synthFromPlain(clean);
      if (lrc) { applySynced(lrc, scraped); synthed = true; }
      else { synced = []; plain = clean; mode = 'ours'; }
    }
    // Only retry if the duration wasn't ready yet (metadata still loading) —
    // otherwise a genuine miss shouldn't loop for 20s+. One quick retry max.
    else if (!hadDuration && attempts < 2) { setTimeout(() => { if (active && key === forKey) doFetch(); }, 1200); return; }
    else { synced = []; plain = null; mode = 'off'; }
    // Synthesized timing (Genius, or synthesized-from-plain) has no real
    // timestamps, so we DRIVE progression by the actual vocal energy.
    synthMode = (synthed || !!(res && res.kind === 'synth')) && synced.length > 0;
    if (synthMode) buildSynthModel();
    lastIdx = -1; curEl = null; curSpans = null; sylAcc = 0;
    setSourceLabel(res && res.source, res || null);
    render(statusText()); sync();
    // Auto word-sync: when the lyrics lack real word timing and a Groq key is
    // set, fetch + align in the background — no interaction, music keeps
    // playing, the timing upgrades itself mid-song.
    console.log('[Stardust] lyrics:', (res && res.source) || 'none', (res && res.kind) || '-',
      'wordTimed=' + hasWordTiming(), 'keySet=' + !!(settings && settings.transcribeKey),
      'auto=' + (settings && settings.autoWordSync !== false));
    if (settings && settings.transcribeKey && settings.autoWordSync !== false) {
      if (synced.length && !hasWordTiming()) {
        console.log('[Stardust] auto-sync scheduled in 2.5s');
        setTimeout(() => { if (active && key === forKey && !hasWordTiming()) remoteWordSync(true); }, 2500);
      } else if (res && res.source === 'transcript' && !res.pinned && synced.length) {
        // Raw transcripts carry Whisper's misheard TEXT. If the databases have
        // the real words, swap to them and align — but the transcription file
        // is KEPT (🎙★ switches back), and a user-pinned transcript is never
        // touched.
        setTimeout(async () => {
          if (!(active && key === forKey)) return;
          let db = null;
          try { db = await ipcRenderer.invoke('stardust:lyrics', { artist: np.artist, title: np.title, album: np.album, duration: np.duration, skipTranscript: true }); } catch {}
          if (!(active && key === forKey) || !db || !db.syncedLyrics || db.kind === 'synth') return;
          // Only swap an ALIGNED cache for a strictly better (word-timed) DB
          // source; raw transcripts upgrade to any real DB lyrics.
          const aligned = res.syncedLyrics && res.syncedLyrics.includes('stardust-aligned-v2');
          if (aligned && db.kind !== 'word') return;
          try { ipcRenderer.invoke('stardust:transcript-pref', { title: np.title, artist: np.artist, pref: 'db' }); } catch {}
          applySynced(db.syncedLyrics);
          stampsReal = db.kind === 'line' || db.kind === 'word';
          setSourceLabel(db.source, db);
          render(); sync();
          if (!hasWordTiming()) remoteWordSync(true);
        }, 2500);
      } else if (mode === 'off' && np.duration > 0 && np.duration < 720 && !autoTried.has(forKey)) {
        // NOTHING found anywhere → transcribe automatically in the background
        // (direct audio fetch — no listening). Word timing on every song.
        autoTried.add(forKey);
        setTimeout(() => autoTranscribe(forKey, true), 1800);
      }
    }
  }

  // Background transcription via the direct audio fetch. Used when no lyrics
  // exist anywhere, and as the fallback when Genius text won't align to the
  // audio (spoken/atypical vocals) — Whisper's own words become the lyrics.
  async function autoTranscribe(forKey, requireOff) {
    if (!(active && key === forKey) || transcribing || syncing) return;
    if (requireOff && mode !== 'off') return;
    const vid = await resolveVideoId();
    if (!vid) return;
    syncing = true;
    const el = body && body.querySelector('.stardust-lyric-status');
    if (el) el.textContent = 'No lyrics anywhere — 🎙 transcribing this song in the background…';
    else if (srcEl) srcEl.textContent = '🎙 transcribing…';
    let r = null;
    try { r = await ipcRenderer.invoke('stardust:wordsync', { videoId: vid, title: np.title, artist: np.artist, album: np.album, duration: np.duration }); } catch {}
    syncing = false;
    if (!(active && key === forKey)) return;
    if (r && r.syncedLyrics) {
      applySynced(r.syncedLyrics);
      localTranscript = r.syncedLyrics; curSourceIsTranscript = true;
      setSourceLabel('transcript');
      render(); sync();
      toast('🎙 Transcribed automatically' + (r.shared ? ' · shared with the community' : ''));
    } else if (r && r.plainLyrics && mode === 'off') {
      synced = []; plain = r.plainLyrics; mode = 'ours';
      setSourceLabel('transcript');
      render(); sync();
    } else {
      const el2 = body && body.querySelector('.stardust-lyric-status');
      if (el2) el2.textContent = statusText() || '';
      setSourceLabel(lastSource, lastMeta);
    }
  }
  // Turn plain (untimed) lyrics into an LRC by spreading lines across the track
  // (weighted by syllables) so they can be highlighted line + word by listening.
  function synthFromPlain(text) {
    const lines = (text || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const dur = np && np.duration > 0 ? np.duration : 0;
    if (!dur || lines.length < 2) return null;
    const sylOf = (s) => ((s || '').toLowerCase().match(/[aeiouy]+/g) || []).length;
    const weights = lines.map((l) => Math.max(0.6, sylOf(l)));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const start = dur * 0.04, span = dur * 0.9;
    let acc = 0; const out = [];
    for (let i = 0; i < lines.length; i++) {
      const t = start + span * (acc / total);
      const mm = Math.floor(t / 60), ss = (t - mm * 60).toFixed(2);
      out.push('[' + String(mm).padStart(2, '0') + ':' + ss.padStart(5, '0') + ']' + lines[i]);
      acc += weights[i];
    }
    return out.join('\n');
  }
  // Per-line syllable weights for energy-driven progression of synth lyrics.
  function buildSynthModel() {
    lineSyl = synced.map((l) => {
      const text = ((l.s || '') + ' ' + (l.ad || '')).toLowerCase().replace(/\[[^\]]*\]/g, '');
      return Math.max(0.6, text.match(/[aeiouy]+/g)?.length || 0.6);
    });
    totalSyl = 0; cumSyl = []; secSyl = [];
    for (let i = 0; i < lineSyl.length; i++) {
      cumSyl.push(totalSyl);
      if (synced[i].sec) secSyl.push(totalSyl); // section starts = snap anchors
      totalSyl += lineSyl[i];
    }
    totalSyl = totalSyl || 1;
  }

  // Per-tick driver: sample the audio ONCE, keep the hearing model fed even
  // when the lyrics tab is closed (so re-opening lands in the right place),
  // then advance + paint whatever timing mode is active.
  function tick() {
    if (!active || !synced.length) return;
    const v = playingVideo(); if (!v) return;
    const t = (v.currentTime || 0) + offset + LOOKAHEAD; // sync-offset + perceptual lead
    let dt = t - hear.lastT; hear.lastT = t;
    if (hear.elapsed > 0 && Math.abs(dt) > 3) {
      // SEEK — re-anchor everything the model accumulated to the new position
      // (it never rewound before, which froze synth-mode highlights after a
      // line-click). Keep the observed voiced fraction, rescale to t.
      const vf = Math.max(0.3, Math.min(0.95, (29 + hear.voiced) / (40 + hear.elapsed)));
      hear.elapsed = Math.max(0, t);
      hear.voiced = Math.max(0, t * vf);
      hear.silent = 0; hear.prevVoice = false;
      if (synthMode && totalSyl > 1) {
        const dur = (isFinite(v.duration) && v.duration > 0) ? v.duration : 210;
        sylAcc = Math.min(1, Math.max(0, t / dur)) * totalSyl;
      }
      lastIdx = -2; // force the line to re-resolve immediately
    }
    if (!(dt > 0) || dt > 1.5) dt = 0;       // first frame / pause / seek
    const L = listen();
    hear.resumed = false;
    if (dt > 0 && L.e >= 0) {
      hear.elapsed += dt;
      if (L.voice) {
        hear.resumed = !hear.prevVoice && hear.silent > 2.5;
        hear.voiced += dt; hear.silent = 0;
        hear.eAvg += (L.e - hear.eAvg) * Math.min(1, dt * 0.35); // this song's typical voiced energy
      } else {
        hear.silent += dt;
      }
      hear.prevVoice = L.voice;
    }
    if (synthMode && lineSyl && cumSyl) advanceSynth(t, dt, v, L);
    paint(t, v, L);
  }

  // Synthesized (Genius / from-plain) timing has no real timestamps, so the
  // LISTENING model drives it: syllables advance only while a voice is present,
  // paced so the words finish exactly when the singing is predicted to end
  // (from the observed voiced fraction), and anchored to voiced-time-HEARD
  // rather than wall time — so long intros, solos and outros hold still
  // instead of drifting, and the pace self-corrects as the song plays.
  function advanceSynth(t, dt, v, L) {
    const dur = (isFinite(v.duration) && v.duration > 0) ? v.duration : 210;
    if (L.e < 0) { sylAcc = Math.min(1, Math.max(0, t / dur)) * totalSyl; return; } // can't hear -> even spread
    const remaining = Math.max(0, dur - t);
    // Voiced fraction of the song: observed so far, blended with a 0.72 prior
    // (~40s pseudo-observation) so an intro can't crater the estimate early.
    const vfEst = Math.max(0.3, Math.min(0.95, (29 + hear.voiced) / (40 + hear.elapsed)));
    const predVoiced = Math.max(20, hear.voiced + remaining * vfEst);
    const rate = totalSyl / predVoiced;      // syllables per VOICED second
    if (dt > 0 && L.voice) {
      // Modulate around THIS song's average voiced energy so the mean pace is
      // exactly the learned rate — a fixed (a + b*e) form ran ~15% slow and
      // made the highlight trail the singer.
      const mod = Math.max(0.6, Math.min(1.5, 1 + 0.6 * (L.e - hear.eAvg)));
      sylAcc += dt * rate * mod;
      if (L.onset > 0) sylAcc += 0.45 * L.onset; // syllable attacks carry more weight
    }
    // Singing resumed after a real instrumental break -> a structural boundary.
    // Prefer snapping to a SECTION start ([Verse]/[Chorus] positions survive as
    // l.sec) with a generous tolerance; fall back to the nearest line start.
    if (hear.resumed && cumSyl.length > 2) {
      const nearest = (arr, tol) => {
        let best = null, bd = Infinity;
        for (const c of arr) { const d = Math.abs(c - sylAcc); if (d < bd) { bd = d; best = c; } }
        return bd <= tol ? best : null;
      };
      const snap = (secSyl && secSyl.length > 1 ? nearest(secSyl, totalSyl * 0.12 + 6) : null)
        ?? nearest(cumSyl, totalSyl * 0.06 + 4);
      if (snap != null) sylAcc = snap;
    }
    // Anchor to voiced-time-heard (NOT wall time). Asymmetric band: lagging a
    // little reads fine, running ahead of the singer reads terribly.
    const anchor = Math.min(totalSyl, hear.voiced * rate);
    sylAcc = Math.max(sylAcc, anchor - totalSyl * 0.08);
    sylAcc = Math.min(sylAcc, anchor + totalSyl * 0.08);
    sylAcc = Math.min(totalSyl, Math.max(0, sylAcc));
  }

  function paint(t, v, L) {
    if (!box || !body) return;
    // If YTM re-rendered the tab and dropped our box, re-attach it instead of
    // freezing (this was leaving the words static).
    if (!box.isConnected) {
      const h0 = tabHost();
      if (h0 && tabSelected()) { h0.classList.add('stardust-lyrics-on'); if (box.parentElement !== h0) h0.appendChild(box); host = h0; }
      else return;
    }
    const kids = body.children;

    // Synthesized timing: render the line/word position advanceSynth computed.
    if (synthMode && lineSyl && cumSyl) {
      const target = sylAcc;
      let sidx = 0;
      for (let i = 0; i < cumSyl.length; i++) { if (cumSyl[i] <= target) sidx = i; else break; }
      if (sidx !== lastIdx) {
        if (curEl) { curEl.classList.remove('active'); clearWords(curEl); }
        lastIdx = sidx; curEl = kids[sidx] || null;
        if (curEl) { curEl.classList.add('active'); curSpans = curEl.querySelectorAll('.w'); paintLineDepth(kids, sidx); autoScroll(curEl); }
      }
      if (!curEl || !curSpans || !curSpans.length) return;
      const words = (synced[sidx].words || []).concat(synced[sidx].adWords || []);
      const lineTot = words.reduce((a, w) => a + (((w.text || '').toLowerCase().match(/[aeiouy]+/g) || []).length || 1), 0) || 1;
      const wt = ((target - cumSyl[sidx]) / lineSyl[sidx]) * lineTot; // syllables into this line -> word space
      let acc = 0;
      for (let i = 0; i < curSpans.length; i++) {
        const ws = ((words[i] && words[i].text || '').toLowerCase().match(/[aeiouy]+/g) || []).length || 1;
        setWordFill(curSpans[i], Math.min(1, Math.max(0, (wt - acc) / ws)));
        acc += ws;
      }
      return;
    }

    // Which line is current?
    let idx = -1;
    for (let i = 0; i < synced.length; i++) { if (synced[i].t <= t + 0.05) idx = i; else break; }

    // Line changed: move .active, reset the old line, scroll, and precompute
    // the new line's per-word timing once (cheap per-frame after).
    if (idx !== lastIdx) {
      if (curEl) { curEl.classList.remove('active'); curEl.style.removeProperty('--wp'); clearWords(curEl); }
      lastIdx = idx;
      curEl = idx >= 0 ? kids[idx] : null;
      curSpans = curTiming = null;
      animBase = null;
      if (curEl) {
        curEl.classList.add('active');
        curSpans = curEl.querySelectorAll('.w');
        paintLineDepth(kids, idx);
        const line = synced[idx];
        const lineEnd = synced[idx + 1] ? synced[idx + 1].t
          : (isFinite(v.duration) && v.duration > line.t ? v.duration : line.t + 6);
        const real = line.words && line.words.length && line.words[0].time != null;
        curMode = real ? 'real' : 'est';
        if (real) {
          curTiming = computeWordTiming(line, lineEnd);
        } else {
          // Weight words by syllables, plus how singers actually phrase:
          // a breath after punctuation, and the final word of a line held long.
          // Adlib words are part of the sequence — they're sung too.
          const ws2 = (line.words || []).concat(line.adWords || []);
          curSyl = ws2.map((w, i2) => {
            let syl = ((w.text || '').toLowerCase().match(/[aeiouy]+/g) || []).length || 1;
            if (/[,;:.!?…—–-]$/.test(w.text || '')) syl += 0.6;
            if (i2 === ws2.length - 1) syl *= 1.35;
            return syl;
          });
          curSylTotal = curSyl.reduce((a, b) => a + b, 0) || 1;
          const win = Math.max(0.5, lineEnd - line.t);
          // LEARN the song's sung pace from the line's REAL timestamps: a short
          // line-to-line gap means the line is sung throughout, so syllables /
          // window samples the true rate (rap ~6/s, ballad ~2.5/s). EMA per song.
          if (win <= 8 && curSylTotal >= 3) {
            hear.rate += (Math.min(7, Math.max(1.8, curSylTotal / win)) - hear.rate) * 0.25;
          }
          // Sing the line at the learned pace; never stretch across a gap.
          curSungDur = Math.max(0.5, Math.min(win, curSylTotal / hear.rate));
          lastCT = t; sylPtr = 0;
        }
        autoScroll(curEl);
      }
    }
    if (!curEl || !curSpans || !curSpans.length) return;
    const line = synced[idx];

    if (curMode === 'real' && curTiming) {
      // Live onset phase-lock: a vocal attack near a scheduled word start
      // means that word is being sung NOW — nudge a smoothed correction so
      // the fill locks onto the real singing instead of the schedule.
      if (L && L.e >= 0 && L.voice && L.onset > 0.15) {
        const tRaw = t - LOOKAHEAD;
        let best = null, bd = 0.4;
        for (const tm of curTiming) {
          const d = Math.abs(tm.start - tRaw);
          if (d < bd) { bd = d; best = tm.start; }
        }
        if (best != null) {
          microOff += ((best - tRaw) - microOff) * 0.25;
          microOff = Math.max(-0.45, Math.min(0.45, microOff));
        }
      }
      const te = t + microOff;
      const rate = v.playbackRate || 1;
      const paused = !!v.paused;
      if (box.classList.contains('sd-paused') !== paused) box.classList.toggle('sd-paused', paused);
      if (!paused) {
        // (Re)build the schedule on line entry, seek, tempo change, or drift
        // (buffering / large phase-lock correction). Otherwise the GPU runs it.
        const expected = animBase && animBase.el === curEl
          ? animBase.te + ((performance.now() - animBase.wall) / 1000) * animBase.rate
          : null;
        if (expected == null || animBase.rate !== rate || Math.abs(expected - te) > 0.25) {
          scheduleWordAnims(te, rate);
        }
      }
      markGap(t, curTiming.length ? curTiming[curTiming.length - 1].end : line.t, idx, v);
      return;
    }
    if (!curSyl) return;

    // Estimated timing, driven by LISTENING: advance the sung-syllable pointer
    // at the song's LEARNED pace while a voice is active (so it holds through
    // instrumental gaps mid-line), snapping forward on real vocal onsets. The
    // clock target — also at the learned pace — bounds drift to a band scaled
    // to the line length.
    let dt = t - lastCT; lastCT = t;
    if (dt < 0 || dt > 1) { dt = 0; sylPtr = 0; } // seek/pause -> resync
    const timeProg = Math.min(1, Math.max(0, (t - line.t) / curSungDur));
    const timeTarget = timeProg * curSylTotal;
    if (L.e < 0) {
      sylPtr = timeTarget; // no audio -> clock
    } else {
      if (L.voice) sylPtr += dt * hear.rate * Math.max(0.6, Math.min(1.5, 1 + 0.6 * (L.e - hear.eAvg))); // unbiased pace
      if (L.voice && L.onset > 0) sylPtr += Math.min(0.9, 0.4 + 0.6 * L.onset); // snap on attacks
      // Catch up to the clock fast when behind (lag is the visible failure),
      // drift back gently when ahead.
      sylPtr += (timeTarget - sylPtr) * (sylPtr < timeTarget ? 0.10 : 0.02);
      const band = Math.min(3.2, 1.5 + curSylTotal * 0.15);
      sylPtr = Math.max(sylPtr, timeTarget - band);
      sylPtr = Math.min(sylPtr, timeTarget + band);
    }
    sylPtr = Math.min(curSylTotal, Math.max(0, sylPtr));
    let acc = 0;
    for (let i = 0; i < curSpans.length; i++) {
      const s = curSyl[i] || 1;
      setWordFill(curSpans[i], Math.min(1, Math.max(0, (sylPtr - acc) / s)));
      acc += s;
    }
    markGap(t, line.t + curSungDur, idx, v);
  }

  // A "♪" pulse on the active line during a long instrumental wait before the
  // next line, so a finished line doesn't read as frozen.
  function markGap(t, sungEnd, idx, v) {
    if (!curEl) return;
    const nextT = synced[idx + 1] ? synced[idx + 1].t : (isFinite(v.duration) ? v.duration : sungEnd);
    const gap = nextT - sungEnd > 4 && t > sungEnd + 0.8 && t < nextT - 0.5;
    if (curEl.classList.contains('gap') !== gap) curEl.classList.toggle('gap', gap);
  }

  // Auto-scroll the active line to center — unless the user is scrolling the
  // lyrics themselves right now (resumes ~4s after their last scroll).
  function autoScroll(el) {
    if (Date.now() < userScrollUntil) return;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
  }

  // Depth-of-field: lines blur/dim progressively with distance from the
  // active line; already-sung lines dim without blur (beautiful-lyrics look).
  function paintLineDepth(kids, idx) {
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      const d = idx < 0 ? 2 : Math.min(4, Math.abs(i - idx));
      if (el._d !== d) { el.setAttribute('data-d', d); el._d = d; }
      const sung = idx >= 0 && i < idx;
      if (el._sung !== sung) { el.classList.toggle('sung-line', sung); el._sung = sung; }
    }
  }

  // Pre-schedule the active line's word fills as CSS ANIMATIONS: the GPU
  // sweeps every word continuously at display refresh rate — no 32ms tick
  // quantization — with negative delays entering mid-word after a seek.
  function scheduleWordAnims(te, rate) {
    if (!curSpans || !curTiming) return;
    for (let i = 0; i < curSpans.length; i++) {
      const el = curSpans[i], tm = curTiming[i];
      if (!tm) continue;
      el.className = 'w';
      el.style.removeProperty('--wp');
      void el.offsetWidth; // reflow so re-adding the class restarts the animation
      el.style.setProperty('--wd', (Math.max(0.08, (tm.end - tm.start)) / rate).toFixed(3) + 's');
      el.style.setProperty('--wdel', ((tm.start - te) / rate).toFixed(3) + 's');
      el.className = 'w sched';
    }
    animBase = { el: curEl, te, wall: performance.now(), rate };
  }

  // Build per-word [start,end] times for a line. Uses real timestamps when the
  // line has them (enhanced LRC / NetEase yrc); otherwise estimates each word's
  // duration from its length at a natural pace and, crucially, lets the words
  // FINISH within the sung portion instead of being stretched across a long gap
  // to the next line — so word-by-word keeps working before instrumental breaks.
  function computeWordTiming(line, lineEnd) {
    const words = line.words || [];
    if (!words.length) return [];
    if (words[0].time != null) {
      return words.map((w, i) => {
        const next = (words[i + 1] && words[i + 1].time != null) ? words[i + 1].time : Math.min(lineEnd, w.time + 1.2);
        // A long gap to the next word is a pause AFTER this word, not a
        // 2s-long word — cap the sweep so the word completes at singing pace.
        return { start: w.time, end: Math.min(next, w.time + Math.max(0.35, 0.12 + 0.07 * (w.text || '').length)) };
      });
    }
    // Weight each word by SYLLABLES (vowel groups) — closer to how long a word
    // is actually sung than raw character count — plus a small per-word floor.
    const PER_SYL = 0.34, BASE = 0.16, MIN_W = 0.26;
    const durs = words.map((w) => {
      const syl = ((w.text || '').toLowerCase().match(/[aeiouy]+/g) || []).length || 1;
      return Math.max(MIN_W, BASE + syl * PER_SYL);
    });
    const natural = durs.reduce((a, b) => a + b, 0);
    const window = Math.max(0.5, lineEnd - line.t);
    // Scale to the line window, but clamped: compress busy lines (down to 0.5x),
    // stretch a little to better fill the sung time (up to 1.5x), and NEVER
    // stretch across a long instrumental gap (the 1.5x cap means the words
    // finish at a natural pace and then hold lit until the next line).
    const scale = Math.max(0.5, Math.min(1.5, window / natural));
    let acc = line.t; const out = [];
    for (const d of durs) { const s = acc; const e = acc + d * scale; out.push({ start: s, end: e }); acc = e; }
    return out;
  }
  // Every active word uses the same continuous-fill style; only --wp changes.
  function setWordFill(el, f) {
    if (f > 0 && f < 1) f = Math.pow(f, 0.8); // fast attack, easing hold — matches sung articulation
    const cls = (f > 0 && f < 1) ? 'w cur on' : 'w cur'; // 'on' = the word being sung right now (pop)
    if (el.className !== cls) el.className = cls;
    const pct = (f * 100).toFixed(1) + '%';
    if (el._wp !== pct) { el.style.setProperty('--wp', pct); el._wp = pct; }
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
  const isAd = !!document.querySelector(
    '.ad-showing, .ytp-ad-player-overlay, ytmusic-player[player-ui-state_="AD"], .ytp-ad-text'
  );
  return {
    title: title || 'YouTube Music',
    artist: parts[0] || '',
    album: parts[1] || '',
    art: img ? img.src : '',
    playing: !video.paused && !video.ended,
    position: Math.floor(video.currentTime || 0),
    duration: Math.floor(video.duration || 0),
    isAd,
    // A "real" music track we can trust for stats/lyrics: not an ad, has a
    // parsed title (not the placeholder) and a known duration.
    isTrack: !isAd && !!title && title !== 'YouTube Music' && (video.duration || 0) > 0,
    accent: reactiveAccent || (settings && settings.accentOverride) || (activeTheme && activeTheme.accent) || '#8b5cff'
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

  // Only react to genuine track changes — ignore ads and the placeholder so
  // lyrics keep the current song and stats don't log junk.
  const track = `${np.title}|${np.artist}`;
  if (track !== lastTrack && np.isTrack) {
    lastTrack = track;
    AmbientGlow.onTrack(np);
    ReactiveTheme.onTrack(np);
    Crossfade.onTrack(np);
    Lyrics.onTrack(np);
  }

  const sig = `${track}|${np.playing}|${np.position}`;
  if (sig !== lastSig) {
    lastSig = sig;
    ipcRenderer.send('stardust:nowplaying', np);
  }
}
let lastTrack = '';

// Click the first element inside the player bar whose aria-label/title matches.
function clickByLabel(re) {
  const bar = q('ytmusic-player-bar'); if (!bar) return false;
  for (const el of bar.querySelectorAll('button, tp-yt-paper-icon-button, yt-button-shape')) {
    const lbl = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    if (lbl && re.test(lbl)) { try { el.click(); return true; } catch {} }
  }
  return false;
}
// Best-effort: current watch URL for the playing track (for "copy link").
function currentTrackUrl() {
  const sel = document.querySelector('ytmusic-player-queue-item[selected] a[href*="watch?v="], ytmusic-player-queue-item[play-button-state="playing"] a[href*="watch?v="]');
  const href = sel && sel.getAttribute('href');
  const m = href && href.match(/[?&]v=([\w-]+)/);
  if (m) return 'https://music.youtube.com/watch?v=' + m[1];
  const u = location.href.match(/[?&]v=([\w-]+)/);
  return u ? 'https://music.youtube.com/watch?v=' + u[1] : null;
}
function toast(msg) {
  let t = document.getElementById('stardust-toast');
  if (!t) { t = h('div', { id: 'stardust-toast' }); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

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
    case 'like':
      toast(clickByLabel(/^(un)?like\b|thumbs up/i) ? '👍 Like' : 'Like unavailable');
      break;
    case 'dislike':
      toast(clickByLabel(/dislike|thumbs down/i) ? '👎 Disliked' : 'Dislike unavailable');
      break;
    case 'shuffle':
      toast(clickByLabel(/shuffle/i) ? '🔀 Shuffle toggled' : 'Shuffle unavailable');
      break;
    case 'copy-link': {
      const url = currentTrackUrl();
      if (url) { navigator.clipboard.writeText(url).then(() => toast('🔗 Link copied'), () => toast('Copy failed')); }
      else toast('No link found');
      break;
    }
    case 'add-playlist':
      // Surface YTM's own menu so the user can pick a playlist (reliable path).
      toast(clickByLabel(/more actions|menu/i) ? 'Choose a playlist ↑' : 'Menu unavailable');
      break;
    case 'radio':
      toast(clickByLabel(/radio/i) ? '📻 Radio started' : 'Radio unavailable');
      break;
    case 'goto-artist': {
      const a = q('ytmusic-player-bar .byline a');
      if (a) { a.click(); toast('👤 Artist'); } else toast('Artist link unavailable');
      break;
    }
    case 'goto-album': {
      const links = document.querySelectorAll('ytmusic-player-bar .byline a');
      const a = links[links.length - 1];
      if (a && links.length > 1) { a.click(); toast('💿 Album'); } else toast('Album link unavailable');
      break;
    }
    case 'random-library':
      randomLibrary();
      break;
    case 'save-queue':
      // Best-effort: open the queue overflow menu so "Save"/"Add to playlist" is reachable.
      toast(clickByLabel(/save|more actions|menu/i) ? 'Pick a playlist to save into ↑' : 'Not available here');
      break;
  }
  setTimeout(pollNowPlaying, 250);
}

// Navigate to the library and start something at random. Best-effort against
// YTM's DOM; degrades to a toast if nothing playable is found.
let randomTries = 0;
function randomLibrary() {
  if (!/\/library/.test(location.href)) {
    toast('🎲 Opening library…');
    location.href = 'https://music.youtube.com/library/playlists';
    randomTries = 0;
    setTimeout(randomLibrary, 1600);
    return;
  }
  const items = [...document.querySelectorAll('ytmusic-two-row-item-renderer, ytmusic-responsive-list-item-renderer')];
  if (!items.length) {
    if (++randomTries < 4) { setTimeout(randomLibrary, 1200); return; }
    toast('Nothing to shuffle in library'); return;
  }
  const pick = items[Math.floor(Math.random() * items.length)];
  const play = pick.querySelector('#play-button, ytmusic-play-button-renderer, a');
  if (play) { play.click(); toast('🎲 Playing something random'); }
  else toast('Could not start a random item');
}

ipcRenderer.on('stardust:command', (_e, { action }) => doCommand(action));

// Stream a small spectrum to the mini player only while it's open.
let miniSpectrumTimer = null;
ipcRenderer.on('stardust:mini-spectrum', (_e, on) => {
  if (on && !miniSpectrumTimer) {
    miniSpectrumTimer = setInterval(() => {
      try { ipcRenderer.send('stardust:spectrum', Visualizer.getBars(24)); } catch {}
    }, 66); // ~15fps
  } else if (!on && miniSpectrumTimer) {
    clearInterval(miniSpectrumTimer); miniSpectrumTimer = null;
  }
});

// ---------------------------------------------------------------------------
// In-page ad skipper — complements the network-level blocker. Clicks skip
// buttons, fast-forwards any ad that still plays, and dismisses upsell popups.
// ---------------------------------------------------------------------------
const AD_SELECTOR = '.ad-showing, .ytp-ad-player-overlay, .ytp-ad-module :not(:empty), ytmusic-player[player-ui-state_="AD"], .ytp-ad-text, .ytp-ad-preview-container';
let weMutedForAd = false;

// Called both on a fast poll and instantly by a MutationObserver, so an ad is
// fast-forwarded within a frame instead of playing an audible blip.
function skipAds() {
  if (settings && settings.adBlock === false) return;
  const v = document.querySelector('video');

  // Click any visible "Skip ad" button.
  const skip = document.querySelector(
    '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, tp-yt-paper-button.skip'
  );
  if (skip) { try { skip.click(); } catch {} }

  const adShowing = document.querySelector(AD_SELECTOR);
  if (v && adShowing) {
    // Mute instantly, then blast to the end so nothing is heard.
    try {
      v.muted = true; weMutedForAd = true;
      if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration;
    } catch {}
  } else if (v && weMutedForAd && !adShowing) {
    // Ad's gone — restore audio we muted (never leave the music silenced).
    try { v.muted = false; } catch {}
    weMutedForAd = false;
  }

  // The upsell sweep is 6 selector groups over the whole document — its own
  // slower beat keeps the hot ad path cheap.
  if (Date.now() - lastUpsellSweep > 1500) { lastUpsellSweep = Date.now(); dismissUpsells(); }
}
let lastUpsellSweep = 0;

// Dismiss + hide every Premium / upgrade upsell we can find.
function dismissUpsells() {
  const dismisses = document.querySelectorAll(
    'ytmusic-mealbar-promo-renderer #dismiss-button button, ' +
    'ytmusic-mealbar-promo-renderer tp-yt-paper-button#dismiss-button, ' +
    'tp-yt-paper-dialog #dismiss-button, tp-yt-paper-dialog #cancel-button, ' +
    '.ytmusic-popup-container #dismiss-button button, ' +
    'ytmusic-you-there-renderer #dismiss-button button, ' +
    'ytmusic-popup-container yt-button-renderer[dialog-dismiss] button'
  );
  dismisses.forEach((d) => { try { d.click(); } catch {} });
  // Remove the persistent promo banners/mealbars outright.
  document.querySelectorAll(
    'ytmusic-mealbar-promo-renderer, ytmusic-statement-banner-renderer, ' +
    'ytmusic-you-there-renderer, ytmusic-premium-promo-renderer'
  ).forEach((el) => { try { el.remove(); } catch {} });
}

// Watch the player for the AD state flipping on, so we react immediately.
// Throttled + scoped to the player's own state attribute — NOT document-wide
// class changes (YTM mutates those constantly, which caused UI stutter).
let adTick = 0;
function scheduleSkip() {
  const now = Date.now();
  if (now - adTick < 80) return;
  adTick = now; skipAds();
}
function watchAds() {
  try {
    const target = document.querySelector('ytmusic-player') || document.querySelector('ytmusic-app') || document.documentElement;
    const obs = new MutationObserver(scheduleSkip);
    obs.observe(target, { subtree: true, attributes: true, attributeFilter: ['player-ui-state_'] });
  } catch {}
  hookVideoForAds();
  setInterval(hookVideoForAds, 2000); // the <video> can be recreated
}

// Attach ad-guards directly to the media element so an ad is caught the instant
// it starts playing (before any audible blip), not just on the poll/observer.
let adHookedEl = null;
function hookVideoForAds() {
  const v = document.querySelector('video');
  if (!v || v === adHookedEl) return;
  adHookedEl = v;
  const guard = () => {
    if (settings && settings.adBlock === false) return;
    if (document.querySelector(AD_SELECTOR)) {
      try { v.muted = true; weMutedForAd = true; if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration; } catch {}
    }
  };
  ['loadstart', 'loadedmetadata', 'play', 'playing', 'timeupdate', 'durationchange'].forEach((ev) => {
    try { v.addEventListener(ev, guard); } catch {}
  });
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
    h('div', { class: 'stardust-discord-help', text: 'Works out of the box — no setup needed. Optionally paste your own Application ID to change the app name Discord shows.' }),
    h('button', { class: 'stardust-mini-btn', dataset: { act: 'discord-portal' }, text: '↗ Discord Developer Portal (optional)' }),
    h('input', { type: 'text', id: 'stardust-discord-id', placeholder: 'Optional: custom Application ID' })
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
      label('Smart'),
      h('button', { class: 'stardust-market-cta', dataset: { act: 'open-stats' }, text: '✦  Listening Stats' }),
      h('div', { class: 'stardust-row' }, [
        miniBtn('toggle-lyrics', 'Lyrics: off')
      ]),
      h('input', { type: 'password', id: 'stardust-transcribe-key', class: 'stardust-text-input', placeholder: 'Groq API key — for song transcription' }),
      h('div', { class: 'stardust-hint', text: 'Free key at console.groq.com → enables "🎙 Transcribe from the song" when no lyrics are found (word-timed).' }),
      toggleRow('Auto word-sync', 'autoWordSync'),
      h('div', { class: 'stardust-hint', text: 'With a Groq key set, songs without word timing are word-synced automatically in the background — nothing to sit through.' }),
      toggleRow('Share transcriptions', 'shareTranscripts'),
      h('div', { class: 'stardust-hint', text: 'Uploads finished transcriptions to the shared Stardust library so nobody transcribes the same song twice. Transcripts never enter public lyric databases, and real synced lyrics always take priority over them.' }),
      h('div', { class: 'stardust-hint', text: 'Hotkeys: ⌘/Ctrl+Shift+↑ like · ↓ dislike · S shuffle · C copy link' })
    ]),
    section([
      toggleRow('Ad blocker', 'adBlock'),
      toggleRow('Mini player', 'miniPlayer'),
      toggleRow('Global hotkeys', 'globalHotkeys'),
      toggleRow('Discord presence', 'discordRichPresence', 'stardust-discord'),
      discordIdWrap
    ]),
    h('div', { class: 'stardust-foot', text: 'Stardust v' + (appVersion || '?') + ' • drop themes into the folder above' })
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
      if (act === 'open-stats') openStats();
      if (act === 'discord-portal') ipcRenderer.invoke('stardust:open-external', 'https://discord.com/developers/applications');
      if (act === 'toggle-lyrics') {
        const on = (settings.enabledFeatures || []).includes('feat-lyrics');
        const next = on
          ? (settings.enabledFeatures || []).filter((x) => x !== 'feat-lyrics')
          : uniqAdd(settings.enabledFeatures, 'feat-lyrics');
        await onSetting('enabledFeatures', next);
        btn.textContent = on ? 'Lyrics: off' : 'Lyrics: on';
      }
    });
  });
  // Reflect current lyrics state on the toggle.
  const lt = panel.querySelector('[data-act="toggle-lyrics"]');
  if (lt) lt.textContent = (settings.enabledFeatures || []).includes('feat-lyrics') ? 'Lyrics: on' : 'Lyrics: off';

  // Transcription API key.
  const tk = panel.querySelector('#stardust-transcribe-key');
  if (tk) {
    tk.value = settings.transcribeKey || '';
    tk.addEventListener('change', () => setSetting('transcribeKey', tk.value.trim()));
  }
}

// ---------------------------------------------------------------------------
// Listening Stats modal
// ---------------------------------------------------------------------------
let statsModal = null;
async function openStats() {
  const s = await ipcRenderer.invoke('stardust:stats');
  if (!statsModal) {
    statsModal = h('div', { id: 'stardust-stats', class: 'stardust-modal' }, [
      h('div', { class: 'stardust-modal-card' }, [
        h('div', { class: 'stardust-head' }, [
          h('span', { class: 'stardust-logo', text: '✦ Listening Stats' }),
          h('div', { class: 'stardust-row' }, [
            h('button', { class: 'stardust-mini-btn', dataset: { sact: 'reset' }, text: 'Reset' }),
            h('button', { class: 'stardust-x', dataset: { sact: 'close' }, text: '✕' })
          ])
        ]),
        h('div', { id: 'stardust-stats-body' })
      ])
    ]);
    document.body.appendChild(statsModal);
    statsModal.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-sact]'); if (!a && e.target !== statsModal) return;
      const act = a && a.dataset.sact;
      if (!a || act === 'close') { statsModal.classList.remove('open'); return; }
      if (act === 'reset') { await ipcRenderer.invoke('stardust:stats-reset'); openStats(); }
    });
  }
  renderStats(s);
  statsModal.classList.add('open');
}
function fmtDur(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return min + ' min';
  const h2 = Math.floor(min / 60), m = min % 60;
  return h2 + 'h ' + m + 'm';
}
function renderStats(s) {
  const body = statsModal.querySelector('#stardust-stats-body');
  while (body.firstChild) body.removeChild(body.firstChild);
  const stat = (n, l) => h('div', { class: 'stardust-stat' }, [h('div', { class: 'stardust-stat-n', text: n }), h('div', { class: 'stardust-stat-l', text: l })]);
  body.appendChild(h('div', { class: 'stardust-stat-grid' }, [
    stat(fmtDur(s.totalMs), 'Total listened'),
    stat(fmtDur(s.todayMs), 'Today'),
    stat(String(s.distinctSongs), 'Songs'),
    stat(String(s.distinctArtists), 'Artists')
  ]));
  const list = (title, items, line) => {
    const rows = items.length ? items.map((it, i) => h('div', { class: 'stardust-stat-row' }, [
      h('span', { class: 'stardust-stat-rank', text: String(i + 1) }),
      h('span', { class: 'stardust-stat-main', text: line(it) }),
      h('span', { class: 'stardust-stat-sub', text: it.count ? it.count + ' plays' : fmtDur(it.ms || 0) })
    ])) : [h('div', { class: 'stardust-hint', text: 'Nothing yet — play some music!' })];
    return h('div', { class: 'stardust-stat-col' }, [h('div', { class: 'stardust-label', text: title }), ...rows]);
  };
  body.appendChild(h('div', { class: 'stardust-stat-cols' }, [
    list('Top songs', s.topSongs, (t) => t.title + (t.artist ? ' — ' + t.artist : '')),
    list('Top artists', s.topArtists, (a) => a.name)
  ]));
}

async function onSetting(key, value) {
  settings = await setSetting(key, value);
  // Visual settings re-apply immediately.
  if (key === 'starfieldEnabled' || key === 'starfieldDensity') Starfield.configure(activeTheme.starfield);
  if (key === 'visualizerEnabled') Visualizer.configure(activeTheme.visualizer);
  if (key === 'glassEnabled' || key === 'glassBlur') applyVars();
  // Marketplace extras (fonts/animations/features/audio) need re-applying so
  // their CSS + JS behaviours toggle on/off.
  if (key === 'enabledFeatures' || key === 'enabledAnimations' || key === 'enabledAudio' || key === 'activeFont') applyExtras();
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
        search,
        h('div', { class: 'stardust-row' }, [
          h('button', { class: 'stardust-mini-btn', dataset: { mact: 'import' }, text: '＋ Import' }),
          h('button', { class: 'stardust-mini-btn', dataset: { mact: 'publish' }, text: 'Publish yours ↗' })
        ])
      ]),
      h('div', { id: 'stardust-market-grid', class: 'stardust-market-grid' })
    ])
  ]);
  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });
  modal.querySelector('[data-mact="close"]').addEventListener('click', () => modal.classList.remove('open'));
  modal.querySelector('[data-mact="import"]').addEventListener('click', openImport);
  modal.querySelector('[data-mact="publish"]').addEventListener('click', () => {
    const body = encodeURIComponent(
      'Paste your item JSON below (a single object or an array). See an existing entry in src/marketplace/catalog.json for the format.\n\n```json\n\n```\n'
    );
    ipcRenderer.invoke('stardust:open-external',
      'https://github.com/coopermitchell007-pixel/stardust-music/issues/new?title=' +
      encodeURIComponent('[Marketplace] New submission') + '&body=' + body);
  });
  tabs.forEach((tb) => tb.addEventListener('click', () => {
    marketState.filter = tb.dataset.tab;
    modal.querySelectorAll('.stardust-market-tab').forEach((x) => x.classList.toggle('active', x === tb));
    renderMarketGrid();
  }));
  search.addEventListener('input', () => { marketState.search = search.value.toLowerCase(); renderMarketGrid(); });
  return modal;
}

// Import creations shared by others: paste one item JSON (or an array).
let importModal = null;
function openImport() {
  if (!importModal) {
    const ta = h('textarea', { id: 'stardust-import-ta', placeholder: 'Paste item JSON here — a single {…} or an array [ … ]' });
    const msg = h('div', { class: 'stardust-hint', id: 'stardust-import-msg' });
    const go = h('button', { class: 'stardust-market-btn primary', text: 'Import' });
    importModal = h('div', { class: 'stardust-modal', id: 'stardust-import' }, [
      h('div', { class: 'stardust-modal-card' }, [
        h('div', { class: 'stardust-head' }, [
          h('span', { class: 'stardust-logo', text: '✦ Import' }),
          h('button', { class: 'stardust-x', dataset: { iact: 'close' }, text: '✕' })
        ]),
        h('div', { class: 'stardust-hint', text: 'Add a theme / font / animation / feature / audio effect someone shared with you.' }),
        ta, msg, go
      ])
    ]);
    document.body.appendChild(importModal);
    importModal.addEventListener('click', (e) => { if (e.target === importModal || e.target.closest('[data-iact="close"]')) importModal.classList.remove('open'); });
    go.addEventListener('click', async () => {
      let items;
      try { items = JSON.parse(ta.value.trim()); } catch { msg.textContent = '⚠ That is not valid JSON.'; return; }
      if (!Array.isArray(items)) items = [items];
      const ok = items.filter((it) => it && it.id && it.type);
      if (!ok.length) { msg.textContent = '⚠ No valid items (each needs an id and type).'; return; }
      let n = 0;
      for (const it of ok) { const r = await ipcRenderer.invoke('stardust:marketplace-install', it); if (r) { installed = r.installed || installed; extras = r.extras || extras; themeList = r.themes || themeList; n++; } }
      // Merge into the visible catalog so they show up immediately.
      const byId = new Map(marketState.items.map((x) => [x.id, x]));
      for (const it of ok) byId.set(it.id, it);
      marketState.items = [...byId.values()];
      applyExtras(); if (panelEl) renderThemes(panelEl); renderMarketGrid();
      msg.textContent = `✓ Imported ${n} item${n === 1 ? '' : 's'}.`;
      toast(`✓ Imported ${n} item${n === 1 ? '' : 's'}`);
    });
  }
  importModal.querySelector('#stardust-import-msg').textContent = '';
  importModal.classList.add('open');
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
  const share = h('button', { class: 'stardust-market-btn ghost', title: 'Copy this item as JSON to share', text: 'Share' });
  share.addEventListener('click', () => {
    navigator.clipboard.writeText(JSON.stringify(item, null, 2))
      .then(() => toast('📋 Copied — paste via Import to share'), () => toast('Copy failed'));
  });
  actions.appendChild(share);
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
  appVersion = init.version || '';

  await applyTheme(settings.activeTheme || (themeList[0] && themeList[0].id));
  applyExtras();
  buildUI();

  setInterval(pollNowPlaying, 1000);
  setInterval(skipAds, 500);
  watchAds();
  skipAds();
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
