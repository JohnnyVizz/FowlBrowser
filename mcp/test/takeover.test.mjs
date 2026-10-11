// Takeover and handoff (src/takeover.mjs and the tools around it) against doubles: the classifiers as pure functions,
// the signals a browser sends, the notices agents get, tab_handoff, tab_claim with resume, tab_list and turn end.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { Activity, agentActed, inputHow, markEnding, navigationHow, USER_BINDING, watchTakeovers, watchUserInput } from '../src/takeover.mjs';
import { registerTools } from '../src/tools.mjs';
import { endTurn } from '../src/turns.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = (at) => new Date(at).toTimeString().slice(0, 5);

function fakePage(url = 'https://shop.example/checkout') {
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => url, isClosed: () => false,
    mainFrame: () => page, ariaSnapshot: async () => '- button "Pay now" [ref=e1]',
  });
  return page;
}

let browsers = 0;
// A browser (its own key per test: takeover state is per "<browser>:<id>") with mapped tabs `ids`, whose extension
// answers isShown with `seen` and tabs.listAll with `listed`.
async function fakeBrowser({ ids = [1], seen = { shown: true, focused: true }, listed = () => [] } = {}) {
  const requests = [];
  const host = Object.assign(new EventEmitter(), {
    async request(method, params) {
      requests.push([method, params]);
      if (method === 'tabs.isShown') return seen;
      if (method === 'tabs.listAll') return listed();
      if (method === 'tabs.claim') return { id: params.tabId };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'Checkout' } };
      if (method === 'chrome.debugger.sendCommand' && params[1] !== 'Runtime.addBinding' && params[1] !== 'Page.addScriptToEvaluateOnNewDocument'
        && params[1] !== 'Emulation.clearDeviceMetricsOverride') throw new Error('not in this double');
      return {};
    },
  });
  const known = new Set(ids);
  const browser = {
    key: `chrome-t${++browsers}`, name: 'Chrome', host, tabs: new Map(), requests,
    relay: { viewports: new Map(), model: { hasTab: (id) => known.has(id), isAttached: () => true, onTabCreated() {} } },
    async playwright() {}, async waitForTab(id) { return this.tabs.get(id); }, forget(id) { known.delete(id); this.tabs.delete(id); },
  };
  watchTakeovers(browser);
  for (const id of ids) {
    const tab = new Tab(browser, id, fakePage());
    browser.tabs.set(id, tab);
    await watchUserInput(tab);
  }
  return browser;
}

function toolsFor(browser) {
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const call = async (name, args) => {
    const result = await tools[name](args);
    return { error: !!result.isError, text: result.content.map((c) => c.text).join('\n') };
  };
  return call;
}

const parks = (browser) => browser.requests.filter(([m]) => m === 'tabs.park').map(([, p]) => p);
const report = (tab, type, at, what = '') => tab.emit('binding', USER_BINDING, JSON.stringify({ type, at, what }));

test('agent windows: a call on the tab or relayed input covers [start - 50, end + 250] ms', async () => {
  const activity = new Activity();
  const done = activity.begin();
  const start = Date.now();
  assert.ok(activity.covers(start - 40) && activity.covers(start + 60_000), 'while it runs');
  assert.ok(!activity.covers(start - 80));
  await sleep(20);
  done();
  const end = activity.windows[0][1];
  assert.ok(activity.covers(end + 240) && !activity.covers(end + 270));
  assert.ok(activity.covers(end + 1700, 1750), 'navigation margin');

  const browser = await fakeBrowser({ ids: [4] });
  const input = browser.relay.onInput(4);
  assert.ok(agentActed(browser, 4, Date.now()));
  input();
  assert.ok(!agentActed(browser, 4, Date.now() + 400));
  assert.ok(!agentActed(browser, 5, Date.now()), 'other tabs are not covered');
});

