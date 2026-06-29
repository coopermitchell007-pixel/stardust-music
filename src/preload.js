'use strict';

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

console.log('YTM+ preload loaded at', location.href);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let settings = null;
let themeList = [];
let activeTheme = null; // full theme object incl. starfield/visualizer config
let discordAvailable = false;

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
    canvas.id = 'ytmplus-starfield';
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
// Visualizer — playback-reactive bars.
// NOTE: YouTube Music streams audio cross-origin (googlevideo.com), so the
// Web Audio AnalyserNode cannot legally sample it (and tapping the element
// risks muting playback). We therefore drive a smooth, beat-feel simulation
// from the real playback state (only animates while a track is playing).
// ---------------------------------------------------------------------------
const Visualizer = (() => {
  let canvas, ctx, raf = null, cfg = null, enabled = true, w = 0, h = 0;
  const BARS = 64;
  let levels = new Array(BARS).fill(0);
  let targets = new Array(BARS).fill(0);
  let playing = false;
  let phase = 0;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'ytmplus-visualizer';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    window.addEventListener('resize', resize);
  }

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = 140;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function configure(visCfg) {
    ensureCanvas();
    cfg = visCfg || { color: '#8b5cff', style: 'bars' };
    enabled = settings.visualizerEnabled && cfg.enabled !== false;
    resize();
    canvas.style.display = enabled ? 'block' : 'none';
    enabled ? start() : stop();
  }

  function setPlaying(p) { playing = p; }

  function newTargets() {
    for (let i = 0; i < BARS; i++) {
      // layered sines give a music-like, center-weighted spectrum shape
      const center = 1 - Math.abs(i - BARS / 2) / (BARS / 2);
      const base = playing ? 0.25 + 0.75 * center : 0.04;
      const wobble = playing ? (Math.sin(phase + i * 0.5) * 0.3 + Math.random() * 0.4) : 0;
      // Collapse fully to 0 when paused so no idle bars/lines linger.
      targets[i] = playing ? Math.max(0.04, Math.min(1, base * (0.6 + wobble))) : 0;
    }
  }

  let lastTargetAt = 0;
  function frame(ts) {
    if (!enabled) return;
    if (ts - lastTargetAt > 90) { phase += 0.35; newTargets(); lastTargetAt = ts; }
    ctx.clearRect(0, 0, w, h);
    const accent = settings.accentOverride || cfg.color || '#8b5cff';
    const gap = 2;
    const bw = (w / BARS) - gap;
    for (let i = 0; i < BARS; i++) {
      levels[i] += (targets[i] - levels[i]) * 0.18;
      const bh = levels[i] * (h - 20);
      if (bh < 2) continue; // don't render hairline idle bars
      const x = i * (bw + gap);
      const y = h - bh;
      const grad = ctx.createLinearGradient(0, y, 0, h);
      grad.addColorStop(0, accent);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, bw, bh);
    }
    raf = requestAnimationFrame(frame);
  }

  function start() { if (enabled && !raf) raf = requestAnimationFrame(frame); }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } if (ctx) ctx.clearRect(0, 0, w, h); }

  return { configure, setPlaying };
})();

// ---------------------------------------------------------------------------
// Theme application
// ---------------------------------------------------------------------------
async function applyTheme(id) {
  const theme = await ipcRenderer.invoke('ytmplus:get-theme', id);
  if (!theme) return;
  activeTheme = theme;
  applyVars();
  sheet('ytmplus-theme').textContent = theme.css || '';
  Starfield.configure(theme.starfield);
  Visualizer.configure(theme.visualizer);
}

function applyVars() {
  if (!activeTheme) return;
  const accent = settings.accentOverride || activeTheme.accent;
  const blur = settings.glassBlur != null ? settings.glassBlur : (activeTheme.glass && activeTheme.glass.blur) || 16;
  const glassOpacity = (activeTheme.glass && activeTheme.glass.opacity) != null ? activeTheme.glass.opacity : 0.5;
  sheet('ytmplus-vars').textContent = `:root {
  --ytmplus-accent: ${accent};
  --ytmplus-bg: ${activeTheme.background || 'radial-gradient(circle at 50% 0%, #1b1340, #05060f 70%)'};
  --ytmplus-glass-blur: ${settings.glassEnabled ? blur : 0}px;
  --ytmplus-glass-opacity: ${settings.glassEnabled ? glassOpacity : 0.92};
}`;
}

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
  const sig = `${np.title}|${np.artist}|${np.playing}|${np.position}`;
  if (sig !== lastSig) {
    lastSig = sig;
    ipcRenderer.send('ytmplus:nowplaying', np);
  }
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
  }
  setTimeout(pollNowPlaying, 250);
}

ipcRenderer.on('ytmplus:command', (_e, { action }) => doCommand(action));

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

function section(children) { return h('div', { class: 'ytmplus-section' }, children); }
function label(text) { return h('div', { class: 'ytmplus-label', text }); }
function miniBtn(act, text) { return h('button', { class: 'ytmplus-mini-btn', dataset: { act }, text }); }

