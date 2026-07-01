'use strict';

// Multi-source lyrics (all free, no API keys). Runs in the main process so
// there are no CORS restrictions. Providers: lrclib, NetEase, Kugou (synced) and
// Genius (plain, scraped) as a last resort.
const https = require('https');
const http = require('http');

// Core HTTP(S) GET with redirect-following, a hard timeout, and optional raw
// (non-JSON) body — used for Genius's HTML lyrics pages.
function httpGet(url, { headers = {}, raw = false, redirects = 3 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      const mod = url.startsWith('http://') ? http : https;
      req = mod.get(url, {
        headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 (Stardust)', 'Accept-Language': 'en' }, headers),
        timeout: 6000
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          return finish(httpGet(new URL(res.headers.location, url).href, { headers, raw, redirects: redirects - 1 }));
        }
        if (res.statusCode !== 200) { res.resume(); return finish(null); }
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { if (raw) return finish(d); try { finish(JSON.parse(d)); } catch { finish(null); } });
      });
      req.on('error', () => finish(null));
      req.on('timeout', () => { try { req.destroy(); } catch {} finish(null); });
    } catch { finish(null); }
    setTimeout(() => { try { req && req.destroy(); } catch {} finish(null); }, 7000);
  });
}
const getJson = (url, extraHeaders) => httpGet(url, { headers: extraHeaders });
const getText = (url, extraHeaders) => httpGet(url, { headers: extraHeaders, raw: true });

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

  const knownDur = !!(x.duration && want.duration);
  const ddiff = knownDur ? Math.abs(x.duration - want.duration) : 999;
  if (knownDur && ddiff > 8) return null; // wrong length → almost always a different song

  const artistExact = !!want.artist && na === want.artist;
  const artistOverlap = !!want.artist && !!na && (na.includes(want.artist) || want.artist.includes(na));
  const durClose = ddiff <= 4;

  // Acceptance (CJK guard already blocks wrong-language covers):
  //  - duration KNOWN + within 8s → trust an exact/partial title (right length);
  //  - duration UNKNOWN → require artist corroboration, so a same-title song by
  //    a different artist can't be locked in before duration loads (wrong-song bug).
  if (knownDur) {
    if (!titleExact && !durClose && !artistExact && !artistOverlap) return null;
  } else {
    if (want.artist) { if (!artistExact && !artistOverlap) return null; }
    else if (!titleExact) return null; // no artist + no duration → need exact title
  }

  let s = 0;
  if (titleExact) s += 4;
  if (artistExact) s += 5; else if (artistOverlap) s += 2;
  if (x.syncedLyrics) s += 3;
  if (ddiff <= 2) s += 4; else if (ddiff <= 5) s += 2; else if (ddiff <= 8) s += 1;
  return { x, score: s, synced: !!x.syncedLyrics, ddiff };
}

// Minimum confidence. title-exact + close-duration (7) clears it even when the
// artist string differs, which is the common "couldn't find it" case.
const MIN_SCORE = 5;

// Priority-aware race. Each provider result carries a `kind`:
//   word  = real per-word timing (NetEase yrc / enhanced LRC)  ← best
//   line  = real line-level synced (lrclib / Kugou / NetEase lrc)
//   synth = synthesized line timing (Genius plain spread over the song)
//   plain = plain text, no timing                              ← last
// We resolve instantly on a `word` result (that's what "prefer NetEase" means),
// otherwise wait a short bounded grace for something better, then take the best.
const KIND_RANK = { word: 4, line: 3, synth: 2, plain: 1 };
function raceLyrics(promises) {
  return new Promise((resolve) => {
    let pending = promises.length, best = null, resolved = false, timer = null;
    if (!pending) return resolve(null);
    const settle = () => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(best); } };
    const consider = (r) => {
      if (resolved || !r || !r.kind) return;
      if (!best || KIND_RANK[r.kind] > KIND_RANK[best.kind]) best = r;
      if (best.kind === 'word') return settle();     // can't do better — stop now
      if (!timer) timer = setTimeout(settle, 1000);  // give a better source ~1s
    };
    promises.forEach((p) => Promise.resolve(p).then(consider).catch(() => {}).finally(() => {
      if (!resolved && --pending === 0) settle();
    }));
  });
}

