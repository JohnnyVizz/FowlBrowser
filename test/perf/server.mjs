// Pages for the performance rounds (local/agents/perf.json): a slow page and an app whose side panel leaks. Every page
// lives under /t/<tag>/ (tag = the task's name), so an agent's page views and the panel's open/close cycles land in that
// tag's log, GET /t/<tag>/api/log -> {events: [{at, kind, path, ...}], lines: ["<kind> <path> ..."]}, as test/demo does.
//   node test/perf/server.mjs [--port 5431]
import { createServer } from 'node:http';

const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 5431);
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', json: 'application/json' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A 1600x900 image heavy enough (file size) to count as an LCP candidate.
let seed = 7;
const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
let hero = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#1c2541"/>';
for (let i = 0; i < 2500; i++) hero += `<circle cx="${(rnd() * 1600).toFixed(1)}" cy="${(rnd() * 900).toFixed(1)}" r="${(rnd() * 40 + 2).toFixed(1)}" fill="hsl(${Math.round(rnd() * 360)},70%,60%)" opacity="0.6"/>`;
hero += '</svg>';
// Mostly unused JS.
let bloat = 'window.used = () => document.title;\n';
for (let i = 0; i < 2000; i++) bloat += `function unused${i}(a, b) { const s = "${'x'.repeat(80)}"; return a + b + s.length + ${i}; }\n`;

// Logs page views and panel cycles to this tag's log.
const LOG_SCRIPT = `<script>
const base = location.pathname.split('/').slice(0, 3).join('/');
const log = (e) => fetch(base + '/api/log', { method: 'POST', body: JSON.stringify({ ...e, path: location.pathname.slice(base.length) }), keepalive: true });
log({ kind: 'view' });
</script>`;

// Render-blocking slow CSS and JS, a late unsized hero image (LCP discovery, layout shift), long tasks on load, a big
// DOM, a slow click handler.
const slowPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tidewell catalogue</title>
<link rel="stylesheet" href="/slow.css?ms=600">
<script src="/slow.js?ms=500"></script>
<script src="/bloat.js"></script>
<style>main{max-width:960px;margin:0 auto;font-family:system-ui,sans-serif}#banner{background:#ffd166;padding:48px 16px;font-size:20px}#hero{width:100%}.grid{display:flex;flex-wrap:wrap;gap:4px}.card{width:90px;font-size:11px;border:1px solid #ddd;padding:4px}button{font-size:16px;padding:10px 16px;margin:8px 4px 16px 0}</style>
</head><body>${LOG_SCRIPT}
<main>
  <h1>Tidewell catalogue</h1>
  <p>Hand-glazed stoneware mugs. The catalogue below loads every mug we make.</p>
  <button id="filter">Show blue mugs</button> <span id="status">all mugs</span>
  <div id="hero-box"></div>
  <div class="grid" id="grid"></div>
</main>
<script>
  setTimeout(() => { const img = document.createElement('img'); img.id = 'hero'; img.alt = ''; img.src = '/hero.svg'; document.getElementById('hero-box').appendChild(img); }, 800);
  setTimeout(() => { const b = document.createElement('div'); b.id = 'banner'; b.textContent = 'Free shipping this week on every order'; document.querySelector('main').prepend(b); }, 1200);
  let html = '';
  for (let i = 0; i < 1500; i++) html += '<div class="card"><span>mug</span> <b>' + i + '</b><i>·</i></div>';
  document.getElementById('grid').innerHTML = html;
  const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end) {} };
  addEventListener('load', () => { busy(250); setTimeout(() => busy(250), 20); setTimeout(() => busy(250), 60); });
  document.getElementById('filter').addEventListener('click', () => { busy(350); document.getElementById('status').textContent = 'blue mugs'; });
