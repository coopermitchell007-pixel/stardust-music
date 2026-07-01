'use strict';

// Synced/plain lyrics via lrclib.net (free, no API key). Runs in the main
// process so there are no CORS restrictions.
const https = require('https');

function getJson(url, extraHeaders) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = https.get(url, {
        headers: Object.assign({ 'User-Agent': 'Stardust v0.8 (https://github.com/coopermitchell007-pixel/stardust-music)' }, extraHeaders || {}),
        timeout: 3500
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish(null); }
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { try { finish(JSON.parse(d)); } catch { finish(null); } });
      });
      req.on('error', () => finish(null));
      req.on('timeout', () => { try { req.destroy(); } catch {} finish(null); });
    } catch { finish(null); }
    // Hard cap — guards against a connect/DNS hang that never fires 'timeout'.
    setTimeout(() => { try { req && req.destroy(); } catch {} finish(null); }, 4500);
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

  const artistExact = !!want.artist && na === want.artist;
  const artistOverlap = !!want.artist && !!na && (na.includes(want.artist) || want.artist.includes(na));
  const durClose = ddiff <= 4;

  // Trust rules (the CJK guard above already blocks wrong-language covers):
  //  - EXACT title  → accept (this is the common case lrclib formats the artist
  //    differently, which was making us miss basically everything);
  //  - partial title → require artist correspondence or a close duration.
  if (!titleExact) {
    if (want.artist) { if (!artistExact && !artistOverlap && !durClose) return null; }
    else if (!durClose) return null;
  }

  let s = 0;
  if (titleExact) s += 5;
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

  const want = {
    title: norm(title), artist: norm(artist),
    duration, cjkTitle: isCJK(title)
  };
  let best = null;
  const rank = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const x of arr) {
      const scored = scoreCandidate(x, want);
      if (scored && (!best || scored.score > best.score ||
        (scored.score === best.score && scored.ddiff < best.ddiff))) best = scored;
    }
  };

  // Fire the exact lookup AND the search TOGETHER (parallel) so a slow/unreachable
  // endpoint can't make us "stuck searching" — total latency ~one round-trip.
  const [getRes, searchArr] = await Promise.all([
    getJson('https://lrclib.net/api/get?' + qs({ artist_name: artist, track_name: ct, duration })),
    getJson('https://lrclib.net/api/search?' + qs({ track_name: bare, artist_name: artist1 }))
  ]);
  if (getRes && (getRes.syncedLyrics || getRes.plainLyrics)) {
    return { syncedLyrics: getRes.syncedLyrics || '', plainLyrics: getRes.plainLyrics || '' };
  }
  rank(searchArr);

  let hit = best && best.score >= MIN_SCORE && best.x;
  if (hit && (hit.syncedLyrics || hit.plainLyrics)) {
    return { syncedLyrics: hit.syncedLyrics || '', plainLyrics: hit.plainLyrics || '' };
  }

  // Still nothing — widen (title-only lrclib search) and NetEase, in parallel.
  const [arr2, ne] = await Promise.all([
    getJson('https://lrclib.net/api/search?' + qs({ track_name: bare })),
    fetchNetease({ title: bare, artist: artist1, want }).catch(() => null)
  ]);
  rank(arr2);
  hit = best && best.score >= MIN_SCORE && best.x;
  if (hit && (hit.syncedLyrics || hit.plainLyrics)) {
    return { syncedLyrics: hit.syncedLyrics || '', plainLyrics: hit.plainLyrics || '' };
  }
  if (ne) return ne;

  return null; // no confident match — show nothing rather than the wrong song
}

// --- NetEase provider ------------------------------------------------------
const NE_HEADERS = { Referer: 'https://music.163.com', Cookie: 'NMTID=1', 'User-Agent': 'Mozilla/5.0' };

// yrc (word karaoke) → enhanced LRC: "[mm:ss.xx]<mm:ss.xx>word<mm:ss.xx>word".
function yrcToEnhancedLRC(yrc) {
  const stamp = (ms) => {
    const t = ms / 1000, mm = Math.floor(t / 60), ss = (t - mm * 60).toFixed(2);
    return String(mm).padStart(2, '0') + ':' + ss.padStart(5, '0');
  };
  const out = [];
  for (const line of yrc.split('\n')) {
    if (line[0] !== '[') continue;                 // skip metadata (e.g. {"t":..})
    const head = line.match(/^\[(\d+),(\d+)\]/);
    if (!head) continue;
    const words = [...line.matchAll(/\((\d+),(\d+),\d+\)([^(]*)/g)];
    if (!words.length) continue;
    let body = '';
    for (const w of words) body += '<' + stamp(+w[1]) + '>' + w[3];
    out.push('[' + stamp(+head[1]) + ']' + body);
  }
  return out.join('\n');
}

async function fetchNetease({ title, artist, want }) {
  const q = encodeURIComponent(`${title} ${artist || ''}`.trim());
  const s = await getJson(`https://music.163.com/api/search/get?type=1&limit=8&s=${q}`, NE_HEADERS);
  const songs = s && s.result && s.result.songs;
  if (!Array.isArray(songs) || !songs.length) return null;

  let bestId = null, bestScore = -1;
  for (const sg of songs) {
    const cand = {
      trackName: sg.name,
      artistName: (sg.artists || []).map((a) => a.name).join(' '),
      duration: sg.duration ? Math.round(sg.duration / 1000) : 0,
      syncedLyrics: 'x' // placeholder so the content check passes; verified below
    };
    const sc = scoreCandidate(cand, want);
    if (sc && sc.score > bestScore) { bestScore = sc.score; bestId = sg.id; }
  }
  if (bestId == null || bestScore < MIN_SCORE) return null;

  const ly = await getJson(`https://music.163.com/api/song/lyric/v1?id=${bestId}&lv=1&kv=1&tv=-1&yv=1`, NE_HEADERS);
  if (!ly) return null;
  const yrc = ly.yrc && ly.yrc.lyric;
  const lrc = ly.lrc && ly.lrc.lyric;
  if (yrc) { const enh = yrcToEnhancedLRC(yrc); if (enh) return { syncedLyrics: enh, plainLyrics: '' }; }
  if (lrc && /\[\d+:\d+/.test(lrc)) return { syncedLyrics: lrc, plainLyrics: '' };
  if (lrc) return { syncedLyrics: '', plainLyrics: lrc };
  return null;
}

module.exports = { fetchLyrics };
