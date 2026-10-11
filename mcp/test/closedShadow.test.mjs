// s refs of closed shadow roots, against a fake tab answering the CDP calls closedShadow.mjs makes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closedShadowSection, focusShadowRef, shadowRefPoint } from '../src/closedShadow.mjs';

// A claimed-tab fake: one closed root on host 10 whose controls are `controls` (backendNodeIds, each a button).
function fakeTab() {
  const tab = { documentGeneration: 0, controls: [], focused: [], page: { url: () => 'https://example.test/' } };
  const answers = {
    'Runtime.evaluate': () => ({ result: { value: 1 } }),
    'DOM.getDocument': () => ({
      root: { backendNodeId: 1, children: [{ backendNodeId: 10, shadowRoots: [{ backendNodeId: 11, shadowRootType: 'closed', children: tab.controls.map((id) => ({ backendNodeId: id })) }] }] },
    }),
    'Accessibility.queryAXTree': () => ({ nodes: tab.controls.map((id) => ({ backendDOMNodeId: id, role: { value: 'button' }, name: { value: `b${id}` } })) }),
    'DOM.focus': (params) => { tab.focused.push(params.backendNodeId); return {}; },
  };
  tab.browser = { host: { request: async (_, [, method, params]) => answers[method]?.(params) ?? {} } };
  return tab;
}

const refsOf = (section) => [...section.matchAll(/"b(\d+)" \[ref=(s\d+)\]/g)].map(([, id, ref]) => `${ref}=${id}`);

test('closed shadow s refs: stable within a document, never reused across documents', async () => {
  const tab = fakeTab();
  tab.controls = [101, 102];
  assert.deepEqual(refsOf(await closedShadowSection(tab)), ['s1=101', 's2=102']);
  // Same document, a control added before the others: existing ones keep their numbers.
  tab.controls = [103, 101, 102];
  assert.deepEqual(refsOf(await closedShadowSection(tab)), ['s3=103', 's1=101', 's2=102']);
  await focusShadowRef(tab, 's1');
  assert.deepEqual(tab.focused, [101]);

  // New document: old refs are refused before and after its scan; its controls get new numbers.
  tab.documentGeneration = 1;
  tab.controls = [201, 101]; // even a backendNodeId seen on the old document gets a new number
  await assert.rejects(focusShadowRef(tab, 's1'), /from an earlier page/);
  assert.deepEqual(refsOf(await closedShadowSection(tab)), ['s4=201', 's5=101']);
  await assert.rejects(focusShadowRef(tab, 's1'), /from an earlier page/);
  await assert.rejects(focusShadowRef(tab, 's3'), /from an earlier page/);
  await focusShadowRef(tab, 's4');
  assert.deepEqual(tab.focused, [101, 201]);
  await assert.rejects(focusShadowRef(tab, 's9'), /unknown, stale/);

  // A document without closed roots still leaves the old numbers refused.
  tab.documentGeneration = 2;
  tab.controls = [];
  assert.equal(await closedShadowSection(tab), '');
  await assert.rejects(focusShadowRef(tab, 's4'), /from an earlier page/);
});

// The cover check before an s ref click: the page scrolled by 1000 px, the control's box at (100, 50) in the viewport.
function hitTab(hitAt) {
  const tab = fakeTab();
  tab.controls = [101];
  const answers = {
    'Page.getLayoutMetrics': () => ({ cssLayoutViewport: { pageX: 0, pageY: 1000 } }),
    'DOM.getBoxModel': () => ({ model: { border: [90, 40, 110, 40, 110, 60, 90, 60] } }),
    // Document coordinates: only the scrolled point finds the node.
    'DOM.getNodeForLocation': ({ x, y }) => (x === 100 && y === 1050 ? { backendNodeId: hitAt } : {}),
    // The button's own ::after knob is a pseudo-element of it; 900 is something else.
    'DOM.describeNode': ({ backendNodeId }) => ({ node: backendNodeId === 101
      ? { backendNodeId: 101, pseudoElements: [{ backendNodeId: 1011, nodeName: '::after' }] }
      : { backendNodeId, localName: 'div', nodeName: 'DIV', attributes: ['id', 'banner'] } }),
  };
  const request = tab.browser.host.request;
  tab.browser.host.request = async (name, [target, method, params]) => (answers[method] ? answers[method](params) : request(name, [target, method, params]));
  return tab;
}

test('closed shadow click: hit test in document coordinates, the control\'s own pseudo-element is no cover', async () => {
  const knob = hitTab(1011);
  await closedShadowSection(knob);
  assert.deepEqual(await shadowRefPoint(knob, 's1'), { x: 100, y: 50 });

  const covered = hitTab(900);
  await closedShadowSection(covered);
  await assert.rejects(shadowRefPoint(covered, 's1'), /covered at its centre \(100, 50\) by <div#banner>/);
});
