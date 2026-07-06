'use strict';

// Groq helpers beyond Whisper: chat completions (AI DJ lines, voice-command
// intent, stats Q&A) and text-to-speech (the DJ's voice). Same API key as
// transcription — one key powers everything.
const https = require('https');

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TTS_URL = 'https://api.groq.com/openai/v1/audio/speech';
const CHAT_MODEL = 'llama-3.3-70b-versatile';
const TTS_MODEL = 'playai-tts';

function postJSON(url, body, apiKey, binary) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      }, timeout: 45000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (binary) return resolve({ status: res.statusCode, buf });
        try { resolve({ status: res.statusCode, json: JSON.parse(buf.toString('utf8')) }); }
        catch { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
    req.write(payload); req.end();
  });
}

// messages: [{role, content}]. Returns { text } or { error }.
async function chat(apiKey, messages, { maxTokens = 300, temperature = 0.8, json = false } = {}) {
  if (!apiKey) return { error: 'no-key' };
  const body = { model: CHAT_MODEL, messages, max_tokens: maxTokens, temperature };
  if (json) body.response_format = { type: 'json_object' };
  const res = await postJSON(CHAT_URL, body, apiKey);
  if (!res) return { error: 'network' };
  if (res.status === 401 || res.status === 403) return { error: 'bad-key' };
  if (res.status === 429) return { error: 'rate' };
  const text = res.json && res.json.choices && res.json.choices[0] && res.json.choices[0].message && res.json.choices[0].message.content;
  if (res.status !== 200 || !text) return { error: 'engine' };
  return { text: String(text).trim() };
}

// Returns { buf, mime } (wav) or { error }. Groq's PlayAI voices.
async function tts(apiKey, text, voice) {
  if (!apiKey) return { error: 'no-key' };
  if (!text) return { error: 'empty' };
  const res = await postJSON(TTS_URL, {
    model: TTS_MODEL, voice: voice || 'Fritz-PlayAI',
    input: String(text).slice(0, 600), response_format: 'wav'
  }, apiKey, true);
  if (!res) return { error: 'network' };
  if (res.status === 401 || res.status === 403) return { error: 'bad-key' };
  if (res.status === 429) return { error: 'rate' };
  if (res.status !== 200 || !res.buf || res.buf.length < 200) return { error: 'tts-unavailable' };
  return { buf: res.buf, mime: 'audio/wav' };
}

module.exports = { chat, tts };
