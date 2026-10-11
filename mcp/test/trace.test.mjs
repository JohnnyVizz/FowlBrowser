// The trace summary and insight details over two real traces of test/site/perf.html (screenshots and script sources
// stripped): a page load (render-blocking CSS, long task, layout shift, late text LCP) and a slow click (INP).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { TRACE_WAIT, tracingSlot } from '../src/perf.mjs';
import { insightText, parseTrace, registerTrace, summaryText } from '../src/trace.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const load = (name) => parseTrace(JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))));
const pageLoad = await load('trace-load.json.gz');
const click = await load('trace-click.json.gz');

test('summary of a page load: set, metrics, long tasks, file', () => {
  const s = summaryText(pageLoad, { file: '/tmp/t.json.gz' });
  assert.match(s, /^Trace: http:\/\/127\.0\.0\.1:\d+\/perf\.html\S* · 2\.5 s · [\d,]+ events$/m);
  assert.match(s, /^File: \/tmp\/t\.json\.gz /m);
  assert.match(s, /^Throttling: CPU none · network none$/m);
  assert.match(s, /^NAVIGATION_0: http:\/\/127\.0\.0\.1:\d+\/perf\.html\S* · \d+ ms to [\d,]+ ms of the trace$/m);
  assert.match(s, /^LCP: 928 ms \(TTFB 2 ms · render delay 926 ms\) · element: P id='hero' \(node 10\) · text$/m);
  assert.match(s, /^INP: n\/a \(no interactions\)$/m);
  assert.match(s, /^CLS: 0\.02$/m);
  assert.match(s, /^Long tasks: 1 over 50 ms, longest 151 ms$/m);
  assert.match(s, /^Details: trace_insight \{tab, name\}$/m);
});

test('summary lists failing, then informative insights, then the passed ones on one line', () => {
  const lines = summaryText(pageLoad, { file: 'f' }).split('\n');
  const listed = lines.filter((l) => l.startsWith('- ')).map((l) => /^- (\w+) \((\w+)\)/.exec(l).slice(1, 3));
  assert.deepEqual(listed, [['RenderBlocking', 'fail'], ['NetworkDependencyTree', 'fail'], ['LCPBreakdown', 'informative'], ['CLSCulprits', 'informative']]);
  assert.ok(lines.includes('- RenderBlocking (fail): Render-blocking requests · est. FCP -140 ms · est. LCP -140 ms'));
  const passed = lines.filter((l) => l.startsWith('Passed: '));
  assert.equal(passed.length, 1);
  assert.match(passed[0], /^Passed: INPBreakdown, LCPDiscovery, .*LegacyJavaScript$/);
  assert.ok(!/RenderBlocking/.test(passed[0]));
});

test('summary of an interaction: INP with its phases, no LCP', () => {
  const s = summaryText(click, { file: 'f', dataLoss: true });
  assert.match(s, /some events were lost/);
  assert.match(s, /^NO_NAVIGATION: /m);
  assert.match(s, /^LCP: n\/a /m);
  assert.match(s, /^INP: 231 ms \(pointerdown: input delay 1 ms · processing 201 ms · presentation delay 28 ms\)$/m);
  assert.match(s, /^- INPBreakdown \(fail\): INP breakdown$/m);
});

test('insight details: title, plain description, savings, data', () => {
  const lcp = insightText(pageLoad, 'LCPBreakdown');
  assert.match(lcp, /^LCPBreakdown \(informative\): LCP breakdown\nEach \[subpart has specific improvement strategies\]\(https:\/\/developer\.chrome\.com\/[^)]+\)/);
  assert.match(lcp, /^Estimated savings: none$/m);
  assert.match(lcp, /^- TTFB: 2 ms \(0%\)$/m);
  assert.match(lcp, /^- render delay: 926 ms \(100%\)$/m);
  const rb = insightText(pageLoad, 'RenderBlocking');
  assert.match(rb, /^Estimated savings: FCP -140 ms · LCP -140 ms$/m);
  assert.match(rb, /^- http:\/\/127\.0\.0\.1:\d+\/style\.css\?delay=300 · 303 ms · 516 B · est\. 151 ms saved without it$/m);
  assert.match(insightText(pageLoad, 'CLSCulprits'), /^Shift 1: at 721 ms, score 0\.017 · moved: H1, /m);
  assert.match(insightText(pageLoad, 'DocumentLatency'), /^- \[pass\] Server responds quickly \(observed \d+ ms\)$/m);
  assert.match(insightText(click, 'INPBreakdown'), /^Longest interaction: pointerdown, 231 ms\n- input delay: 1 ms\n- processing: 201 ms\n- presentation delay: 28 ms$/m);
  assert.match(insightText(pageLoad, 'INPBreakdown'), /^No interactions in this trace\.$/m);
  for (const name of Object.keys(pageLoad.insights.get('NAVIGATION_0').model)) assert.ok(insightText(pageLoad, name).length > 0, name);
});

