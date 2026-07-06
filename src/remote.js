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
body{margin:0;font-family:system-ui;background:radial-gradient(circle at 50% 0%,#1b1340,#05060f 70%);color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;box-sizing:border-box;text-align:center}
img{width:200px;height:200px;border-radius:18px;object-fit:cover;box-shadow:0 18px 60px rgba(0,0,0,.6)}
h1{font-size:20px;margin:0}h2{font-size:14px;margin:0;opacity:.6;font-weight:500}
.prev,.next{opacity:.4;font-size:15px;min-height:20px}
.line{font-size:22px;font-weight:800;min-height:56px;line-height:1.3}
.line b{color:#8b5cff}
.row{display:flex;gap:14px}
button{font-size:26px;width:64px;height:64px;border-radius:50%;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff}
button.big{width:80px;height:80px;background:#8b5cff}
</style>
<img id=art><h1 id=t>—</h1><h2 id=a></h2>
<div class=prev id=lp></div><div class=line id=ll></div><div class=next id=ln></div>
<div class=row>
<button onclick="cmd('previous')">⏮</button>
<button class=big id=pp onclick="cmd('playpause')">⏯</button>
<button onclick="cmd('next')">⏭</button>
</div>
<script>
const T='${tok}';
function cmd(a){fetch('/'+T+'/cmd',{method:'POST',body:a})}
async function tick(){try{
const s=await (await fetch('/'+T+'/np')).json();
t.textContent=s.title||'—';a.textContent=s.artist||'';
if(s.art&&art.src!==s.art)art.src=s.art;
lp.textContent=s.prevLine||'';ln.textContent=s.nextLine||'';
ll.innerHTML='';const el=document.createElement('b');el.textContent=s.line||'♪';ll.appendChild(el);
pp.textContent=s.playing?'⏸':'▶';
}catch(e){}}
setInterval(tick,800);tick();
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
        if (/^[a-z-]{2,20}$/.test(body) && onCmd) onCmd(body);
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
