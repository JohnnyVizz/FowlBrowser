// Popup scripts (src/popups.mjs): what the MAIN-world script decides for each kind of open (run in a vm with a
// stand-in window), how they are installed and removed over raw CDP, the page's reports, and release removing them.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import vm from 'node:vm';
import { Tab } from '../src/browsers.mjs';
import { installPopups, pageScripts, uninstallPopups } from '../src/popups.mjs';
import { registerTools } from '../src/tools.mjs';

// A window with a native-looking open/close, and an isolated world that takes every open it is handed (unless
// `take` is false). Returns the vm context plus what reached the isolated world and the native functions.
function page({ active = true, take = true, frames = [] } = {}) {
  const handed = [];
  const native = [];
  const listeners = [];
  const context = vm.createContext({
    URL,
    navigator: { userActivation: { isActive: active } },
    document: {
      baseURI: 'https://site.example/dir/page.html',
      dispatchEvent(e) { handed.push(JSON.parse(e.detail)); return !(take && e.cancelable); },
      querySelectorAll: () => frames,
      querySelector: () => null,
    },
    // Like the DOM: the same listener is added once.
    addEventListener: (type, fn, capture) => listeners.some((l) => l.fn === fn && l.capture === !!capture) || listeners.push({ type, fn, capture: !!capture }),
    removeEventListener: (type, fn, capture) => { const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture); if (i >= 0) listeners.splice(i, 1); },
    record: (...call) => native.push(call), // arrays and objects of this realm, for deepEqual
    newWindow: () => ({ closed: false }),
  });
  vm.runInContext(`
    globalThis.window = globalThis; globalThis.parent = globalThis; globalThis.top = globalThis; globalThis.name = '';
    globalThis.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
    globalThis.MouseEvent = class { constructor(init) { Object.assign(this, { button: 0 }, init); } };
    globalThis.open = function open() { record('open', ...arguments); return newWindow(); };
    globalThis.close = function close() { record('close'); };
    globalThis.nativeOpen = open; globalThis.nativeClose = close; globalThis.realToString = Function.prototype.toString;
  `, context);
  vm.runInContext(`(${pageScripts.main})('fowlbrowser-test')`, context);
  const run = (code) => vm.runInContext(code, context);
  // A trusted click on a link: the capture listener arms the bubble one, which decides.
  const clickLink = (attributes, init = {}) => {
    let prevented = false;
    const link = { localName: 'a', href: new URL(attributes.href, 'https://site.example/dir/').href, referrerPolicy: '',
      getAttribute: (n) => attributes[n] ?? null, hasAttribute: (n) => n in attributes };
    const event = run('(init) => new MouseEvent(init)')({ isTrusted: true, defaultPrevented: false, ...init });
    Object.assign(event, { composedPath: () => [link], preventDefault: () => { prevented = true; } });
    for (const { fn } of listeners.filter((l) => l.type === 'click' && l.capture)) fn(event);
    for (const { fn } of listeners.filter((l) => l.type === 'click' && !l.capture)) fn(event);
    return prevented;
  };
  return { context, run, handed, native, clickLink };
}

test('opens that need no opener go to the isolated world and the page gets null, as natively', () => {
  const p = page();
  assert.equal(p.run(`window.open('next.html', '_blank', 'noopener')`), null);
  assert.equal(p.run(`window.open('https://other.example/', 'x', 'width=300, noreferrer')`), null);
  assert.deepEqual(p.handed, [
    { type: 'open', url: 'https://site.example/dir/next.html', noreferrer: false },
    { type: 'open', url: 'https://other.example/', noreferrer: true },
  ]);
  assert.deepEqual(p.native, []);

  // Nobody took it (no isolated world in that frame): the native call runs as asked.
  const lone = page({ take: false });
  lone.run(`window.open('next.html', '_blank', 'noopener')`);
  assert.deepEqual(lone.native, [['open', 'next.html', '_blank', 'noopener']]);
});

