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
  '/generate_204'
];

let enabled = true;
let attachedSession = null;

function shouldBlock(url) {
  if (!enabled) return false;
  for (const p of BLOCK) if (url.includes(p)) return true;
  return false;
}

function attach(session) {
  attachedSession = session;
  session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    cb({ cancel: shouldBlock(details.url) });
  });
}

function setEnabled(v) { enabled = !!v; }

module.exports = { attach, setEnabled };
