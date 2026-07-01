'use strict';

// Synced/plain lyrics via lrclib.net (free, no API key). Runs in the main
// process so there are no CORS restrictions.
const https = require('https');

function getJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Stardust v0.4 (https://github.com/coopermitchell007-pixel/stardust-music)' },
      timeout: 6000
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const qs = (o) => Object.entries(o)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

async function fetchLyrics({ artist, title, album, duration } = {}) {
  if (!title) return null;

  // Exact match first (best synced result).
  let r = await getJson('https://lrclib.net/api/get?' + qs({
    artist_name: artist, track_name: title, album_name: album, duration
  }));
  if (r && (r.syncedLyrics || r.plainLyrics)) {
    return { syncedLyrics: r.syncedLyrics || '', plainLyrics: r.plainLyrics || '' };
  }

  // Fall back to search (duration/album may not match exactly).
  const arr = await getJson('https://lrclib.net/api/search?' + qs({ track_name: title, artist_name: artist }));
  if (Array.isArray(arr) && arr.length) {
    const hit = arr.find((x) => x.syncedLyrics) || arr.find((x) => x.plainLyrics) || arr[0];
    if (hit) return { syncedLyrics: hit.syncedLyrics || '', plainLyrics: hit.plainLyrics || '' };
  }
  return null;
}

module.exports = { fetchLyrics };
