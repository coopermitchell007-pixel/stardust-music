'use strict';

const titleEl = document.getElementById('title');
const artistEl = document.getElementById('artist');
const artEl = document.getElementById('art');
const barEl = document.getElementById('bar');
const ppEl = document.getElementById('pp');

document.querySelectorAll('[data-act]').forEach((btn) => {
  btn.addEventListener('click', () => window.stardust.control(btn.dataset.act));
});

window.stardust.onNowPlaying((np) => {
  if (!np) return;
  titleEl.textContent = np.title || 'Nothing playing';
  artistEl.textContent = np.artist || '';
  if (np.art) artEl.style.backgroundImage = `url("${np.art}")`;
  ppEl.textContent = np.playing ? '⏸' : '▶';
  const pct = np.duration ? Math.min(100, (np.position / np.duration) * 100) : 0;
  barEl.style.width = pct + '%';
  if (np.accent) {
    barEl.style.background = np.accent;
    ppEl.style.background = np.accent;
    ppEl.style.borderColor = np.accent;
  }
});
