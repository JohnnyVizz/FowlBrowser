// Codex teardown provenance and the --remote round's own resources (unique local dir, free ports, bed manifest).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bedDiff, bedManifest, codexCreatedTabs, parseTranscript, portsInUse, remoteLocalDir } from '../rounds.mjs';

const t = 1_760_000_000_000;
const use = (at, id, code) => ({ t: at, type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__codex-cu__js', input: { code } }] } });
const result = (at, id, text) => ({ t: at, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });

test('codex teardown: only tabs the transcript proves the agent created; a user tab in its group or on its demo page stays', () => {
  const transcript = parseTranscript([
    use(t, 'a', "const tab = await cua.createBrowserTab(b.browserId, 'http://127.0.0.1:5420/t/x/shop/', { sessionName: '🧪 x' })"),
    result(t + 900, 'a', 'Browser tab: 101, Title: "Shop"'),
    // a click whose popup came into being during the call and is named in its result
    use(t + 2000, 'b', 'await tab.click(12)'),
    result(t + 3000, 'b', 'Browser tab: 102, Title: "Size guide"'),
    // a tab the agent only looked up (the user's, open before the call) is named but not created
    use(t + 4000, 'c', "const mine = await cua.getTab({ url: 'http://127.0.0.1:5420/t/x/shop/cart' }, { browser: b })"),
    result(t + 4500, 'c', 'Browser tab: 103, Title: "Cart"'),
    // a tab open at round start, even from a creating call, is never the agent's
    use(t + 5000, 'd', 'await cua.createBrowserTab(b.browserId)'),
    result(t + 5200, 'd', 'Browser tab: 7'),
  ]);
  assert.deepEqual(transcript.namedTabs.map((n) => [n.ids, n.creates]), [[[101], true], [[102], false], [[103], false], [[7], true]]);
  const monitor = [
    { t: t + 300, kind: 'activity', event: 'created', browser: 'chrome', tabId: 101, at: t + 290 },
    { t: t + 3200, kind: 'tab', event: 'new', tab: 'chrome:102', url: 'http://127.0.0.1:5420/t/x/shop/size' }, // polled just after the result
    { t: t + 1000, kind: 'tab', event: 'new', tab: 'chrome:103', url: 'http://127.0.0.1:5420/t/x/shop/cart' }, // the user opened it
    { t: t + 1000, kind: 'group', tab: 'chrome:104', label: '🧪 x', url: 'chrome://newtab/' }, // the user's new tab in the group
    { t: t + 3100, kind: 'activity', event: 'created', browser: 'helium', tabId: 102, at: t + 2500 }, // other browser
  ];
  const created = codexCreatedTabs({ browser: 'chrome', transcript, monitor, startKeys: new Set(['chrome:7']) });
  assert.deepEqual([...created], ['chrome:101', 'chrome:102']);
});

test('remote: each round gets its own local dir; making one leaves another round\'s alone', () => {
  const a = remoteLocalDir();
  fs.writeFileSync(path.join(a, 'cm'), '');
  const b = remoteLocalDir();
  assert.notEqual(a, b);
  assert.match(path.basename(b), /^fb-remote-/);
  assert.ok(fs.existsSync(path.join(a, 'cm')));
  for (const dir of [a, b]) fs.rmSync(dir, { recursive: true });
});

test('remote: ports already taken locally are found before ssh tries to forward them', async (t) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const free = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  assert.deepEqual(await portsInUse([port, free]), [port]);
});

test('remote: the bed manifest covers every runtime file of the surface, and a stale or missing one fails the check', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bed-'));
  const files = { 'extension/core.js': 'core', 'extension/test/x.test.mjs': 't', 'extension/NOTES.md': 'n', 'mcp/src/takeover.mjs': 'take',
    'mcp/src/vendor/cdpRelay.mjs': 'relay', 'mcp/node_modules/z/index.js': 'z', 'mcp/package-lock.json': '{}', 'test/demo/server.mjs': 'demo',
    'tools/mcp-tee.mjs': 'tee', 'host/host.mjs': 'host' };
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), body); }
  const fb = bedManifest('fowlbrowser', root);
  assert.deepEqual(Object.keys(fb).sort(), ['extension/core.js', 'host/host.mjs', 'mcp/package-lock.json', 'mcp/src/takeover.mjs', 'mcp/src/vendor/cdpRelay.mjs', 'test/demo/server.mjs']);
  assert.deepEqual(Object.keys(bedManifest('codex', root)).sort(), ['extension/core.js', 'host/host.mjs', 'test/demo/server.mjs', 'tools/mcp-tee.mjs']);
  const md5 = (m) => Object.entries(m).map(([f, h]) => `${h} ${f}`).join('\n');
  assert.deepEqual(bedDiff(fb, md5(fb)), []);
  const stale = { ...fb, 'mcp/src/takeover.mjs': '0'.repeat(32) };
  delete stale['mcp/src/vendor/cdpRelay.mjs'];
  assert.deepEqual(bedDiff(fb, md5(stale)), ['mcp/src/takeover.mjs', 'mcp/src/vendor/cdpRelay.mjs']);
  fs.rmSync(root, { recursive: true });
});
