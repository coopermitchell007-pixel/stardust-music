'use strict';

// Discord Rich Presence — fully optional and dependency-guarded.
// Requires the `discord-rpc` package (optionalDependency). No setup needed:
// a public default application ID is used unless the user pastes their own
// (a custom ID changes the activity's app name, e.g. to "Stardust").

let RPC = null;
try {
  RPC = require('discord-rpc');
} catch {
  RPC = null;
}

// Public application ID of the open-source th-ch/youtube-music project (MIT)
// — the ecosystem-standard zero-setup ID; the activity renders as
// "YouTube Music". A user-supplied ID overrides it.
const DEFAULT_CLIENT_ID = '1177081335727267940';
// Hosted badge images (Discord proxies https URLs), so no per-app uploaded
// assets are required for the small icons either.
const BADGE_LOGO = 'https://raw.githubusercontent.com/coopermitchell007-pixel/stardust-music/main/assets/icon.png';
const BADGE_PAUSE = 'https://raw.githubusercontent.com/coopermitchell007-pixel/stardust-music/main/assets/pause.png';

let client = null;
let ready = false;
let clientId = '';
let lastActivity = null;
let lastKey = '';

function isAvailable() {
  return !!RPC;
}

// Turn the now-playing artwork into a Discord-usable large image. Modern
// Discord accepts a raw https:// URL as an image key (it proxies it), so we
// can show the real cover art instead of a static uploaded asset. YTM/Google
// thumbnails carry a "=w60-h60-..." size suffix — bump it to a crisp square.
function artUrl(np) {
  let u = np && np.art;
  if (!u || typeof u !== 'string' || !u.startsWith('https://')) return null;
  u = u.replace(/=w\d+-h\d+(-[^/?#]*)?$/, '=w512-h512');
  // Discord caps image keys at 256 chars; skip a pathological URL rather than
  // truncate it into something broken (falls back to the Stardust logo).
  return u.length <= 256 ? u : null;
}

async function connect(id) {
  id = (id || '').trim() || DEFAULT_CLIENT_ID;
  if (!RPC) return false;
  if (client && clientId === id && ready) return true;
  await disconnect();
  clientId = id;
  try {
    client = new RPC.Client({ transport: 'ipc' });
    client.on('ready', () => {
      ready = true;
      if (lastActivity) setActivity(lastActivity);
    });
    await client.login({ clientId: id });
    return true;
  } catch (err) {
    console.error('[Stardust] Discord RPC connect failed:', err.message);
    client = null;
    ready = false;
    return false;
  }
}

async function disconnect() {
  ready = false;
  lastKey = ''; // force a fresh push after any reconnect
  if (client) {
    try {
      await client.destroy();
    } catch {}
  }
  client = null;
}

function setActivity(np) {
  lastActivity = np;
  if (!client || !ready || !np) return;

  // Skip position-only churn: now-playing fires every second, but Discord
  // renders the elapsed bar itself from startTimestamp, so we only need to
  // push when the track, play-state, or artwork actually changes. This also
  // keeps us under Discord's activity rate limit and avoids re-fetching the
  // cover art needlessly.
  const art = artUrl(np);
  const key = `${np.title}|${np.artist}|${!!np.playing}|${art || ''}`;
  if (key === lastKey) return;
  lastKey = key;

  const activity = {
    details: (np.title || 'YouTube Music').slice(0, 128),
    state: (np.artist ? `by ${np.artist}` : 'Listening').slice(0, 128),
    // Real cover art when we have it; the hosted Stardust logo otherwise.
    largeImageKey: art || BADGE_LOGO,
    largeImageText: (np.album || np.title || 'Stardust').slice(0, 128),
    instance: false
  };
  if (np.playing && np.duration && np.position != null) {
    // Keep the Stardust logo visible as the small badge over the cover art.
    activity.smallImageKey = BADGE_LOGO;
    activity.smallImageText = 'via Stardust';
    const now = Date.now();
    activity.startTimestamp = now - np.position * 1000;
    activity.endTimestamp = now + (np.duration - np.position) * 1000;
  } else {
    activity.smallImageKey = BADGE_PAUSE;
    activity.smallImageText = 'Paused';
  }
  try {
    client.setActivity(activity);
  } catch (err) {
    console.error('[Stardust] Discord setActivity failed:', err.message);
  }
}

function clear() {
  lastActivity = null;
  lastKey = '';
  if (client && ready) {
    try {
      client.clearActivity();
    } catch {}
  }
}

module.exports = { isAvailable, connect, disconnect, setActivity, clear };
