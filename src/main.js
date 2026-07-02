'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, shell, Menu, nativeImage } = require('electron');
const path = require('path');

const config = require('./config');
const themes = require('./themes');
const discord = require('./discord');
const marketplace = require('./marketplace');
const adblock = require('./adblock');
const lyrics = require('./lyrics');
const updater = require('./updater');
const stats = require('./stats');
const transcribe = require('./transcribe');
const songAudio = require('./audio');

const YTM_URL = 'https://music.youtube.com/';
const ICON_PNG = path.join(__dirname, '..', 'assets', 'icon.png');

// Identify as Stardust rather than "Electron" everywhere we can in dev.
app.setName('Stardust');
app.setAppUserModelId('com.stardust.app');

let mainWindow = null;
let miniWindow = null;
let lastNowPlaying = null;

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------
function createMainWindow() {
  const bounds = config.get('windowBounds') || { width: 1280, height: 800 };
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#05060f',
    title: 'Stardust',
    icon: ICON_PNG,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false // keep timers/rAF running so lyrics never freeze
    }
  });

  // Ad/tracker blocking on this window's session, before the first request.
  adblock.setEnabled(config.get('adBlock') !== false);
  adblock.attach(mainWindow.webContents.session);

  // A modern desktop UA keeps music.youtube.com from nagging about the browser.
  const ua = mainWindow.webContents.getUserAgent().replace(/Electron\/[\d.]+\s*/, '');
  mainWindow.loadURL(YTM_URL, { userAgent: ua });

  // Surface renderer-side console output (incl. preload errors) in the terminal.
  mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    if (message.includes('Stardust') || level >= 2) {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    }
  });
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[Stardust] preload-error:', preloadPath, error);
  });
  // If the mini player is already open, (re)start its spectrum feed once the
  // YTM page + preload are ready to receive the message.
  mainWindow.webContents.on('did-finish-load', () => {
    if (miniWindow && !miniWindow.isDestroyed()) setMiniSpectrum(true);
  });

  // Debug-only: capture a screenshot of the rendered page (STARDUST_CAPTURE=path).
  if (process.env.STARDUST_CAPTURE) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // Optionally open UI before the snapshot (debug only).
          const open = process.env.STARDUST_OPEN;
          if (open) {
            const tab = process.env.STARDUST_TAB || '';
            await mainWindow.webContents.executeJavaScript(`(() => {
              const l = document.getElementById('stardust-launcher'); if (l) l.click();
              if (${open === 'market' ? 'true' : 'false'}) {
                const b = document.getElementById('stardust-open-market'); if (b) b.click();
                const tab = ${JSON.stringify(tab)};
                if (tab) setTimeout(() => { const t = document.querySelector('.stardust-market-tab[data-tab="'+tab+'"]'); if (t) t.click(); }, 400);
              }
            })();`);
            await new Promise((r) => setTimeout(r, 1500));
          }
          const img = await mainWindow.webContents.capturePage();
          require('fs').writeFileSync(process.env.STARDUST_CAPTURE, img.toPNG());
          console.log('[Stardust] captured to', process.env.STARDUST_CAPTURE);
        } catch (e) { console.error('[Stardust] capture failed', e.message); }
      }, 8000);
    });
  }

  // Debug-only: dump computed styles of section containers to find seam lines.
  if (process.env.STARDUST_DUMP) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const out = await mainWindow.webContents.executeJavaScript(`(() => {
            const sels = ['ytmusic-carousel-shelf-renderer','ytmusic-shelf-renderer','ytmusic-item-section-renderer','ytmusic-carousel','ytmusic-grid-renderer','ytmusic-section-list-renderer','ytmusic-tab-renderer','ytmusic-carousel-shelf-basic-header-renderer','ytmusic-responsive-header-renderer','#contents','#header'];
            const rep = [];
            for (const s of sels) {
              const els = document.querySelectorAll(s);
              if (!els.length) { rep.push(s + ' :: (none)'); continue; }
              const el = els[0]; const c = getComputedStyle(el);
              rep.push(s + ' [' + els.length + '] bg=' + c.backgroundColor + ' img=' + (c.backgroundImage||'none').slice(0,30) + ' bT=' + c.borderTopWidth + '/' + c.borderTopColor + ' bB=' + c.borderBottomWidth + '/' + c.borderBottomColor + ' shadow=' + (c.boxShadow||'none').slice(0,40));
            }
            return rep.join('\\n');
          })();`);
          console.log('=== STARDUST DOM DUMP ===\n' + out + '\n=== END DUMP ===');
        } catch (e) { console.error('[Stardust] dump failed', e.message); }
      }, 8000);
    });
  }

  // Open external links (account, policies, etc.) in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('https://music.youtube.com') && !url.startsWith('https://accounts.google.com')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  const persistBounds = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const b = mainWindow.getBounds();
      config.save({ windowBounds: { width: b.width, height: b.height } });
    }
  };
  mainWindow.on('resize', debounce(persistBounds, 500));

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Closing the main window tears everything down (incl. the mini player).
    if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close();
    app.quit();
  });
}