test('window.open that may need its opener runs for real, as a tab: popup features are dropped', () => {
  const p = page();
  const w = p.run(`window.open('https://idp.example/auth', 'idp', 'popup,width=480,height=640')`);
  assert.deepEqual(w, { closed: false });
  assert.deepEqual(p.native, [['open', 'https://idp.example/auth', 'idp', '']]);
  assert.deepEqual(p.handed, []);
  // noopener=0 is not noopener.
  p.run(`window.open('a.html', '_blank', 'noopener=0,left=10')`);
  assert.deepEqual(p.native.at(-1), ['open', 'a.html', '_blank', '']);
  // The window it named now exists, so a noopener open of that name navigates it natively.
  p.run(`window.open('b.html', 'idp', 'noopener')`);
  assert.deepEqual(p.native.at(-1), ['open', 'b.html', 'idp', 'noopener']);
});

test('everything else is left to the browser untouched', () => {
  const cases = [
    `window.open('', '_blank', 'popup')`, // then document.write: needs the real window
    `window.open('about:blank', '_blank', 'popup')`,
    `window.open('javascript:void 0', '_blank', 'noopener')`,
    `window.open('next.html', '_self', 'noopener')`,
    `window.open('next.html', 'side', 'noopener')`, // an iframe of that name exists
  ];
  for (const code of cases) {
    const p = page({ frames: [{ name: 'side' }] });
    p.run(code);
    assert.equal(p.handed.length, 0, code);
    assert.equal(p.native.length, 1, code);
    assert.ok(/popup|noopener/.test(p.native[0][3]), `${code}: features kept`);
  }
  const idle = page({ active: false }); // no user activation: not the agent's click (the browser blocks it anyway)
  idle.run(`window.open('next.html', 'x', 'popup')`);
  assert.deepEqual(idle.native, [['open', 'next.html', 'x', 'popup']]);
  const modified = page(); // a real modified click already picks a background tab or a new window
  modified.run(`window.event = new MouseEvent({ metaKey: true }); window.open('next.html', 'x', 'popup')`);
  assert.deepEqual(modified.native, [['open', 'next.html', 'x', 'popup']]);
});

test('links that open a new context without an opener are replaced; the rest keep their default action', () => {
  const p = page({ frames: [{ name: 'side' }] });
  assert.equal(p.clickLink({ href: 'target.html', target: '_blank' }), true);
  assert.equal(p.clickLink({ href: 'target.html', target: 'fresh', rel: 'noreferrer' }), true);
  assert.deepEqual(p.handed, [
    { type: 'open', url: 'https://site.example/dir/target.html', noreferrer: false, referrerPolicy: '' },
    { type: 'open', url: 'https://site.example/dir/target.html', noreferrer: true, referrerPolicy: '' },
  ]);
  const kept = [
    [{ href: 'target.html', target: '_blank', rel: 'opener' }],
    [{ href: 'target.html' }],
    [{ href: 'target.html', target: 'side' }],
    [{ href: 'file.zip', target: '_blank', download: '' }],
    [{ href: 'mailto:a@b.example', target: '_blank' }],
    [{ href: 'target.html', target: '_blank' }, { metaKey: true }],
    [{ href: 'target.html', target: '_blank' }, { button: 1 }],
    [{ href: 'target.html', target: '_blank' }, { isTrusted: false }],
    [{ href: 'target.html', target: '_blank' }, { defaultPrevented: true }],
  ];
  for (const [attributes, init] of kept) assert.equal(p.clickLink(attributes, init), false, JSON.stringify([attributes, init]));
  assert.equal(p.handed.length, 2);
});

test('window.close is reported first; the wrappers look native and the off-switch restores the originals', () => {
  const p = page();
  p.run('window.close()');
  assert.deepEqual(p.handed, [{ type: 'close' }]);
  assert.deepEqual(p.native, [['close']]);
  assert.equal(p.run('window.open.name'), 'open');
  assert.equal(p.run('window.open.length'), 0);
  assert.equal(p.run('window.open.toString()'), p.run('realToString.call(nativeOpen)'));
  assert.equal(p.run('Function.prototype.toString.toString()'), p.run('realToString.call(realToString)'));

  p.run(`(${pageScripts.main})('fowlbrowser-test')`); // a second install changes nothing
  p.run(`window.open('x.html', '_blank', 'noopener')`);
  assert.equal(p.handed.length, 2);

  p.run(`window[Symbol.for('fowlbrowser.popups')].off()`);
  assert.equal(p.run('window.open === nativeOpen && window.close === nativeClose && Function.prototype.toString === realToString'), true);
  p.run(`(${pageScripts.main})('fowlbrowser-test')`); // installed again (a resumed tab): on again
  assert.equal(p.run('window.open === nativeOpen'), false);
});

