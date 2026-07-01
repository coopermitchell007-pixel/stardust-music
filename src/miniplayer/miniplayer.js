'use strict';

const titleEl = document.getElementById('title');
const artistEl = document.getElementById('artist');
const artEl = document.getElementById('art');
const barEl = document.getElementById('bar');
const ppEl = document.getElementById('pp');

document.querySelectorAll('[data-act]').forEach((btn) => {
  btn.addEventListener('click', () => window.stardust.control(btn.dataset.act));
});

let accent = '#8b5cff';
window.stardust.onNowPlaying((np) => {
  if (!np) return;
  titleEl.textContent = np.title || 'Nothing playing';
  artistEl.textContent = np.artist || '';
  if (np.art) artEl.style.backgroundImage = `url("${np.art}")`;
  ppEl.textContent = np.playing ? '⏸' : '▶';
  const pct = np.duration ? Math.min(100, (np.position / np.duration) * 100) : 0;
  barEl.style.width = pct + '%';
  if (np.accent) {
    accent = np.accent;
    barEl.style.background = np.accent;
    ppEl.style.background = np.accent;
    ppEl.style.borderColor = np.accent;
  }
});

// --- Reactive spectrum behind the player ---
const viz = document.getElementById('viz');
const vctx = viz.getContext('2d');
let bars = new Array(24).fill(0);
const levels = new Array(24).fill(0);
function sizeViz() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  viz.width = window.innerWidth * dpr; viz.height = window.innerHeight * dpr;
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', sizeViz); sizeViz();
window.stardust.onSpectrum((b) => { if (Array.isArray(b) && b.length) bars = b; });
function drawViz() {
  requestAnimationFrame(drawViz);
  const w = window.innerWidth, h = window.innerHeight;
  vctx.clearRect(0, 0, w, h);
  const n = levels.length, bw = w / n;
  for (let i = 0; i < n; i++) {
    levels[i] += ((bars[i] || 0) - levels[i]) * 0.3;
    const bh = Math.max(0, levels[i]) * h * 0.9;
    if (bh < 1) continue;
    vctx.fillStyle = accent;
    vctx.globalAlpha = 0.16 + 0.24 * levels[i];
    vctx.fillRect(i * bw, h - bh, bw - 1, bh);
  }
  vctx.globalAlpha = 1;
}
drawViz();
