'use strict';

// Network-level ad/tracker blocking for the YouTube Music session, plus a
// small in-page ad-skipper (see preload.js). This blocks the ad-serving and
// ad-tracking endpoints YouTube uses; combined with the DOM skipper it removes
// or fast-forwards the occasional video/audio ad. Toggleable at runtime.

// Substrings / hosts to cancel. Kept conservative so normal playback,
// artwork, and the API the app scrapes keep working.
const BLOCK = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adservice.google',
  '/pagead/',
  '/pagead',
  '/ptracking',
  '/api/stats/ads',
  '/api/stats/qoe',            // playback QoE tracking
  '/youtubei/v1/player/ad_break',
  '/get_midroll_info',
  '/get_video_info?',          // legacy ad/info endpoint
  'doubleclickbygoogle',
  '/pcs/activeview',
  '/generate_204',
  'securepubads.g.doubleclick',
  'static.doubleclick',
  'imasdk.googleapis.com',
  'googleads.g.doubleclick',
  '/pagead/interaction',
  '/pagead/viewthroughconversion',
  '/ad_break',
  '/get_ads',
  '/log_interaction',
  '/qoe?',
  'ade.googlesyndication'
];

let enabled = true;
let attachedSession = null;

function shouldBlock(url) {
  if (!enabled) return false;
  for (const p of BLOCK) if (url.includes(p)) return true;
  return false;
}

// The current track's videoId, sniffed from YTM's own /player requests —
// the ONLY source that works on every page for every kind of track (the DOM
// often exposes no id at all for album songs). Electron allows a single
// onBeforeRequest listener per session, so the sniff lives inside the
// blocker's listener and runs even when blocking is toggled off.
let lastVideo = { id: null, at: 0 };
function sniffVideoId(details) {
  if (!details.url.includes('/youtubei/v1/player') || details.url.includes('ad_break')) return;
  try {
    const b = details.uploadData && details.uploadData[0] && details.uploadData[0].bytes;
    if (!b) return;
    const m = Buffer.from(b).toString('utf8').match(/"videoId"\s*:\s*"([\w-]{6,20})"/);
    if (m) lastVideo = { id: m[1], at: Date.now() };
  } catch {}
}
function currentVideoId() {
  return lastVideo.id && Date.now() - lastVideo.at < 15 * 60000 ? lastVideo.id : null;
}

function attach(session) {
  attachedSession = session;
  session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    sniffVideoId(details);
    cb({ cancel: shouldBlock(details.url) });
  });
}

function setEnabled(v) { enabled = !!v; }

module.exports = { attach, setEnabled, currentVideoId };
