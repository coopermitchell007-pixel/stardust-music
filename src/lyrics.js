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

const norm = (s) => (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]|feat\.?.*$|ft\.?.*$/g, '').replace(/[^a-z0-9]/g, '').trim();

async function fetchLyrics({ artist, title, album, duration } = {}) {
  if (!title) return null;

  // Exact match first (best synced result, verified by title+artist+duration).
  let r = await getJson('https://lrclib.net/api/get?' + qs({
    artist_name: artist, track_name: title, album_name: album, duration
  }));
  if (r && (r.syncedLyrics || r.plainLyrics)) {
    return { syncedLyrics: r.syncedLyrics || '', plainLyrics: r.plainLyrics || '' };
  }

  // Search fallback — but ONLY accept a result that actually matches the track,
  // so we never show lyrics for a different (e.g. same-title) song.
  const arr = await getJson('https://lrclib.net/api/search?' + qs({ track_name: title, artist_name: artist }));
  if (!Array.isArray(arr) || !arr.length) return null;

  const wantTitle = norm(title), wantArtist = norm(artist);
  const scored = arr.map((x) => {
    const tMatch = norm(x.trackName) === wantTitle || norm(x.trackName).includes(wantTitle) || wantTitle.includes(norm(x.trackName));
    const aMatch = !wantArtist || norm(x.artistName).includes(wantArtist) || wantArtist.includes(norm(x.artistName));
    const dOk = !duration || !x.duration || Math.abs(x.duration - duration) <= 8;
    return { x, ok: tMatch && aMatch && dOk, synced: !!x.syncedLyrics, ddiff: x.duration ? Math.abs((x.duration || 0) - (duration || 0)) : 999 };
  }).filter((s) => s.ok);

  // Prefer synced, then closest duration.
  scored.sort((a, b) => (b.synced - a.synced) || (a.ddiff - b.ddiff));
  const hit = scored[0] && scored[0].x;
  if (hit && (hit.syncedLyrics || hit.plainLyrics)) {
    return { syncedLyrics: hit.syncedLyrics || '', plainLyrics: hit.plainLyrics || '' };
  }
  return null; // no confident match — show nothing rather than the wrong song
}

module.exports = { fetchLyrics };
