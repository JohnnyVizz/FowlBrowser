// End-to-end smoke test against the real browsers: node test/smoke.mjs [browser...]
// Spawns the MCP server over stdio and, in each browser (default: chrome and helium), opens background tabs,
// reads, clicks, waits, screenshots, works two tabs in parallel, claims and releases one of the user's tabs,
// drives a YouTube player, and closes every tab it opened.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['chrome', 'helium'];
const YOUTUBE = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'; // Big Buck Bunny, Blender Foundation

const client = new Client({ name: 'fowlbrowser-smoke', version: '0' });
await client.connect(new StdioClientTransport({
  command: 'sh',
  args: [fileURLToPath(new URL('../bin/fowlbrowser-mcp', import.meta.url))],
  env: { ...process.env, FOWLBROWSER_LABEL: 'smoke' },
  stderr: 'inherit',
}));

const opened = new Set();
const t0 = Date.now();
const log = (browser, step, detail = '') => console.log(`ok  ${browser.padEnd(7)} ${step.padEnd(22)} ${detail}`.trimEnd());

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const body = result.content.find((c) => c.type === 'text')?.text ?? '';
  if (result.isError) throw new Error(`${name} ${JSON.stringify(args)} failed:\n${body}`);
  return { body, result };
}

const firstLine = (body) => body.split('\n')[0];
const tabIdOf = (body) => /Tab: (\S+) ·/.exec(body)?.[1];
const refOf = (body, pattern) => new RegExp(`${pattern}[^\\n]*\\[ref=(e\\d+)\\]`).exec(body)?.[1];

async function open(browser, url) {
  const { body } = await call('tab_open', { browser, url });
  const tab = tabIdOf(body);
  assert.ok(tab?.startsWith(`${browser}:`), `tab id in: ${firstLine(body)}`);
  opened.add(tab);
  return { tab, body };
}

async function close(tab) {
  await call('tab_close', { tab });
  opened.delete(tab);
}

