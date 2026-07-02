'use strict';

// Shared community transcript store (Supabase). Transcriptions are best-effort
// (Whisper can mishear words), so they live in Stardust's OWN database rather
// than being published into the public lyrics ecosystem: real synced sources
// always win, and a community transcript only fills the gap before Genius
// guessing. Word-level <mm:ss.xx> tags are preserved end-to-end.
const https = require('https');

// One shared project for every Stardust install. The anon key is safe to ship:
// row-level security allows select + insert only (no update/delete).
const SUPABASE_URL = process.env.STARDUST_SUPABASE_URL || 'https://ufztwzzdcnlhkjflfkgk.supabase.co';
const SUPABASE_ANON = process.env.STARDUST_SUPABASE_ANON || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVmenR3enpkY25saGtqZmxma2drIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5NDA1NzAsImV4cCI6MjA5ODUxNjU3MH0.aR51WJkvyf1lfmIFQJArWor7AJGIsuSYRF4-Ed6BAJ4';

const enabled = () => !!(SUPABASE_URL && SUPABASE_ANON);

// Normalized match keys — resilient to case/punctuation/diacritic differences.
const keyOf = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFKC')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim()
  .slice(0, 120);

function req(method, path, body) {
  return new Promise((resolve) => {
    if (!enabled()) return resolve(null);
    let u;
    try { u = new URL(SUPABASE_URL + path); } catch { return resolve(null); }
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {
      apikey: SUPABASE_ANON,
      Authorization: 'Bearer ' + SUPABASE_ANON,
      'Content-Type': 'application/json'
    };
    if (data) headers['Content-Length'] = data.length;
    if (method === 'POST') headers.Prefer = 'return=minimal';
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method, headers, timeout: 8000
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { let json = null; try { json = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode, json }); });
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { try { r.destroy(); } catch {} resolve(null); });
    if (data) r.write(data);
    r.end();
  });
}

// Latest matching transcript for a song (duration within ±7s when both known).
async function getTranscript(title, artist, duration) {
  const tk = keyOf(title), ak = keyOf(artist);
  if (!tk) return null;
  const res = await req('GET', '/rest/v1/transcripts'
    + '?select=lrc,duration'
    + '&title_key=eq.' + encodeURIComponent(tk)
    + '&artist_key=eq.' + encodeURIComponent(ak)
    + '&order=created_at.desc&limit=8');
  if (!res || res.status !== 200 || !Array.isArray(res.json)) return null;
  for (const row of res.json) {
    if (duration > 0 && row.duration > 0 && Math.abs(row.duration - duration) > 7) continue;
    if (row.lrc && /\[\d+:\d+/.test(row.lrc)) return row.lrc;
  }
  return null;
}

// Fire-and-forget upload of a finished transcription (word-timed LRC).
async function putTranscript({ title, artist, album, duration, lrc } = {}) {
  const tk = keyOf(title);
  if (!tk || !lrc) return false;
  const res = await req('POST', '/rest/v1/transcripts', {
    title_key: tk,
    artist_key: keyOf(artist),
    title: String(title || '').slice(0, 300),
    artist: String(artist || '').slice(0, 300),
    album: String(album || '').slice(0, 300),
    duration: Math.round(duration > 0 ? duration : 0),
    lrc: String(lrc).slice(0, 200000)
  });
  const ok = !!res && res.status >= 200 && res.status < 300;
  console.log('[Stardust] community transcript upload', ok ? 'ok' : 'failed (' + (res && res.status) + ')');
  return ok;
}

module.exports = { getTranscript, putTranscript, enabled };
