// The agent cursor's server side (mcp/src/cursor/index.mjs) against a fake tab and host (no browser): a slow
// overlay never holds up a screenshot, and cue calls reach the overlay in the order they were made. The overlay's
// travel timing runs in a node vm with a stub DOM.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import * as cursor from '../src/cursor/index.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let nextTab = 1;
function fakeTab({ captureDelayMs = 0, shown = true } = {}) {
  const evaluated = []; // overlay calls, in the order the host received them
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown };
      const [, cdp, args] = params;
      if (cdp === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (cdp === 'Page.createIsolatedWorld') return { executionContextId: 5 };
      const call = args.expression.startsWith('globalThis.__fbCursor.') ? args.expression.slice('globalThis.__fbCursor.'.length) : 'overlay source';
      evaluated.push(call);
      if (call === 'capture(true)') await sleep(captureDelayMs);
      return { result: { value: true } };
    },
  };
  const tabId = nextTab++;
  return { tab: { id: `chrome:${tabId}`, tabId, documentGeneration: 0, page: new EventEmitter(), browser: { host } }, evaluated };
}

test('a slow hide does not hold up the screenshot, and the cursor is shown again after it', async () => {
  const { tab, evaluated } = fakeTab({ captureDelayMs: 3000 });
  cursor.cue(tab, 'observe');
  await sleep(20);
  const started = Date.now();
  let tookMs;
  await cursor.hideForCapture(tab, async () => { tookMs = Date.now() - started; });
  assert.ok(tookMs < 600, `capture waited ${tookMs} ms for the hide`);
  await sleep(20);
  assert.ok(evaluated.includes('capture(false)'), `never shown again: ${evaluated.join(', ')}`);
});

test('a cue and its end reach the overlay in order, after the overlay itself', async () => {
  const { tab, evaluated } = fakeTab();
  cursor.cue(tab, 'scroll');
  cursor.cueEnd(tab);
  await sleep(50);
  const calls = evaluated.map((c) => c.split('(')[0]);
  assert.deepEqual(calls, ['overlay source', 'cue', 'cueEnd']);
});

test('no overlay, nothing to hide: the capture runs at once without injecting anything', async () => {
  const { tab, evaluated } = fakeTab();
  let ran = false;
  await cursor.hideForCapture(tab, async () => { ran = true; });
  assert.ok(ran);
  assert.deepEqual(evaluated, []);
});

test('a late cue from an earlier action never puts the cursor into a running screenshot', async () => {
  const { tab, evaluated } = fakeTab();
  await cursor.hideForCapture(tab, async () => {
    cursor.cue(tab, 'observe'); // the snapshot before this screenshot learned only now that the tab is shown
    await sleep(50);
    assert.deepEqual(evaluated, [], 'cursor injected during the capture');
  });
  cursor.cue(tab, 'observe');
  await sleep(50);
  assert.deepEqual(evaluated.map((c) => c.split('(')[0]), ['overlay source', 'cue']);
});

test('prepare injects the overlay ahead of the first action only where the cursor shows, and shows nothing', async () => {
  const hidden = fakeTab({ shown: false });
  cursor.prepare(hidden.tab);
  await sleep(20);
  assert.deepEqual(hidden.evaluated, []);
  const shown = fakeTab();
  cursor.prepare(shown.tab);
  await sleep(20);
  assert.deepEqual(shown.evaluated, ['overlay source']);
});

test('moveTo hands the overlay the time left of its budget', async () => {
  const { tab, evaluated } = fakeTab();
  const started = Date.now();
  await cursor.moveTo(tab, async () => { await sleep(100); return { x: 10, y: 20 }; }, 500);
  const until = JSON.parse(/move\(10, 20, (.*)\)$/.exec(evaluated.find((c) => c.startsWith('move(')))[1]).until;
  assert.ok(until > started + 380 && until <= started + 500, `until ${until - started} ms after the start`);
});

