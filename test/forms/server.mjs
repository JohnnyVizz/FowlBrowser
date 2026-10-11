// The form gauntlet: six tricky forms for browser agents, graded per persona token.
//   node test/forms/server.mjs [--port 5413]   pages on <port>, the same site on <port>+1 (second origin for iframes)
// POST /submit/<form> (JSON with `reference` = persona token) stores it and answers {id}; GET /grade/<token> grades the
// latest submission against personas.json; GET /grades grades every persona. Submissions live in memory only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./site/', import.meta.url));
const files = fileURLToPath(new URL('./files/', import.meta.url));
const data = JSON.parse(fs.readFileSync(new URL('./personas.json', import.meta.url), 'utf8'));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.pdf': 'application/pdf' };

const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
const same = (expected, got) => Array.isArray(expected)
  ? Array.isArray(got) && got.length === expected.length && got.every((v, i) => norm(v) === norm(expected[i]))
  : norm(expected) === norm(got);
const values = (v) => (Array.isArray(v) ? v : [v]).map((x) => norm(x).toLowerCase()).filter(Boolean);

// Every personal value (names, emails, typed text...) -> the persona it belongs to, so another agent's data in a
// submission shows up as cross-talk.
function personalIndex(personas) {
  const index = new Map();
  for (const [token, p] of Object.entries(personas)) {
    for (const field of data.forms[p.form].personal) for (const v of values(p.fields[field])) index.set(v, token);
  }
  return index;
}

export function gradeToken(token, submissions, personas = data.personas) {
  const persona = personas[token];
  if (!persona) return { ok: false, error: `unknown token ${token}` };
  const list = submissions.get(token) || [];
  const last = list.at(-1);
  const got = last?.data || {};
  const fields = data.forms[persona.form].fields.map((name) => {
    const expected = persona.fields[name] ?? '';
    return { name, expected, got: got[name] ?? null, ok: !!last && same(expected, got[name] ?? '') };
  });
  const index = personalIndex(personas);
  const mine = new Set(Object.values(persona.fields).flatMap(values));
  const crossTalk = [];
  for (const [name, v] of Object.entries(got)) {
    for (const value of values(v)) {
      const owner = index.get(value);
      if (owner && owner !== token && !mine.has(value)) crossTalk.push({ field: name, value, persona: owner });
    }
  }
  const score = fields.filter((f) => f.ok).length;
  const formOk = !last || last.form === persona.form;
  return {
    ok: !!last && formOk && score === fields.length && crossTalk.length === 0,
    form: persona.form, submittedForm: last?.form ?? null, id: last?.id ?? null,
    score, total: fields.length, fields, submissions: list.length, crossTalk,
  };
}

export function startServer({ port = 5413 } = {}) {
  const submissions = new Map();
  let next = 1;
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    const submit = /^\/submit\/(\w+)$/.exec(url.pathname);
    if (req.method === 'POST' && submit) {
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload;
      try { payload = JSON.parse(body); } catch { return json(400, { error: 'body is not JSON' }); }
      const id = `SUB-${String(next++).padStart(4, '0')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const token = norm(payload.reference).toLowerCase() || 'unknown';
      if (!submissions.has(token)) submissions.set(token, []);
      submissions.get(token).push({ id, form: submit[1], at: Date.now(), data: payload });
      return json(200, { id });
    }
    const grade = /^\/grade\/(\w+)$/.exec(url.pathname);
    if (grade) return json(200, gradeToken(grade[1], submissions));
    if (url.pathname === '/grades') return json(200, Object.fromEntries(Object.keys(data.personas).map((t) => [t, gradeToken(t, submissions)])));
    // Pages are served without extension too: /travel -> travel.html.
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    if (!extname(path)) path += '.html';
    const base = path.startsWith('/files/') ? files : root;
    const file = normalize(join(base, path.replace(/^\/files\//, '/')));
    if (!file.startsWith(base)) return res.writeHead(403).end();
    let content;
    try { content = await readFile(file); } catch { return res.writeHead(404).end('not found'); }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(content);
  }
  const servers = [port, port + 1].map((p) => createServer((req, res) => handle(req, res).catch(() => res.writeHead(500).end()))
    .listen(p, '127.0.0.1', () => console.log(`forms on http://127.0.0.1:${p}`)));
  return { submissions, close: () => Promise.all(servers.map((s) => new Promise((resolve) => { s.close(resolve); s.closeAllConnections(); }))) };
}

if (import.meta.main) {
  const i = process.argv.indexOf('--port');
  startServer({ port: i > 0 ? Number(process.argv[i + 1]) : 5413 });
}
