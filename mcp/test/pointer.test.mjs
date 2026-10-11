// Pointer actions that can't happen: the reason read from Playwright's call log, and which box a scroll by ref moves.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedState, describeCover, onRef, performed, quickly, REF_POINT_FN, SCROLL_TARGET_FN, selectOnce } from '../src/tools.mjs';

const log = (...lines) => `locator.click: Timeout 1000ms exceeded.\nCall log:\n${lines.map((l) => `\x1b[2m  - ${l}\x1b[22m`).join('\n')}`;

test('blockedState: a cover, disabled or hidden element is named from the last matching log line', () => {
  const banner = '<button id="accept">Accept all</button> from <div id="cookies" role="region">…</div> subtree';
  assert.deepEqual(blockedState(log('attempting click action', 'element is visible, enabled and stable', `${banner} intercepts pointer events`, 'retrying click action', 'waiting 20ms')),
    { kind: 'covered', by: '<button id="accept">Accept all</button> in <div id="cookies" role="region">…</div>' });
  assert.deepEqual(blockedState(log('attempting click action', '<span class="name">Express</span> intercepts pointer events')),
    { kind: 'covered', by: '<span class="name">Express</span>' });
  assert.deepEqual(blockedState(log('waiting for element to be visible, enabled and stable', 'element is not enabled', 'retrying click action')), { kind: 'disabled' });
  assert.deepEqual(blockedState(log('waiting for element to be visible, enabled and stable', '2 × element is not visible')), { kind: 'hidden' });
  assert.deepEqual(blockedState(log('element is outside of the viewport')), { kind: 'hidden' });
  // The latest state wins: covered first, then disabled.
  assert.deepEqual(blockedState(log('<div> intercepts pointer events', 'retrying click action', 'element is not enabled')), { kind: 'disabled' });
  // Not stable (animating), or no call log at all: no reason, so the action keeps its normal timeout.
  assert.equal(blockedState(log('waiting for element to be visible, enabled and stable', 'element is not stable')), null);
  assert.equal(blockedState('locator.click: Timeout 1000ms exceeded.'), null);
});

test('performed: done only with the "action done" line; performing without it is uncertain', () => {
  assert.equal(performed(log('element is visible, enabled and stable', 'performing click action', 'click action done', 'waiting for scheduled navigations to finish')), 'done');
  assert.equal(performed(log('element is visible, enabled and stable', 'performing click action')), 'started');
  assert.equal(performed(log('performing click action', '<div> intercepts pointer events', 'retrying click action', 'waiting 20ms')), null);
  assert.equal(performed(log('<div> intercepts pointer events', 'retrying click action')), null);
});

// A tab whose cursor is never shown, so pointed() only runs the action.
const tab = { tabId: 1, browser: { host: { request: async () => ({ shown: false }) } } };
const timeout = (...lines) => new Error(log(...lines));

test('quickly: a timeout while performing the input is an error and is never retried', async () => {
  let attempts = 0;
  const loc = { count: async () => 1 };
  await assert.rejects(quickly(tab, 'e5', loc, async () => { attempts++; throw timeout('performing click action'); }), /e5 started but did not finish .* may or may not have happened\. Call snapshot/);
  assert.equal(attempts, 1);
  attempts = 0;
  assert.equal(await quickly(tab, 'e5', loc, async () => { attempts++; throw timeout('performing click action', 'click action done', 'waiting for scheduled navigations to finish'); }), undefined, 'done: act() waits for the navigation');
  assert.equal(attempts, 1);
});

test('selectOnce: selectOption runs once even when it times out after dispatching; blocked states fail before it', async () => {
  const calls = [];
  const loc = (state) => ({
    count: async () => 1,
    evaluate: async () => state,
    selectOption: async (values, options) => { calls.push([values, options]); throw new Error('locator.selectOption: Timeout 10000ms exceeded.'); },
  });
  await assert.rejects(selectOnce(tab, 'e7', loc(null), ['Lisbon']), /Timeout 10000ms/);
  assert.deepEqual(calls, [[['Lisbon'], { timeout: undefined }]], 'one selectOption, with the normal timeout');
  calls.length = 0;
  await assert.rejects(selectOnce(tab, 'e7', loc('disabled'), ['Lisbon']), /e7 is disabled/);
  await assert.rejects(selectOnce(tab, 'e7', loc('hidden'), ['Lisbon']), /e7 is not visible/);
  assert.equal(calls.length, 0);
  const gone = { count: async () => 0, evaluate: async () => { throw new Error('locator.evaluate: Timeout 1000ms exceeded.'); }, selectOption: async () => calls.push(1) };
  await assert.rejects(selectOnce(tab, 'e7', gone, ['Lisbon']), /older snapshot/);
  assert.equal(calls.length, 0);
});

// A hidden checkbox or radio (state) whose label click does `onLabelClick` to it.
function hiddenInput(state, onLabelClick) {
  const clicks = [];
  const label = {
    evaluate: async () => ({ x: 12, y: 30, w: 200, h: 24, position: { x: 4, y: 12 } }), // LABEL_POINT_FN
    click: async (options) => { clicks.push(options); onLabelClick(state); },
  };
  let lookedUp = false;
  const loc = {
    count: async () => 1,
    evaluate: async () => ({ ...state }),
    evaluateHandle: async () => { lookedUp = true; return { asElement: () => label, dispose: async () => {} }; },
    elementHandle: async () => ({ dispose: async () => {} }),
  };
  const attempt = async () => { throw timeout('waiting for element to be visible, enabled and stable', 'element is not visible', 'retrying click action'); };
  return { loc, attempt, clicks, lookedUp: () => lookedUp };
}

test('label fallback: only for a plain click, and only when the label click set the state', async () => {
  const toggles = (s) => { s.checked = s.type === 'radio' ? true : !s.checked; };
  // right, middle, double or modified clicks: no fallback (want undefined), the clear error instead.
  const plainOnly = hiddenInput({ type: 'checkbox', checked: false }, toggles);
  await assert.rejects(onRef(tab, 'e3', plainOnly.loc, plainOnly.attempt, undefined, undefined), /e3 is not visible/);
  assert.equal(plainOnly.lookedUp(), false);

  const works = hiddenInput({ type: 'checkbox', checked: false }, toggles);
  assert.match(await onRef(tab, 'e3', works.loc, works.attempt, undefined, 'toggle'), /Clicked the label of e3 \(the checkbox itself is hidden under it\)/);
  assert.deepEqual(works.clicks[0].position, { x: 4, y: 12 }, "at the label's point nearest the input");

  const link = hiddenInput({ type: 'radio', checked: false }, () => {}); // a link in the label took the click
  await assert.rejects(onRef(tab, 'e4', link.loc, link.attempt, undefined, 'toggle'), /Clicked the label of e4 but the radio is still unchecked \(the label may hold a link/);

  const fill = hiddenInput({ type: 'checkbox', checked: false }, () => {});
  await assert.rejects(onRef(tab, 'e5', fill.loc, fill.attempt, undefined, true), /checkbox is still unchecked/);
  const filled = hiddenInput({ type: 'checkbox', checked: false }, toggles);
  assert.match(await onRef(tab, 'e5', filled.loc, filled.attempt, undefined, true), /Clicked the label of e5/);
});

test('describeCover: a candidate ref locator() refuses (s ref) is skipped, the cover is still named', async () => {
  const cover = { evaluate: async () => ({ tag: '<div#cookies>', name: 'Accept', text: 'Accept' }) };
  const loc = { evaluateHandle: async () => ({ asElement: () => cover, dispose: async () => {} }) };
  const coverTab = { documentGeneration: 1, snapshotBaseline: { generation: 1, text: '- button "Accept" [ref=s4]' } };
  assert.equal(await describeCover(coverTab, loc, 'fallback'), '<div#cookies> "Accept"');
});

// A tiny DOM: nodes with overflow, sizes and parents (a shadow host via getRootNode).
function node(name, { overflowY = 'visible', overflowX = 'visible', scroll = 0, scrollX = 0, parent = null, host = null } = {}) {
  return { name, style: { overflowY, overflowX }, scrollHeight: 100 + scroll, clientHeight: 100, scrollWidth: 100 + scrollX, clientWidth: 100,
    parentElement: parent, getRootNode: () => ({ host }) };
}

test('SCROLL_TARGET_FN: the element if it scrolls, else its nearest scrolling ancestor, never the page', () => {
  const body = node('body', { overflowY: 'auto', scroll: 5000 });
  globalThis.document = { body, documentElement: node('html') };
  globalThis.getComputedStyle = (n) => n.style;
  try {
    const list = node('list', { overflowY: 'auto', scroll: 35000, parent: body });
    const row = node('row', { parent: list });
    assert.equal(SCROLL_TARGET_FN(row, true)?.name, 'list');
    assert.equal(SCROLL_TARGET_FN(list, true)?.name, 'list');
    // Horizontal asks about the other axis: the list doesn't scroll sideways, so only the page is left.
    assert.equal(SCROLL_TARGET_FN(row, false), null);
    // overflow hidden with room is not a scroll box; one inside a shadow root reaches its host's box.
    const clipped = node('clipped', { overflowY: 'hidden', scroll: 500, parent: list });
    assert.equal(SCROLL_TARGET_FN(node('inner', { parent: clipped }), true)?.name, 'list');
    const host = node('host', { parent: list });
    assert.equal(SCROLL_TARGET_FN(node('shadowChild', { host }), true)?.name, 'list');
    // overflow auto whose content fits: nothing to scroll, skipped.
    const fits = node('fits', { overflowY: 'auto', parent: body });
    assert.equal(SCROLL_TARGET_FN(node('x', { parent: fits }), true), null);
  } finally {
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});

test('REF_POINT_FN: scrolls the element into view if needed and returns its box centre and size in one call', () => {
  let scrolled = 0;
  const el = { scrollIntoViewIfNeeded() { scrolled++; }, getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 40 }) };
  assert.deepEqual(REF_POINT_FN(el), { x: 60, y: 40, w: 100, h: 40 });
  assert.equal(scrolled, 1);
  assert.equal(REF_POINT_FN({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) }), null);
});
