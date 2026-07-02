'use strict';

// Multi-source lyrics (all free, no API keys). Runs in the main process so
// there are no CORS restrictions. Providers: lrclib, NetEase, Kugou (synced) and
// Genius (plain, scraped) as a last resort.
const https = require('https');
const http = require('http');
const transcribe = require('./transcribe');
const community = require('./community');

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
// Strip the junk YTM/YouTube appends to titles. Matches the keyword ANYWHERE
// inside the brackets (so "(Official Music Video)", "(HD Remaster)", etc. go),
// not only when it's the first word.
const CLEAN_KW = 'official|lyrics?|audio|video|music\\s*video|visuali[sz]er|hd|hq|4k|8k|mv|m/v|explicit|clean|remaster(?:ed)?|extended|full|prod\\.?|sped\\s*up|slowed|reverb|live|performance|color(?:ou)?r?\\s*coded';
const cleanTitle = (s) => (s || '')
  .replace(new RegExp('\\((?=[^)]*(?:' + CLEAN_KW + '))[^)]*\\)', 'gi'), '')
  .replace(new RegExp('\\[(?=[^\\]]*(?:' + CLEAN_KW + '))[^\\]]*\\]', 'gi'), '')
  .replace(/\s*-\s*topic$/i, '')
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
  const artistExact = !!want.artist && na === want.artist;
  const artistOverlap = !!want.artist && !!na && (na.includes(want.artist) || want.artist.includes(na));

  // Better way (no exact-artist requirement): DURATION is the disambiguator.
  //  - duration KNOWN → the right song has the right length; require it within
  //    ~7s. Artist is NOT required (just scored), so odd artist formatting never
  //    causes a miss, and the correct version still wins via the score below.
  //  - duration UNKNOWN → we can't tell same-title songs apart yet, so only
  //    accept a strong title+artist match; otherwise bail and let it retry once
  //    the duration has loaded (prevents locking in a wrong same-title song).
  // Sped-up / slowed / nightcore / remix versions have a DIFFERENT length than
  // the original lyrics entry, so the duration gate would wrongly reject them
  // (and we'd fall through to Genius). For those, ignore duration and require an
  // artist match instead — the same words, re-timed by the listening engine.
  if (knownDur && !want.relaxDur) {
    if (ddiff > 7) return null;
  } else if (!(titleExact && (artistExact || artistOverlap)) && !(titleOverlap && artistExact)) {
    return null;
  }

  let s = 0;
  if (titleExact) s += 4;
  if (artistExact) s += 5; else if (artistOverlap) s += 2;
  if (x.syncedLyrics) s += 2;
  if (ddiff <= 1) s += 6; else if (ddiff <= 3) s += 4; else if (ddiff <= 7) s += 2; // duration closeness dominates
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