async function fetchLyrics({ artist, title, album, duration } = {}) {
  if (!title) return null;
  if (!(duration > 0)) duration = undefined; // 0/NaN at track start → don't over-constrain
  const ct = cleanTitle(title);
  const bare = title.replace(/\(.*?\)|\[.*?\]/g, '').replace(/\s+/g, ' ').trim() || ct;
  const artist1 = (artist || '').split(/[,&]| feat| ft| x /i)[0].trim();

  const want = { title: norm(title), artist: norm(artist), duration, cjkTitle: isCJK(title) };

  // "Artist - Song" videos: the uploader isn't the real artist — try the title
  // split on " - " (both orders).
  const dash = bare.split(/\s[-–—]\s/);
  const altPairs = [];
  if (dash.length === 2) {
    altPairs.push({ track: dash[1].trim(), artist: dash[0].trim() });
    altPairs.push({ track: dash[0].trim(), artist: dash[1].trim() });
  }
  const wants = [want];
  for (const p of altPairs) wants.push({ title: norm(p.track), artist: norm(p.artist), duration, cjkTitle: isCJK(p.track) });
  const fTitle = altPairs[0] ? altPairs[0].track : bare;
  const fArtist = altPairs[0] ? altPairs[0].artist : artist1;
  const fWant = altPairs[0] ? wants[1] : want;

  // All providers race in parallel; first confident SYNCED result wins.
  return raceLyrics([
    fetchLrclib({ artist, ct, bare, artist1, duration, wants, altPairs }).catch(() => null),
    fetchNetease({ title: fTitle, artist: fArtist, want: fWant }).catch(() => null),
    fetchKugou({ title: fTitle, artist: fArtist, want: fWant }).catch(() => null),
    fetchGenius({ title: fTitle, artist: fArtist, want: fWant }).catch(() => null)
  ]);
}

