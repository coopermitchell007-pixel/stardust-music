'use strict';

// Transcribe a song's audio into WORD-TIMED lyrics via a Whisper endpoint
// (Groq's free OpenAI-compatible API by default). Results are cached to disk so
// a transcribed song shows instantly on replay.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Worker } = require('worker_threads');
const { app } = require('electron');

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3';
const CACHE_DIR = path.join(app.getPath('userData'), 'Transcripts');
const LRCLIB = 'https://lrclib.net/api';

function ensureDir() { try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {} }
const keyFor = (title, artist) =>
  (String(title || '') + '__' + String(artist || '')).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 120) || 'unknown';

function getCached(title, artist) {
  try {
    const p = path.join(CACHE_DIR, keyFor(title, artist) + '.lrc');
    const lrc = fs.readFileSync(p, 'utf8');
    if (lrc && lrc.trim()) return lrc;
  } catch {}
  return null;
}
function putCached(title, artist, lrc) {
  ensureDir();
  try { fs.writeFileSync(path.join(CACHE_DIR, keyFor(title, artist) + '.lrc'), lrc); } catch {}
}

const stamp = (sec) => {
  const t = Math.max(0, sec || 0), mm = Math.floor(t / 60), ss = (t - mm * 60).toFixed(2);
  return String(mm).padStart(2, '0') + ':' + ss.padStart(5, '0');
};

// Build an enhanced-LRC string (with <mm:ss.xx> word tags) from Whisper's
// verbose_json. Groups words into lines using segment boundaries when present.
function buildLRC(json) {
  if (!json) return '';
  const words = json.words || (json.segments || []).flatMap((s) => s.words || []);
  if (words && words.length) {
    const segs = (json.segments && json.segments.length) ? json.segments : null;
    const lines = [];
    if (segs) {
      for (const seg of segs) {
        const inSeg = words.filter((w) => w.start >= seg.start - 0.05 && w.start <= seg.end + 0.05);
        if (!inSeg.length) continue;
        let body = '';
        for (const w of inSeg) body += '<' + stamp(w.start) + '>' + String(w.word || w.text || '').trim() + ' ';
        lines.push('[' + stamp(inSeg[0].start) + ']' + body.trim());
      }
    }
    if (!lines.length) {
      // No segments — chunk ~8 words per line.
      for (let i = 0; i < words.length; i += 8) {
        const chunk = words.slice(i, i + 8);
        let body = '';
        for (const w of chunk) body += '<' + stamp(w.start) + '>' + String(w.word || w.text || '').trim() + ' ';
        lines.push('[' + stamp(chunk[0].start) + ']' + body.trim());
      }
    }
    return lines.join('\n');
  }
  if (json.segments && json.segments.length) {
    return json.segments.map((s) => '[' + stamp(s.start) + ']' + String(s.text || '').trim()).join('\n');
  }
  return '';
}

function postMultipart(url, fieldPairs, fileBuf, apiKey) {
  return new Promise((resolve) => {
    const boundary = '----stardust' + Date.now();
    const chunks = [];
    for (const [k, v] of fieldPairs) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(Buffer.from(fileBuf));
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }, timeout: 120000
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
    req.write(body); req.end();
  });
}

// ---------------------------------------------------------------------------
// Community sharing — publish a finished transcription to lrclib.net, the open
// lyrics database Stardust already reads first. Once one person transcribes a
// song, everyone else (any lrclib-backed player) finds it instantly.
// Publishing is gated by a SHA-256 proof-of-work challenge; we solve it in a
// worker thread so the app stays responsive, and give up after ~90s.
// ---------------------------------------------------------------------------
const stripWordTags = (lrc) => lrc.replace(/<\d+:\d+(?:\.\d+)?>\s*/g, '')
  .split('\n').map((l) => l.replace(/\s+/g, ' ').trimEnd()).join('\n');

function postJson(url, body, headers = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'User-Agent': 'Stardust (https://github.com/coopermitchell007-pixel/stardust-music)'
      }, headers), timeout: 15000
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
    req.write(data); req.end();
  });
}

