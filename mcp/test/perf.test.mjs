// perf.mjs helpers: the process-wide tracing slot (traces and Lighthouse runs take turns).
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import { test } from 'node:test';
import { readStream, startTracing, tracingSlot, waitForTracing } from '../src/perf.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('tracingSlot: the second holder waits for the first release, the third for the second', async () => {
  const order = [];
  const first = await tracingSlot();
  const second = tracingSlot().then((release) => { order.push('second'); return release; });
  const third = tracingSlot().then((release) => { order.push('third'); return release; });
  await tick();
  assert.deepEqual(order, []);
  first();
  const releaseSecond = await second;
  await tick();
  assert.deepEqual(order, ['second']);
  releaseSecond();
  (await third)();
  assert.deepEqual(order, ['second', 'third']);
});

test('tracingSlot: releasing twice is harmless and a free slot resolves at once', async () => {
  const release = await tracingSlot();
  release();
  release();
  let got = false;
  const next = await tracingSlot().then((r) => { got = true; return r; });
  assert.ok(got);
  next();
});

// --- Another session's trace: waiting for the browser's tracing to be free ---

const BUSY = 'Tracing has already been started (possibly in another tab).';

test('startTracing: a busy browser is retried until the start goes through, and says how long it waited', async () => {
  let calls = 0;
  const { result, waitedMs } = await startTracing(async () => { if (++calls < 3) throw new Error(BUSY); return 'ok'; }, { waitMs: 500, retryMs: 10 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.ok(waitedMs >= 15 && waitedMs < 500, `waited ${waitedMs} ms`);
});

test('startTracing: still busy at the end of the wait throws the last error; any other error throws at once', async () => {
  let calls = 0;
  await assert.rejects(startTracing(async () => { calls++; throw new Error(BUSY); }, { waitMs: 50, retryMs: 10 }), /already been started/);
  assert.ok(calls >= 2 && calls <= 7, `retried ${calls} times`);
  calls = 0;
  await assert.rejects(startTracing(async () => { calls++; throw new Error('Not allowed'); }, { waitMs: 50, retryMs: 10 }), /Not allowed/);
  assert.equal(calls, 1);
});

test('waitForTracing: an empty trace is started (retried while busy) and ended at once, its stream closed', async () => {
  const host = new EventEmitter();
  const sent = [];
  let starts = 0;
  host.request = async (name, [, command, params]) => {
    sent.push([command, params]);
    if (command === 'Tracing.start' && ++starts < 3) throw new Error(BUSY);
    if (command === 'Tracing.end') setImmediate(() => host.emit('chrome.debugger.onEvent', [{ tabId: 3 }, 'Tracing.tracingComplete', { stream: 's3' }]));
    return {};
  };
  const waited = await waitForTracing({ tabId: 3, id: 'chrome:3', browser: { host } }, { waitMs: 500, retryMs: 5 });
  assert.ok(waited >= 5 && waited < 500, `waited ${waited} ms`);
  assert.deepEqual(sent.map(([c]) => c), ['Tracing.start', 'Tracing.start', 'Tracing.start', 'Tracing.end', 'IO.close']);
  assert.deepEqual(sent[0][1], { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: ['__metadata'], excludedCategories: ['*'] } });
  assert.deepEqual(sent[4][1], { handle: 's3' });
  assert.equal(host.listenerCount('chrome.debugger.onEvent'), 0);
});

test('waitForTracing: a failing Tracing.end stops the wait for tracingComplete', async () => {
  const host = new EventEmitter();
  host.request = async (name, [, command]) => { if (command === 'Tracing.end') throw new Error('end failed'); return {}; };
  assert.equal(await waitForTracing({ tabId: 3, id: 'chrome:3', browser: { host } }, { waitMs: 100, retryMs: 5 }), 0);
  assert.equal(host.listenerCount('chrome.debugger.onEvent'), 0);
});

test('readStream: chunks are joined (base64 decoded) and the stream closed, also when a read fails', async () => {
  const reads = [{ data: Buffer.from('ab').toString('base64'), base64Encoded: true, eof: false }, { data: 'cd', base64Encoded: false, eof: true }];
  const sent = [];
  assert.equal((await readStream(async (method) => { sent.push(method); return method === 'IO.read' ? reads.shift() : {}; }, 'h')).toString(), 'abcd');
  assert.deepEqual(sent, ['IO.read', 'IO.read', 'IO.close']);
  sent.length = 0;
  await assert.rejects(readStream(async (method) => { sent.push(method); if (method === 'IO.read') throw new Error('gone'); return {}; }, 'h'), /gone/);
  assert.deepEqual(sent, ['IO.read', 'IO.close']);
});
