'use strict';

// Direct audio fetch — pulls a song's audio track from YouTube's own servers
// (the same stream the player would use), so word-sync and transcription can
// run in the background in seconds instead of sitting through the song once.
let ytPromise = null;
async function client() {
  if (!ytPromise) {
    ytPromise = (async () => {
      const { Innertube, UniversalCache } = require('youtubei.js');
      return Innertube.create({ cache: new UniversalCache(false), generate_session_locally: true });
    })();
    ytPromise.catch(() => { ytPromise = null; }); // let a failed init retry later
  }
  return ytPromise;
}

const MAX_BYTES = 24 * 1024 * 1024; // Groq's upload cap is 25MB

// Returns { buf, name } (name hints the container for the Whisper upload) or
// null. Client order matters: which InnerTube clients hand out URLs that work
// without deciphering shifts as YouTube changes; IOS works today.
async function fetchSongAudio(videoId) {
  if (!/^[\w-]{6,20}$/.test(String(videoId || ''))) return null;
  let yt;
  try { yt = await client(); } catch { return null; }
  const { Utils } = require('youtubei.js');
  for (const c of ['IOS', 'ANDROID', 'TV', 'WEB_EMBEDDED']) {
    try {
      const stream = await yt.download(videoId, { type: 'audio', quality: 'bestefficiency', client: c });
      const chunks = [];
      let bytes = 0;
      for await (const chunk of Utils.streamToIterable(stream)) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) throw new Error('too-big');
        chunks.push(Buffer.from(chunk));
      }
      if (bytes < 50000) continue; // suspiciously small — try the next client
      const buf = Buffer.concat(chunks);
      const name = buf.slice(4, 8).toString() === 'ftyp' ? 'audio.m4a'
        : (buf[0] === 0x1a && buf[1] === 0x45 ? 'audio.webm' : 'audio.mp3');
      console.log('[Stardust] fetched audio via', c, '—', (bytes / 1e6).toFixed(1) + 'MB', name);
      return { buf, name };
    } catch (e) {
      if (e && e.message === 'too-big') return null;
    }
  }
  return null;
}

module.exports = { fetchSongAudio };
