'use strict';

// Discord Rich Presence — fully optional and dependency-guarded.
// Requires the `discord-rpc` package (optionalDependency) and a Discord
// application Client ID. If either is missing, this module no-ops silently.

let RPC = null;
try {
  RPC = require('discord-rpc');
} catch {
  RPC = null;
}

let client = null;
let ready = false;
let clientId = '';
let lastActivity = null;

function isAvailable() {
  return !!RPC;
}

async function connect(id) {
  if (!RPC || !id) return false;
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
  const activity = {
    details: (np.title || 'YouTube Music').slice(0, 128),
    state: (np.artist ? `by ${np.artist}` : 'Listening').slice(0, 128),
    largeImageKey: 'stardust',
    largeImageText: np.album || 'Stardust',
    instance: false
  };
  if (np.playing && np.duration && np.position != null) {
    const now = Date.now();
    activity.startTimestamp = now - np.position * 1000;
    activity.endTimestamp = now + (np.duration - np.position) * 1000;
  } else {
    activity.smallImageKey = 'pause';
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
  if (client && ready) {
    try {
      client.clearActivity();
    } catch {}
  }
}

module.exports = { isAvailable, connect, disconnect, setActivity, clear };
