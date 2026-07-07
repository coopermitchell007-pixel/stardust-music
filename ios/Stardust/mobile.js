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
  let cfg = { theme: 'nebula', starfield: true };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('sd-mobile') || '{}')); } catch {}
  const save = () => localStorage.setItem('sd-mobile', JSON.stringify(cfg));

  function applyTheme() {
    const t = THEMES[cfg.theme] || THEMES.nebula;
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
      .sd-line.on{color:var(--stardust-accent);transform:scale(1.02);text-shadow:0 0 18px color-mix(in srgb,var(--stardust-accent) 60%,transparent)}
    `;
    document.head.appendChild(style);

    const orb = document.createElement('button');
    orb.id = 'sd-orb'; orb.textContent = '✦';
    document.body.appendChild(orb);

    const twrap = el('div', { id: 'sd-themes' });
    const st = el('input', { type: 'checkbox', id: 'sd-star-t' });
    const lyrBtn = el('button', { class: 'sd-btn', id: 'sd-lyr-open', text: '🎤 Synced lyrics' });
    const panel = el('div', { id: 'sd-panel' }, [
      el('div', { class: 'sd-h', text: '✦ Stardust' }),
      twrap,
      el('div', { class: 'sd-row' }, [el('span', { text: 'Starfield' }), st]),
      lyrBtn
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
    lyrBtn.addEventListener('touchend', (e) => {
      e.preventDefault(); e.stopPropagation();
      panel.classList.remove('open'); lyricsSheet(true);
    }, true);
  }

  function boot() {
    applyTheme();
    buildUI();
    starfield(cfg.starfield);
    // The SPA can rebuild <body>; keep our UI mounted.
    setInterval(() => { buildUI(); if (cfg.starfield && !document.getElementById('sd-stars')) starfield(true); }, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
