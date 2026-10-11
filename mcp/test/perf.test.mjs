// perf.mjs helpers: the process-wide tracing slot (traces and Lighthouse runs take turns).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tracingSlot } from '../src/perf.mjs';

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
