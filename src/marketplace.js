'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { app } = require('electron');

const themes = require('./themes');

// Bundled catalog ships with the app so the marketplace works offline. A remote
// catalog (community-contributed) can override/extend it by id when reachable.
const BUNDLED_CATALOG = path.join(__dirname, 'marketplace', 'catalog.json');
const REMOTE_CATALOG_URL =
  'https://raw.githubusercontent.com/coopermitchell007-pixel/stardust-music/main/src/marketplace/catalog.json';

// Installed non-theme items live here (themes go through themes.js into Themes/).
const ROOT = path.join(app.getPath('userData'), 'Marketplace');
const TYPE_DIRS = {
  font: path.join(ROOT, 'fonts'),
  animation: path.join(ROOT, 'animations'),
  feature: path.join(ROOT, 'features'),
  audio: path.join(ROOT, 'audio')
};

function ensureDirs() {
  for (const d of Object.values(TYPE_DIRS)) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
}

function readBundled() {
  try { return JSON.parse(fs.readFileSync(BUNDLED_CATALOG, 'utf8')); }
  catch (e) { console.error('[Stardust] bad bundled catalog:', e.message); return []; }
}

function fetchRemote(timeout = 3500) {
  return new Promise((resolve) => {
    const req = https.get(REMOTE_CATALOG_URL, { timeout }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Bundled first, remote items override/extend by id.
async function catalog() {
  const bundled = readBundled();
  let remote = null;
  try { remote = await fetchRemote(); } catch {}
  if (!Array.isArray(remote)) return bundled;
  const byId = new Map();
  for (const it of bundled) byId.set(it.id, it);
  for (const it of remote) if (it && it.id) byId.set(it.id, it);
  return [...byId.values()];
}

function installedIds() {
  ensureDirs();
  const out = { theme: [], font: [], animation: [], feature: [], audio: [] };
  // themes
  try {
    out.theme = fs.readdirSync(themes.USER_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {}
  for (const [type, dir] of Object.entries(TYPE_DIRS)) {
    try {
      out[type] = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    } catch {}
  }
  return out;
}

// Full payloads for every installed non-theme item, so the renderer can apply
// the ones the user has enabled (fonts/animations/features).
function installedExtras() {
  ensureDirs();
  const out = { font: [], animation: [], feature: [], audio: [] };
  for (const [type, dir] of Object.entries(TYPE_DIRS)) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
    for (const f of files) {
      try { out[type].push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {}
    }
  }
  return out;
}

function install(item) {
  if (!item || !item.id || !item.type) return { ok: false, error: 'invalid item' };
  ensureDirs();
  try {
    if (item.type === 'theme') {
      const t = item.theme || {};
      const dir = path.join(themes.USER_DIR, item.id);
      fs.mkdirSync(dir, { recursive: true });
      const meta = {
        id: item.id, name: item.name, author: item.author || 'community',
        accent: t.accent || item.accent, background: t.background,
        glass: t.glass, starfield: t.starfield, visualizer: t.visualizer,
        blackhole: t.blackhole || null, bg: t.bg || null
      };
      fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(meta, null, 2));
      fs.writeFileSync(path.join(dir, 'theme.css'), t.css || '');
    } else if (TYPE_DIRS[item.type]) {
      fs.writeFileSync(path.join(TYPE_DIRS[item.type], item.id + '.json'), JSON.stringify(item, null, 2));
    } else {
      return { ok: false, error: 'unknown type' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function remove(type, id) {
  try {
    if (type === 'theme') {
      fs.rmSync(path.join(themes.USER_DIR, id), { recursive: true, force: true });
    } else if (TYPE_DIRS[type]) {
      fs.rmSync(path.join(TYPE_DIRS[type], id + '.json'), { force: true });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Refresh installed BUNDLED items (author "Stardust") from the current bundled
// catalog on launch, so shipped bug-fixes to a theme/animation/feature reach
// users who already installed it — without touching their imported creations.
function syncBundled() {
  let bundled = [];
  try { bundled = readBundled(); } catch { return; }
  const byId = new Map(bundled.map((i) => [i.id, i]));
  const inst = installedIds();
  for (const type of Object.keys(inst)) {
    for (const id of inst[type]) {
      const b = byId.get(id);
      if (b && b.author === 'Stardust') { try { install(b); } catch {} }
    }
  }
}

module.exports = { catalog, install, remove, installedIds, installedExtras, syncBundled, ROOT };