test('what the user did, in words', () => {
  assert.equal(inputHow({ type: 'pointerdown', what: 'Add to cart' }), 'clicked "Add to cart"');
  assert.equal(inputHow({ type: 'pointerdown', what: '' }), 'clicked in the page');
  assert.equal(inputHow({ type: 'keydown', what: 'Search' }), 'typed in "Search"');
  assert.equal(inputHow({ type: 'beforeinput', what: 'Search' }), 'typed in "Search"');
  assert.equal(inputHow({ type: 'wheel' }), 'scrolled the page');
  assert.equal(inputHow({ type: 'frame' }), 'clicked inside a frame');
  assert.equal(inputHow({ type: 'navigate' }), null);
});

test('navigation rules: address bar and bookmarks always; reload and back/forward only outside agent windows, when the page did not ask', () => {
  const free = { agentActed: false, selfNavigated: false, focused: true };
  const how = (type, qualifiers, context = {}) => navigationHow({ transitionType: type, transitionQualifiers: qualifiers }, { ...free, ...context });
  assert.equal(how('typed', ['from_address_bar'], { agentActed: true }), 'typed an address in the address bar');
  assert.equal(how('generated', ['from_address_bar']), 'typed an address in the address bar');
  assert.equal(how('keyword', []), 'typed an address in the address bar');
  assert.equal(how('auto_bookmark', []), 'opened a bookmark');
  assert.equal(how('typed', []), null, 'the agent\'s Page.navigate');
  assert.equal(how('link', []), null);
  assert.equal(how('link', ['client_redirect']), null, 'location.reload() by the page');
  assert.equal(how('reload', []), 'reloaded the page');
  assert.equal(how('reload', [], { agentActed: true }), null);
  assert.equal(how('reload', [], { selfNavigated: true }), null);
  assert.equal(how('typed', ['forward_back'], { direction: 'went back' }), 'went back');
  assert.equal(how('typed', ['forward_back']), 'went back or forward');
  assert.equal(how('typed', ['forward_back'], { focused: false }), null, 'the Back button needs the window');
  assert.equal(how('typed', ['forward_back'], { selfNavigated: true }), null, 'history.back() by the page');
  assert.equal(how('typed', ['forward_back'], { agentActed: true }), null);
});

test('input in the page is the user\'s only outside agent windows, in the shown tab of the focused window', async () => {
  const browser = await fakeBrowser({ ids: [1] });
  const tab = browser.tabs.get(1);
  let finish;
  const running = tab.run(() => new Promise((resolve) => { finish = resolve; }));
  report(tab, 'pointerdown', Date.now(), 'Pay now');
  await sleep(10);
  assert.deepEqual(parks(browser), [], 'during a call');
  finish();
  await running;
  report(tab, 'pointerdown', Date.now() + 100, 'Pay now');
  await sleep(10);
  assert.deepEqual(parks(browser), [], 'right after it');

  const unfocused = await fakeBrowser({ ids: [1], seen: { shown: true, focused: false } });
  report(unfocused.tabs.get(1), 'keydown', Date.now() - 5000, 'Search');
  await sleep(10);
  assert.deepEqual(parks(unfocused), [], 'window not focused');

  report(tab, 'keydown', Date.now() + 1000, 'Search');
  await sleep(10);
  assert.deepEqual(parks(browser), [{ tabId: 1, kind: 'takeover' }]);
  const call = toolsFor(browser);
  const result = await call('console', { tab: `${browser.key}:1` });
  assert.equal(result.error, true);
  assert.match(result.text, new RegExp(`The user took over ${browser.key}:1 at \\d\\d:\\d\\d \\(typed in "Search"\\)\\. Stop working in that tab, tell the user where you got to, and ask before going on\\. If they say to carry on there, call tab_claim on it with resume: true\\.`));
});

