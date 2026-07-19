'use strict';

// Shared userData so Hub + standalone apps share the same Chromium partitions
// (logins, cookies, localStorage). Call useSharedUserData() BEFORE app.ready.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const SHARED_DIR_NAME = 'Stardust';

// partition string without "persist:" prefix → folder under Partitions/
const PARTITION_KEYS = {
  music: 'stardust-music',
  youtube: 'stardust-yt',
  twitch: 'stardust-twitch',
  discord: 'stardust-discord'
};

function sharedRoot() {
  return path.join(app.getPath('appData'), SHARED_DIR_NAME);
}

/** Must run before app.isReady() */
function useSharedUserData() {
  const root = sharedRoot();
  try { fs.mkdirSync(root, { recursive: true }); } catch {}
  app.setPath('userData', root);
  return root;
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(dest, { recursive: true });
  // Node 16.7+ fs.cpSync
  if (fs.cpSync) {
    fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
    return true;
  }
  // fallback
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
  }
  return true;
}

function hasCookies(dir) {
  return fs.existsSync(path.join(dir, 'Cookies')) ||
    fs.existsSync(path.join(dir, 'Network', 'Cookies'));
}

/**
 * Prefer existing shared partition; else migrate from standalone app userData
 * or from a previous hub userData copy.
 */
function migrateSessions() {
  const appData = app.getPath('appData');
  const shared = app.getPath('userData'); // already pointed at Stardust
  const partsRoot = path.join(shared, 'Partitions');
  fs.mkdirSync(partsRoot, { recursive: true });

  const migrations = [
    {
      key: PARTITION_KEYS.discord,
      sources: [
        path.join(appData, 'stardust-discord', 'Partitions', 'stardust-discord'),
        path.join(appData, 'stardust-hub', 'Partitions', 'stardust-discord')
      ]
    },
    {
      key: PARTITION_KEYS.youtube,
      sources: [
        path.join(appData, 'stardust-yt', 'Partitions', 'stardust-yt'),
        path.join(appData, 'stardust-hub', 'Partitions', 'stardust-yt')
      ]
    },
    {
      key: PARTITION_KEYS.twitch,
      sources: [
        path.join(appData, 'stardust-twitch', 'Partitions', 'stardust-twitch'),
        path.join(appData, 'stardust-hub', 'Partitions', 'stardust-twitch')
      ]
    },
    {
      key: PARTITION_KEYS.music,
      sources: [
        // Hub already used a partition
        path.join(appData, 'stardust-hub', 'Partitions', 'stardust-music'),
        // Standalone YTM used the DEFAULT session (files at userData root)
        path.join(appData, 'stardust-music')
      ],
      // For default-session source, only copy session-ish folders/files
      defaultSession: true
    }
  ];

  for (const m of migrations) {
    const dest = path.join(partsRoot, m.key);
    if (hasCookies(dest)) continue; // already good

    // Pick the newest source that has cookies (standalone or previous hub)
    let best = null;
    let bestMtime = 0;
    for (const src of m.sources) {
      if (!fs.existsSync(src)) continue;
      const cookieFile = path.join(src, 'Cookies');
      const alt = path.join(src, 'Network', 'Cookies');
      const c = fs.existsSync(cookieFile) ? cookieFile : (fs.existsSync(alt) ? alt : null);
      if (!c && !(m.defaultSession && path.basename(src) === 'stardust-music')) continue;
      try {
        const mt = c ? fs.statSync(c).mtimeMs : fs.statSync(src).mtimeMs;
        if (mt >= bestMtime) { bestMtime = mt; best = src; }
      } catch {}
    }
    if (!best) continue;

    // Default-session YTM root → partition pieces
    if (m.defaultSession && path.basename(best) === 'stardust-music' && !best.includes('Partitions')) {
      fs.mkdirSync(dest, { recursive: true });
      const pieces = [
        'Cookies', 'Cookies-journal', 'Local Storage', 'Session Storage',
        'IndexedDB', 'Service Worker', 'Network Persistent State',
        'Preferences', 'Code Cache', 'GPUCache', 'Shared Dictionary',
        'shared_proto_db', 'blob_storage'
      ];
      let any = false;
      for (const p of pieces) {
        const s = path.join(best, p);
        if (!fs.existsSync(s)) continue;
        const d = path.join(dest, p);
        try {
          const st = fs.statSync(s);
          if (st.isDirectory()) copyDir(s, d);
          else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
          any = true;
        } catch (e) {
          console.warn('[Stardust] migrate piece failed', p, e.message);
        }
      }
      if (any) console.log('[Stardust] migrated music session from', best);
      continue;
    }

    try {
      copyDir(best, dest);
      if (hasCookies(dest)) console.log('[Stardust] migrated session', m.key, 'from', best);
    } catch (e) {
      console.warn('[Stardust] migrate failed', m.key, e.message);
    }
  }
}

function partitionName(service) {
  // full Electron partition string
  const key = PARTITION_KEYS[service] || service;
  return 'persist:' + key;
}

module.exports = {
  useSharedUserData,
  migrateSessions,
  partitionName,
  PARTITION_KEYS,
  sharedRoot
};