async function fetchLyrics({ artist, title, album, duration, skipTranscript } = {}) {
  if (!title) return null;
  // A previously transcribed version of THIS song is the truest match (it's the
  // actual audio's words, word-timed) — use it instantly. skipTranscript is the
  // "search the databases again" path: ignore transcription sources entirely.
  if (!skipTranscript) {
    try {
      const pref = transcribe.getPref(title, artist);
      if (pref !== 'db') {
        const c = transcribe.getCached(title, artist);
        // pinned: the user explicitly chose their transcription — the renderer
        // must not auto-upgrade it away.
        if (c) return { syncedLyrics: c, plainLyrics: '', kind: 'word', source: 'transcript', pinned: pref === 'transcript' };
      }
    } catch {}
  }
  if (!(duration > 0)) duration = undefined; // 0/NaN at track start → don't over-constrain
  const ct = cleanTitle(title);
  const bare = title.replace(/\(.*?\)|\[.*?\]/g, '').replace(/\s+/g, ' ').trim() || ct;
  const artist1 = (artist || '').split(/[,&]| feat| ft| x /i)[0].trim();

  // Re-timed versions (sped up / slowed / nightcore / remix) have a different
  // length than the original lyrics, so ignore duration when matching them.
  const relaxDur = /\b(sped\s*up|slow(ed)?|nightcore|remix|reverb|8d|bass\s*boost)\b/i.test(title);
  const want = { title: norm(title), artist: norm(artist), duration, cjkTitle: isCJK(title), relaxDur };

  // "Artist - Song" videos: the uploader isn't the real artist — try the title
  // split on " - " (both orders).
  const dash = bare.split(/\s[-–—]\s/);
  const altPairs = [];
  if (dash.length === 2) {
    altPairs.push({ track: dash[1].trim(), artist: dash[0].trim() });
    altPairs.push({ track: dash[0].trim(), artist: dash[1].trim() });
  }
  const wants = [want];
  for (const p of altPairs) wants.push({ title: norm(p.track), artist: norm(p.artist), duration, cjkTitle: isCJK(p.track), relaxDur });
  const fTitle = altPairs[0] ? altPairs[0].track : bare;
  const fArtist = altPairs[0] ? altPairs[0].artist : artist1;
  const fWant = altPairs[0] ? wants[1] : want;

  // Stage 1: Musixmatch gets a RESERVED window — it needs 2-3 round trips,
  // and the fast line-level sources must not beat its human word-level
  // richsync to the finish line. The rest race as before. Community rows are
  // fetched ONCE: aligned (word-timed, database text) entries compete in the
  // race itself so keyless users get shared word timing over line-level
  // sources; raw transcripts stay a late fallback (stage 1.5).
  const communityP = skipTranscript ? Promise.resolve(null)
    : community.getTranscript(title, artist, duration).catch(() => null);
  const mxmP = fetchMusixmatch({ title: fTitle, artist: fArtist, duration, want: fWant }).catch(() => null);
  const othersP = raceLyrics([
    fetchLrclib({ artist, ct, bare, artist1, duration, wants, altPairs }).catch(() => null),
    fetchNetease({ title: fTitle, artist: fArtist, want: fWant }).catch(() => null),
    fetchKugou({ title: fTitle, artist: fArtist, want: fWant }).catch(() => null),
    communityP.then((clrc) => (clrc && clrc.includes('stardust-aligned-v2'))
      ? { syncedLyrics: clrc, plainLyrics: '', kind: 'word', source: 'community' } : null)
  ]);
  const mxm = await Promise.race([mxmP, new Promise((r) => setTimeout(() => r(undefined), 4000))]);
  if (mxm && mxm.kind === 'word') return mxm;   // richsync — nothing beats it
  const rest = await othersP;
  if (mxm && (!rest || KIND_RANK[mxm.kind] >= KIND_RANK[rest.kind])) return mxm;
  if (rest) return rest;
  // MXM may still finish after its window if everything else came up empty.
  const late = await Promise.race([mxmP, new Promise((r) => setTimeout(() => r(undefined), 1500))]);
  if (late) return late;

  // Stage 1.5: RAW community transcripts (whisper text — can mishear) only
  // beat Genius guessing; aligned entries already competed in stage 1.
  if (!skipTranscript) {
    try {
      const clrc = await communityP;
      if (clrc) return { syncedLyrics: clrc, plainLyrics: '', kind: 'word', source: 'community' };
    } catch {}
  }

  // Stage 2 (WORST CASE ONLY): Genius, and only because everything else came up
  // empty — its timing is synthesized/approximate, so it must never pre-empt a
  // real synced source (that's why it's not in the stage-1 race).
  return await fetchGenius({ title: fTitle, artist: fArtist, want: fWant }).catch(() => null);
}

// --- Musixmatch provider (desktop API, keyless token) -----------------------
// The strongest catalog, and for many tracks it has RICHSYNC — human-quality
// word-level timing — which outranks every other source. Uses the desktop
// app's free auto-issued user token (cached; refreshed on expiry/captcha).
const MXM_ROOT = 'https://apic-desktop.musixmatch.com/ws/1.1/';
const MXM_HEADERS = { Cookie: 'AWSELB=0; AWSELBCORS=0' };
let mxmTok = null; // { token, at }

function mxmTokenFile() {
  try {
    const { app } = require('electron');
    return require('path').join(app.getPath('userData'), 'mxm.json');
  } catch { return null; }
}
async function mxmToken(force) {
  const fs = require('fs');
  const file = mxmTokenFile();
  if (!mxmTok && file) { try { mxmTok = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} }
  if (!force && mxmTok && mxmTok.token && Date.now() - mxmTok.at < 7 * 86400e3) return mxmTok.token;
  const r = await getJson(MXM_ROOT + 'token.get?app_id=web-desktop-app-v1.0', MXM_HEADERS);
  const tok = r && r.message && r.message.body && r.message.body.user_token;
  if (!tok || tok.includes('Upgrade')) return null;
  mxmTok = { token: tok, at: Date.now() };
  if (file) { try { fs.writeFileSync(file, JSON.stringify(mxmTok)); } catch {} }
  return tok;
}