test('notices: once at the start of the next result of any other tool, and on every call of the taken-over tab', async () => {
  const browser = await fakeBrowser({ ids: [1, 2] });
  const call = toolsFor(browser);
  browser.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 1 }, 'canceled_by_user']);
  await sleep(10);
  assert.deepEqual(parks(browser), [{ tabId: 1, kind: 'takeover' }]);
  const notice = `The user took over ${browser.key}:1 at ${clock(Date.now())} (pressed Cancel on the browser's debugging bar).`;
  assert.equal((await call('console', { tab: `${browser.key}:1` })).error, true, 'a call on the tab itself first');
  const other = await call('console', { tab: `${browser.key}:2` });
  assert.equal(other.error, false);
  assert.ok(other.text.startsWith(notice), other.text);
  assert.ok(!(await call('console', { tab: `${browser.key}:2` })).text.includes('took over'), 'only once');
  for (let i = 0; i < 2; i++) {
    const again = await call('console', { tab: `${browser.key}:1` });
    assert.equal(again.error, true);
    assert.equal(again.text.split('took over').length, 2, 'the notice once per result');
  }
  // The parked tab's own detach and events change nothing.
  browser.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 1 }, 'parked']);
  browser.host.emit('event', 'tabs.committed', { tabId: 1, url: 'https://x.example/', transitionType: 'typed', transitionQualifiers: ['from_address_bar'] });
  await sleep(10);
  assert.equal(parks(browser).length, 1);
});

test('a call running on the tab when the user takes it over returns the notice instead of its result', async () => {
  const browser = await fakeBrowser({ ids: [3] });
  const tab = browser.tabs.get(3);
  const call = toolsFor(browser);
  let finish;
  const blocker = tab.run(() => new Promise((resolve) => { finish = resolve; }));
  const running = call('console', { tab: `${browser.key}:3` });
  await sleep(10);
  browser.host.emit('event', 'tabs.committed', { tabId: 3, url: 'https://elsewhere.example/', transitionType: 'typed', transitionQualifiers: ['from_address_bar'] });
  await sleep(10);
  finish();
  await blocker;
  const result = await running;
  assert.equal(result.error, true);
  assert.match(result.text, /took over .*:3 at .* \(typed an address in the address bar\)/);
});

test('detaches: Cancel and a browser page are takeovers; a crash and a closing tab are not', async () => {
  let listed = [];
  const browser = await fakeBrowser({ ids: [1, 2, 3], listed: () => listed });
  browser.host.emit('event', 'chrome.debugger.onEvent', [{ tabId: 1 }, 'Inspector.targetCrashed', {}]);
  browser.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 1 }, 'target_closed']);
  listed = [{ id: 1, owner: 'you', url: 'https://shop.example/' }, { id: 2, owner: 'you', url: 'chrome://settings/' }];
  browser.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 2 }, 'target_closed']);
  browser.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 3 }, 'target_closed']); // closing: not listed
  await sleep(400);
  assert.deepEqual(parks(browser), [{ tabId: 2, kind: 'takeover' }]);
  const text = (await toolsFor(browser)('console', { tab: `${browser.key}:2` })).text;
  assert.match(text, /\(opened a browser page \(chrome:\/\/settings\/\)\)/);
});

test('closing: the user closing a tab is a takeover with no resume; our own closes, the page closing itself and swaps are not', async () => {
  const browser = await fakeBrowser({ ids: [1, 2, 3, 4] });
  const removed = (tabId, info = {}) => browser.host.emit('event', 'chrome.tabs.onRemoved', [tabId, { windowId: 1, isWindowClosing: false, ...info }]);
  markEnding(`${browser.key}:2`);
  browser.tabs.get(3).closedByPageAt = Date.now();
  removed(1);
  removed(2);
  removed(3);
  removed(4, { replacedBy: 9 });
  removed(77); // never ours
  await sleep(10);
  assert.deepEqual(parks(browser), [], 'a closed tab is not parked');
  const call = toolsFor(browser);
  const text = (await call('console', { tab: `${browser.key}:1` })).text;
  assert.match(text, /The user took over .*:1 at .* \(closed the tab\)\. Stop working in that tab, tell the user where you got to, and ask before going on\.$/);
  assert.match((await call('tab_claim', { tab: `${browser.key}:1`, resume: true })).text, /closed the tab/);
  for (const id of [2, 3, 4]) assert.ok(!(await call('console', { tab: `${browser.key}:${id}` })).text.includes(`took over ${browser.key}:${id} `));
});

