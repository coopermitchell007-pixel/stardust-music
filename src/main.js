'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, shell, Menu, nativeImage } = require('electron');
const path = require('path');

const config = require('./config');
const themes = require('./themes');
const discord = require('./discord');

const YTM_URL = 'https://music.youtube.com/';
const ICON_PNG = path.join(__dirname, '..', 'assets', 'icon.png');

// Identify as YTM+ rather than "Electron" everywhere we can in dev.
app.setName('YTM+');
app.setAppUserModelId('com.ytmplus.app');

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
    title: 'YTM+',
    icon: ICON_PNG,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // A modern desktop UA keeps music.youtube.com from nagging about the browser.
  const ua = mainWindow.webContents.getUserAgent().replace(/Electron\/[\d.]+\s*/, '');
  mainWindow.loadURL(YTM_URL, { userAgent: ua });

  // Surface renderer-side console output (incl. preload errors) in the terminal.
  mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    if (message.includes('YTM+') || level >= 2) {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    }
  });
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[YTM+] preload-error:', preloadPath, error);
  });

  // Debug-only: capture a screenshot of the rendered page (YTMPLUS_CAPTURE=path).
  if (process.env.YTMPLUS_CAPTURE) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await mainWindow.webContents.capturePage();
          require('fs').writeFileSync(process.env.YTMPLUS_CAPTURE, img.toPNG());
          console.log('[YTM+] captured to', process.env.YTMPLUS_CAPTURE);
        } catch (e) { console.error('[YTM+] capture failed', e.message); }
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
    title: 'YTM+ Mini',
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
    if (lastNowPlaying) miniWindow.webContents.send('ytmplus:nowplaying', lastNowPlaying);
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
    mainWindow.webContents.send('ytmplus:command', { action });
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
  ipcMain.handle('ytmplus:init', () => ({
    themes: lightThemeList(),
    settings: config.load(),
    discordAvailable: discord.isAvailable()
  }));

  ipcMain.handle('ytmplus:get-theme', (_e, id) => {
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
      css: t.css
    };
  });

  ipcMain.handle('ytmplus:set-setting', async (_e, { key, value }) => {
    const settings = config.save({ [key]: value });
    await applySideEffects(key, value, settings);
    return settings;
  });

  ipcMain.handle('ytmplus:open-themes-folder', () => {
    themes.ensureUserDir();
    shell.openPath(themes.USER_DIR);
    return themes.USER_DIR;
  });

  ipcMain.handle('ytmplus:reload-themes', () => lightThemeList());

  ipcMain.handle('ytmplus:get-nowplaying', () => lastNowPlaying);

  // From the YTM page: current track + playback state.
  ipcMain.on('ytmplus:nowplaying', (_e, np) => {
    lastNowPlaying = np;
    if (config.get('discordRichPresence')) discord.setActivity(np);
    if (miniWindow && !miniWindow.isDestroyed()) {
      miniWindow.webContents.send('ytmplus:nowplaying', np);
    }
  });

  // From the mini player: a control button was pressed.
  ipcMain.on('ytmplus:miniplayer-control', (_e, action) => {
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
  // A real menu makes the macOS menu bar read "YTM+" instead of "Electron",
  // and restores standard Edit/View shortcuts (copy, paste, reload, devtools).
  const template = [
    {
      label: 'YTM+',
      submenu: [
        { label: 'About YTM+', role: 'about' },
        { type: 'separator' },
        { label: 'Hide YTM+', role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit YTM+', role: 'quit' }
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
  app.setAboutPanelOptions({ applicationName: 'YTM+', applicationVersion: app.getVersion(), copyright: 'Spicetify-style theming for YouTube Music' });
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