function toggleRow(text, setting, id) {
  const input = h('input', { type: 'checkbox', dataset: { setting } });
  if (id) input.id = id;
  return h('div', { class: 'ytmplus-toggle-row' }, [h('label', { text }), input]);
}
function sliderRow(text, setting, attrs) {
  const input = h('input', Object.assign({ type: 'range', dataset: { setting } }, attrs));
  return h('div', { class: 'ytmplus-slider-row' }, [h('label', { text }), input]);
}

function buildUI() {
  if (document.getElementById('ytmplus-launcher')) return;

  const launcher = h('button', { id: 'ytmplus-launcher', title: 'YTM+ themes' }, [
    h('span', { class: 'ytmplus-orbit', text: '✦' })
  ]);
  document.body.appendChild(launcher);

  const discordIdWrap = h('div', { class: 'ytmplus-discord-id', id: 'ytmplus-discord-id-wrap' }, [
    h('input', { type: 'text', id: 'ytmplus-discord-id', placeholder: 'Discord application Client ID' })
  ]);

  const panel = h('div', { id: 'ytmplus-panel' }, [
    h('div', { class: 'ytmplus-head' }, [
      h('span', { class: 'ytmplus-logo', text: '✦ YTM+' }),
      h('button', { class: 'ytmplus-x', dataset: { act: 'close' }, text: '✕' })
    ]),
    section([
      label('Theme'),
      h('div', { id: 'ytmplus-themes', class: 'ytmplus-themes' }),
      h('div', { class: 'ytmplus-row' }, [miniBtn('open-themes', 'Open themes folder'), miniBtn('reload-themes', 'Reload')])
    ]),
    section([
      label('Accent'),
      h('div', { class: 'ytmplus-row' }, [
        h('input', { type: 'color', id: 'ytmplus-accent' }),
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
      toggleRow('Mini player', 'miniPlayer'),
      toggleRow('Global hotkeys', 'globalHotkeys'),
      toggleRow('Discord presence', 'discordRichPresence', 'ytmplus-discord'),
      discordIdWrap
    ]),
    h('div', { class: 'ytmplus-foot', text: 'Drop themes into the folder above • restart-free' })
  ]);
  document.body.appendChild(panel);

  launcher.addEventListener('click', () => panel.classList.toggle('open'));

  wirePanel(panel);
}

function wirePanel(panel) {
  // Theme grid
  renderThemes(panel);

  // Accent
  const accentInput = panel.querySelector('#ytmplus-accent');
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
  const discordIdWrap = panel.querySelector('#ytmplus-discord-id-wrap');
  const discordId = panel.querySelector('#ytmplus-discord-id');
  discordId.value = settings.discordClientId || '';
  discordIdWrap.style.display = settings.discordRichPresence ? 'block' : 'none';
  if (!discordAvailable) {
    const dc = panel.querySelector('#ytmplus-discord');
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
      if (act === 'open-themes') ipcRenderer.invoke('ytmplus:open-themes-folder');
      if (act === 'reload-themes') {
        themeList = await ipcRenderer.invoke('ytmplus:reload-themes');
        renderThemes(panel);
      }
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
    document.getElementById('ytmplus-discord-id-wrap').style.display = value ? 'block' : 'none';
  }
}

function renderThemes(panel) {
  const wrap = panel.querySelector('#ytmplus-themes');
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  for (const t of themeList) {
    const b = document.createElement('button');
    b.className = 'ytmplus-theme-btn' + (activeTheme && t.id === activeTheme.id ? ' active' : '');
    b.style.setProperty('--swatch', t.accent);
    const preview = h('div', { class: 'ytmplus-preview' });
    if (t.background) preview.style.background = t.background;
    b.appendChild(preview);
    b.appendChild(h('span', { class: 'ytmplus-tname', text: t.name }));
    if (t.source === 'user') b.appendChild(h('span', { class: 'ytmplus-badge', text: 'user' }));
    b.addEventListener('click', async () => {
      await setSetting('activeTheme', t.id);
      await applyTheme(t.id);
      renderThemes(panel);
      const ai = panel.querySelector('#ytmplus-accent');
      if (!settings.accentOverride) ai.value = activeTheme.accent;
    });
    wrap.appendChild(b);
  }
}

async function setSetting(key, value) {
  return ipcRenderer.invoke('ytmplus:set-setting', { key, value });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  // Base structural CSS lives in overlay.css next to this preload.
  try {
    sheet('ytmplus-base').textContent = fs.readFileSync(path.join(__dirname, 'overlay', 'overlay.css'), 'utf8');
  } catch (e) {
    console.error('[YTM+] failed to load overlay.css', e.message);
  }

  const init = await ipcRenderer.invoke('ytmplus:init');
  settings = init.settings;
  themeList = init.themes;
  discordAvailable = init.discordAvailable;

  await applyTheme(settings.activeTheme || (themeList[0] && themeList[0].id));
  buildUI();

  setInterval(pollNowPlaying, 1000);
}

function safeBoot() {
  // Only inject on the actual YTM app, not on Google sign-in pages.
  if (!location.hostname.includes('music.youtube.com')) {
    console.log('YTM+ skipping injection on', location.hostname);
    return;
  }
  boot().catch((e) => console.error('YTM+ boot failed:', e && e.stack || e));
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', safeBoot);
} else {
  safeBoot();
}