test('user navigation: the address bar at once; back only when the page did not go back itself', async () => {
  const browser = await fakeBrowser({ ids: [1, 2] });
  const commit = (tabId, url, transitionType, transitionQualifiers = []) => browser.host.emit('event', 'tabs.committed', { tabId, url, transitionType, transitionQualifiers });
  commit(1, 'https://a.example/', 'typed');
  commit(1, 'https://b.example/', 'link');
  commit(2, 'https://a.example/', 'typed');
  commit(2, 'https://b.example/', 'link');
  await sleep(10);
  // The page's own history.back(): its navigate event comes in, then the commit.
  report(browser.tabs.get(1), 'navigate', Date.now());
  commit(1, 'https://a.example/', 'typed', ['forward_back']);
  commit(2, 'https://a.example/', 'typed', ['forward_back']);
  await sleep(400);
  assert.deepEqual(parks(browser), [{ tabId: 2, kind: 'takeover' }]);
  assert.match((await toolsFor(browser)('console', { tab: `${browser.key}:2` })).text, /\(went back\)/);
});

test('tab_handoff parks the tab and returns the line for the user; calls on it get the handoff notice; resume brings it back', async () => {
  const browser = await fakeBrowser({ ids: [1] });
  const call = toolsFor(browser);
  const id = `${browser.key}:1`;
  browser.tabs.get(1).viewport = { width: 390, height: 844, mobile: false }; // a phone-size override the user must not inherit
  const handed = await call('tab_handoff', { tab: id, reason: 'enter the card details' });
  assert.equal(handed.error, false);
  assert.match(handed.text, /Your turn in Chrome tab "Checkout": enter the card details, then tell me\./);
  assert.match(handed.text, /tab_claim on it with resume: true/);
  assert.deepEqual(parks(browser), [{ tabId: 1, kind: 'handoff' }]);
  assert.ok(browser.requests.some(([m, p]) => m === 'chrome.debugger.sendCommand' && p[1] === 'Emulation.clearDeviceMetricsOverride'));
  assert.ok(!browser.requests.some(([m]) => m === 'tabs.focus'), 'never focused');

  const blocked = await call('console', { tab: id });
  assert.equal(blocked.error, true);
  assert.match(blocked.text, new RegExp(`You handed ${id} to the user at \\d\\d:\\d\\d \\(enter the card details\\); wait until they say they are done, then tab_claim it with resume: true\\.`));
  assert.equal((await call('tab_claim', { tab: id })).error, true, 'a plain claim is refused');
  assert.ok(!browser.requests.some(([m]) => m === 'tabs.claim'));

  const resumed = await call('tab_claim', { tab: id, resume: true, snapshot: false });
  assert.equal(resumed.error, false, resumed.text);
  assert.match(resumed.text, /Resumed .*: you control it again/);
  assert.match(resumed.text, /Pay now/, 'a fresh snapshot even with snapshot: false');
  assert.equal((await call('console', { tab: id })).error, false);
});

test('tab_list says in words which tabs are parked', async () => {
  const browser = await fakeBrowser({ ids: [], listed: () => [
    { id: 1, url: 'https://shop.example/', title: 'Shop', owner: 'you', origin: 'agent', parked: 'handoff' },
    { id: 2, url: 'https://mail.example/', title: 'Mail', owner: 'you', origin: 'user', parked: 'takeover' },
    { id: 3, url: 'https://news.example/', title: 'News', owner: 'you', origin: 'agent', parked: null },
  ] });
  const { text } = await toolsFor(browser)('tab_list', { scope: 'mine' });
  assert.match(text, /:1 · Shop · https:\/\/shop\.example\/ · owner: you \(agent tab; handed to the user\)/);
  assert.match(text, /:2 · Mail · https:\/\/mail\.example\/ · owner: you \(claimed from the user; taken over by the user\)/);
  assert.match(text, /:3 · News · https:\/\/news\.example\/ · owner: you \(agent tab\)$/m);
});

test('turn end leaves parked tabs alone', async () => {
  const browser = await fakeBrowser({ ids: [1], listed: () => [{ id: 1, owner: 'you', origin: 'agent', kept: true, handedOver: true, parked: 'handoff' }] });
  const result = await endTurn({ browsers: new Map([[browser.key, browser]]) });
  assert.deepEqual(result, { closed: [], released: [], skipped: [`${browser.key}:1`] });
  assert.ok(!browser.requests.some(([m]) => m === 'tabs.release' || m === 'chrome.tabs.remove'));
});
