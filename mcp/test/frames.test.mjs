// Which frame navigations void a tab's iframe refs (browsers.mjs): an iframe that loads a new document, in the page's
// process or out of it (on its own session), never a same-document navigation (pushState, a hash) or a session coming
// under control, which Playwright's framenavigated reports too.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Browser, Tab } from '../src/browsers.mjs';
import { newRefState, numberRefs, playwrightRef } from '../src/snapshots.mjs';

test('iframe refs survive an iframe\'s same-document navigation and are refused once an iframe loads a new document', () => {
  const host = Object.assign(new EventEmitter(), { hello: { extension: { userAgent: 'Chrome/150.0.0.0' } }, request: async () => ({}) });
  const browser = new Browser('chrome', host);
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://shop.example/', isClosed: () => false, mainFrame: () => page,
  });
  const tab = new Tab(browser, 1, page);
  browser.tabs.set(1, tab);
  const cdpEvent = (method, params, sessionId) => host.emit('event', 'chrome.debugger.onEvent', [{ tabId: 1, sessionId }, method, params]);
  let refs;
  const snapshot = () => {
    refs = newRefState();
    numberRefs(refs, '- iframe [ref=e2]:\n  - button "Pay" [ref=f1e5]', tab.documentGeneration, { frameGeneration: tab.frameGeneration });
  };
  const valid = () => playwrightRef(refs, 'f1e5', tab.documentGeneration, tab.frameGeneration) !== null;

  snapshot();
  // An ad iframe calls history.pushState: Chrome says within the document, Playwright says framenavigated.
  cdpEvent('Page.navigatedWithinDocument', { frameId: 'ad', url: 'https://ads.example/#slot2' });
  page.emit('framenavigated', {});
  // A worker's or an out-of-process iframe's other events on their own sessions.
  cdpEvent('Runtime.consoleAPICalled', { type: 'log', args: [] }, 'worker-session');
  assert.ok(valid(), 'refs of the iframes stay valid');

  cdpEvent('Page.frameNavigated', { frame: { id: 'ad', parentId: 'main', url: 'https://ads.example/next' } });
  assert.ok(!valid(), 'an iframe in the page\'s process loaded a new document');
  snapshot();
  cdpEvent('Page.frameNavigated', { frame: { id: 'pay', parentId: 'main', url: 'https://pay.example/step2' } }, 'oopif-session');
  assert.ok(!valid(), 'an out-of-process iframe loaded a new document');
  snapshot();
  const generation = tab.documentGeneration;
  cdpEvent('Page.frameNavigated', { frame: { id: 'main', url: 'https://shop.example/next' } });
  assert.equal(tab.documentGeneration, generation + 1, 'the main frame\'s new document is the tab\'s');
  assert.ok(!valid());
});
