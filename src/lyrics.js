'use strict';

// Synced/plain lyrics via lrclib.net (free, no API key). Runs in the main
// process so there are no CORS restrictions.
const https = require('https');

function getJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Stardust v0.6 (https://github.com/coopermitchell007-pixel/stardust-music)' },
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

// Normalize for comparison: drop bracketed/feat noise, keep unicode letters &
// digits (so non-Latin scripts survive instead of collapsing to '').
const norm = (s) => (s || '')
  .toLowerCase()
  .replace(/\(.*?\)|\[.*?\]|feat\.?.*$|ft\.?.*$/g, '')
  .replace(/[^\p{L}\p{N}]/gu, '')
  .trim();

// Strip the junk YTM often appends to titles before querying lrclib.
const cleanTitle = (s) => (s || '')
  .replace(/\((?:official|lyric|audio|video|visualizer|hd|4k|mv|m\/v).*?\)/gi, '')
  .replace(/\[(?:official|lyric|audio|video|visualizer|hd|4k|mv|m\/v).*?\]/gi, '')
  .replace(/\s+/g, ' ')
  .trim();

// True when a string is predominantly CJK / Hangul / Kana.
const CJK_G = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff66-\uff9d]/g;
const isCJK = (s) => {
  const chars = (s || '').replace(/[^\p{L}]/gu, '');
  if (!chars) return false;
  const cjk = (chars.match(CJK_G) || []).length;
  return cjk / chars.length > 0.4;
};

function scoreCandidate(x, want) {
  if (!x || (!x.syncedLyrics && !x.plainLyrics)) return null; // no usable content
  const nt = norm(x.trackName), na = norm(x.artistName);
  if (!nt) return null; // can't verify an empty/unknown title
  const titleExact = nt === want.title;
  const titleOverlap = nt.length >= 3 && want.title.length >= 3 &&
    (nt.includes(want.title) || want.title.includes(nt));
  if (!titleExact && !titleOverlap) return null;

  // Script guard: reject a CJK cover for a non-CJK track (and vice-versa) —
  // this is what produced random Chinese lyrics for English songs.
  if (isCJK(x.trackName) !== want.cjkTitle) return null;

  const ddiff = (x.duration && want.duration) ? Math.abs(x.duration - want.duration) : 999;
  if (want.duration && x.duration && ddiff > 12) return null;

  // Artist matching is fuzzy on lrclib (feat., multiple artists, romanization),
  // so DON'T hard-require it. Instead: trust a candidate when the artist lines
  // up, OR when the title is exact and the duration is close (very likely the
  // same recording). The CJK guard already blocks wrong-language covers.
  const artistExact = !!want.artist && na === want.artist;
  const artistOverlap = !!want.artist && !!na && (na.includes(want.artist) || want.artist.includes(na));
  const durClose = ddiff <= 4;
  if (want.artist) {
    if (!artistExact && !artistOverlap && !(titleExact && durClose)) return null;
  } else if (!titleExact) {
    return null; // no artist known → require an exact title
  }

  let s = 0;
  if (titleExact) s += 4;
  if (artistExact) s += 4; else if (artistOverlap) s += 2;
  if (x.syncedLyrics) s += 4;
  if (durClose) s += 3; else if (ddiff <= 8) s += 1;
  return { x, score: s, synced: !!x.syncedLyrics, ddiff };
}

// Minimum confidence. title-exact + close-duration (7) clears it even when the
// artist string differs, which is the common "couldn't find it" case.
const MIN_SCORE = 5;

async function fetchLyrics({ artist, title, album, duration } = {}) {
  if (!title) return null;
  if (!(duration > 0)) duration = undefined; // 0/NaN at track start → don't over-constrain
  const ct = cleanTitle(title);
  const bare = title.replace(/\(.*?\)|\[.*?\]/g, '').replace(/\s+/g, ' ').trim() || ct;
  const artist1 = (artist || '').split(/[,&]| feat| ft| x /i)[0].trim(); // primary artist only

  // 1) Exact match (lrclib verifies title+artist+duration for us). Try several
  //    title/artist shapes, and finally without duration/album constraints.
  const getVariants = [
    { artist_name: artist, track_name: ct, album_name: album, duration },
    { artist_name: artist, track_name: ct, duration },
    { artist_name: artist1, track_name: bare, duration },
    { artist_name: artist, track_name: title },
    { artist_name: artist1, track_name: bare }
  ];
  for (const v of getVariants) {
    const r = await getJson('https://lrclib.net/api/get?' + qs(v));
    if (r && (r.syncedLyrics || r.plainLyrics)) {
      return { syncedLyrics: r.syncedLyrics || '', plainLyrics: r.plainLyrics || '' };
    }
  }

  // 2) Search fallback — accept only a confidently-matching result so we never
  //    show lyrics for a different (same-title / different-language) song.
  const want = {
    title: norm(title), artist: norm(artist),
    duration, cjkTitle: isCJK(title)
  };
  const queries = [
    { track_name: ct, artist_name: artist1 },
    { track_name: bare, artist_name: artist1 },
    { track_name: bare },          // title only, still gated by score + CJK guard
    { q: `${bare} ${artist1}`.trim() }
  ];
  const seen = new Set();
  let best = null;
  for (const query of queries) {
    const arr = await getJson('https://lrclib.net/api/search?' + qs(query));
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      if (!x || seen.has(x.id)) continue;
      seen.add(x.id);
      const scored = scoreCandidate(x, want);
      if (scored && (!best || scored.score > best.score ||
        (scored.score === best.score && scored.ddiff < best.ddiff))) best = scored;
    }
    if (best && best.synced && best.score >= 11) break; // strong synced hit, stop early
  }

  const hit = best && best.score >= MIN_SCORE && best.x;
  if (hit && (hit.syncedLyrics || hit.plainLyrics)) {
    return { syncedLyrics: hit.syncedLyrics || '', plainLyrics: hit.plainLyrics || '' };
  }
  return null; // no confident match — show nothing rather than the wrong song
}

module.exports = { fetchLyrics };
