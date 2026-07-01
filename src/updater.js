'use strict';

// Auto-update via electron-updater + GitHub Releases.
// electron-builder bakes the GitHub publish config into app-update.yml, and
// each release ships latest.yml / latest-mac.yml describing the newest build.
// On launch we check, download in the background, and offer a restart when the
// update is ready. Everything is wrapped defensively so a missing module or a
// dev/unpackaged run never throws.
//
// Note: on macOS, Squirrel.Mac only applies updates that are signed with a
// valid Developer ID. Our CI ships ad-hoc-signed builds, so mac users are
// notified of a new version and pointed at the releases page instead of an
// in-place install. Windows (NSIS) updates apply automatically.

const { app, dialog, shell, BrowserWindow } = require('electron');

const RELEASES_URL = 'https://github.com/coopermitchell007-pixel/stardust-music/releases/latest';

let autoUpdater = null;
let started = false;

function load() {
  if (autoUpdater) return autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
  } catch (e) {
    console.warn('[Stardust] electron-updater unavailable:', e.message);
    autoUpdater = null;
  }
  return autoUpdater;
}

function notifyMac(info) {
  const win = BrowserWindow.getAllWindows()[0];
  const opts = {
    type: 'info',
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update available',
    message: `Stardust ${info && info.version ? info.version : ''} is available.`,
    detail: 'Open the releases page to download the latest version.'
  };
  const p = win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
  p.then((r) => { if (r.response === 0) shell.openExternal(RELEASES_URL); }).catch(() => {});
}

function promptRestart(info) {
  const win = BrowserWindow.getAllWindows()[0];
  const opts = {
    type: 'info',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update ready',
    message: `Stardust ${info && info.version ? info.version : ''} has been downloaded.`,
    detail: 'Restart to finish installing. It will also install automatically next time you quit.'
  };
  const p = win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
  p.then((r) => { if (r.response === 0) { setImmediate(() => autoUpdater.quitAndInstall()); } }).catch(() => {});
}

// Kick off a check. Safe to call once after the window exists.
function start() {
  if (started || !app.isPackaged) return;   // no-op in dev / unpackaged runs
  const u = load();
  if (!u) return;
  started = true;

  if (process.platform === 'darwin') {
    // Ad-hoc-signed: notify only, don't attempt an in-place install.
    u.autoDownload = false;
    u.on('update-available', notifyMac);
    u.on('error', (err) => console.warn('[Stardust] update check failed:', err && err.message));
    u.checkForUpdates().catch((e) => console.warn('[Stardust] update check failed:', e.message));
    return;
  }

  u.on('update-downloaded', promptRestart);
  u.on('error', (err) => console.warn('[Stardust] update error:', err && err.message));
  u.checkForUpdatesAndNotify().catch((e) => console.warn('[Stardust] update check failed:', e.message));
}

module.exports = { start };
