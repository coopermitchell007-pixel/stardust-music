'use strict';

// Release radar: watch the user's top artists (local stats) for fresh albums
// and singles via InnerTube. Everything is duck-typed defensively — YouTube
// reshuffles these structures often, and a miss must mean "no news", never
// a crash. Seen releases persist so each one announces exactly once.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const songAudio = require('./audio'); // shares the InnerTube client module

const SEEN_PATH = path.join(app.getPath('userData'), 'radar-seen.json');
let seen = null;
function loadSeen() {
  if (seen) return seen;
  try { seen = new Set(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'))); } catch { seen = new Set(); }
  return seen;
}
function saveSeen() {
  try { fs.writeFileSync(SEEN_PATH, JSON.stringify([...loadSeen()].slice(-2000))); } catch {}
}

const text = (x) => {
  if (!x) return '';
  if (typeof x === 'string') return x;
  if (x.text) return text(x.text);
  if (Array.isArray(x.runs)) return x.runs.map((r) => r.text || '').join('');
  return '';
};

// New releases for one artist: albums/singles whose subtitle carries the
// current year and that we haven't announced before.
async function artistNews(yt, artistName) {
  const out = [];
  try {
    const search = await yt.music.search(artistName, { type: 'artist' });
    let artistId = null;
    for (const sec of search.contents || []) {
      for (const it of (sec.contents || [])) {
        const name = text(it.name || it.title);
        if (name && name.toLowerCase() === artistName.toLowerCase() && (it.id || it.endpoint)) {
          artistId = it.id || (it.endpoint && it.endpoint.payload && it.endpoint.payload.browseId);
          break;
        }
      }
      if (artistId) break;
    }
    if (!artistId) return out;
    const artist = await yt.music.getArtist(artistId);
    const year = String(new Date().getFullYear());
    for (const sec of artist.sections || []) {
      const header = text(sec.header && sec.header.title).toLowerCase();
      if (!/album|single|release/.test(header)) continue;
      for (const it of (sec.contents || [])) {
        const title = text(it.title || it.name);
        const sub = text(it.subtitle);
        if (!title || !sub.includes(year)) continue;
        const key = artistName + '::' + title;
        if (loadSeen().has(key)) continue;
        out.push({ artist: artistName, title, subtitle: sub, key });
      }
    }
  } catch {}
  return out;
}

// topArtists: [names]. firstRun seeds the seen-set silently (no spam of the
// whole back catalog the first time the radar turns on).
async function check(topArtists, firstRun) {
  const yt = await songAudio.client().catch(() => null);
  if (!yt || !yt.music) return [];
  const news = [];
  for (const name of (topArtists || []).slice(0, 6)) {
    for (const n of await artistNews(yt, name)) {
      loadSeen().add(n.key);
      if (!firstRun) news.push(n);
    }
  }
  saveSeen();
  return news;
}

module.exports = { check };