// richsync body -> enhanced LRC. Lines are {ts,te,l:[{c,o}]}: c is a text
// chunk (words AND spaces), o its offset from ts in seconds.
function richsyncToLRC(arr) {
  const stampM = (t) => {
    const mm = Math.floor(t / 60), ss = (t - mm * 60).toFixed(2);
    return String(mm).padStart(2, '0') + ':' + ss.padStart(5, '0');
  };
  const out = [];
  for (const ln of arr) {
    if (!ln || !Array.isArray(ln.l) || !ln.l.length) continue;
    let body = '', word = '', wordO = null;
    const flush = () => {
      if (word.trim()) body += '<' + stampM(ln.ts + (wordO || 0)) + '>' + word.trim() + ' ';
      word = ''; wordO = null;
    };
    for (const ch of ln.l) {
      const c = String(ch.c != null ? ch.c : '');
      if (/^\s*$/.test(c)) { flush(); continue; }
      if (wordO == null) wordO = +ch.o || 0;
      word += c;
    }
    flush();
    if (body) out.push('[' + stampM(ln.ts) + ']' + body.trim());
  }
  return out.join('\n');
}

async function fetchMusixmatch({ title, artist, duration, want }) {
  const token = await mxmToken();
  if (!token) return null;
  let macro = await getJson(MXM_ROOT + 'macro.subtitles.get?' + qs({
    format: 'json', namespace: 'lyrics_richsynched', subtitle_format: 'lrc',
    app_id: 'web-desktop-app-v1.0', usertoken: token,
    q_artist: artist || '', q_track: title || '', q_duration: duration || ''
  }), MXM_HEADERS);
  let head = macro && macro.message && macro.message.header;
  if (head && (head.status_code === 401 || head.hint === 'captcha')) {
    // Token expired/captcha'd — refresh once and retry immediately, so a
    // stale token costs one extra round trip instead of losing the song.
    mxmTok = null;
    const fresh = await mxmToken(true);
    if (!fresh) return null;
    macro = await getJson(MXM_ROOT + 'macro.subtitles.get?' + qs({
      format: 'json', namespace: 'lyrics_richsynched', subtitle_format: 'lrc',
      app_id: 'web-desktop-app-v1.0', usertoken: fresh,
      q_artist: artist || '', q_track: title || '', q_duration: duration || ''
    }), MXM_HEADERS);
  }
  const mc = macro && macro.message && macro.message.body && macro.message.body.macro_calls;
  if (!mc) return null;
  const trk = mc['matcher.track.get'] && mc['matcher.track.get'].message && mc['matcher.track.get'].message.body && mc['matcher.track.get'].message.body.track;
  if (!trk) return null;
  // Verify the match — but LENIENTLY: Musixmatch's matcher already matched
  // with q_duration, and a YouTube edition often runs several seconds longer
  // than the album cut. Require a title match + (artist overlap OR duration
  // within 12s); the strict ±7s gate was rejecting correct hits.
  const nt = norm(trk.track_name), na = norm(trk.artist_name);
  const titleOk = nt && (nt === want.title || (nt.length >= 3 && want.title.length >= 3 && (nt.includes(want.title) || want.title.includes(nt))));
  const artistOk = !!want.artist && !!na && (na.includes(want.artist) || want.artist.includes(na));
  const durOk = !(trk.track_length && want.duration) || Math.abs(trk.track_length - want.duration) <= 12;
  if (!titleOk || (!artistOk && !durOk)) return null;
  if (isCJK(trk.track_name) !== want.cjkTitle) return null;

  if (trk.has_richsync) {
    const rs = await getJson(MXM_ROOT + 'track.richsync.get?' + qs({
      format: 'json', app_id: 'web-desktop-app-v1.0', usertoken: token, track_id: trk.track_id
    }), MXM_HEADERS);
    const body = rs && rs.message && rs.message.body && rs.message.body.richsync;
    if (body && body.richsync_body) {
      try {
        const enh = richsyncToLRC(JSON.parse(body.richsync_body));
        if (enh) return { syncedLyrics: enh, plainLyrics: '', kind: 'word', source: 'musixmatch' };
      } catch {}
    }
  }
  const st = mc['track.subtitles.get'] && mc['track.subtitles.get'].message && mc['track.subtitles.get'].message.body;
  const subtitle = st && st.subtitle_list && st.subtitle_list[0] && st.subtitle_list[0].subtitle;
  if (subtitle && subtitle.subtitle_body && /\[\d+:\d+/.test(subtitle.subtitle_body)) {
    return { syncedLyrics: subtitle.subtitle_body, plainLyrics: '', kind: 'line', source: 'musixmatch' };
  }
  return null;
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

  const wrap = (r) => ({ syncedLyrics: r.syncedLyrics || '', plainLyrics: r.plainLyrics || '', kind: r.syncedLyrics ? 'line' : 'plain', source: 'lrclib' });
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
  if (yrc) { const enh = yrcToEnhancedLRC(yrc); if (enh) return { syncedLyrics: enh, plainLyrics: '', kind: 'word', source: 'netease' }; }
  if (lrc && /\[\d+:\d+/.test(lrc)) return { syncedLyrics: lrc, plainLyrics: '', kind: 'line', source: 'netease' };
  if (lrc) return { syncedLyrics: '', plainLyrics: lrc, kind: 'plain', source: 'netease' };
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
  if (/\[\d+:\d+/.test(lrc)) return { syncedLyrics: lrc, plainLyrics: '', kind: 'line', source: 'kugou' };
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

  // Strip Genius page junk that leaks into the container:
  //  - header preamble: "247 Contributors", "Translations", the language list,
  //    and a trailing "<Title> Lyrics" — everything before the real lyrics;
  //  - "You might also like" injected between sections;
  //  - trailing "…Embed" / "NEmbed".
  // The real lyrics begin at the first [Section] tag, or after "… Lyrics".
  const secIdx = t.search(/\[[^\]\n]{1,60}\]/);
  if (secIdx > 0 && /contributor|translation/i.test(t.slice(0, secIdx))) {
    t = t.slice(secIdx);
  } else {
    t = t.replace(/^[\s\S]*?\bLyrics\b[ \t]*\n?/i, (m) => /contributor|translation/i.test(m) ? '' : m);
    t = t.replace(/^\s*\d+\s*Contributors?[\s\S]*?(?=\n)/i, '');
  }
  t = t.replace(/You might also like/gi, '\n');
  t = t.replace(/\d*\s*Embed\b/gi, '');                 // "123Embed" anywhere
  t = t.replace(/^.*\bGet tickets\b.*$/gim, '');         // concert promo
  t = t.replace(/^\s*See .+ Live.*$/gim, '');
  return t.split('\n').map((x) => x.trim()).filter(Boolean).join('\n');
}
async function fetchGenius({ title, artist, want }) {
  const q = encodeURIComponent(`${title} ${artist || ''}`.trim());
  const s = await getJson(`https://genius.com/api/search/multi?q=${q}`);
  const sections = s && s.response && s.response.sections;
  if (!Array.isArray(sections)) return null;

  // Only accept a CONFIDENT title+artist match — no loose "first hit" fallback
  // (that's what produced wrong-song Genius lyrics).
  let hit = null;
  for (const sec of sections) {
    for (const h of (sec.hits || [])) {
      if (h.type !== 'song' || !h.result) continue;
      const cand = { trackName: h.result.title, artistName: (h.result.primary_artist && h.result.primary_artist.name) || '', duration: 0, syncedLyrics: 'x' };
      if (scoreCandidate(cand, { ...want, duration: undefined, relaxDur: false })) { hit = h.result; break; }
    }
    if (hit) break;
  }
  if (!hit || !hit.url) return null;
  const html = await getText(hit.url);
  if (!html) return null;
  const text = extractGeniusLyrics(html);
  if (!text) return null;

  // Genius has no timing — synthesize line timestamps by spreading the lines
  // across the track (weighted by syllables) so it gets line-by-line + word
  // highlighting. Approximate, but now on the RIGHT song (artist-gated match).
  if (want && want.duration > 0) {
    const lines = text.split('\n');
    const sylOf = (s) => ((s || '').toLowerCase().match(/[aeiouy]+/g) || []).length;
    const weights = lines.map((l) => /^\[.*\]$/.test(l.trim()) ? 0.4 : Math.max(0.6, sylOf(l)));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const start = want.duration * 0.04, span = want.duration * 0.9; // vocals ~4%–94%
    let acc = 0; const out = [];
    for (let i = 0; i < lines.length; i++) {
      const t = start + span * (acc / total);
      const mm = Math.floor(t / 60), ss = (t - mm * 60).toFixed(2);
      out.push('[' + String(mm).padStart(2, '0') + ':' + ss.padStart(5, '0') + ']' + lines[i]);
      acc += weights[i];
    }
    return { syncedLyrics: out.join('\n'), plainLyrics: '', kind: 'synth', source: 'genius' };
  }
  return { syncedLyrics: '', plainLyrics: text, kind: 'plain', source: 'genius' };
}

module.exports = { fetchLyrics };
