// Zero-dependency static server for test/site on 127.0.0.1:5411 and :5412 (the second origin for cross-origin iframes).
// Any URL with ?delay=<ms> is answered that much later; ?redirect=<url> and ?status=204 answer as named.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./site/', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.txt': 'text/plain',
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  // ?delay=<ms> answers late, like a slow site (at most 10 s).
  const delay = Math.min(Number(url.searchParams.get('delay')) || 0, 10_000);
  if (delay) await new Promise(r => setTimeout(r, delay));
  // ?redirect=<url> answers 302 to it; ?status=204 answers 204 No Content (a link that loads no new page).
  if (url.searchParams.has('redirect')) return res.writeHead(302, { location: url.searchParams.get('redirect') }).end();
  if (url.searchParams.get('status') === '204') return res.writeHead(204).end();
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  let body;
  try { body = await readFile(file); } catch { return res.writeHead(404).end('not found'); }
  const headers = { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
  // ?attachment=<name> makes the browser download the file under that name.
  const attachment = url.searchParams.get('attachment');
  if (attachment) headers['content-disposition'] = `attachment; filename="${attachment.replace(/[^\w.-]/g, '_')}"`;
  // ?strict serves the page under a strict policy like YouTube's and GitHub's: Trusted Types, no inline styles.
  if (url.searchParams.has('strict')) headers['content-security-policy'] = "require-trusted-types-for 'script'; trusted-types 'none'; style-src 'self'";
  // Media elements seek with Range requests.
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 });
    return res.end(body.subarray(start, end + 1));
  }
  res.writeHead(200, { ...headers, 'content-length': body.length });
  res.end(body);
}

const base = Number(process.env.FOWLBROWSER_TEST_PORT) || 5411;
for (const port of [base, base + 1]) {
  createServer((req, res) => handle(req, res).catch(() => res.writeHead(500).end()))
    .listen(port, '127.0.0.1', () => console.log(`serving test/site on http://127.0.0.1:${port}`));
}
