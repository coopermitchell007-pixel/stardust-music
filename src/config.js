'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Persistent settings stored as JSON in the OS user-data dir.
const CONFIG_PATH = path.join(app.getPath('userData'), 'stardust-config.json');

const DEFAULTS = {
  activeTheme: 'nebula',
  // null = use the theme's own accent; a hex string overrides it.
  accentOverride: null,
  starfieldEnabled: true,
  starfieldDensity: 1.0, // multiplier applied to the theme's star count
  visualizerEnabled: true,
  glassEnabled: true,
  glassBlur: null, // null = use theme value; number overrides (px)
  miniPlayer: false,
  discordRichPresence: false,
  // Create a Discord application and paste its Client ID here (or via the panel)
  // to enable Rich Presence. https://discord.com/developers/applications
  discordClientId: '',
  globalHotkeys: true,
  adBlock: true,             // block ad/tracker requests + skip in-page ads
  windowBounds: { width: 1280, height: 800 },
  // Marketplace extras
  activeFont: null,          // installed font id, or null for YTM default
  enabledAnimations: [],     // installed animation ids that are on
  enabledFeatures: [],       // installed feature ids that are on
  enabledAudio: [],          // installed audio-effect ids that are on
  // Optional: a Groq API key (free tier) enables "Transcribe this song" — it
  // listens to the audio once and generates word-timed lyrics via Whisper.
  transcribeKey: '',
  // Automatically word-sync songs in the background (fetches the audio
  // directly — nothing to sit through) whenever lyrics lack word timing.
  // Needs the Groq key below; off = the ⚡ button still works manually.
  autoWordSync: true,
  // Share successful transcriptions with the Stardust community store
  // (Supabase) so nobody has to transcribe the same song twice. Transcripts
  // stay out of public lyric databases — they can mishear words.
  shareTranscripts: true,
  // Room lighting sync (Room Lights marketplace feature): which ecosystem,
  // the device/bridge IP on the LAN, and a token where one is needed (Hue
  // bridge username / Nanoleaf auth token — WLED and Govee need none, but
  // Govee needs "LAN control" switched on in its app).
  lightsProtocol: 'wled',   // 'wled' | 'govee' | 'hue' | 'nanoleaf'
  lightsHost: '',
  lightsToken: '',
  lightsCount: 120,         // WLED LED count
  lightsMode: 'pulse',      // 'pulse' | 'breathe' | 'strobe' | 'wash'
  lightsSegments: false,    // Govee: per-panel colours via razer streaming (Hexa etc.)
  djVoice: 'male'           // the DJ's voice: 'male' | 'female'
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    cache = Object.assign({}, DEFAULTS, JSON.parse(raw));
  } catch {
    cache = Object.assign({}, DEFAULTS);
  }
  return cache;
}

function save(patch = {}) {
  cache = Object.assign(load(), patch);
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[Stardust] failed to save config:', err.message);
  }
  return cache;
}

function get(key) {
  return load()[key];
}

module.exports = { load, save, get, DEFAULTS, CONFIG_PATH };