// ---------------------------------------------------------------------------
// Mini player (frameless, always-on-top)
// ---------------------------------------------------------------------------
function openMiniPlayer() {
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.focus();
    return;
  }
  miniWindow = new BrowserWindow({
    width: 320,
    height: 132,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#0a0b18',
    title: 'Stardust Mini',
    webPreferences: {
      preload: path.join(__dirname, 'miniplayer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  miniWindow.loadFile(path.join(__dirname, 'miniplayer', 'miniplayer.html'));
  miniWindow.on('closed', () => {
    miniWindow = null;
    config.save({ miniPlayer: false });
    setMiniSpectrum(false);
  });
  miniWindow.webContents.on('did-finish-load', () => {
    if (lastNowPlaying) miniWindow.webContents.send('stardust:nowplaying', lastNowPlaying);
  });
  setMiniSpectrum(true);
}

function closeMiniPlayer() {
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close();
  miniWindow = null;
  setMiniSpectrum(false);
}

// Ask the YTM page to start/stop streaming its spectrum to the mini player.
function setMiniSpectrum(on) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('stardust:mini-spectrum', on);
  }
}

// ---------------------------------------------------------------------------
// Media command bridge — forwards an action to the YTM page.
// ---------------------------------------------------------------------------
function sendCommand(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('stardust:command', { action });
  }
}

