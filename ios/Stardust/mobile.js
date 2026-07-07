// Stardust mobile runtime — the app-side of the wrapper. Ports the parts of
// the desktop preload that can live in a WKWebView with no main process:
// the ✦ launcher + panel, theme presets, an animated starfield, and
// line-synced lyrics via lrclib (CORS-open). Settings persist in localStorage.
(function () {
  'use strict';
  if (window.__stardustMobile) return;
  window.__stardustMobile = true;
  window.__sdLog = [];
  const dlog = (m) => { try { window.__sdLog.push(m); if (window.__sdLog.length > 30) window.__sdLog.shift(); } catch {} };
  window.addEventListener('error', (e) => dlog('ERR ' + (e.message || '?')));
  // YouTube enforces Trusted Types — innerHTML assignment THROWS. All UI must
  // be built with createElement (same reason the desktop preload does).
  const el = (tag, props, kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'text') n.textContent = v;
      else if (k === 'css') n.style.cssText = v;
      else n.setAttribute(k, v);
    }
    for (const c of kids || []) if (c) n.appendChild(c);
    return n;
  };

  const THEMES = {
    nebula:  { name: 'Nebula',  accent: '#8b5cff', bg: 'radial-gradient(circle at 50% 0%, #1b1340, #05060f 70%)' },
    aurora:  { name: 'Aurora',  accent: '#4ade9e', bg: 'radial-gradient(circle at 50% 0%, #0b2e26, #04100d 70%)' },
    solar:   { name: 'Solar',   accent: '#ffb14d', bg: 'radial-gradient(circle at 50% 0%, #33200b, #0d0703 70%)' },
    galaxy:  { name: 'Galaxy',  accent: '#5da2ff', bg: 'radial-gradient(circle at 50% 0%, #0d1f3d, #04070f 70%)' },
    rose:    { name: 'Rose',    accent: '#ff5d9e', bg: 'radial-gradient(circle at 50% 0%, #33101f, #0f0409 70%)' }
  };
  let cfg = { theme: 'nebula', starfield: true, visualizer: true, remoteUrl: '' };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('sd-mobile') || '{}')); } catch {}
  const save = () => localStorage.setItem('sd-mobile', JSON.stringify(cfg));

  function applyTheme() {
    const t = cfg.theme === 'custom' && cfg.customAccent
      ? { accent: cfg.customAccent, bg: cfg.customBg }
      : (THEMES[cfg.theme] || THEMES.nebula);
    const r = document.documentElement.style;
    r.setProperty('--stardust-accent', t.accent);
    r.setProperty('--stardust-bg', t.bg);
  }

  // ---- animated starfield (canvas, like the desktop app) --------------------
  let starCanvas = null, starRAF = null;
  function starfield(on) {
    if (!on) { if (starRAF) cancelAnimationFrame(starRAF); starRAF = null; if (starCanvas) starCanvas.remove(); starCanvas = null; return; }
    if (starCanvas) return;
    starCanvas = document.createElement('canvas');
    starCanvas.id = 'sd-stars';
    starCanvas.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;';
    document.body.appendChild(starCanvas);
    const ctx = starCanvas.getContext('2d');
    const dpr = Math.min(devicePixelRatio || 1, 2);
    let W, H, stars;
    function size() {
      W = innerWidth; H = innerHeight;
      starCanvas.width = W * dpr; starCanvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = Array.from({ length: 90 }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        r: Math.random() * 1.3 + 0.3, p: Math.random() * Math.PI * 2,
        s: 0.4 + Math.random() * 0.9
      }));
    }
    size();
    addEventListener('resize', size);
    let t = 0;
    (function frame() {
      starRAF = requestAnimationFrame(frame);
      t += 0.016;
      ctx.clearRect(0, 0, W, H);
      for (const st of stars) {
        const a = 0.35 + 0.55 * (0.5 + 0.5 * Math.sin(t * st.s + st.p));
        ctx.globalAlpha = a;
        ctx.fillStyle = '#cfc6ff';
        ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    })();
  }

  // ---- now playing from the player bar --------------------------------------
  function nowPlaying() {
    const bar = document.querySelector('ytmusic-player-bar');
    if (!bar) return null;
    const title = (bar.querySelector('.title') || {}).textContent || '';
    const byline = (bar.querySelector('.byline') || {}).textContent || '';
    const v = document.querySelector('video');
    return { title: title.trim(), artist: (byline.split('•')[0] || '').trim(), video: v };
  }

  // ---- synced lyrics via lrclib ---------------------------------------------
  let lyr = { key: '', lines: [], el: null, timer: null };
  function parseLRC(text) {
    const out = [];
    for (const line of (text || '').split('\n')) {
      const m = line.match(/^((?:\s*\[\d+:\d+(?:\.\d+)?\])+)(.*)$/);
      if (!m) continue;
      const s = m[2].replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
      for (const t of m[1].matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)) {
        out.push({ t: parseInt(t[1], 10) * 60 + parseFloat(t[2]), s });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }
  async function fetchLyrics(np) {
    const u = 'https://lrclib.net/api/get?artist_name=' + encodeURIComponent(np.artist) + '&track_name=' + encodeURIComponent(np.title);
    try {
      const r = await fetch(u);
      if (!r.ok) return [];
      const j = await r.json();
      return parseLRC(j.syncedLyrics || '');
    } catch { return []; }
  }
  function lyricsSheet(open) {
    if (!open) { if (lyr.el) lyr.el.remove(); lyr.el = null; if (lyr.timer) clearInterval(lyr.timer); lyr.timer = null; return; }
    if (lyr.el) return;
    const xBtn = el('button', { id: 'sd-lyr-x', text: '✕' });
    lyr.el = el('div', { id: 'sd-lyrics' }, [
      el('div', { id: 'sd-lyr-head' }, [el('span', { text: '✦ Lyrics' }), xBtn]),
      el('div', { id: 'sd-lyr-body', text: 'Searching…' })
    ]);
    document.body.appendChild(lyr.el);
    xBtn.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); lyricsSheet(false); }, true);
    lyr.timer = setInterval(tickLyrics, 400);
    tickLyrics(true);
  }
  async function tickLyrics(force) {
    const np = nowPlaying();
    if (!np || !np.title || !lyr.el) return;
    const key = np.title + '|' + np.artist;
    if (key !== lyr.key || force === true) {
      lyr.key = key;
      lyr.lines = [];
      const body = lyr.el.querySelector('#sd-lyr-body');
      body.textContent = 'Searching…';
      const lines = await fetchLyrics(np);
      if (lyr.key !== key || !lyr.el) return;
      lyr.lines = lines;
      while (body.firstChild) body.removeChild(body.firstChild);
      if (!lines.length) { body.textContent = 'No synced lyrics found for this song.'; return; }
      lines.forEach((l, i) => {
        const d = document.createElement('div');
        d.className = 'sd-line'; d.textContent = l.s || '♪'; d.dataset.i = i;
        d.addEventListener('touchend', (e) => { e.preventDefault(); const v = nowPlaying().video; if (v) v.currentTime = l.t + 0.01; }, true);
        body.appendChild(d);
      });
    }
    if (!lyr.lines.length) return;
    const v = np.video; if (!v) return;
    const t = v.currentTime + 0.12;
    let idx = -1;
    for (let i = 0; i < lyr.lines.length; i++) { if (lyr.lines[i].t <= t) idx = i; else break; }
    const body = lyr.el.querySelector('#sd-lyr-body');
    const prev = body.querySelector('.sd-line.on');
    const cur = body.querySelector('.sd-line[data-i="' + idx + '"]');
    if (prev !== cur) {
      if (prev) prev.classList.remove('on');
      if (cur) { cur.classList.add('on'); cur.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }
  }


  // ==== WAVE 1 OF THE DESKTOP PORT ==========================================

  // ---- word-aware LRC parsing (ported from the desktop preload) -------------
  function parseLRCWords(text) {
    const out = [];
    for (const line of (text || '').split('\n')) {
      const m = line.match(/^((?:\s*\[\d+:\d+(?:\.\d+)?\])+)([^]*)$/);
      if (!m) continue;
      const times = [...m[1].matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)].map((x) => parseInt(x[1], 10) * 60 + parseFloat(x[2]));
      let rest = m[2];
      const wordTags = [...rest.matchAll(/<(\d+):(\d+(?:\.\d+)?)>\s*([^<]*)/g)];
      let words = null;
      if (wordTags.length) {
        words = wordTags.map((w) => ({ text: w[3].trim(), time: parseInt(w[1], 10) * 60 + parseFloat(w[2]) })).filter((w) => w.text);
        rest = words.map((w) => w.text).join(' ');
      } else rest = rest.replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
      for (const t of times) out.push({ t, s: rest.trim(), words: t === times[0] ? words : null });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // ---- community word-syncs (the same Supabase library the desktop shares to)
  const SB_URL = 'https://ufztwzzdcnlhkjflfkgk.supabase.co';
  const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVmenR3enpkY25saGtqZmxma2drIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5NDA1NzAsImV4cCI6MjA5ODUxNjU3MH0.aR51WJkvyf1lfmIFQJArWor7AJGIsuSYRF4-Ed6BAJ4';
  const keyOf = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 120);
  async function fetchCommunity(np) {
    try {
      const u = SB_URL + '/rest/v1/transcripts?select=lrc,duration&title_key=eq.' + encodeURIComponent(keyOf(np.title))
        + '&artist_key=eq.' + encodeURIComponent(keyOf(np.artist)) + '&order=created_at.desc&limit=6';
      const r = await fetch(u, { headers: { apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON } });
      if (!r.ok) return null;
      const rows = await r.json();
      const dur = np.video && isFinite(np.video.duration) ? np.video.duration : 0;
      for (const row of rows || []) {
        if (dur > 0 && row.duration > 0 && Math.abs(row.duration - dur) > 7) continue;
        if (row.lrc && /\[\d+:\d+/.test(row.lrc)) return row.lrc;
      }
    } catch {}
    return null;
  }
  async function fetchBestLyrics(np) {
    const community = await fetchCommunity(np);          // word-timed when it exists
    if (community) return parseLRCWords(community);
    try {
      const u = 'https://lrclib.net/api/get?artist_name=' + encodeURIComponent(np.artist) + '&track_name=' + encodeURIComponent(np.title);
      const r = await fetch(u);
      if (r.ok) { const j = await r.json(); if (j.syncedLyrics) return parseLRCWords(j.syncedLyrics); }
    } catch {}
    return [];
  }

  // ---- lyrics IN the player page's lyrics tab (like the desktop app) --------
  const lyricsTab = () => [...document.querySelectorAll('ytmusic-player-page tp-yt-paper-tab')].find((t) => /lyric/i.test(t.textContent || ''));
  const tabSelected = () => { const t = lyricsTab(); return !!t && (t.getAttribute('aria-selected') === 'true' || t.hasAttribute('selected')); };
  let tab = { key: '', lines: [], box: null, timer: null };
  function ensureTabLyrics() {
    const t = lyricsTab();
    if (t) { t.removeAttribute('disabled'); t.removeAttribute('aria-disabled'); }
    const host = document.querySelector('ytmusic-player-page #tab-renderer');
    if (!host || !tabSelected()) { if (tab.box && tab.box.parentElement) tab.box.remove(); return; }
    if (!tab.box) {
      tab.box = el('div', { id: 'sd-tab-lyrics' }, [el('div', { class: 'sd-tl-body', text: 'Searching lyrics…' })]);
    }
    if (tab.box.parentElement !== host) host.appendChild(tab.box);
    host.classList.add('sd-lyrics-on');
  }
  async function tickTabLyrics() {
    ensureTabLyrics();
    if (!tab.box || !tab.box.parentElement) return;
    const np = nowPlaying();
    if (!np || !np.title) return;
    const key = np.title + '|' + np.artist;
    const body = tab.box.querySelector('.sd-tl-body');
    if (key !== tab.key) {
      tab.key = key; tab.lines = [];
      body.textContent = 'Searching lyrics…';
      const lines = await fetchBestLyrics(np);
      if (tab.key !== key) return;
      tab.lines = lines;
      while (body.firstChild) body.removeChild(body.firstChild);
      if (!lines.length) { body.textContent = 'No synced lyrics found for this song.'; return; }
      lines.forEach((l, i) => {
        const d = el('div', { class: 'sd-line', 'data-i': i });
        if (l.words) l.words.forEach((w, wi) => {
          d.appendChild(el('span', { class: 'sd-w', text: w.text }));
          if (wi < l.words.length - 1) d.appendChild(document.createTextNode(' '));
        });
        else d.textContent = l.s || '♪';
        d.addEventListener('touchend', (e) => { e.preventDefault(); const v = nowPlaying().video; if (v) v.currentTime = l.t + 0.01; }, true);
        body.appendChild(d);
      });
    }
    if (!tab.lines.length) return;
    const v = np.video; if (!v) return;
    const t = v.currentTime + 0.12;
    let idx = -1;
    for (let i = 0; i < tab.lines.length; i++) { if (tab.lines[i].t <= t) idx = i; else break; }
    const prev = body.querySelector('.sd-line.on');
    const cur = body.querySelector('.sd-line[data-i="' + idx + '"]');
    if (prev !== cur) {
      if (prev) prev.classList.remove('on');
      if (cur) { cur.classList.add('on'); cur.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }
    // word-by-word fill — the community word-syncs light up like desktop
    const line = idx >= 0 ? tab.lines[idx] : null;
    if (cur && line && line.words) {
      const spans = cur.querySelectorAll('.sd-w');
      for (let i = 0; i < line.words.length && i < spans.length; i++) {
        spans[i].classList.toggle('sung', line.words[i].time != null && line.words[i].time <= t);
      }
    }
  }
  setInterval(tickTabLyrics, 250);

  // ---- in-page ad skipper (port of the desktop skipAds) ----------------------
  function skipAds() {
    const showing = document.querySelector('.ad-showing, ytmusic-player[player-ui-state_="AD"], .ytp-ad-player-overlay');
    const v = document.querySelector('video');
    if (showing && v) {
      v.muted = true;
      try { if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration - 0.2; } catch {}
      for (const sel of ['.ytp-ad-skip-button', '.ytp-skip-ad-button', 'button[class*="skip"]']) {
        const b = document.querySelector(sel);
        if (b) { try { b.click(); } catch {} }
      }
    } else if (v && v.muted && window.__sdMutedForAd) { v.muted = false; window.__sdMutedForAd = false; }
    if (showing) window.__sdMutedForAd = true;
  }
  setInterval(skipAds, 600);

  // ---- marketplace: the live catalog, themes installable on the phone -------
  const CATALOG_URL = 'https://raw.githubusercontent.com/coopermitchell007-pixel/stardust-music/main/src/marketplace/catalog.json';
  let market = null;
  async function openMarket() {
    if (market) { market.remove(); market = null; }
    const bodyEl = el('div', { id: 'sd-mkt-body', text: 'Loading marketplace…' });
    const xBtn = el('button', { id: 'sd-lyr-x', text: '✕' });
    market = el('div', { id: 'sd-lyrics' }, [
      el('div', { id: 'sd-lyr-head' }, [el('span', { text: '✦ Marketplace' }), xBtn]),
      bodyEl
    ]);
    xBtn.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); market.remove(); market = null; }, true);
    document.body.appendChild(market);
    let items = [];
    try { items = JSON.parse(localStorage.getItem('sd-catalog') || '[]'); } catch {}
    try {
      const r = await fetch(CATALOG_URL, { cache: 'no-store' });
      if (r.ok) { items = await r.json(); localStorage.setItem('sd-catalog', JSON.stringify(items)); }
    } catch {}
    if (!market) return;
    while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
    const themes = items.filter((i) => i.type === 'theme' && i.mobile);
    const rest = items.filter((i) => !(i.type === 'theme' && i.mobile));
    bodyEl.appendChild(el('div', { class: 'sd-mkt-h', text: 'Themes — tap to apply' }));
    for (const it of themes) {
      const row = el('div', { class: 'sd-mkt-row' }, [
        el('div', { class: 'sd-mkt-sw', css: 'background:' + (it.preview || it.mobile.bg) }),
        el('div', { class: 'sd-mkt-meta' }, [
          el('div', { class: 'sd-mkt-name', text: it.name + (cfg.themeCustom === it.id ? '  ✓' : '') }),
          el('div', { class: 'sd-mkt-desc', text: it.description || '' })
        ])
      ]);
      row.addEventListener('touchend', (e) => {
        e.preventDefault(); e.stopPropagation();
        cfg.theme = 'custom'; cfg.themeCustom = it.id;
        cfg.customAccent = it.mobile.accent; cfg.customBg = it.mobile.bg;
        save(); applyTheme();
        openMarket(); // re-render the checkmark
      }, true);
      bodyEl.appendChild(row);
    }
    bodyEl.appendChild(el('div', { class: 'sd-mkt-h', text: 'On desktop only' }));
    for (const it of rest.slice(0, 40)) {
      bodyEl.appendChild(el('div', { class: 'sd-mkt-row off' }, [
        el('div', { class: 'sd-mkt-sw', css: 'background:' + (it.preview || '#222') }),
        el('div', { class: 'sd-mkt-meta' }, [
          el('div', { class: 'sd-mkt-name', text: it.name }),
          el('div', { class: 'sd-mkt-desc', text: it.description || '' })
        ])
      ]));
    }
  }


  // ---- visualizer bars (real WebAudio when iOS allows the tap, sim fallback)
  let vis = { canvas: null, raf: null, an: null, freq: null, real: false, zero: 0 };
  function visualizer(on) {
    if (!on) { if (vis.raf) cancelAnimationFrame(vis.raf); vis.raf = null; if (vis.canvas) vis.canvas.remove(); vis.canvas = null; return; }
    if (vis.canvas) return;
    vis.canvas = el('canvas', { id: 'sd-vis', css: 'position:fixed;left:0;right:0;bottom:calc(56px + env(safe-area-inset-bottom));height:44px;z-index:2;pointer-events:none;opacity:.9' });
    document.body.appendChild(vis.canvas);
    const ctx = vis.canvas.getContext('2d');
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const BARS = 28;
    let levels = new Array(BARS).fill(0), phase = 0;
    function tapAudio() {
      if (vis.an) return;
      try {
        const v = document.querySelector('video');
        if (!v) return;
        const AC = window.AudioContext || window.webkitAudioContext;
        const ac = new AC();
        const an = ac.createAnalyser(); an.fftSize = 512;
        const s = ac.createMediaElementSource(v);
        s.connect(an); an.connect(ac.destination);
        vis.an = an; vis.freq = new Uint8Array(an.frequencyBinCount);
      } catch {}
    }
    document.addEventListener('touchend', tapAudio, { once: true, capture: true });
    (function frame() {
      vis.raf = requestAnimationFrame(frame);
      const W = innerWidth, H = 44;
      if (vis.canvas.width !== W * dpr) { vis.canvas.width = W * dpr; vis.canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
      const v = document.querySelector('video');
      const playing = v && !v.paused && !v.ended;
      let targets = new Array(BARS).fill(0);
      if (vis.an && vis.freq) {
        vis.an.getByteFrequencyData(vis.freq);
        let sum = 0;
        for (let i = 0; i < BARS; i++) {
          const f0 = Math.pow(i / BARS, 2), f1 = Math.pow((i + 1) / BARS, 2);
          const lo = Math.floor(f0 * vis.freq.length), hi = Math.max(lo + 1, Math.floor(f1 * vis.freq.length));
          let mx = 0; for (let j = lo; j < hi; j++) if (vis.freq[j] > mx) mx = vis.freq[j];
          targets[i] = Math.min(1, Math.pow(mx / 255, 1.4) * 1.25); sum += targets[i];
        }
        vis.real = sum > 0.02 ? true : (playing && ++vis.zero > 90 ? false : vis.real);
      }
      if (!vis.real) {
        // iOS usually refuses the media tap on MSE audio — simulate, like desktop.
        phase += 0.12;
        for (let i = 0; i < BARS; i++) {
          const c = 1 - Math.abs(i - BARS / 2) / (BARS / 2);
          targets[i] = playing ? Math.max(0.05, Math.min(1, (0.3 + 0.7 * c) * (0.55 + 0.35 * Math.sin(phase + i * 0.6) + Math.random() * 0.25))) : 0;
        }
      }
      ctx.clearRect(0, 0, W, H);
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--stardust-accent').trim() || '#8b5cff';
      ctx.fillStyle = accent;
      const gap = 2, bw = W / BARS - gap;
      for (let i = 0; i < BARS; i++) {
        levels[i] += (targets[i] - levels[i]) * 0.3;
        const bh = levels[i] * (H - 4);
        if (bh > 1.5) { ctx.globalAlpha = 0.85; ctx.fillRect(i * (bw + gap), H - bh, bw, bh); }
      }
      ctx.globalAlpha = 1;
    })();
  }

  // ---- the ✦ button + panel --------------------------------------------------
  function buildUI() {
    try { buildUIInner(); } catch (e) { dlog('buildUI threw: ' + (e && e.message)); }
  }
  function buildUIInner() {
    if (document.getElementById('sd-orb') || !document.body) return;
    const style = document.createElement('style');
    style.textContent = `
      #sd-orb{position:fixed;right:14px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:2147483646;
        width:46px;height:46px;border-radius:50%;font-size:19px;color:#fff;border:1px solid color-mix(in srgb,var(--stardust-accent) 55%,rgba(255,255,255,.12));
        background:color-mix(in srgb,var(--stardust-accent) 32%,rgba(10,10,22,.85));backdrop-filter:blur(12px);
        box-shadow:0 6px 24px rgba(0,0,0,.45),0 0 18px color-mix(in srgb,var(--stardust-accent) 30%,transparent);}
      #sd-panel{position:fixed;right:12px;bottom:calc(140px + env(safe-area-inset-bottom));z-index:2147483646;width:240px;
        display:none;flex-direction:column;gap:10px;padding:14px;border-radius:16px;color:#fff;font-family:system-ui;
        background:color-mix(in srgb,var(--stardust-accent) 10%,rgba(8,8,16,.92));border:1px solid color-mix(in srgb,var(--stardust-accent) 35%,rgba(255,255,255,.1));
        backdrop-filter:blur(16px);}
      #sd-panel.open{display:flex}
      #sd-panel .sd-h{font-weight:800;font-size:13px;letter-spacing:.4px}
      #sd-themes{display:flex;gap:8px;flex-wrap:wrap}
      .sd-sw{width:34px;height:34px;border-radius:10px;border:2px solid transparent}
      .sd-sw.on{border-color:#fff}
      .sd-row{display:flex;justify-content:space-between;align-items:center;font-size:13px}
      .sd-btn{padding:8px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#fff;font-size:13px}
      #sd-lyrics{position:fixed;inset:0;z-index:2147483645;display:flex;flex-direction:column;background:var(--stardust-bg);}
      #sd-lyr-head{display:flex;justify-content:space-between;align-items:center;padding:calc(12px + env(safe-area-inset-top)) 18px 10px;color:#fff;font-weight:800}
      #sd-lyr-head button{background:none;border:none;color:#fff;font-size:18px}
      #sd-lyr-body{flex:1;overflow-y:auto;padding:8px 22px calc(140px + env(safe-area-inset-bottom));color:rgba(255,255,255,.45);font-size:20px;line-height:1.6;font-weight:700}
      .sd-line{margin:10px 0;transition:color .2s,transform .2s}
      #sd-tab-lyrics{padding:14px 18px 120px;color:rgba(255,255,255,.45);font-size:19px;line-height:1.6;font-weight:700}
      #sd-tab-lyrics .sd-line.on{color:#fff}
      #sd-tab-lyrics .sd-w.sung{color:var(--stardust-accent);text-shadow:0 0 14px color-mix(in srgb,var(--stardust-accent) 60%,transparent)}
      .sd-lyrics-on ytmusic-description-shelf-renderer,.sd-lyrics-on ytmusic-message-renderer{display:none!important}
      .sd-mkt-h{font-weight:800;font-size:13px;margin:14px 0 6px;color:var(--stardust-accent)}
      .sd-mkt-row{display:flex;gap:12px;align-items:center;padding:8px 0}
      .sd-mkt-row.off{opacity:.45}
      .sd-mkt-sw{width:44px;height:44px;border-radius:12px;flex:none}
      .sd-mkt-name{font-size:14px;font-weight:700;color:#fff}
      .sd-mkt-desc{font-size:11.5px;color:rgba(255,255,255,.55);line-height:1.35}
      #sd-mkt-body{flex:1;overflow-y:auto;padding:6px 20px calc(120px + env(safe-area-inset-bottom));font-size:14px;color:#fff}
      .sd-line.on{color:var(--stardust-accent);transform:scale(1.02);text-shadow:0 0 18px color-mix(in srgb,var(--stardust-accent) 60%,transparent)}
    `;
    document.head.appendChild(style);

    const orb = document.createElement('button');
    orb.id = 'sd-orb'; orb.textContent = '✦';
    document.body.appendChild(orb);

    const twrap = el('div', { id: 'sd-themes' });
    const st = el('input', { type: 'checkbox', id: 'sd-star-t' });
    const vt = el('input', { type: 'checkbox', id: 'sd-vis-t' });
    const remoteIn = el('input', { id: 'sd-remote-in', placeholder: 'Desktop remote address…', css: 'padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#fff;font-size:12px' });
    const remoteGo = el('button', { class: 'sd-btn', text: location.hostname.includes('music.youtube') ? '📱 Open desktop remote' : '🎵 Back to the music' });
    const lyrBtn = el('button', { class: 'sd-btn', id: 'sd-lyr-open', text: '🎤 Synced lyrics' });
    const mktBtn = el('button', { class: 'sd-btn', id: 'sd-mkt-open', text: '🛍 Marketplace' });
    const panel = el('div', { id: 'sd-panel' }, [
      el('div', { class: 'sd-h', text: '✦ Stardust' }),
      twrap,
      el('div', { class: 'sd-row' }, [el('span', { text: 'Starfield' }), st]),
      el('div', { class: 'sd-row' }, [el('span', { text: 'Visualizer' }), vt]),
      lyrBtn, mktBtn, remoteIn, remoteGo
    ]);
    document.body.appendChild(panel);

    // Mobile YTM swallows events before they bubble to overlaid buttons, so
    // taps are caught in CAPTURE phase and hit-tested by COORDINATES — the
    // page can neither stop nor cover them.
    const inside = (el, x, y) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const tap = (e) => {
      const x = (e.changedTouches ? e.changedTouches[0] : e).clientX;
      const y = (e.changedTouches ? e.changedTouches[0] : e).clientY;
      dlog('tap ' + e.type + ' @' + Math.round(x) + ',' + Math.round(y) + ' orbHit=' + inside(orb, x, y) + ' orbConn=' + (orb && orb.isConnected));
      if (inside(orb, x, y)) {
        e.preventDefault(); e.stopPropagation();
        panel.classList.toggle('open');
        dlog('panel now ' + panel.className + ' display=' + getComputedStyle(panel).display + ' conn=' + panel.isConnected);
        return;
      }
      if (panel.classList.contains('open') && !inside(panel, x, y) && !document.getElementById('sd-lyrics')) {
        panel.classList.remove('open');
      }
    };
    document.addEventListener('touchend', tap, { capture: true, passive: false });
    document.addEventListener('click', (e) => {
      // Ghost click after a handled touchend — swallow it near the orb.
      if (inside(orb, e.clientX, e.clientY)) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    for (const [id, t] of Object.entries(THEMES)) {
      const b = document.createElement('button');
      b.className = 'sd-sw' + (cfg.theme === id ? ' on' : '');
      b.style.background = t.bg; b.style.boxShadow = 'inset 0 0 0 2px ' + t.accent + '44';
      b.title = t.name;
      b.addEventListener('touchend', (e) => {
        e.preventDefault(); e.stopPropagation();
        cfg.theme = id; save(); applyTheme();
        twrap.querySelectorAll('.sd-sw').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      }, true);
      twrap.appendChild(b);
    }
    st.checked = !!cfg.starfield;
    st.addEventListener('change', () => { cfg.starfield = st.checked; save(); starfield(st.checked); });
    vt.checked = cfg.visualizer !== false;
    vt.addEventListener('change', () => { cfg.visualizer = vt.checked; save(); visualizer(vt.checked); });
    remoteIn.value = cfg.remoteUrl || '';
    remoteIn.addEventListener('change', () => { cfg.remoteUrl = remoteIn.value.trim(); save(); });
    remoteGo.addEventListener('touchend', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!location.hostname.includes('music.youtube')) { location.href = 'https://music.youtube.com'; return; }
      let u = (remoteIn.value || cfg.remoteUrl || '').trim();
      if (!u) return;
      if (!/^https?:/.test(u)) u = 'http://' + u;
      cfg.remoteUrl = u; save();
      location.href = u; // the ✦ follows you there; it has a Back-to-music button
    }, true);
    lyrBtn.addEventListener('touchend', (e) => {
      e.preventDefault(); e.stopPropagation();
      panel.classList.remove('open');
      // Prefer the real lyrics tab; the sheet is the fallback.
      const t = lyricsTab();
      if (t) { try { t.click(); } catch {} setTimeout(ensureTabLyrics, 300); }
      else lyricsSheet(true);
    }, true);
    mktBtn.addEventListener('touchend', (e) => {
      e.preventDefault(); e.stopPropagation();
      panel.classList.remove('open'); openMarket();
    }, true);
  }

  function boot() {
    applyTheme();
    buildUI();
    starfield(cfg.starfield);
    visualizer(cfg.visualizer !== false);
    // The SPA can rebuild <body>; keep our UI mounted.
    setInterval(() => { buildUI(); if (cfg.starfield && !document.getElementById('sd-stars')) starfield(true); }, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
