'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, shell, Menu, nativeImage } = require('electron');
const path = require('path');

const config = require('./config');
const themes = require('./themes');
const discord = require('./discord');
const marketplace = require('./marketplace');
const adblock = require('./adblock');
const lyrics = require('./lyrics');

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
      sandbox: false
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
  });
  miniWindow.webContents.on('did-finish-load', () => {
    if (lastNowPlaying) miniWindow.webContents.send('stardust:nowplaying', lastNowPlaying);
  });
}

function closeMiniPlayer() {
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close();
  miniWindow = null;
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
    'CommandOrControl+Shift+Left': 'previous'
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
    extras: marketplace.installedExtras()
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

  ipcMain.handle('stardust:reload-themes', () => lightThemeList());

  ipcMain.handle('stardust:get-nowplaying', () => lastNowPlaying);

  ipcMain.handle('stardust:lyrics', (_e, meta) => lyrics.fetchLyrics(meta));

  // From the YTM page: current track + playback state.
  ipcMain.on('stardust:nowplaying', (_e, np) => {
    lastNowPlaying = np;
    if (config.get('discordRichPresence')) discord.setActivity(np);
    if (miniWindow && !miniWindow.isDestroyed()) {
      miniWindow.webContents.send('stardust:nowplaying', np);
    }
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
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  discord.disconnect();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