test('unknown insight or set: the error lists what exists', () => {
  assert.throws(() => insightText(pageLoad, 'Nope'), /^Error: No insight "Nope"\. Insights of the last trace: .*\bRenderBlocking\b.*\bLCPBreakdown\b/);
  assert.throws(() => insightText(pageLoad, 'LCPBreakdown', 'NAVIGATION_7'), /No insight set "NAVIGATION_7"\. Sets of the last trace: NAVIGATION_0/);
});

test('insight details are cut at 20,000 characters', async () => {
  const parsed = await load('trace-load.json.gz');
  const rb = parsed.insights.get('NAVIGATION_0').model.RenderBlocking;
  rb.renderBlockingRequests = Array(2000).fill(rb.renderBlockingRequests[0]);
  const out = insightText(parsed, 'RenderBlocking');
  assert.ok(out.length <= 20_000, String(out.length));
  assert.match(out, /\.\.\. \[\d+ more lines not shown\. The trace file has everything/);
});

test('a failed insight generator: the summary names it with its error, trace_insight says the engine failed', async () => {
  const parsed = await load('trace-load.json.gz');
  const set = parsed.insights.get('NAVIGATION_0');
  delete set.model.RenderBlocking;
  set.modelErrors.RenderBlocking = new Error('boom\nstack');
  const s = summaryText(parsed, { file: 'f' });
  assert.match(s, /^Could not compute: RenderBlocking \(boom\)$/m);
  assert.ok(!/^- RenderBlocking /m.test(s));
  assert.throws(() => insightText(parsed, 'RenderBlocking'), /^Error: The trace engine failed to compute RenderBlocking: boom$/);
});

test('DuplicatedJavaScript is not shown as passed: it needs source maps', () => {
  const lines = summaryText(pageLoad, { file: 'f' }).split('\n');
  assert.ok(!lines.find((l) => l.startsWith('Passed: ')).includes('DuplicatedJavaScript'));
  assert.ok(lines.includes('Not computed (needs source maps, which are not fetched): DuplicatedJavaScript'));
  assert.match(insightText(pageLoad, 'DuplicatedJavaScript'), /^DuplicatedJavaScript: not computed\. It needs the scripts' source maps, which are not fetched/);
});

test('parsing resets the engine\'s module state without touching the parsed traces kept', async () => {
  const before = [summaryText(pageLoad, { file: 'f' }), ...Object.keys(pageLoad.insights.get('NAVIGATION_0').model).map((n) => insightText(pageLoad, n))];
  await load('trace-click.json.gz');
  const after = [summaryText(pageLoad, { file: 'f' }), ...Object.keys(pageLoad.insights.get('NAVIGATION_0').model).map((n) => insightText(pageLoad, n))];
  assert.deepEqual(after, before);
  const Trace = await import('@paulirish/trace_engine');
  assert.throws(() => Trace.Helpers.SyntheticEvents.SyntheticEventsManager.getActiveManager(), /without initializing/);
});

// --- Recording, through a fake tab whose host answers the CDP commands ---

const clickTrace = zlib.gunzipSync(fs.readFileSync(new URL('./fixtures/trace-click.json.gz', import.meta.url))).toString('utf8');
const tools = {};
registerTrace((name, description, shape, handler) => { tools[name] = handler; }, null,
  { withTab: (handler) => handler, header: async () => 'Tab: chrome:1', text: (body) => body, tabArg: undefined });

const clickTraceGz = zlib.gzipSync(clickTrace); // as Chrome streams it (streamCompression gzip)
const BUSY = 'Tracing has already been started (possibly in another tab).';
Object.assign(TRACE_WAIT, { waitMs: 100, retryMs: 5 }); // a busy browser is waited for this long here

// `fail`: command -> error message, or a function of the command's 1-based count returning one (or nothing).
function fakeTab(fail = {}) {
  const host = new EventEmitter();
  const sent = [];
  const params = [];
  const counts = {};
  host.request = async (method, args) => {
    if (method === 'tabs.listAll') return [];
    const [, command, p] = args;
    sent.push(command);
    params.push(p);
    counts[command] = (counts[command] ?? 0) + 1;
    const message = typeof fail[command] === 'function' ? fail[command](counts[command]) : fail[command];
    if (message) throw new Error(message);
    if (command === 'Tracing.end') {
      setImmediate(() => host.emit('chrome.debugger.onEvent', [{ tabId: 1 }, 'Tracing.tracingComplete', { stream: 's1', dataLossOccurred: false }]));
    }
    if (command === 'IO.read') return { data: clickTraceGz.toString('base64'), base64Encoded: true, eof: true };
    return {};
  };
  const page = new EventEmitter();
  page.gotos = [];
  page.url = () => 'http://127.0.0.1/perf.html';
  page.goto = async (u) => { page.gotos.push(u); };
  return { id: 'chrome:1', tabId: 1, page, browser: { host }, sent, params };
}

const slotIsFree = async () => (await Promise.race([tracingSlot(), sleep(500).then(() => null)]))?.();

test('trace_start takes the slot first; a busy browser is waited for on the page as it is, then given up on', async () => {
  const tab = fakeTab({ 'Tracing.start': BUSY });
  const held = await tracingSlot();
  const started = tools.trace_start(tab, { reload: true, auto_stop: false }).then(() => null, (e) => e.message);
  await sleep(20);
  assert.deepEqual(tab.sent, [], 'nothing is sent while the slot is held');
  held();
  assert.match(await started, /^Chrome records one trace at a time and something else kept recording/);
  assert.ok(tab.sent.filter((c) => c === 'Tracing.start').length >= 3, `retried (${tab.sent.length} sends)`);
  assert.deepEqual(tab.page.gotos, [], 'the page was never blanked');
  assert.equal(tab.page.listenerCount('close'), 0);
  assert.ok(!tab.trace?.startedAt);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});

test('trace_start: busy at first, then free: the empty probe trace ends, the page is blanked and the recording starts gzipped', async () => {
  const tab = fakeTab({ 'Tracing.start': (n) => (n < 3 ? BUSY : undefined) });
  assert.match(await tools.trace_start(tab, { reload: true, auto_stop: false }), /Trace recording \(page reloaded\)\./);
  assert.deepEqual(tab.sent, ['Tracing.start', 'Tracing.start', 'Tracing.start', 'Tracing.end', 'IO.close', 'Tracing.start']);
  assert.deepEqual(tab.params[0].traceConfig, { includedCategories: ['__metadata'], excludedCategories: ['*'] });
  assert.equal(tab.params[5].streamCompression, 'gzip');
  assert.deepEqual(tab.page.gotos, ['about:blank', 'http://127.0.0.1/perf.html']);
  tab.trace.waitedMs = 3000;
  const out = await tools.trace_stop(tab);
  const file = /^File: (\S+)/m.exec(out)[1];
  assert.equal(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'), clickTrace, 'saved as Chrome wrote it');
  fs.rmSync(file);
  assert.match(out, /^Waited 3 s for another session's trace to end before recording\.$/m);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});

test('trace_start: a start failing after the page was blanked releases the slot and goes back', async () => {
  const tab = fakeTab({ 'Tracing.start': (n) => (n === 2 ? 'boom' : undefined) });
  await assert.rejects(tools.trace_start(tab, { reload: true, auto_stop: false }), /boom/);
  assert.deepEqual(tab.page.gotos, ['about:blank', 'http://127.0.0.1/perf.html']);
  assert.ok(!tab.trace?.startedAt);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});

test('trace_stop end to end: summary and file, and the close listener goes with the recording', async () => {
  const tab = fakeTab();
  assert.match(await tools.trace_start(tab, { reload: false, auto_stop: false }), /Trace recording\./);
  assert.equal(tab.page.listenerCount('close'), 1);
  const out = await tools.trace_stop(tab);
  const file = /^File: (\S+)/m.exec(out)[1];
  fs.rmSync(file);
  assert.match(out, /^INP: 231 ms /m);
  assert.deepEqual(tab.sent, ['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close']);
  assert.equal(tab.page.listenerCount('close'), 0);
  assert.equal(tab.browser.host.listenerCount('chrome.debugger.onEvent'), 0);
  assert.ok(tab.trace.last && !tab.trace.startedAt);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});

test('trace_stop: a failing Tracing.end stops waiting for tracingComplete and ends the recording', async () => {
  const tab = fakeTab({ 'Tracing.end': 'end failed' });
  await tools.trace_start(tab, { reload: false, auto_stop: false });
  await assert.rejects(tools.trace_stop(tab), /end failed/);
  assert.equal(tab.browser.host.listenerCount('chrome.debugger.onEvent'), 0);
  assert.equal(tab.page.listenerCount('close'), 0);
  assert.ok(!tab.trace.startedAt);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});

test('trace_stop: a failing IO.read still closes the stream', async () => {
  const tab = fakeTab({ 'IO.read': 'read failed' });
  await tools.trace_start(tab, { reload: false, auto_stop: false });
  await assert.rejects(tools.trace_stop(tab), /read failed/);
  assert.deepEqual(tab.sent, ['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close']);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});
