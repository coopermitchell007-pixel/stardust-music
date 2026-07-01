'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const BUILTIN_DIR = path.join(__dirname, 'themes');
// User drop-in themes — same format as built-ins (folder with theme.json + theme.css).
const USER_DIR = path.join(app.getPath('userData'), 'Themes');

function ensureUserDir() {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
  } catch {}
}

function readThemeFolder(dir, source) {
  const metaPath = path.join(dir, 'theme.json');
  const cssPath = path.join(dir, 'theme.css');
  if (!fs.existsSync(metaPath) || !fs.existsSync(cssPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const css = fs.readFileSync(cssPath, 'utf8');
    return {
      id: meta.id || path.basename(dir),
      name: meta.name || meta.id || path.basename(dir),
      author: meta.author || 'Unknown',
      accent: meta.accent || '#8b5cff',
      background: meta.background || null,
      glass: meta.glass || { blur: 16, opacity: 0.5 },
      starfield: meta.starfield || { enabled: true, count: 180, color: '#cdbcff', speed: 0.25, size: 1.6, twinkle: true, shootingStars: true },
      visualizer: meta.visualizer || { enabled: true, color: meta.accent || '#8b5cff', style: 'bars' },
      source,
      css
    };
  } catch (err) {
    console.error(`[Stardust] bad theme in ${dir}:`, err.message);
    return null;
  }
}

function listFrom(baseDir, source) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const theme = readThemeFolder(path.join(baseDir, ent.name), source);
    if (theme) out.push(theme);
  }
  return out;
}

// Returns all themes (built-in first, then user). User themes win on id collision.
function list() {
  ensureUserDir();
  const builtins = listFrom(BUILTIN_DIR, 'builtin');
  const user = listFrom(USER_DIR, 'user');
  const byId = new Map();
  for (const t of builtins) byId.set(t.id, t);
  for (const t of user) byId.set(t.id, t);
  return [...byId.values()];
}

function get(id) {
  return list().find((t) => t.id === id) || null;
}

module.exports = { list, get, USER_DIR, BUILTIN_DIR, ensureUserDir };