// Solve lrclib's proof-of-work: find nonce so that sha256(prefix+nonce) is
// byte-wise <= target. Runs off-thread; resolves null on timeout/failure.
function solveChallenge(prefix, target) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(`
        const { parentPort, workerData } = require('worker_threads');
        const crypto = require('crypto');
        const target = Buffer.from(workerData.target, 'hex');
        let nonce = 0;
        for (;;) {
          const h = crypto.createHash('sha256').update(workerData.prefix + nonce).digest();
          if (h.compare(target) <= 0) break;
          if (++nonce > 400e6) { nonce = -1; break; }
        }
        parentPort.postMessage(nonce);
      `, { eval: true, workerData: { prefix, target } });
    } catch { return resolve(null); }
    const timer = setTimeout(() => { try { worker.terminate(); } catch {} resolve(null); }, 90000);
    worker.once('message', (n) => { clearTimeout(timer); try { worker.terminate(); } catch {} resolve(n >= 0 ? String(n) : null); });
    worker.once('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function publishCommunity({ title, artist, album, duration, lrc }) {
  if (!title || !artist || !(duration > 0) || !lrc) return false;
  const ch = await postJson(LRCLIB + '/request-challenge');
  if (!ch || !ch.json || !ch.json.prefix || !ch.json.target) return false;
  const nonce = await solveChallenge(ch.json.prefix, ch.json.target);
  if (!nonce) return false;
  const synced = stripWordTags(lrc); // lrclib stores standard line-level LRC
  const res = await postJson(LRCLIB + '/publish', {
    trackName: String(title).trim(),
    artistName: String(artist).trim(),
    albumName: String(album || '').trim(),
    duration: Math.round(duration),
    plainLyrics: synced.replace(/^\[\d+:\d+(?:\.\d+)?\] ?/gm, ''),
    syncedLyrics: synced
  }, { 'X-Publish-Token': ch.json.prefix + ':' + nonce });
  const ok = !!res && res.status === 201;
  console.log('[Stardust] community publish', ok ? 'ok' : ('failed (' + (res && res.status) + ')'), '—', title);
  return ok;
}

// audio: Uint8Array/Buffer of the recorded song (webm/opus). Returns
// { syncedLyrics } on success, or { error } describing what to fix.
async function transcribe({ title, artist, album, duration, audio } = {}, apiKey, share) {
  if (!apiKey) return { error: 'no-key' };
  if (!audio || !audio.length) return { error: 'no-audio' };
  const buf = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
  const fields = [
    ['model', MODEL],
    ['response_format', 'verbose_json'],
    ['timestamp_granularities[]', 'segment'],
    ['timestamp_granularities[]', 'word'],
    ['temperature', '0']
  ];
  const res = await postMultipart(ENDPOINT, fields, buf, apiKey);
  if (!res) return { error: 'network' };
  console.log('[Stardust] transcribe status', res.status, res.json && (res.json.error ? JSON.stringify(res.json.error).slice(0, 200) : ('segments=' + ((res.json.segments || []).length) + ' words=' + ((res.json.words || []).length))));
  if (res.status === 401 || res.status === 403) return { error: 'bad-key' };
  if (res.status !== 200 || !res.json) return { error: 'engine' };
  const lrc = buildLRC(res.json);
  if (lrc) {
    putCached(title, artist, lrc);
    // Fire-and-forget: share with the community DB so the next listener gets
    // these lyrics for free (their app finds them via the normal lrclib fetch).
    if (share) publishCommunity({ title, artist, album, duration, lrc }).catch(() => {});
    return { syncedLyrics: lrc, shared: !!share };
  }
  // No usable timing but we got text → show it as plain (not cached).
  if (res.json.text && res.json.text.trim()) return { syncedLyrics: '', plainLyrics: res.json.text.trim() };
  return { error: 'empty' };
}

module.exports = { transcribe, getCached, putCached, publishCommunity, CACHE_DIR };
