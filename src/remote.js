'use strict';

// Phone remote + second-screen lyrics: a tiny LAN HTTP server. The phone
// polls /np for state (incl. the current lyric lines) and POSTs /cmd for
// transport. Path-token'd so a random LAN scan doesn't find the endpoints;
// plain HTTP because it never leaves the LAN.
const http = require('http');
const os = require('os');

let server = null, token = '', state = {}, onCmd = null;

function lanIP() {
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
}

const PAGE = (tok) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stardust Remote</title>
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
<script>
const T='${tok}';let haptics=false,lastBeat=0,dur=0;
function cmd(a){fetch('/'+T+'/cmd',{method:'POST',body:a})}
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

function start(handler) {
  if (server) return url();
  onCmd = handler;
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