async function run(browser) {
  // 1. The browser is listed by name.
  const list = (await call('browser_list')).body;
  const line = list.split('\n').find((l) => l.includes(`browser: "${browser}"`));
  assert.ok(line, `${browser} missing from browser_list:\n${list}`);
  log(browser, 'browser_list', line.slice(2));

  // 2. Background tab on example.com, snapshot, click the link, wait for the navigation.
  const { tab, body: openBody } = await open(browser, 'https://example.com');
  assert.match(firstLine(openBody), new RegExp(`^Browser: \\w+ · Tab: ${tab} · Example Domain · https://example.com/`));
  log(browser, 'tab_open', firstLine(openBody));

  const snap = (await call('snapshot', { tab })).body;
  const link = refOf(snap, 'link');
  assert.ok(link, `no link ref in snapshot:\n${snap}`);
  log(browser, 'snapshot', `heading + link ref ${link}`);

  const clicked = (await call('click', { tab, ref: link, snapshot: false })).body;
  log(browser, 'click', firstLine(clicked));
  const waited = (await call('wait_for', { tab, url: 'iana.org', snapshot: false })).body;
  assert.match(firstLine(waited), /iana\.org/);
  log(browser, 'wait_for url', firstLine(waited));

  const shot = (await call('screenshot', { tab })).result;
  const image = shot.content.find((c) => c.type === 'image');
  assert.equal(image?.mimeType, 'image/jpeg');
  assert.ok(Buffer.from(image.data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'JPEG magic');
  log(browser, 'screenshot', `${Math.round(image.data.length * 0.75 / 1024)} KB jpeg`);

  // 3. A second tab, then actions on both tabs at the same time.
  const { tab: tab2 } = await open(browser, 'https://en.wikipedia.org/wiki/Special:Random');
  const started = Date.now();
  const [a, b, c, d] = await Promise.all([
    call('navigate', { tab, url: 'https://example.com/?parallel=1' }),
    call('scroll', { tab: tab2, direction: 'down', pages: 2, snapshot: false }),
    call('evaluate', { tab: tab2, function: '() => document.title' }),
    call('screenshot', { tab: tab2 }),
  ]);
  assert.match(a.body, /Tab: \S+ · Example Domain/);
  assert.match(b.body, /Scrolled down 2 pages/);
  assert.match(c.body, /Wikipedia/);
  assert.ok(d.result.content.some((x) => x.type === 'image'));
  log(browser, 'parallel x4', `${Date.now() - started} ms · ${firstLine(a.body).split(' · ')[1]} + ${firstLine(c.body).split(' · ')[1]}`);

  // 4. Claim one of the user's own tabs and give it back.
  const all = (await call('tab_list', { browser, scope: 'all' })).body;
  const claimable = all.split('\n').find((l) => /owner: user \(claimable\)/.test(l) && /· (https?:|about:blank|chrome:\/\/newtab|chrome-search:)/.test(l));
  assert.ok(claimable, `no claimable user tab in ${browser}:\n${all}`);
  const userTab = /^- (\S+) ·/.exec(claimable)[1];
  const claimed = (await call('tab_claim', { tab: userTab })).body;
  assert.match(firstLine(claimed), new RegExp(`Tab: ${userTab}`));
  log(browser, 'tab_claim', firstLine(claimed));
  const refused = await client.callTool({ name: 'tab_close', arguments: { tab: userTab } });
  assert.ok(refused.isError && /tab_release/.test(refused.content[0].text), `tab_close on a claimed tab must be refused:\n${refused.content[0].text}`);
  log(browser, 'tab_close refused', 'claimed tab stays open without confirm_close_users_tab');
  await call('tab_release', { tab: userTab });
  const after = (await call('tab_list', { browser, scope: 'all' })).body;
  assert.match(after, new RegExp(`- ${userTab} · .*owner: user \\(claimable\\)`));
  log(browser, 'tab_release', `${userTab} back to the user, still open`);

  await close(tab);
  await close(tab2);
  const mine = (await call('tab_list', { browser, scope: 'mine' })).body;
  assert.match(mine, /· 0 tabs controlled by you/);
  log(browser, 'tab_close', 'both tabs closed');

  // 5. YouTube: status, play, pause, seek.
  const { tab: yt } = await open(browser, YOUTUBE);
  const media = async (action, value) => {
    const { body } = await call('media', { tab: yt, action, value });
    const json = /Media \w+[^:]*: (\{.*\})/.exec(body)?.[1];
    assert.ok(json, `media ${action}:\n${body}`);
    return { status: JSON.parse(json), line: body.split('\n')[1] };
  };
  let { status } = await media('status');
  assert.equal(status.element.split('#')[0], 'video');
  log(browser, 'media status', `duration ${status.duration}s paused ${status.paused}`);
  ({ status } = await media('play'));
  await new Promise((r) => setTimeout(r, 2500));
  const playing = (await media('status')).status;
  assert.equal(playing.paused, false, 'playing');
  log(browser, 'media play', `t=${status.currentTime}s -> ${playing.currentTime}s after 2.5 s`);
  ({ status } = await media('pause'));
  assert.equal(status.paused, true);
  log(browser, 'media pause', `paused at ${status.currentTime}s`);
  ({ status } = await media('seek', 120));
  assert.ok(Math.abs(status.currentTime - 120) < 2, `seek landed at ${status.currentTime}`);
  log(browser, 'media seek', `currentTime ${status.currentTime}s`);
  await close(yt);
}

let failed = false;
try {
  for (const browser of wanted) await run(browser);
} catch (error) {
  failed = true;
  console.error(`FAIL ${error.stack ?? error}`);
} finally {
  for (const tab of opened) await call('tab_close', { tab }).catch(() => {});
  await client.close();
}
console.log(failed ? 'SMOKE FAILED' : `SMOKE PASSED (${wanted.join(', ')}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