function fakeTab() {
  const commands = [];
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://site.example/',
    frames: () => [{ evaluate: async (code) => commands.push(['evaluate', code]) }, { evaluate: async (code) => commands.push(['evaluate', code]) }],
  });
  let next = 1;
  const host = {
    async request(method, params) {
      if (method === 'chrome.debugger.sendCommand') {
        commands.push([params[1], params[2]]);
        return params[1] === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: String(next++) } : {};
      }
      commands.push([method, params]);
      return method === 'tabs.listAll' ? [] : { ok: true };
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), forget(id) { this.tabs.delete(id); } };
  const tab = new Tab(browser, 7, page);
  browser.tabs.set(7, tab);
  return { tab, browser, commands };
}

test('installed over raw CDP: the binding first (isolated world only), then both scripts for every new document', async () => {
  const { tab, commands } = fakeTab();
  await installPopups(tab);
  await installPopups(tab); // once per tab
  assert.deepEqual(commands.map(([m, p]) => [m, p.name ?? p.worldName ?? null, p.runImmediately ?? null, p.executionContextName ?? null]), [
    ['Runtime.addBinding', '__fowlbrowserPopup', null, 'fowlbrowser-popups'],
    ['Page.addScriptToEvaluateOnNewDocument', null, true, null],
    ['Page.addScriptToEvaluateOnNewDocument', 'fowlbrowser-popups', true, null],
  ]);

  await uninstallPopups(tab);
  await installPopups(tab); // again (a resumed tab): its reports are still heard once
  const opens = [];
  tab.on('windowopen', (url) => opens.push(url));
  tab.emit('binding', '__fowlbrowserPopup', '{"type":"open","url":"https://site.example/next"}');
  tab.emit('binding', '__fowlbrowserUserInput', '{"type":"close"}'); // someone else's binding
  tab.emit('binding', '__fowlbrowserPopup', 'not json');
  assert.deepEqual(opens, ['https://site.example/next']);
  assert.equal(tab.closedByPageAt, undefined);
  const before = Date.now();
  tab.emit('binding', '__fowlbrowserPopup', '{"type":"close"}');
  assert.ok(tab.closedByPageAt >= before);

  commands.length = 0;
  await uninstallPopups(tab);
  await uninstallPopups(tab);
  assert.deepEqual(commands.map(([m, p]) => [m, p?.identifier ?? p?.name ?? p]).sort(), [
    ['Page.removeScriptToEvaluateOnNewDocument', '3'],
    ['Page.removeScriptToEvaluateOnNewDocument', '4'],
    ['Runtime.removeBinding', '__fowlbrowserPopup'],
    ['evaluate', `window[Symbol.for('fowlbrowser.popups')]?.off()`],
    ['evaluate', `window[Symbol.for('fowlbrowser.popups')]?.off()`],
  ].sort());
});

test('an unanswered uninstall (debugger gone, page hung) never holds up the release', async () => {
  const { tab, browser } = fakeTab();
  await installPopups(tab);
  browser.host.request = (method) => (method === 'chrome.debugger.sendCommand' ? new Promise(() => {}) : Promise.resolve({ ok: true }));
  tab.page.frames = () => [{ evaluate: () => new Promise(() => {}) }];
  const started = Date.now();
  await uninstallPopups(tab);
  assert.ok(Date.now() - started < 1000);
});

test('tab_release and tab_keep take the scripts out before the tab goes back to the user', async () => {
  for (const [tool, method] of [['tab_release', 'tabs.release'], ['tab_keep', 'tabs.keep']]) {
    const { tab, browser, commands } = fakeTab();
    await installPopups(tab);
    commands.length = 0;
    const handlers = {};
    registerTools({ registerTool: (name, meta, handler) => { handlers[name] = handler; } }, { get: async () => browser });
    const result = await handlers[tool]({ tab: 'chrome:7' });
    assert.ok(!result.isError, result.content?.[0]?.text);
    const order = commands.map(([m]) => m);
    assert.ok(order.includes('Runtime.removeBinding'), `${tool}: ${order}`);
    assert.ok(order.indexOf('Runtime.removeBinding') < order.indexOf(method), `${tool}: ${order}`);
  }
});
