// Popup scripts (src/popups.mjs): what the MAIN-world script decides for each kind of open (run in a vm with a
// stand-in window), how they are installed and removed over raw CDP, the page's reports, and release removing them.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import vm from 'node:vm';

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
import { Browser, Tab } from '../src/browsers.mjs';
import { BACKGROUND_CLICK_FN, backgroundClick, backgroundClickDone, installPopups, pageScripts, uninstallPopups } from '../src/popups.mjs';
import { registerTools } from '../src/tools.mjs';

// A window with a native-looking open/close, and an isolated world that takes every open it is handed (unless
// `take` is false). Returns the vm context plus what reached the isolated world and the native functions.
function page({ active = true, take = true, frames = [] } = {}) {
  const handed = [];
  const native = [];
  const order = []; // both, in turn
  const listeners = [];
  const context = vm.createContext({
    URL,
    navigator: { userActivation: { isActive: active } },
    document: {
      baseURI: 'https://site.example/dir/page.html',
      querySelectorAll: () => frames,
      querySelector: () => null,
    },
    // What reaches the isolated world (document only); window's listeners like the DOM: the same one is added once.
    hooks: {
      dispatch: (e) => { handed.push(JSON.parse(e.detail)); order.push(`handed ${handed.at(-1).type}`); return !(take && e.cancelable); },
      listen: (type, fn, capture) => listeners.some((l) => l.type === type && l.fn === fn && l.capture === !!capture) || listeners.push({ type, fn, capture: !!capture }),
      unlisten: (type, fn, capture) => { const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture); if (i >= 0) listeners.splice(i, 1); },
    },
    record: (...call) => { native.push(call); order.push(`native ${call[0]}`); }, // arrays and objects of this realm, for deepEqual
    newWindow: () => ({ closed: false }),
    setTimeout, clearTimeout,
  });
  vm.runInContext(`
    globalThis.window = globalThis; globalThis.parent = globalThis; globalThis.top = globalThis; globalThis.name = '';
    globalThis.EventTarget = class {};
    EventTarget.prototype.dispatchEvent = function (e) { return hooks.dispatch(e); };
    EventTarget.prototype.addEventListener = function (...a) { return hooks.listen(...a); };
    EventTarget.prototype.removeEventListener = function (...a) { return hooks.unlisten(...a); };
    globalThis.addEventListener = EventTarget.prototype.addEventListener; globalThis.removeEventListener = EventTarget.prototype.removeEventListener;
    document.dispatchEvent = EventTarget.prototype.dispatchEvent;
    globalThis.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
    globalThis.Event = class { stopImmediatePropagation() { this.stopped = true; } };
    // Modifiers behind native-like accessors, as in Blink (instances have no own metaKey).
    globalThis.MouseEvent = class extends Event {
      #keys;
      constructor({ metaKey = false, ctrlKey = false, ...init } = {}) { super(); this.#keys = { metaKey, ctrlKey }; Object.assign(this, { button: 0 }, init); }
      get metaKey() { return this.#keys.metaKey; }
      get ctrlKey() { return this.#keys.ctrlKey; }
      getModifierState(key) { return key === 'Meta' ? this.#keys.metaKey : key === 'Control' ? this.#keys.ctrlKey : false; }
    };
    const accessor = (key) => Object.getOwnPropertyDescriptor(MouseEvent.prototype, key).get;
    globalThis.mouseNow = () => [accessor('metaKey'), accessor('ctrlKey'), MouseEvent.prototype.getModifierState];
    globalThis.mouseNatives = mouseNow();
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
  // A key event as the browser sends it, through the window capture listeners; true when the page would see it.
  const key = (init) => {
    const event = run('(init) => Object.assign(new Event(), init)')({ isTrusted: true, ...init });
    for (const { fn } of listeners.filter((l) => l.type === init.type && l.capture)) if (!event.stopped) fn(event);
    return !event.stopped;
  };
  return { context, run, handed, native, order, clickLink, key };
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

  // Refused (the debugger is gone, or no isolated world in that frame): the native call runs as asked, and from then
  // on the natives are back.
  const lone = page({ take: false });
  lone.run(`window.open('next.html', '_blank', 'noopener')`);
  assert.deepEqual(lone.native, [['open', 'next.html', '_blank', 'noopener']]);
  assert.equal(lone.run('window.open === nativeOpen && window.close === nativeClose && Function.prototype.toString === realToString'), true);
});

test('a refused opener-keeping open (debugger gone) runs natively with its features and switches the wrappers off', () => {
  const p = page({ take: false });
  p.run(`window.open('https://idp.example/auth', 'idp', 'popup,width=480')`);
  assert.deepEqual(p.handed, [{ type: 'live' }]);
  assert.deepEqual(p.native, [['open', 'https://idp.example/auth', 'idp', 'popup,width=480']]);
  assert.equal(p.run('window.open === nativeOpen'), true);
  assert.equal(p.clickLink({ href: 'target.html', target: '_blank' }), false, 'links are native too');
});

test('the private event goes through the dispatchEvent of document start: a page that wraps it later learns nothing', () => {
  const p = page();
  p.run(`globalThis.leaked = []; const real = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = document.dispatchEvent = function (e) { leaked.push(e.type); return real.call(this, e); };`);
  p.run(`window.open('next.html', '_blank', 'noopener')`);
  assert.equal(p.handed.length, 1);
  assert.equal(p.run('leaked.length'), 0);
});

test('window.open that may need its opener runs for real, as a tab: popup features are dropped', () => {
  const p = page();
  const w = p.run(`window.open('https://idp.example/auth', 'idp', 'popup,width=480,height=640')`);
  assert.deepEqual(w, { closed: false });
  assert.deepEqual(p.native, [['open', 'https://idp.example/auth', 'idp', '']]);
  assert.deepEqual(p.handed, [{ type: 'live' }]); // the isolated world says the debugger is still there
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

test('links that open a new context without an opener are replaced; the rest (named targets keep their opener) keep their default action', () => {
  const p = page({ frames: [{ name: 'side' }] });
  assert.equal(p.clickLink({ href: 'target.html', target: '_blank' }), true);
  assert.equal(p.clickLink({ href: 'target.html', target: 'fresh', rel: 'noreferrer' }), true);
  assert.deepEqual(p.handed, [
    { type: 'open', url: 'https://site.example/dir/target.html', noreferrer: false },
    { type: 'open', url: 'https://site.example/dir/target.html', noreferrer: true },
  ]);
  const kept = [
    [{ href: 'target.html', target: '_blank', rel: 'opener' }],
    [{ href: 'target.html' }],
    [{ href: 'target.html', target: 'side' }],
    [{ href: 'target.html', target: 'fresh' }], // a new named context: it has an opener (HTML: only _blank implies noopener)
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

test('window.close is reported once it ran; the wrappers look native and the off-switch restores the originals', () => {
  const p = page();
  p.run('window.close()');
  assert.deepEqual(p.order, ['native close', 'handed close']);
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

test('hidden-modifier window: the page reads no Cmd or Ctrl on trusted mouse events and never gets the key itself', async () => {
  const p = page();
  const read = () => JSON.parse(p.run(`JSON.stringify([true, false].map((isTrusted) => {
    const e = Object.assign(new MouseEvent({ metaKey: true, ctrlKey: true }), { isTrusted });
    return [e.metaKey, e.ctrlKey, e.getModifierState('Meta'), e.getModifierState('Control')];
  }))`));
  const meta = (type, isTrusted = true) => p.key({ type, key: 'Meta', isTrusted });
  assert.deepEqual(read(), [[true, true, true, true], [true, true, true, true]], 'closed: everything as is');
  assert.equal(meta('keydown'), true);

  assert.equal(p.run(`window[Symbol.for('fowlbrowser.popups')].hide(10000)`), true);
  assert.deepEqual(read(), [[false, false, false, false], [true, true, true, true]], 'open: trusted events only');
  assert.equal(p.run(`new MouseEvent({ metaKey: true }).getModifierState('Shift')`), false);
  assert.deepEqual([meta('keydown'), meta('keyup'), p.key({ type: 'keydown', key: 'Control' })], [false, false, false], 'the modifier key is stopped');
  assert.deepEqual([p.key({ type: 'keydown', key: 'a' }), meta('keydown', false)], [true, true], 'other keys and synthetic events pass');
  // Their own window.open still takes the opener-keeping path (the page script reads the masked event too).
  p.run(`window.event = Object.assign(new MouseEvent({ metaKey: true }), { isTrusted: true }); window.open('https://idp.example/auth', 'idp', 'popup')`);
  assert.deepEqual(p.native.at(-1), ['open', 'https://idp.example/auth', 'idp', '']);

  p.run(`window[Symbol.for('fowlbrowser.popups')].show()`);
  assert.deepEqual(read()[0], [true, true, true, true], 'closed again');
  assert.equal(meta('keydown'), true);

  // Never left open: it closes by itself after capMs (a detach mid-click), and on the off-switch.
  p.run(`window[Symbol.for('fowlbrowser.popups')].hide(20)`);
  assert.deepEqual(read()[0], [false, false, false, false]);
  await sleepMs(40);
  assert.deepEqual(read()[0], [true, true, true, true]);
  p.run(`window[Symbol.for('fowlbrowser.popups')].hide(10000)`);
  p.run(`window[Symbol.for('fowlbrowser.popups')].off()`);
  assert.deepEqual(read()[0], [true, true, true, true]);
  assert.equal(p.run(`window[Symbol.for('fowlbrowser.popups')].hide(10000)`), false, 'off: no window');
  assert.equal(meta('keydown'), true);
});

test('hidden-modifier window: the patched getters look native and the off-switch puts the originals back', () => {
  const p = page();
  p.run(`(${pageScripts.main})('fowlbrowser-test')`); // already installed: no second patch
  assert.equal(p.run('mouseNow().every((fn, i) => fn !== mouseNatives[i])'), true, 'patched while on');
  assert.equal(p.run('mouseNow().every((fn, i) => fn.toString() === realToString.call(mouseNatives[i]))'), true);
  assert.equal(p.run('mouseNow().every((fn, i) => fn.name === mouseNatives[i].name && fn.length === mouseNatives[i].length)'), true);
  assert.equal(p.run('mouseNow()[0].name'), 'get metaKey');
  p.run(`window[Symbol.for('fowlbrowser.popups')].off()`);
  assert.equal(p.run('mouseNow().every((fn, i) => fn === mouseNatives[i])'), true, 'originals back');
  p.run(`(${pageScripts.main})('fowlbrowser-test')`);
  assert.equal(p.run('mouseNow().every((fn, i) => fn !== mouseNatives[i])'), true, 'on again');
});

// BACKGROUND_CLICK_FN on stand-in elements: the decision table, and the hidden-modifier window it opens.
function probe(tree, { focused = null, control = { hide: () => true } } = {}) {
  const context = vm.createContext({});
  vm.runInContext('globalThis.window = globalThis;', context);
  const make = (spec, parent = null) => {
    const { tag, attrs = {}, type, form = null, editable = false, root = false, shadowHost = null } = spec;
    return {
      localName: tag, type, form, isContentEditable: editable, parentElement: parent,
      getRootNode: () => ({ host: root ? shadowHost : undefined }),
      hasAttribute: (n) => n in attrs, getAttribute: (n) => attrs[n] ?? null,
    };
  };
  let node = null;
  for (const spec of tree) node = make(spec, spec.root ? null : node);
  context.document = { activeElement: focused };
  if (control) context[Symbol.for('fowlbrowser.popups')] = control;
  return vm.runInContext(`(${BACKGROUND_CLICK_FN})`, context)(node, 10000);
}

test('background click probe: plain buttons and click-handler elements qualify; links, submits, fields, labels, toggles and rows do not', () => {
  const form = {};
  const yes = [
    [{ tag: 'body' }, { tag: 'button', type: 'button' }],
    [{ tag: 'body' }, { tag: 'form' }, { tag: 'button', type: 'button', form }],
    [{ tag: 'body' }, { tag: 'button', type: 'submit', form: null }], // submit outside any form submits nothing
    [{ tag: 'body' }, { tag: 'div', attrs: { role: 'button' } }, { tag: 'span' }],
    [{ tag: 'body' }, { tag: 'div' }],
    [{ tag: 'body' }, { tag: 'input', type: 'button' }],
    [{ tag: 'body' }, { tag: 'a' }, { tag: 'span' }], // an anchor without href is no link
  ];
  const no = [
    [{ tag: 'body' }, { tag: 'a', attrs: { href: '/x' } }, { tag: 'span' }],
    [{ tag: 'map' }, { tag: 'area', attrs: { href: '/x' } }],
    [{ tag: 'form' }, { tag: 'button', type: 'submit', form }, { tag: 'span' }],
    [{ tag: 'form' }, { tag: 'input', type: 'submit', form }],
    [{ tag: 'form' }, { tag: 'input', type: 'image', form }],
    [{ tag: 'body' }, { tag: 'input', type: 'text' }],
    [{ tag: 'body' }, { tag: 'input', type: 'checkbox' }],
    [{ tag: 'body' }, { tag: 'textarea' }],
    [{ tag: 'body' }, { tag: 'select' }, { tag: 'option' }],
    [{ tag: 'body' }, { tag: 'label' }, { tag: 'span' }],
    [{ tag: 'body' }, { tag: 'div', editable: true }],
    ...['checkbox', 'radio', 'switch', 'option', 'menuitemcheckbox', 'menuitemradio', 'row', 'gridcell', 'treeitem']
      .map((role) => [{ tag: 'body' }, { tag: 'div', attrs: { role: ` ${role.toUpperCase()} button` } }]),
    [{ tag: 'body' }, { tag: 'div', attrs: { role: 'row' } }, { tag: 'button', type: 'button' }],
  ];
  for (const tree of yes) assert.equal(probe(tree), true, JSON.stringify(tree));
  for (const tree of no) assert.equal(probe(tree), false, JSON.stringify(tree));

  // Across a shadow root: a button in a component inside a link is still inside the link.
  const link = { tag: 'a', attrs: { href: '/x' } };
  const host = { localName: 'x-card', parentElement: null, getRootNode: () => ({}), hasAttribute: (n) => n === 'href' && false, getAttribute: () => null };
  const inLink = { localName: 'x-card', parentElement: { localName: 'a', parentElement: null, getRootNode: () => ({}), hasAttribute: (n) => n in link.attrs, getAttribute: (n) => link.attrs[n] ?? null }, getRootNode: () => ({}), hasAttribute: () => false, getAttribute: () => null };
  assert.equal(probe([{ tag: 'button', type: 'button', root: true, shadowHost: inLink }]), false);
  assert.equal(probe([{ tag: 'button', type: 'button', root: true, shadowHost: host }]), true);

  // Focus in a frame (the modifier's key events would go there), or no page script (or switched off): no modifier.
  assert.equal(probe([{ tag: 'button', type: 'button' }], { focused: { localName: 'iframe' } }), false);
  assert.equal(probe([{ tag: 'button', type: 'button' }], { focused: { localName: 'x-app', shadowRoot: { activeElement: { localName: 'iframe' } } } }), false);
  assert.equal(probe([{ tag: 'button', type: 'button' }], { focused: { localName: 'input' } }), true);
  assert.equal(probe([{ tag: 'button', type: 'button' }], { control: null }), false);
  assert.equal(probe([{ tag: 'button', type: 'button' }], { control: { hide: () => false } }), false);
  let cap;
  probe([{ tag: 'button', type: 'button' }], { control: { hide: (ms) => { cap = ms; return true; } } });
  assert.equal(cap, 10000, 'the window is opened with the cap it was given');
});

test('background click: only in tabs with the scripts; the window is closed in the main frame afterwards', async () => {
  const { tab, commands } = fakeTab();
  const asked = [];
  const loc = { evaluate: async (fn, arg) => { asked.push(arg); return true; } };
  assert.equal(await backgroundClick(tab, loc, 15000), false, 'no scripts: never');
  assert.deepEqual(asked, []);
  await installPopups(tab);
  assert.equal(await backgroundClick(tab, loc, 15000), true);
  assert.deepEqual(asked, [15000]);
  assert.equal(await backgroundClick(tab, { evaluate: async () => { throw new Error('Timeout 300ms exceeded'); } }, 15000), false);
  commands.length = 0;
  await backgroundClickDone(tab);
  assert.deepEqual(commands, [['Runtime.evaluate', { expression: `window[Symbol.for('fowlbrowser.popups')]?.show()` }]]);
  await uninstallPopups(tab);
  assert.equal(await backgroundClick(tab, loc, 15000), false, 'given back: never');
});

// The isolated world with a stand-in DOM: `attached` says whether a new context of the world gets the binding (only
// while the debugger is attached). Returns how to send it a request as MAIN would (true when taken), the clicks it
// made on its private link, its reports, and the nodes it left in the document.
function isolatedWorld({ attached = true, active = true, closed = false } = {}) {
  const clicks = [];
  const reports = [];
  const tree = new Set();
  let listener;
  const element = (localName) => ({
    localName,
    contentWindow: localName === 'iframe' ? (attached ? { __fowlbrowserPopup() {} } : {}) : undefined,
    attachShadow: () => ({ append() {} }),
    remove() { tree.delete(this); },
    dispatchEvent(e) { clicks.push({ href: this.href, target: this.target, rel: this.rel, metaKey: e.metaKey, composed: e.composed }); return true; },
  });
  const context = vm.createContext({
    URL, JSON,
    navigator: { platform: 'MacIntel', userActivation: { isActive: active } },
    document: {
      createElement: element,
      documentElement: { append: (node) => tree.add(node) },
      addEventListener: (type, fn) => { listener = fn; },
    },
    __fowlbrowserPopup: (payload) => reports.push(JSON.parse(payload)),
    closed,
  });
  vm.runInContext('globalThis.window = globalThis; globalThis.top = globalThis;', context);
  vm.runInContext(`(${pageScripts.isolated})('fowlbrowser-test', '__fowlbrowserPopup')`, context);
  const send = (detail) => {
    let taken = false;
    listener({ detail: typeof detail === 'string' ? detail : JSON.stringify(detail), preventDefault: () => { taken = true; } });
    return taken;
  };
  return { send, clicks, reports, tree, context };
}

test('isolated world: reports what MAIN hands over (the server has the extension open it), after checking it again', () => {
  const w = isolatedWorld();
  assert.equal(w.send({ type: 'open', url: 'https://site.example/next', noreferrer: false }), true);
  assert.equal(w.send({ type: 'open', url: 'https://site.example/other', noreferrer: true }), true);
  assert.deepEqual(w.reports, [{ type: 'open', url: 'https://site.example/next', noreferrer: false }, { type: 'open', url: 'https://site.example/other', noreferrer: true }]);
  assert.deepEqual(w.clicks, [], 'nothing clicked in the page');
  assert.equal(w.tree.size, 0, 'nothing left in the document');
  assert.equal(w.send({ type: 'live' }), true);

  // Forged by a page that learned the event name: anything MAIN would never send is refused, and never reported.
  for (const forged of [{ type: 'open', url: 'javascript:alert(1)' }, { type: 'open', url: 'next.html' }, { type: 'open' }, { type: 'nope' }, 'not json']) {
    assert.equal(w.send(forged), false, JSON.stringify(forged));
  }
  const idle = isolatedWorld({ active: false });
  assert.equal(idle.send({ type: 'open', url: 'https://site.example/next' }), false, 'no user activation, no open');
  assert.equal(w.reports.length + idle.reports.length, 2);
});

test('isolated world: after a detach (no binding in a new context) it refuses everything, so MAIN switches off', () => {
  const w = isolatedWorld({ attached: false });
  assert.equal(w.send({ type: 'open', url: 'https://site.example/next' }), false);
  assert.equal(w.send({ type: 'live' }), false);
  assert.deepEqual([w.clicks, w.reports, w.tree.size], [[], [], 0]);
});

test('isolated world: a close is reported only when the window really is closing', () => {
  const open = isolatedWorld();
  open.send({ type: 'close' }); // forged: the page is not closing
  assert.deepEqual(open.reports, []);
  const closing = isolatedWorld({ closed: true });
  closing.send({ type: 'close' });
  assert.deepEqual(closing.reports, [{ type: 'close' }]);
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
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), forget(id) { this.tabs.delete(id); } };
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
  await sleepMs(0);
  assert.deepEqual(commands.filter(([m]) => m === 'tabs.openChild'), [['tabs.openChild', { tabId: 7, url: 'https://site.example/next' }]], 'the extension opens it');
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

test('a tab kept while it is being adopted never keeps popup scripts: adoption sees the keep, or keep waits and takes them out', async () => {
  for (const keepFirst of [true, false]) {
    let kept = false;
    const commands = [];
    let tabIdAsked;
    const tabIdReady = new Promise((resolve) => { tabIdAsked = resolve; });
    const host = {
      hello: { extension: { userAgent: 'Chrome/150.0.0.0' } },
      on() {},
      async request(method, params) {
        commands.push(method === 'chrome.debugger.sendCommand' ? `${params[1]} ${params[2]?.name ?? ''}`.trim() : method);
        if (method === 'tabs.listAll') return [{ id: 7, owner: 'you', origin: 'agent', kept, handedOver: kept, parked: null }];
        if (method === 'tabs.keep') { await sleepMs(20); kept = true; return { ok: true }; }
        if (method === 'tabs.isShown') return { shown: false };
        return method === 'chrome.debugger.sendCommand' && params[1] === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: '1' } : {};
      },
    };
    const browser = new Browser('chrome', host);
    const page = Object.assign(new EventEmitter(), {
      setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://site.example/', isClosed: () => false, frames: () => [],
      context: () => ({ newCDPSession: async () => ({ send: async () => { await tabIdReady; return { tabId: 7 }; }, detach: async () => {} }) }),
    });
    const handlers = {};
    registerTools({ registerTool: (name, meta, handler) => { handlers[name] = handler; } }, { get: async () => browser });
    const adopted = browser.tabFor(page);
    if (keepFirst) {
      await handlers.tab_keep({ tab: 'chrome:7' });
      tabIdAsked();
    } else {
      const keeping = handlers.tab_keep({ tab: 'chrome:7' }); // sent before the adoption knows the tab id, lands after its lookup
      await sleepMs(1);
      tabIdAsked();
      await keeping;
    }
    await adopted;
    const installed = commands.indexOf('Runtime.addBinding __fowlbrowserPopup');
    const removed = commands.indexOf('Runtime.removeBinding __fowlbrowserPopup');
    assert.ok(keepFirst ? installed === -1 : removed > installed, `keepFirst ${keepFirst}: ${commands}`);
    browser.stop();
  }
});