// --- lrclib provider -------------------------------------------------------
async function fetchLrclib({ artist, ct, bare, artist1, duration, wants, altPairs }) {
  const reqs = [
    getJson('https://lrclib.net/api/get?' + qs({ artist_name: artist, track_name: ct, duration })),
    getJson('https://lrclib.net/api/search?' + qs({ track_name: bare, artist_name: artist1 })),
    getJson('https://lrclib.net/api/search?' + qs({ track_name: bare }))
  ];
  for (const p of altPairs) reqs.push(getJson('https://lrclib.net/api/search?' + qs({ track_name: p.track, artist_name: p.artist })));
  const [getRes, ...searches] = await Promise.all(reqs);

  const wrap = (r) => ({ syncedLyrics: r.syncedLyrics || '', plainLyrics: r.plainLyrics || '', kind: r.syncedLyrics ? 'line' : 'plain' });
  if (getRes && (getRes.syncedLyrics || getRes.plainLyrics)) return wrap(getRes);
  let best = null;
  for (const arr of searches) {
    if (!Array.isArray(arr)) continue;
    for (const x of arr) for (const w of wants) {
      const scored = scoreCandidate(x, w);
      if (scored && (!best || scored.score > best.score || (scored.score === best.score && scored.ddiff < best.ddiff))) best = scored;
    }
  }
  const hit = best && best.score >= MIN_SCORE && best.x;
  if (hit && (hit.syncedLyrics || hit.plainLyrics)) return wrap(hit);
  return null;
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
  if (yrc) { const enh = yrcToEnhancedLRC(yrc); if (enh) return { syncedLyrics: enh, plainLyrics: '', kind: 'word' }; }
  if (lrc && /\[\d+:\d+/.test(lrc)) return { syncedLyrics: lrc, plainLyrics: '', kind: 'line' };
  if (lrc) return { syncedLyrics: '', plainLyrics: lrc, kind: 'plain' };
  return null;
}

// --- Kugou provider (synced, line-level LRC) -------------------------------
async function fetchKugou({ title, artist, want }) {
  const q = encodeURIComponent(`${title} ${artist || ''}`.trim());
  const s = await getJson(`http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${q}&page=1&pagesize=8`);
  const list = s && s.data && s.data.info;
  if (!Array.isArray(list) || !list.length) return null;

  let best = null, bestScore = -1;
  for (const it of list) {
    const cand = { trackName: it.songname, artistName: it.singername, duration: it.duration || 0, syncedLyrics: 'x' };
    const sc = scoreCandidate(cand, want);
    if (sc && sc.score > bestScore) { bestScore = sc.score; best = it; }
  }
  if (!best || bestScore < MIN_SCORE) return null;

  const sr = await getJson(`http://krcs.kugou.com/search?ver=1&man=yes&client=mobi&hash=${best.hash}`);
  const cand = sr && sr.candidates && sr.candidates[0];
  if (!cand) return null;
  const dl = await getJson(`http://lyrics.kugou.com/download?ver=1&client=pc&fmt=lrc&charset=utf8&id=${cand.id}&accesskey=${cand.accesskey}`);
  if (!dl || !dl.content) return null;
  let lrc = '';
  try { lrc = Buffer.from(dl.content, 'base64').toString('utf8'); } catch { return null; }
  if (/\[\d+:\d+/.test(lrc)) return { syncedLyrics: lrc, plainLyrics: '', kind: 'line' };
  return null;
}

// --- Genius provider (plain text, scraped — last resort, no timing) --------
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
    .replace(/&#x2f;/gi, '/').replace(/&nbsp;/g, ' ');
}
function extractGeniusLyrics(html) {
  const parts = [...html.matchAll(/data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  if (!parts.length) return '';
  let t = parts.join('\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  t = decodeEntities(t);
  return t.split('\n').map((x) => x.trim()).filter(Boolean).join('\n');
}
async function fetchGenius({ title, artist, want }) {
  const q = encodeURIComponent(`${title} ${artist || ''}`.trim());
  const s = await getJson(`https://genius.com/api/search/multi?q=${q}`);
  const sections = s && s.response && s.response.sections;
  if (!Array.isArray(sections)) return null;

  let hit = null, fallback = null;
  for (const sec of sections) {
    for (const h of (sec.hits || [])) {
      if (h.type !== 'song' || !h.result) continue;
      if (!fallback) fallback = h.result;
      const cand = { trackName: h.result.title, artistName: (h.result.primary_artist && h.result.primary_artist.name) || '', duration: 0, syncedLyrics: 'x' };
      if (scoreCandidate(cand, { ...want, duration: undefined })) { hit = h.result; break; }
    }
    if (hit) break;
  }
  hit = hit || fallback;
  if (!hit || !hit.url) return null;
  const html = await getText(hit.url);
  if (!html) return null;
  const text = extractGeniusLyrics(html);
  if (!text) return null;

  // Genius has no timing. If we know the song duration, SYNTHESIZE line
  // timestamps by spreading the lines across the track (weighted by syllables),
  // so it gets line-by-line + word highlighting like a synced source. Skip
  // section headers like [Chorus] for timing but keep them shown.
  if (want && want.duration > 0) {
    const lines = text.split('\n');
    const sylOf = (s) => ((s || '').toLowerCase().match(/[aeiouy]+/g) || []).length;
    const weights = lines.map((l) => /^\[.*\]$/.test(l.trim()) ? 0.4 : Math.max(0.5, sylOf(l)));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    // Assume vocals span ~from 3% to ~97% of the track.
    const start = want.duration * 0.03, span = want.duration * 0.92;
    let acc = 0; const out = [];
    for (let i = 0; i < lines.length; i++) {
      const t = start + span * (acc / total);
      const mm = Math.floor(t / 60), ss = (t - mm * 60).toFixed(2);
      out.push('[' + String(mm).padStart(2, '0') + ':' + ss.padStart(5, '0') + ']' + lines[i]);
      acc += weights[i];
    }
    return { syncedLyrics: out.join('\n'), plainLyrics: '', kind: 'synth' };
  }
  return { syncedLyrics: '', plainLyrics: text, kind: 'plain' };
}

module.exports = { fetchLyrics };
