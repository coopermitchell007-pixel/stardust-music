'use strict';

// Phone remote + second-screen lyrics: a tiny LAN HTTP server. The phone
// polls /np for state (incl. the current lyric lines) and POSTs /cmd for
// transport. Path-token'd so a random LAN scan doesn't find the endpoints;
// plain HTTP because it never leaves the LAN.
const http = require('http');
const os = require('os');

let server = null, token = '', state = {}, onCmd = null, onReq = null;

// Home-screen app icon (violet star, generated procedurally) — served at
// /<token>/icon.png for the PWA install.
const ICON_PNG = Buffer.from('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', 'base64');


function lanIP() {
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
}

const PAGE = (tok) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Stardust</title>
<link rel="manifest" href="/${tok}/manifest.json">
<link rel="apple-touch-icon" href="/${tok}/icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Stardust">
<meta name="theme-color" content="#0a0716">
<style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui;background:#05060f;color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:22px;text-align:center;overflow-x:hidden}
#bg{position:fixed;inset:-10%;background-size:cover;background-position:center;filter:blur(46px) brightness(.36);z-index:-1;transition:background-image .6s}
img.art{width:190px;height:190px;border-radius:18px;object-fit:cover;box-shadow:0 18px 60px rgba(0,0,0,.6)}
h1{font-size:20px;margin:0;max-width:88vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
h2{font-size:14px;margin:0;opacity:.6;font-weight:500}
.prev,.next{opacity:.4;font-size:15px;min-height:20px;max-width:88vw}
.line{font-size:22px;font-weight:800;min-height:56px;line-height:1.3;max-width:90vw}
.line b{color:var(--ac,#8b5cff);text-shadow:0 0 18px var(--ac,#8b5cff)}
.row{display:flex;gap:14px;align-items:center}
button{font-size:24px;width:60px;height:60px;border-radius:50%;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff}
button.big{width:80px;height:80px;font-size:30px;background:var(--ac,#8b5cff)}
button.on{border-color:var(--ac,#8b5cff);box-shadow:0 0 12px var(--ac,#8b5cff)}
#bar{width:min(420px,88vw);height:22px;display:flex;align-items:center;cursor:pointer}
#bar>div{width:100%;height:5px;border-radius:3px;background:rgba(255,255,255,.15);overflow:hidden}
#fill{height:100%;width:0%;background:var(--ac,#8b5cff)}
#time{font-size:11px;opacity:.55;margin-top:-10px}
</style>
<div id=bg></div>
<img class=art id=art><h1 id=t>—</h1><h2 id=a></h2>
<div id=bar><div><div id=fill></div></div></div><div id=time></div>
<div class=prev id=lp></div><div class=line id=ll></div><div class=next id=ln></div>
<div class=row>
<button onclick="cmd('previous')">⏮</button>
<button class=big id=pp onclick="cmd('playpause')">⏯</button>
<button onclick="cmd('next')">⏭</button>
</div>
<div class=row>
<button onclick="cmd('like')" title="Like">♥</button>
<button id=hap onclick="haptics=!haptics;hap.classList.toggle('on',haptics)" title="Vibrate on the beat">〰</button>
</div>
<div class=row style="width:min(420px,88vw)">
<input id=reqi placeholder="Request a song…" style="flex:1;padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;font-size:14px">
<button onclick="sendReq()" style="width:auto;border-radius:12px;padding:0 18px;font-size:15px">Send</button>
</div>
<script>
const T='${tok}';let haptics=false,lastBeat=0,dur=0;
function cmd(a){fetch('/'+T+'/cmd',{method:'POST',body:a})}
function sendReq(){const v=reqi.value.trim();if(!v)return;reqi.value='';fetch('/'+T+'/req',{method:'POST',body:v.slice(0,120)});reqi.placeholder='Sent to the DJ ✓'}

const fmt=s=>{s=Math.max(0,Math.floor(s||0));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
bar.addEventListener('click',e=>{const r=bar.getBoundingClientRect();cmd('seek:'+((e.clientX-r.left)/r.width).toFixed(4))});
async function tick(){try{
const s=await (await fetch('/'+T+'/np')).json();
t.textContent=s.title||'—';a.textContent=s.artist||'';
if(s.accent)document.documentElement.style.setProperty('--ac',s.accent);
if(s.art&&art.src!==s.art){art.src=s.art;bg.style.backgroundImage='url("'+s.art+'")'}
lp.textContent=s.prevLine||'';ln.textContent=s.nextLine||'';
ll.innerHTML='';const el=document.createElement('b');el.textContent=s.line||'♪';ll.appendChild(el);
pp.textContent=s.playing?'⏸':'▶';
dur=s.duration||0;
if(dur>0){fill.style.width=(100*(s.position||0)/dur).toFixed(1)+'%';time.textContent=fmt(s.position)+' / '+fmt(dur)}
if(haptics&&s.beat&&Date.now()-lastBeat>250&&navigator.vibrate){lastBeat=Date.now();navigator.vibrate(30)}
}catch(e){}}
setInterval(tick,700);tick();
</script>`;

function start(handler, reqHandler) {
  if (server) return url();
  onCmd = handler;
  onReq = reqHandler || null;
  token = Math.random().toString(36).slice(2, 8);
  server = http.createServer((req, res) => {
    const parts = (req.url || '').split('/').filter(Boolean);
    if (parts[0] !== token) { res.writeHead(404); return res.end(); }
    if (req.method === 'POST' && parts[1] === 'cmd') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (/^[a-z-]{2,20}(:[\d.]{1,10})?$/.test(body) && onCmd) onCmd(body);
        res.writeHead(204); res.end();
      });
      return;
    }
    if (req.method === 'POST' && parts[1] === 'req') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const t = String(body).slice(0, 120).replace(/[<>]/g, '');
        if (t.trim() && onReq) onReq(t.trim());
        res.writeHead(204); res.end();
      });
      return;
    }
    if (parts[1] === 'icon.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      return res.end(ICON_PNG);
    }
    if (parts[1] === 'manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
      return res.end(JSON.stringify({
        name: 'Stardust', short_name: 'Stardust',
        start_url: '/' + token + '/', display: 'standalone',
        background_color: '#05060f', theme_color: '#0a0716',
        icons: [{ src: '/' + token + '/icon.png', sizes: '180x180', type: 'image/png' }]
      }));
    }
    if (parts[1] === 'np') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(state || {}));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE(token));
  });
  server.listen(8765, '0.0.0.0');
  return url();
}

function stop() { if (server) { try { server.close(); } catch {} server = null; } }
function setState(s) { state = s || {}; }
function url() { return server ? 'http://' + lanIP() + ':8765/' + token : null; }

module.exports = { start, stop, setState, url };
