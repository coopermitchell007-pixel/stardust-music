'use strict';

// Local listening stats & history. Fed by the now-playing stream from the YTM
// page; everything stays on disk in userData (never leaves the machine).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = path.join(app.getPath('userData'), 'stats.json');
const PLAY_THRESHOLD_MS = 20000; // count a "play" once a track is heard this long
const MAX_GAP_MS = 6000;         // ignore gaps bigger than this (paused/asleep)
const RECENT_CAP = 150;

let data = load();
let last = { key: '', ts: 0, ms: 0, counted: false, np: null };
let saveTimer = null;

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      totalMs: d.totalMs || 0,
      byDay: d.byDay || {},
      tracks: d.tracks || {},
      artists: d.artists || {},
      recent: d.recent || []
    };
  } catch {
    return { totalMs: 0, byDay: {}, tracks: {}, artists: {}, recent: [] };
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(FILE, JSON.stringify(data)); } catch {}
  }, 4000);
}

const dayKey = () => new Date().toISOString().slice(0, 10);
const keyOf = (np) => (np.title || '') + '' + (np.artist || '');

function record(np) {
  if (!np || !np.title) return;
  const key = keyOf(np);
  const now = Date.now();

  if (key === last.key) {
    if (np.playing) {
      const delta = now - last.ts;
      if (delta > 0 && delta <= MAX_GAP_MS) {
        data.totalMs += delta;
        data.byDay[dayKey()] = (data.byDay[dayKey()] || 0) + delta;
        last.ms += delta;
        const tr = data.tracks[key];
        if (tr) tr.ms += delta;
        const ar = np.artist && data.artists[np.artist];
        if (ar) ar.ms += delta;
        // Crossing the threshold marks one completed play.
        if (!last.counted && last.ms >= PLAY_THRESHOLD_MS) countPlay(np, key);
      }
    }
  } else {
    // New track: ensure records exist, reset the running clock.
    if (!data.tracks[key]) data.tracks[key] = { title: np.title, artist: np.artist || '', art: np.art || '', count: 0, ms: 0, last: now };
    if (np.artist && !data.artists[np.artist]) data.artists[np.artist] = { name: np.artist, count: 0, ms: 0 };
    last = { key, ts: now, ms: 0, counted: false, np };
  }
  last.ts = now; last.np = np;
  saveSoon();
}

function countPlay(np, key) {
  last.counted = true;
  const tr = data.tracks[key]; if (tr) { tr.count++; tr.last = Date.now(); tr.art = np.art || tr.art; }
  const ar = np.artist && data.artists[np.artist]; if (ar) ar.count++;
  data.recent.unshift({ title: np.title, artist: np.artist || '', art: np.art || '', ts: Date.now() });
  if (data.recent.length > RECENT_CAP) data.recent.length = RECENT_CAP;
}

function get() {
  const topSongs = Object.values(data.tracks)
    .sort((a, b) => (b.count - a.count) || (b.ms - a.ms)).slice(0, 20);
  const topArtists = Object.values(data.artists)
    .sort((a, b) => (b.ms - a.ms) || (b.count - a.count)).slice(0, 20);
  return {
    totalMs: data.totalMs,
    todayMs: data.byDay[dayKey()] || 0,
    days: Object.keys(data.byDay).length,
    distinctSongs: Object.keys(data.tracks).length,
    distinctArtists: Object.keys(data.artists).length,
    topSongs, topArtists,
    recent: data.recent.slice(0, 60)
  };
}

function reset() {
  data = { totalMs: 0, byDay: {}, tracks: {}, artists: {}, recent: [] };
  last = { key: '', ts: 0, ms: 0, counted: false, np: null };
  try { fs.writeFileSync(FILE, JSON.stringify(data)); } catch {}
}

module.exports = { record, get, reset };