test('after the move the cursor is landed on the target before the action', async () => {
  const { tab, evaluated } = fakeTab();
  await cursor.moveTo(tab, { x: 10, y: 20 }, 500);
  assert.deepEqual(evaluated.slice(1).map((c) => c.split('(')[0]), ['move', 'land']);
  assert.match(evaluated[2], /^land\(10, 20,/);
});

test('a target found after the budget is shown at once while the action runs, never after it', async () => {
  const { tab, evaluated } = fakeTab();
  let finish;
  const acting = new Promise((resolve) => { finish = resolve; });
  const lates = [];
  const sent = await cursor.moveTo(tab, async () => { await sleep(150); return { x: 30, y: 40 }; }, 50, { acting, onLate: (p) => lates.push(p) });
  assert.equal(sent, null);
  await sleep(150);
  finish();
  assert.deepEqual(evaluated.slice(1).map((c) => c.split('(')[0]), ['land']);
  assert.match(evaluated[1], /^land\(30, 40,/);
  assert.deepEqual(lates, [{ x: 30, y: 40 }]);

  const after = fakeTab();
  const done = Promise.resolve();
  await cursor.moveTo(after.tab, async () => { await sleep(150); return { x: 30, y: 40 }; }, 50, { acting: done });
  await sleep(150);
  assert.deepEqual(after.evaluated, ['overlay source']);
});

// The overlay in a vm: every DOM call answers with a stub (callable, every property another stub).
// opacity: what getComputedStyle reports (the appear fade not yet run on a busy page: '0').
// The returned overlay carries the test's handles: reads (layout reads of the viewport and top-layer queries so far)
// and setReduced(on) (the reduced motion preference changing).
function overlay({ opacity = '1' } = {}) {
  const stub = new Proxy(function () {}, {
    get: (_, key) => (key === Symbol.toPrimitive ? () => 0 : key === 'then' ? undefined : key === Symbol.iterator ? [][Symbol.iterator]
      : key === 'finished' ? Promise.resolve() : stub),
    apply: () => stub,
    construct: () => stub,
  });
  const reads = { layout: 0, topLayer: 0 };
  const html = { get clientWidth() { reads.layout++; return 1000; }, clientHeight: 800, appendChild() {}, querySelector: () => null };
  const document = new Proxy({ hidden: false, compatMode: 'CSS1Compat', documentElement: html, querySelectorAll: () => [],
    querySelector: () => { reads.topLayer++; return null; } }, { get: (t, k) => (k in t ? t[k] : stub) });
  const later = (fn, ms) => setTimeout(fn, ms).unref(); // the idle timer must not keep the test running
  const media = { matches: false, addEventListener: (_, fn) => { media.onchange = fn; } };
  const context = vm.createContext({
    document, innerWidth: 1000, innerHeight: 800, matchMedia: () => media,
    requestAnimationFrame: (fn) => later(() => fn(performance.now()), 16), cancelAnimationFrame: clearTimeout,
    setTimeout: later, clearTimeout, performance, Date, Math, Number, Object, Promise, JSON,
    MutationObserver: function () { return stub; }, CSSStyleSheet: function () { return stub; },
    getComputedStyle: () => ({ opacity, transform: 'none' }), addEventListener() {},
  });
  vm.runInContext(fs.readFileSync(new URL('../src/cursor/overlay.js', import.meta.url), 'utf8'), context);
  return { ...context.__fbCursor, reads, setReduced: (on) => media.onchange({ matches: on }) };
}

test('a travel longer than the time left is made quicker, and still arrives', async () => {
  const fresh = overlay(); // from its rest point (580, 440): Fitts plans about 640 ms for this move
  let started = Date.now();
  assert.equal(await fresh.move(100, 100, { w: 24, h: 24, until: Date.now() + 300 }), true);
  const quick = Date.now() - started;
  assert.ok(quick >= 200 && quick <= 330, `arrived after ${quick} ms`);
  const unhurried = overlay();
  started = Date.now();
  await unhurried.move(100, 100, { w: 24, h: 24 });
  assert.ok(Date.now() - started > 450, `unhurried travel took ${Date.now() - started} ms`);
});

test('too little time left for a visible travel: the cursor appears at the target', async () => {
  const c = overlay();
  const started = Date.now();
  assert.equal(await c.move(100, 100, { until: Date.now() + 80 }), true);
  assert.ok(Date.now() - started < 30);
  const { x, y } = c.state();
  assert.deepEqual({ x, y }, { x: 100, y: 100 });
});

test('land leaves a cursor already on the target and fully shown alone', async () => {
  const c = overlay();
  await c.move(100, 100, { until: Date.now() + 80 });
  assert.equal(c.land(101, 101), false);
  assert.deepEqual({ x: c.state().x, y: c.state().y }, { x: 100, y: 100 });
});

test('land cuts a running travel short and puts the tip on the target', async () => {
  const c = overlay();
  const arrived = c.move(100, 100, { w: 24, h: 24 }); // about 640 ms from the rest point
  await sleep(100);
  assert.notDeepEqual({ x: c.state().x, y: c.state().y }, { x: 100, y: 100 });
  assert.equal(c.land(100, 100), true);
  assert.deepEqual({ x: c.state().x, y: c.state().y }, { x: 100, y: 100 });
  assert.equal(await arrived, true);
});

test('land shows a cursor on the target whose appear fade has not run', async () => {
  const c = overlay({ opacity: '0' });
  await c.move(100, 100, { until: Date.now() + 80 });
  assert.equal(c.land(100, 100), true);
});

test('a short hop is quick, a long move keeps its pace', async () => {
  const c = overlay();
  await c.move(100, 100, { until: Date.now() + 80 }); // appears there
  let started = Date.now();
  await c.move(130, 100, { w: 24, h: 24 });
  const hop = Date.now() - started;
  assert.ok(hop >= 120 && hop <= 200, `a 30 px hop took ${hop} ms`);
  started = Date.now();
  await c.move(700, 500, { w: 24, h: 24 });
  assert.ok(Date.now() - started > 500, `a 700 px move took ${Date.now() - started} ms`);
});

test('a travel reads the viewport size once, not every frame, and looks for the top layer once', async () => {
  const c = overlay();
  c.cue('observe');
  assert.equal(c.reads.topLayer, 0, 'a cue looked for dialogs above the cursor');
  const before = c.reads.layout;
  await c.move(100, 100, { w: 24, h: 24 });
  assert.ok(c.reads.layout - before <= 1, `${c.reads.layout - before} layout reads during one travel`);
  assert.equal(c.reads.topLayer, 1);
});

test('reduced motion turned on mid-travel puts the tip on the target at once', async () => {
  const c = overlay();
  const arrived = c.move(100, 100, { w: 24, h: 24 });
  await sleep(100);
  c.setReduced(true);
  assert.deepEqual({ x: c.state().x, y: c.state().y }, { x: 100, y: 100 });
  assert.equal(await arrived, true);
});
