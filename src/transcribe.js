'use strict';

// Transcribe a song's audio into WORD-TIMED lyrics via a Whisper endpoint
// (Groq's free OpenAI-compatible API by default). Results are cached to disk so
// a transcribed song shows instantly on replay.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { app } = require('electron');
const community = require('./community');
const align = require('./align');

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3';
const CACHE_DIR = path.join(app.getPath('userData'), 'Transcripts');

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
// Forget a local transcription (the user chose database lyrics instead).
function removeCached(title, artist) {
  try { fs.unlinkSync(path.join(CACHE_DIR, keyFor(title, artist) + '.lrc')); } catch {}
}

// Per-song source preference: 'db' (use database lyrics) or 'transcript'
// (use my transcription). Chinese lyric sites often carry wrong English
// text, so a user's own transcription must stay switchable — never deleted.
const PREFS_PATH = path.join(app.getPath('userData'), 'transcript-prefs.json');
let prefsCache = null;
function loadPrefs() {
  if (prefsCache) return prefsCache;
  try { prefsCache = JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch { prefsCache = {}; }
  return prefsCache;
}
function getPref(title, artist) { return loadPrefs()[keyFor(title, artist)] || null; }
function setPref(title, artist, val) {
  const p = loadPrefs();
  if (val) p[keyFor(title, artist)] = val; else delete p[keyFor(title, artist)];
  try { fs.writeFileSync(PREFS_PATH, JSON.stringify(p)); } catch {}
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

function postMultipart(url, fieldPairs, fileBuf, apiKey, filename = 'audio.webm') {
  return new Promise((resolve) => {
    const boundary = '----stardust' + Date.now();
    const chunks = [];
    for (const [k, v] of fieldPairs) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
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

// Run Whisper on captured audio; returns { json } or { error }.
async function whisperVerbose(audio, apiKey, audioName) {
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
  const res = await postMultipart(ENDPOINT, fields, buf, apiKey, audioName || 'audio.webm');
  if (!res) return { error: 'network' };
  console.log('[Stardust] whisper status', res.status, res.json && (res.json.error ? JSON.stringify(res.json.error).slice(0, 200) : ('segments=' + ((res.json.segments || []).length) + ' words=' + ((res.json.words || []).length))));
  if (res.status === 401 || res.status === 403) return { error: 'bad-key' };
  if (res.status !== 200 || !res.json) return { error: 'engine' };
  return { json: res.json };
}

// audio: Uint8Array/Buffer of the recorded song (webm/opus). Returns
// { syncedLyrics } on success, or { error } describing what to fix.
async function transcribe({ title, artist, album, duration, audio, audioName } = {}, apiKey, share) {
  const w = await whisperVerbose(audio, apiKey, audioName);
  if (w.error) return { error: w.error };
  const lrc = buildLRC(w.json);
  if (lrc) {
    putCached(title, artist, lrc);
    // Fire-and-forget: share with the Stardust community store (Supabase) so
    // the next listener gets these word-timed lyrics without transcribing.
    // Kept OUT of the public lyrics ecosystem — transcriptions can mishear.
    if (share && community.enabled()) community.putTranscript({ title, artist, album, duration, lrc }).catch(() => {});
    return { syncedLyrics: lrc, shared: !!(share && community.enabled()) };
  }
  // No usable timing but we got text → show it as plain (not cached).
  if (w.json.text && w.json.text.trim()) return { syncedLyrics: '', plainLyrics: w.json.text.trim() };
  return { error: 'empty' };
}

// Forced alignment: keep the KNOWN lyrics text, take the audio's word clock.
// Near-perfect word timing without trusting Whisper's (mishearable) words.
async function alignToLyrics({ title, artist, album, duration, audio, audioName, lyrics, realStamps } = {}, apiKey, share) {
  if (!lyrics) return { error: 'no-lyrics' };
  const w = await whisperVerbose(audio, apiKey, audioName);
  if (w.error) return { error: w.error };
  const words = w.json.words || (w.json.segments || []).flatMap((sg) => sg.words || []);
  if (!words || words.length < 10) return { error: 'empty' };
  const res = align.alignLyrics(lyrics, words, duration, !!realStamps);
  if (!res) return { error: 'align-failed' };
  console.log('[Stardust] aligned', title, '— coverage', Math.round(res.coverage * 100) + '%');
  putCached(title, artist, res.syncedLyrics);
  if (share && community.enabled()) community.putTranscript({ title, artist, album, duration, lrc: res.syncedLyrics }).catch(() => {});
  return { syncedLyrics: res.syncedLyrics, coverage: res.coverage, shared: !!(share && community.enabled()) };
}

module.exports = { transcribe, alignToLyrics, getCached, putCached, removeCached, getPref, setPref, CACHE_DIR };
