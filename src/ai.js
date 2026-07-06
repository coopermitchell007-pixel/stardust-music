'use strict';

// AI plumbing with two paths, tried in order:
//   1. The shared Stardust proxy (a Supabase Edge Function holding a Groq key
//      as a secret) — end users need NO key of their own once it's deployed
//      (see supabase/functions/ai/). Probed once, remembered for the session.
//   2. The user's own Groq key (Stardust panel → Settings), direct.
// TTS: Groq decommissioned `playai-tts`; the current model is Orpheus, which
// additionally needs a one-time terms click in the Groq console. Callers must
// treat a TTS failure as "use speechSynthesis instead", never as fatal.
const https = require('https');
const community = require('./community');

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TTS_URL = 'https://api.groq.com/openai/v1/audio/speech';
const CHAT_MODEL = 'llama-3.3-70b-versatile';
const TTS_MODEL = 'canopylabs/orpheus-v1-english';
const TTS_VOICE = 'leo';

function post(url, body, headers, binary) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': payload.length }, headers),
      timeout: 60000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (binary && res.statusCode === 200) return resolve({ status: 200, buf });
        let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, json, raw: buf.toString('utf8').slice(0, 300) });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
    req.write(payload); req.end();
  });
}

// ---- shared proxy -----------------------------------------------------------
let proxyState = 'unknown'; // 'unknown' | 'up' | 'down'
async function viaProxy(kind, payload, binary) {
  const info = community.info();
  if (!info || proxyState === 'down') return null;
  const res = await post(info.url + '/functions/v1/ai', { kind, payload },
    { apikey: info.anon, Authorization: 'Bearer ' + info.anon }, binary);
  if (!res) return null;
  if (res.status === 404 || res.status === 410) { proxyState = 'down'; return null; } // not deployed
  proxyState = 'up';
  return res;
}
const proxyAvailable = async () => {
  if (proxyState === 'unknown') await viaProxy('ping', {});
  return proxyState === 'up';
};

// ---- chat -------------------------------------------------------------------
async function chat(apiKey, messages, { maxTokens = 300, temperature = 0.8, json = false } = {}) {
  const body = { model: CHAT_MODEL, messages, max_tokens: maxTokens, temperature };
  if (json) body.response_format = { type: 'json_object' };
  let res = await viaProxy('chat', body);
  if (!res && !apiKey) return { error: 'no-key' };
  if (!res || res.status !== 200) {
    if (!apiKey) return { error: statusErr(res) };
    res = await post(CHAT_URL, body, { Authorization: 'Bearer ' + apiKey });
  }
  if (!res) return { error: 'network' };
  const text = res.json && res.json.choices && res.json.choices[0] && res.json.choices[0].message && res.json.choices[0].message.content;
  if (res.status !== 200 || !text) { console.log('[Stardust] ai chat failed:', res.status, res.raw); return { error: statusErr(res) }; }
  return { text: String(text).trim() };
}

// ---- tts --------------------------------------------------------------------
async function tts(apiKey, text, voice) {
  if (!text) return { error: 'empty' };
  const body = { model: TTS_MODEL, voice: voice || TTS_VOICE, input: String(text).slice(0, 600), response_format: 'wav' };
  let res = await viaProxy('tts', body, true);
  if ((!res || res.status !== 200) && apiKey) res = await post(TTS_URL, body, { Authorization: 'Bearer ' + apiKey }, true);
  if (!res) return { error: 'network' };
  if (res.status !== 200 || !res.buf || res.buf.length < 200) {
    // Surface WHY (decommissioned model / terms not accepted) in the log so
    // it's diagnosable — then the caller speaks via speechSynthesis instead.
    console.log('[Stardust] tts failed:', res.status, res.raw || '(no body)');
    const terms = res.raw && /terms/i.test(res.raw);
    return { error: terms ? 'tts-terms' : 'tts-unavailable' };
  }
  return { buf: res.buf, mime: 'audio/wav' };
}

// ---- stt (proxy path — keyless voice commands) --------------------------------
async function stt(audio) {
  if (!audio) return { error: 'no-audio' };
  const b64 = Buffer.from(audio).toString('base64');
  if (b64.length > 4000000) return { error: 'too-long' };
  const res = await viaProxy('stt', { b64, name: 'voice.webm' });
  if (!res) return { error: 'no-key' };
  if (res.status !== 200 || !res.json) return { error: statusErr(res) };
  return { text: String(res.json.text || '').trim() };
}

function statusErr(res) {
  if (!res) return 'network';
  if (res.status === 401 || res.status === 403) return 'bad-key';
  if (res.status === 429) return 'rate';
  return 'engine';
}

module.exports = { chat, tts, stt, proxyAvailable };
