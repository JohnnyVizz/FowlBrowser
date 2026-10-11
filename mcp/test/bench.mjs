#!/usr/bin/env node
// Times every common tool through a real MCP server session against the local test site (real browsers).
//   node mcp/test/bench.mjs [--browser chrome|helium|both] [--runs 10]
// Background tabs only (no cursor travel). Prints min / median / p90 per tool, and the wall time of parallel tab_opens
// (fast page, and a page whose document answers 1.5 s late), so serialization shows up as a growing staircase.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ensureSite, parseArgs, SITE, browsersFrom } from '../../test/lib.mjs';

const args = parseArgs(process.argv.slice(2), { browser: 'both', runs: 10 });
const RUNS = Number(args.runs);
const stopSite = await ensureSite();
const client = new Client({ name: 'fowlbrowser-bench', version: '0' });
await client.connect(new StdioClientTransport({
  command: 'sh', args: [new URL('../bin/fowlbrowser-mcp', import.meta.url).pathname],
  env: { ...process.env, FOWLBROWSER_LABEL: 'bench' }, stderr: 'inherit',
}));

const opened = new Set();
async function call(name, callArgs) {
  const started = performance.now();
  const result = await client.callTool({ name, arguments: callArgs });
  const ms = performance.now() - started;
  const body = result.content.find((c) => c.type === 'text')?.text ?? '';
  if (result.isError) throw new Error(`${name} failed: ${body.slice(0, 300)}`);
  return { ms, body };
}
const tabOf = (body) => /Tab: (\S+) ·/.exec(body)?.[1];
const refOf = (body, pattern) => new RegExp(`${pattern}[^\\n]*\\[ref=(e\\d+)\\]`).exec(body)?.[1];
const stats = (list) => {
  const s = [...list].sort((a, b) => a - b);
  return { min: s[0], median: s[Math.floor(s.length / 2)], p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] };
};
const rows = [];
const row = (browser, tool, list) => rows.push({ browser, tool, n: list.length, ...stats(list) });

async function open(browser, url, extra = {}) {
  const r = await call('tab_open', { browser, url, snapshot: false, ...extra });
  opened.add(tabOf(r.body));
  return { tab: tabOf(r.body), ms: r.ms };
}

try {
  for (const browser of browsersFrom(args.browser)) {
    const times = [];
    for (let i = 0; i < 3; i++) times.push((await open(browser, `${SITE}/index.html?bench=${i}`)).ms);
    row(browser, 'tab_open (fast page)', times);

    for (const [label, url] of [['fast', 'index.html'], ['slow doc 1.5 s', 'index.html?delay=1500']]) {
      const started = performance.now();
      const each = await Promise.all([0, 1, 2, 3].map((i) => open(browser, `${SITE}/${url}${url.includes('?') ? '&' : '?'}p=${i}`).then((r) => r.ms)));
      rows.push({ browser, tool: `4 x tab_open parallel (${label})`, n: 4, min: Math.min(...each), median: stats(each).median,
        p90: Math.max(...each), wall: performance.now() - started, each: each.map((v) => Math.round(v)).join(' ') });
    }

    const { tab } = await open(browser, `${SITE}/form.html`);
    const snap = (await call('snapshot', { tab })).body;
    const measure = async (label, make) => {
      const tool = label.split(' ')[0];
      const list = [];
      for (let i = 0; i < RUNS; i++) list.push((await call(tool, make(i))).ms);
      row(browser, label, list);
    };
    await measure('evaluate', () => ({ tab, function: '() => document.title' }));
    await measure('snapshot', () => ({ tab }));
    const field = refOf(snap, 'textbox');
    if (field) await measure('type (ref, no snapshot)', (i) => ({ tab, ref: field, text: `bench ${i}`, snapshot: false }));
    if (field) await measure('type (ref, with snapshot)', (i) => ({ tab, ref: field, text: `bench ${i}` }));
    const box = refOf(snap, 'checkbox');
    if (box) await measure('click (ref, no snapshot)', () => ({ tab, ref: box, snapshot: false }));
    await measure('click (x,y, no snapshot)', () => ({ tab, x: 5, y: 5, snapshot: false }));
    await measure('press_key (no snapshot)', () => ({ tab, key: 'Shift', snapshot: false }));
    await measure('scroll (no snapshot)', () => ({ tab, direction: 'down', pages: 0.2, snapshot: false }));
    await measure('navigate (no snapshot)', (i) => ({ tab, url: `${SITE}/index.html?n=${i}`, snapshot: false }));
    await measure('screenshot', () => ({ tab }));
  }
} finally {
  for (const tab of opened) await client.callTool({ name: 'tab_close', arguments: { tab } }).catch(() => {});
  await client.close();
  stopSite();
}

const fmt = (v) => (v === undefined ? '' : `${Math.round(v)}`);
console.log('\nbrowser  tool                               n   min  median   p90   wall  each');
for (const r of rows) {
  console.log(`${r.browser.padEnd(8)} ${r.tool.padEnd(34)} ${String(r.n).padStart(2)} ${fmt(r.min).padStart(5)} ${fmt(r.median).padStart(7)} ${fmt(r.p90).padStart(5)} ${fmt(r.wall).padStart(6)}  ${r.each ?? ''}`);
}
process.exit(0);