</script>
</body></html>`;

// An inbox-like app: the side panel's open/close keeps every panel's nodes, its data and a resize listener forever.
const appPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tidewell mail</title>
<style>body{margin:0;font-family:system-ui,sans-serif;display:flex;height:100vh}#list{flex:1;padding:16px;overflow:auto}#panel{width:320px;border-left:1px solid #ddd;padding:16px;background:#fafafa}.row{padding:8px;border-bottom:1px solid #eee}button{font-size:15px;padding:8px 14px}</style>
</head><body>${LOG_SCRIPT}
<div id="list">
  <h1>Inbox</h1>
  <button id="toggle">Open details</button> <span id="status">panel closed, 0 cycles</span>
  <div class="row">Tidewell Orders · Your order has shipped</div>
  <div class="row">Sam Ortiz · Team lunch Friday?</div>
  <div class="row">Northbound Supply · Q3 invoice</div>
</div>
<script>
  let cycles = 0, open = false;
  window.__details = []; // every closed panel stays here: its nodes, its cache and its listener
  const say = (kind) => log({ kind, detail: '#' + cycles });
  document.getElementById('toggle').addEventListener('click', () => {
    if (!open) {
      const panel = document.createElement('aside'); panel.id = 'panel';
      panel.innerHTML = '<h2>Order TW-48213</h2>' + Array.from({ length: 300 }, (_, i) => '<div class="row">Line ' + i + ' · Fjord mug</div>').join('');
      document.body.appendChild(panel);
      const cache = Array.from({ length: 128000 }, (_, i) => i * 1.5); // about 1 MB
      const onResize = () => cache.length;
      addEventListener('resize', onResize);
      window.__details.push({ nodes: [...panel.querySelectorAll('div')], cache, onResize });
      open = true; cycles++;
      document.getElementById('toggle').textContent = 'Close details';
      say('panel open');
    } else {
      document.getElementById('panel').remove(); // the nodes, cache and listener stay in window.__details
      open = false;
      document.getElementById('toggle').textContent = 'Open details';
      say('panel close');
    }
    document.getElementById('status').textContent = (open ? 'panel open, ' : 'panel closed, ') + cycles + ' cycles';
  });
</script>
</body></html>`;

export function logLines(events) {
  return events.map((e) => [e.kind, e.path, e.detail].filter((x) => x !== undefined && x !== '').join(' '));
}

const tags = new Map(); // tag -> { events }
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type, status = 200) => { res.writeHead(status, { 'content-type': types[type], 'cache-control': 'no-store' }); res.end(body); };
  const delay = Math.min(Number(url.searchParams.get('ms')) || 0, 10_000);
  if (delay) await sleep(delay);
  if (url.pathname === '/slow.css') return send('body { font-family: system-ui, sans-serif; margin: 0; } .card { padding: 8px; border: 1px solid #ddd; }', 'css');
  if (url.pathname === '/slow.js') return send('window.slowLoaded = Date.now();', 'js');
  if (url.pathname === '/hero.svg') return send(hero, 'svg');
  if (url.pathname === '/bloat.js') return send(bloat, 'js');
  const m = /^\/t\/([\w-]+)\/(.*)$/.exec(url.pathname);
  if (!m) return send('not found', 'html', 404);
  const [, tag, rest] = m;
  if (!tags.has(tag)) tags.set(tag, { events: [] });
  const state = tags.get(tag);
  if (rest === 'api/log') {
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      try { const e = JSON.parse(body); state.events.push({ at: Date.now(), kind: String(e.kind), path: String(e.path ?? ''), detail: e.detail }); } catch {}
      return send('{}', 'json');
    }
    return send(JSON.stringify({ events: state.events, lines: logLines(state.events) }), 'json');
  }
  if (rest === 'slow.html') return send(slowPage(), 'html');
  if (rest === 'app.html') return send(appPage(), 'html');
  return send('not found', 'html', 404);
}).listen(port, '127.0.0.1', () => console.log(`perf pages on http://127.0.0.1:${port}/t/<tag>/slow.html and app.html`));
