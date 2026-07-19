'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, shell, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { useSharedUserData, migrateSessions, partitionName } = require('./shared-userdata');
useSharedUserData();

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
const ai = require('./ai');
const community = require('./community');
const lights = require('./lights');
const remote = require('./remote');
const radar = require('./radar');

const YTM_URL = 'https://music.youtube.com/';
const ICON_PNG = path.join(__dirname, '..', 'assets', 'icon.png');

// Identify as Stardust rather than "Electron" everywhere we can in dev.
app.setName('Stardust');
app.setAppUserModelId('com.stardust.app');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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
      backgroundThrottling: false, // keep timers/rAF running so lyrics never freeze
      // Shared with Hub
      partition: partitionName('music')
    }
  });

  // Ad/tracker blocking on this window's session, before the first request.
  adblock.setEnabled(config.get('adBlock') !== false);
  adblock.attach(mainWindow.webContents.session);

  // A modern desktop UA keeps music.youtube.com from nagging about the browser.
  const ua = mainWindow.webContents.getUserAgent().replace(/Electron\/[\d.]+\s*/, '');
  const startUrl = process.env.STARDUST_PLAY ? YTM_URL + 'watch?v=' + process.env.STARDUST_PLAY : YTM_URL;
  mainWindow.loadURL(startUrl, { userAgent: ua });

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
  ipcMain.handle('stardust:transcript-get', (_e, { title, artist } = {}) => transcribe.getCached(title, artist));
  ipcMain.handle('stardust:current-videoid', () => adblock.currentVideoId());
  ipcMain.handle('stardust:transcript-pref', (_e, { title, artist, pref } = {}) => { transcribe.setPref(title, artist, pref); return true; });
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
      // The player's own (sniffed, authorized) stream first — it works even
      // where YouTube refuses direct downloads; InnerTube is the fallback.
      // The sniff can hold a DIFFERENT track (YTM prefetches the next song
      // mid-play; fast skips outrun it) — syncing lyrics against the wrong
      // audio poisons the timing, so the stream's duration must vouch for it.
      const sniffed = adblock.currentAudio();
      const durOk = !sniffed || !(p.duration > 0) || !(sniffed.dur > 0) || Math.abs(sniffed.dur - p.duration) <= 3;
      if (sniffed && !durOk) console.log('[Stardust] sniffed stream is another track (dur ' + sniffed.dur + 's vs ' + p.duration + 's) — using InnerTube');
      let got = sniffed && durOk ? await songAudio.fetchStreamUrl(sniffed.url) : null;
      if (!got) got = await songAudio.fetchSongAudio(p.videoId);
      if (!got) return { error: 'download' };
      const key = config.get('transcribeKey');
      const share = config.get('shareTranscripts') !== false;
      const payload = { title: p.title, artist: p.artist, album: p.album, duration: p.duration, audio: got.buf, audioName: got.name, lyrics: p.lyrics, realStamps: p.realStamps, force: p.force };
      return p.lyrics
        ? await transcribe.alignToLyrics(payload, key, share)
        : await transcribe.transcribe(payload, key, share);
    } catch (err) { return { error: 'download' }; }
  });
  ipcMain.handle('stardust:community-info', () => community.info());
  // Booth diagnostics: the renderer logs every skip/click/navigation step to
  // disk so field reports are debuggable from the actual machine.
  const BOOTH_LOG = path.join(app.getPath('userData'), 'booth.log');
  ipcMain.on('stardust:booth-log', (_e, line) => {
    try {
      fs.appendFileSync(BOOTH_LOG, new Date().toISOString().slice(11, 19) + ' ' + String(line).slice(0, 300) + '\n');
      const st = fs.statSync(BOOTH_LOG);
      if (st.size > 300000) fs.writeFileSync(BOOTH_LOG, ''); // cap
    } catch {}
  });
  // Lyric index: every lyric the user has SEEN becomes searchable by words —
  // "which song says …". Plain lowercase text, capped, local only.
  const LYRIC_INDEX = path.join(app.getPath('userData'), 'lyric-index.json');
  let lyricIdx = null, lyricIdxTimer = null;
  const loadLyricIdx = () => {
    if (!lyricIdx) { try { lyricIdx = JSON.parse(fs.readFileSync(LYRIC_INDEX, 'utf8')); } catch { lyricIdx = {}; } }
    return lyricIdx;
  };
  ipcMain.on('stardust:lyric-index', (_e, { title, artist, text } = {}) => {
    if (!title || !text) return;
    const idx = loadLyricIdx();
    idx[title + '|' + (artist || '')] = String(text).toLowerCase().slice(0, 12000);
    const keys = Object.keys(idx);
    while (keys.length > 800) delete idx[keys.shift()];
    clearTimeout(lyricIdxTimer);
    lyricIdxTimer = setTimeout(() => { try { fs.writeFileSync(LYRIC_INDEX, JSON.stringify(idx)); } catch {} }, 3000);
  });
  ipcMain.handle('stardust:lyric-search', (_e, { q } = {}) => {
    const needle = String(q || '').toLowerCase().trim();
    if (needle.length < 3) return [];
    const out = [];
    for (const [k, text] of Object.entries(loadLyricIdx())) {
      const at = text.indexOf(needle);
      if (at < 0) continue;
      const cut = k.indexOf('|');
      out.push({
        title: k.slice(0, cut), artist: k.slice(cut + 1),
        snippet: ('…' + text.slice(Math.max(0, at - 28), at + needle.length + 28).replace(/\n/g, ' ') + '…')
      });
      if (out.length >= 12) break;
    }
    return out;
  });
  // Room lighting: fire-and-forget colour frames from the renderer's beat
  // detector; the config lives in settings (panel → Lights).
  const lightsCfg = () => ({
    protocol: config.get('lightsProtocol'), host: config.get('lightsHost'),
    token: config.get('lightsToken'), count: config.get('lightsCount'),
    segments: !!config.get('lightsSegments')
  });
  ipcMain.on('stardust:lights-frame', (_e, f) => { try { lights.frame(lightsCfg(), f); } catch {} });
  ipcMain.handle('stardust:lights-test', async () => { try { return await lights.test(lightsCfg()); } catch { return false; } });
  // Phone remote: LAN server; commands come back through sendCommand.
  ipcMain.handle('stardust:remote-start', () => {
    try {
      return remote.start(
        (a) => sendCommand(a),
        (q2) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stardust:remote-request', { query: q2 }); }
      );
    } catch { return null; }
  });
  ipcMain.handle('stardust:remote-stop', () => { remote.stop(); return true; });
  ipcMain.on('stardust:remote-state', (_e, s) => remote.setState(s));
  // "song title artist" → videoId, so transitions can navigate INSIDE the
  // app (no page reload) instead of bouncing through a search page.
  ipcMain.handle('stardust:resolve-song', async (_e, { query } = {}) => {
    const clean = String(query || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!clean) return null;
    const firstId = (res) => {
      for (const sec of (res && res.contents) || []) {
        for (const it of (sec && sec.contents) || []) {
          const v = it.id || it.video_id || it.videoId;
          if (v && /^[\w-]{6,20}$/.test(String(v))) return String(v);
        }
      }
      return null;
    };
    try {
      const yt = await songAudio.client();
      // Songs first; videos as the fallback — some tracks only exist as videos.
      let v = firstId(await yt.music.search(clean, { type: 'song' }).catch(() => null));
      if (!v) v = firstId(await yt.music.search(clean, { type: 'video' }).catch(() => null));
      if (!v) v = firstId(await yt.music.search(clean).catch(() => null));
      if (!v) console.log('[Stardust] resolve-song: no match for "' + clean + '"');
      return v;
    } catch (e) { console.log('[Stardust] resolve-song failed:', e && String(e.message).slice(0, 100)); return null; }
  });
  // YTM's own "up next" suggestions for the current track — the discovery
  // half of the DJ's Booth candidate pool. Duck-typed defensively.
  ipcMain.handle('stardust:up-next', async (_e, { videoId } = {}) => {
    try {
      if (!/^[\w-]{6,20}$/.test(String(videoId || ''))) return [];
      const yt = await songAudio.client();
      const un = await yt.music.getUpNext(videoId);
      const out = [];
      for (const it of (un && un.contents) || []) {
        const t = it.title && (it.title.text || (typeof it.title === 'string' ? it.title : ''));
        const a = (it.author && (it.author.text || (typeof it.author === 'string' ? it.author : '')))
          || (it.artists && it.artists[0] && it.artists[0].name) || '';
        const v = it.video_id || it.videoId;
        if (t && v && v !== videoId) out.push({ title: String(t).slice(0, 200), artist: String(a).slice(0, 200), videoId: String(v) });
        if (out.length >= 12) break;
      }
      return out;
    } catch (e) { console.log('[Stardust] up-next failed:', e && String(e.message).slice(0, 120)); return []; }
  });
  // Release radar: check the top artists for fresh drops (seen-set persisted).
  ipcMain.handle('stardust:radar-check', async (_e, { artists, firstRun } = {}) => {
    try { return await radar.check(artists, firstRun); } catch { return []; }
  });
  // AI helpers (Groq, same key as transcription): chat for DJ lines / intent /
  // stats Q&A, TTS for the DJ's voice, STT for voice commands.
  ipcMain.handle('stardust:ai-chat', async (_e, { messages, maxTokens, json } = {}) => {
    try { return await ai.chat(config.get('transcribeKey'), messages || [], { maxTokens, json }); }
    catch (err) { return { error: err.message || 'failed' }; }
  });
  ipcMain.handle('stardust:ai-tts', async (_e, { text } = {}) => {
    try { return await ai.tts(config.get('transcribeKey'), text, config.get('djVoice')); }
    catch (err) { return { error: err.message || 'failed' }; }
  });
  ipcMain.handle('stardust:voice-text', async (_e, { audio } = {}) => {
    try {
      const key = config.get('transcribeKey');
      return key ? await transcribe.speechToText(audio, key) : await ai.stt(audio);
    } catch (err) { return { error: err.message || 'failed' }; }
  });
  // Can the AI features run at all? True when the shared proxy is deployed
  // OR the user set their own key — the renderer gates its UI on this.
  ipcMain.handle('stardust:ai-available', async () => {
    if (config.get('transcribeKey')) return true;
    try { return await ai.proxyAvailable(); } catch { return false; }
  });
  // Health panel: what state is the machinery actually in?
  ipcMain.handle('stardust:health', async () => {
    let boothTail = [];
    try {
      boothTail = fs.readFileSync(path.join(app.getPath('userData'), 'booth.log'), 'utf8')
        .trim().split('\n').slice(-4);
    } catch {}
    let proxy = false;
    try { proxy = await ai.proxyAvailable(); } catch {}
    return { key: !!config.get('transcribeKey'), proxy, boothTail, version: app.getVersion() };
  });
  // Raw track audio for renderer-side analysis (X-ray seekbar). Same source
  // rules as word-sync: the sniffed stream only when its duration vouches.
  ipcMain.handle('stardust:track-audio', async (_e, p = {}) => {
    try {
      const sniffed = adblock.currentAudio();
      const durOk = !sniffed || !(p.duration > 0) || !(sniffed.dur > 0) || Math.abs(sniffed.dur - p.duration) <= 3;
      let got = sniffed && durOk ? await songAudio.fetchStreamUrl(sniffed.url) : null;
      if (!got) got = await songAudio.fetchSongAudio(p.videoId);
      return got ? got.buf : null;
    } catch { return null; }
  });
  // Save an exported lyric clip (webm buffer) wherever the user picks.
  ipcMain.handle('stardust:save-clip', async (_e, { name, buf } = {}) => {
    if (!buf) return false;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('downloads'), String(name || 'stardust-clip.webm').replace(/[\\/:*?"<>|]+/g, '_'))
    });
    if (canceled || !filePath) return false;
    try { fs.writeFileSync(filePath, Buffer.from(buf)); return true; } catch { return false; }
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
  try { migrateSessions(); } catch (e) { console.warn('[Stardust] migrate:', e.message); }
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