// ---------------------------------------------------------------------------
// Global hotkeys
// ---------------------------------------------------------------------------
function registerHotkeys() {
  globalShortcut.unregisterAll();
  if (!config.get('globalHotkeys')) return;
  const map = {
    MediaPlayPause: 'playpause',
    MediaNextTrack: 'next',
    MediaPreviousTrack: 'previous',
    'CommandOrControl+Shift+Space': 'playpause',
    'CommandOrControl+Shift+Right': 'next',
    'CommandOrControl+Shift+Left': 'previous',
    'CommandOrControl+Shift+Up': 'like',
    'CommandOrControl+Shift+Down': 'dislike',
    'CommandOrControl+Shift+S': 'shuffle',
    'CommandOrControl+Shift+C': 'copy-link'
  };
  for (const [accel, action] of Object.entries(map)) {
    try {
      globalShortcut.register(accel, () => sendCommand(action));
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function lightThemeList() {
  return themes.list().map((t) => ({
    id: t.id,
    name: t.name,
    author: t.author,
    accent: t.accent,
    background: t.background,
    source: t.source
  }));
}

function registerIpc() {
  ipcMain.handle('stardust:init', () => ({
    themes: lightThemeList(),
    settings: config.load(),
    discordAvailable: discord.isAvailable(),
    installed: marketplace.installedIds(),
    extras: marketplace.installedExtras(),
    version: app.getVersion()
  }));

  // --- Marketplace ---
  ipcMain.handle('stardust:marketplace-catalog', async () => ({
    items: await marketplace.catalog(),
    installed: marketplace.installedIds()
  }));
  ipcMain.handle('stardust:marketplace-install', (_e, item) => {
    const res = marketplace.install(item);
    return { res, installed: marketplace.installedIds(), extras: marketplace.installedExtras(), themes: lightThemeList() };
  });
  ipcMain.handle('stardust:marketplace-remove', (_e, { type, id }) => {
    const res = marketplace.remove(type, id);
    return { res, installed: marketplace.installedIds(), extras: marketplace.installedExtras(), themes: lightThemeList() };
  });

  ipcMain.handle('stardust:get-theme', (_e, id) => {
    const t = themes.get(id);
    if (!t) return null;
    return {
      id: t.id,
      name: t.name,
      accent: t.accent,
      background: t.background,
      glass: t.glass,
      starfield: t.starfield,
      visualizer: t.visualizer,
      blackhole: t.blackhole,
      bg: t.bg,
      css: t.css
    };
  });

  ipcMain.handle('stardust:set-setting', async (_e, { key, value }) => {
    const settings = config.save({ [key]: value });
    await applySideEffects(key, value, settings);
    return settings;
  });

  ipcMain.handle('stardust:open-themes-folder', () => {
    themes.ensureUserDir();
    shell.openPath(themes.USER_DIR);
    return themes.USER_DIR;
  });
  ipcMain.handle('stardust:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
    return true;
  });

  ipcMain.handle('stardust:reload-themes', () => lightThemeList());

  ipcMain.handle('stardust:get-nowplaying', () => lastNowPlaying);

  ipcMain.handle('stardust:lyrics', (_e, meta) => lyrics.fetchLyrics(meta));
  ipcMain.handle('stardust:transcript-remove', (_e, { title, artist } = {}) => { transcribe.removeCached(title, artist); return true; });
  ipcMain.handle('stardust:transcribe', async (_e, payload) => {
    try { return await transcribe.transcribe(payload, config.get('transcribeKey'), config.get('shareTranscripts') !== false); }
    catch (err) { return { error: err.message || 'failed' }; }
  });
  ipcMain.handle('stardust:align', async (_e, payload) => {
    try { return await transcribe.alignToLyrics(payload, config.get('transcribeKey'), config.get('shareTranscripts') !== false); }
    catch (err) { return { error: err.message || 'failed' }; }
  });
  // Background word-sync: fetch the song's audio directly (no playback), then
  // align to the given lyrics — or plain-transcribe when there are none.
  ipcMain.handle('stardust:wordsync', async (_e, p = {}) => {
    try {
      const got = await songAudio.fetchSongAudio(p.videoId);
      if (!got) return { error: 'download' };
      const key = config.get('transcribeKey');
      const share = config.get('shareTranscripts') !== false;
      const payload = { title: p.title, artist: p.artist, album: p.album, duration: p.duration, audio: got.buf, audioName: got.name, lyrics: p.lyrics, realStamps: p.realStamps };
      return p.lyrics
        ? await transcribe.alignToLyrics(payload, key, share)
        : await transcribe.transcribe(payload, key, share);
    } catch (err) { return { error: 'download' }; }
  });
  ipcMain.handle('stardust:stats', () => stats.get());
  ipcMain.handle('stardust:stats-reset', () => { stats.reset(); return true; });

  // From the YTM page: current track + playback state.
  ipcMain.on('stardust:nowplaying', (_e, np) => {
    lastNowPlaying = np;
    if (np && np.isTrack) { try { stats.record(np); } catch {} }
    if (config.get('discordRichPresence')) discord.setActivity(np);
    if (miniWindow && !miniWindow.isDestroyed()) {
      miniWindow.webContents.send('stardust:nowplaying', np);
    }
  });

  // Spectrum frames from the YTM page → forward to the mini player.
  ipcMain.on('stardust:spectrum', (_e, bars) => {
    if (miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('stardust:spectrum', bars);
  });

  // From the mini player: a control button was pressed.
  ipcMain.on('stardust:miniplayer-control', (_e, action) => {
    if (action === 'open-main' && mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      sendCommand(action);
    }
  });
}

async function applySideEffects(key, value, settings) {
  if (key === 'globalHotkeys') registerHotkeys();
  if (key === 'adBlock') {
    adblock.setEnabled(value);
    // Reload so the new blocking state applies to fresh requests.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
  }
  if (key === 'miniPlayer') {
    value ? openMiniPlayer() : closeMiniPlayer();
  }
  if (key === 'discordRichPresence') {
    if (value) {
      await discord.connect(settings.discordClientId);
      if (lastNowPlaying) discord.setActivity(lastNowPlaying);
    } else {
      discord.clear();
      await discord.disconnect();
    }
  }
  if (key === 'discordClientId' && settings.discordRichPresence) {
    await discord.connect(value);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function buildAppMenu() {
  // A real menu makes the macOS menu bar read "Stardust" instead of "Electron",
  // and restores standard Edit/View shortcuts (copy, paste, reload, devtools).
  const template = [
    {
      label: 'Stardust',
      submenu: [
        { label: 'About Stardust', role: 'about' },
        { type: 'separator' },
        { label: 'Hide Stardust', role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Stardust', role: 'quit' }
      ]
    },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
    ] },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' }
    ] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  try { marketplace.syncBundled(); } catch {}
  buildAppMenu();
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(nativeImage.createFromPath(ICON_PNG)); } catch {}
  }
  app.setAboutPanelOptions({ applicationName: 'Stardust', applicationVersion: app.getVersion(), copyright: 'Spicetify-style theming for YouTube Music' });
  registerIpc();
  createMainWindow();
  registerHotkeys();

  const settings = config.load();
  if (settings.miniPlayer) openMiniPlayer();
  if (settings.discordRichPresence) await discord.connect(settings.discordClientId);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  // Check for updates shortly after startup (packaged builds only).
  setTimeout(() => { try { updater.start(); } catch (e) { console.warn('[Stardust] updater:', e.message); } }, 4000);
});

// Guarantee the process actually exits — if any teardown (discord socket,
// pending requests, a busy renderer) stalls the graceful quit, hard-exit.
app.on('before-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
  try { discord.disconnect(); } catch {}
  setTimeout(() => app.exit(0), 1000);
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
});

// Closing the main window quits the app on every platform (no lingering
// dock-only process that has to be force-quit).
app.on('window-all-closed', () => app.quit());
