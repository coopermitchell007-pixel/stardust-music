'use strict';

// Local listening stats & history. Fed by the now-playing stream from the YTM
// page; everything stays on disk in userData (never leaves the machine).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = path.join(app.getPath('userData'), 'stats.json');
const PLAY_THRESHOLD_MS = 30000; // count a "play" once a track is heard this long
const MAX_GAP_MS = 6000;         // ignore gaps bigger than this (paused/asleep)
const RECENT_CAP = 150;

// Titles that are ads / placeholders / interstitials, never real music.
const JUNK = /^youtube music$|will play after ad|^advertisement$|listened to a banger/i;
const isJunkTrack = (t) => !t || !t.title || JUNK.test(t.title);

let data = load();
let last = { key: '', ts: 0, ms: 0, counted: false, np: null };
let saveTimer = null;

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const out = {
      totalMs: d.totalMs || 0,
      byDay: d.byDay || {},
      tracks: d.tracks || {},
      artists: d.artists || {},
      recent: d.recent || [],
      weeks: d.weeks || {},
      byHour: d.byHour || {}
    };
    // Scrub any junk (ads/placeholders) recorded before filtering existed.
    for (const [k, t] of Object.entries(out.tracks)) if (isJunkTrack(t)) delete out.tracks[k];
    out.recent = out.recent.filter((r) => !isJunkTrack(r));
    return out;
  } catch {
    return { totalMs: 0, byDay: {}, tracks: {}, artists: {}, recent: [], weeks: {} };
  }
}

// ISO week key ('2026-W28') — plays bucket by week so the charts can show
// rank movement against LAST week, Billboard-style.
function weekKey(d = new Date()) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day); // ISO: week belongs to its Thursday
  const y = dt.getUTCFullYear();
  const wk = Math.ceil(((dt - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return y + '-W' + String(wk).padStart(2, '0');
}
const prevWeekKey = () => weekKey(new Date(Date.now() - 7 * 86400000));

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
  if (!np || !np.title || isJunkTrack(np)) return;
  const key = keyOf(np);
  const now = Date.now();

  if (key === last.key) {
    if (np.playing) {
      const delta = now - last.ts;
      if (delta > 0 && delta <= MAX_GAP_MS) {
        data.totalMs += delta;
        data.byDay[dayKey()] = (data.byDay[dayKey()] || 0) + delta;
        const hr = new Date().getHours();
        data.byHour[hr] = (data.byHour[hr] || 0) + delta;
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
  // Weekly chart buckets (kept to the last 10 weeks).
  const wk = weekKey();
  const w = data.weeks[wk] || (data.weeks[wk] = { tracks: {}, artists: {} });
  w.tracks[key] = (w.tracks[key] || 0) + 1;
  if (np.artist) w.artists[np.artist] = (w.artists[np.artist] || 0) + 1;
  const keys = Object.keys(data.weeks).sort();
  while (keys.length > 10) delete data.weeks[keys.shift()];
}

// This week's top-15, ranked, with movement vs last week: +n climbed, -n
// fell, 0 held, 'new' debuted. Billboard-style, entirely local.
function chartOf(field, labelOf) {
  const cur = (data.weeks[weekKey()] || {})[field] || {};
  const prev = (data.weeks[prevWeekKey()] || {})[field] || {};
  const rank = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const prevRank = rank(prev);
  return rank(cur).slice(0, 15).map((k, i) => {
    const pi = prevRank.indexOf(k);
    return { ...labelOf(k), plays: cur[k], rank: i + 1, move: pi < 0 ? 'new' : pi - i };
  });
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
    recent: data.recent.slice(0, 60),
    charts: {
      week: weekKey(),
      songs: chartOf('tracks', (k) => { const t = data.tracks[k] || {}; return { title: t.title || k, artist: t.artist || '' }; }),
      artists: chartOf('artists', (k) => ({ title: k, artist: '' }))
    },
    byHour: data.byHour,
    // Daily listening streak: consecutive days with 5+ minutes, today counts
    // once it happens (a quiet morning doesn't break yesterday's streak).
    streak: (() => {
      let n = 0;
      for (let i = 0; i < 3650; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        if ((data.byDay[d] || 0) >= 5 * 60000) n++;
        else if (i === 0) continue;
        else break;
      }
      return n;
    })(),
    // Time capsule: songs you clearly loved (5+ plays) and quietly dropped.
    lostTracks: Object.values(data.tracks)
      .filter((t) => t.count >= 5 && t.last && Date.now() - t.last > 45 * 86400000)
      .sort((a, b) => b.count - a.count).slice(0, 12)
  };
}

function reset() {
  data = { totalMs: 0, byDay: {}, tracks: {}, artists: {}, recent: [], weeks: {}, byHour: {} };
  last = { key: '', ts: 0, ms: 0, counted: false, np: null };
  try { fs.writeFileSync(FILE, JSON.stringify(data)); } catch {}
}

module.exports = { record, get, reset };
