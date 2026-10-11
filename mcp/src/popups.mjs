// Popups from agent tabs open without taking the user's eyes or focus (SPEC "Popups (session 5)").
// Two page scripts, in every same-process frame of an agent tab and every new document, before page scripts:
// - MAIN world: decides. Opens that need no opener (target=_blank links without rel=opener, links to a name no frame
//   or window has, window.open with noopener/noreferrer) are handed to the isolated world, which replays them as a
//   Cmd-click (Ctrl elsewhere) on a private link; Blink opens an isolated-world modified click as a background tab
//   (NEW_BACKGROUND_TAB: never activated, no window shown). Every other window.open still runs for real (the opener
//   and the returned window stay real) but without popup features, so it opens as a tab, never as a window; the
//   extension then switches the window back at once. window.close() is reported before the page closes itself.
// - isolated world `fowlbrowser-popups`: the private link (closed shadow root, a click that never leaves it) and
//   the binding that reports to the server.
// Only for tabs the user hasn't been given; removed (scripts, binding, and a live off-switch in the current
// documents) before a tab goes back to the user.
import crypto from 'node:crypto';
import { cdp } from './cdp.mjs';
import { debug } from './debug.mjs';

const WORLD = 'fowlbrowser-popups';
const BINDING = '__fowlbrowserPopup';
const EVENT = `fowlbrowser-${crypto.randomBytes(6).toString('hex')}`; // MAIN -> isolated world; per process, unguessable
const OFF_CAP_MS = 400;

// MAIN world. Gate: transient user activation, no modifier on the event being handled (a real modified click already
// means a background tab or a new window), http(s) only, a new browsing context only (never _self/_parent/_top or a
// frame or window that exists), never about:blank or empty (window.open('') then document.write needs the window).
function main(event) {
  const CONTROL = Symbol.for('fowlbrowser.popups');
  if (window[CONTROL]) return window[CONTROL].on();
  const nativeOpen = window.open;
  const nativeClose = window.close;
  const nativeToString = Function.prototype.toString;
  const names = new Map(); // window names this document opened -> their windows
  let on = false;

  // Synchronous: the isolated world's listener runs inside dispatchEvent. True when it took the open.
  const send = (data) => !document.dispatchEvent(new CustomEvent(event, { detail: JSON.stringify(data), cancelable: true }));
  const httpUrl = (value) => {
    try {
      const url = new URL(value, document.baseURI);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch { return null; }
  };
  const modified = (e) => (e instanceof MouseEvent && e.button !== 0) || (!!e && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey));
  const exists = (name) => {
    if (names.get(name)?.closed === false) return true;
    for (let w = window; ; w = w.parent) {
      try { if (w.name === name) return true; } catch {}
      if (w === w.parent) break;
    }
    return [...document.querySelectorAll('iframe, frame')].some((frame) => frame.name === name);
  };
  const newContext = (target) => !/^(_self|_parent|_top|_unfencedtop)?$/i.test(target) && (/^_blank$/i.test(target) || !exists(target));
  // The HTML spec's boolean window feature: present with no value, "yes", "true" or a non-zero number.
  const feature = (features, name) => features.toLowerCase().replace(/\s*=\s*/g, '=').split(/[\s,]+/).some((token) => {
    const [key, value = ''] = token.split('=');
    return key === name && (value === '' || value === 'yes' || value === 'true' || (Number.parseInt(value, 10) || 0) !== 0);
  });

  const open = new Proxy(nativeOpen, {
    apply(target, self, args) {
      const url = args[0] === undefined ? '' : String(args[0]);
      const name = args[1] === undefined || String(args[1]) === '' ? '_blank' : String(args[1]);
      const features = args[2] === undefined ? '' : String(args[2]);
      if (!on || !navigator.userActivation?.isActive || modified(window.event) || !url || !httpUrl(url) || !newContext(name)) {
        return Reflect.apply(target, self, args);
      }
      const noreferrer = feature(features, 'noreferrer');
      if (noreferrer || feature(features, 'noopener')) {
        return send({ type: 'open', url: httpUrl(url), noreferrer }) ? null : Reflect.apply(target, self, args);
      }
      // Needs its opener: a real window.open, as a tab (no popup, width, height, left, top...).
      const opened = Reflect.apply(target, self, [args[0], args[1], '']);
      if (opened && !/^_blank$/i.test(name)) names.set(name, opened);
      return opened;
    },
  });
  const close = new Proxy(nativeClose, {
    apply(target, self, args) {
      if (on && (self === undefined || self === window) && window === window.top) send({ type: 'close' });
      return Reflect.apply(target, self, args);
    },
  });
  const fakes = new Map([[open, nativeOpen], [close, nativeClose]]);
  const toString = new Proxy(nativeToString, { apply: (target, self, args) => Reflect.apply(target, fakes.get(self) ?? self, args) });
  fakes.set(toString, nativeToString);

  // Links: decided after the page's own click handlers (a bubble listener added again while the click is on its way
  // down, so it is the last one on window), which run once as usual; only the default action is replaced.
  function onLink(e) {
    if (!on || !e.isTrusted || e.defaultPrevented || modified(e) || !navigator.userActivation?.isActive) return;
    const link = e.composedPath().find((node) => (node.localName === 'a' || node.localName === 'area') && typeof node.href === 'string');
    if (!link || link.hasAttribute('download')) return;
    const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    const url = httpUrl(link.href);
    const target = link.getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '';
    if (!url || rel.includes('opener') || !newContext(target.trim())) return;
    if (send({ type: 'open', url, noreferrer: rel.includes('noreferrer'), referrerPolicy: link.referrerPolicy })) e.preventDefault();
  }
  addEventListener('click', (e) => {
    if (!on || !e.isTrusted) return;
    removeEventListener('click', onLink);
    addEventListener('click', onLink);
  }, true);

  const control = {
    on() {
      on = true;
      window.open = open;
      window.close = close;
      Function.prototype.toString = toString;
    },
    off() {
      on = false;
      if (window.open === open) window.open = nativeOpen;
      if (window.close === close) window.close = nativeClose;
      if (Function.prototype.toString === toString) Function.prototype.toString = nativeToString;
    },
  };
  Object.defineProperty(window, CONTROL, { value: control });
  control.on();
}

// Isolated world: opens what MAIN hands over as a background tab, and reports to the server.
function isolated(event, binding) {
  const CONTROL = Symbol.for('fowlbrowser.popups');
  if (globalThis[CONTROL]) return;
  globalThis[CONTROL] = true;
  const modifier = /Mac/.test(navigator.platform) ? 'metaKey' : 'ctrlKey';
  const report = (data) => { try { globalThis[binding](JSON.stringify(data)); } catch {} };
  document.addEventListener(event, (e) => {
    const data = JSON.parse(e.detail);
    if (data.type === 'open') {
      const host = document.createElement('span');
      const link = document.createElement('a');
      link.href = data.url;
      link.target = '_blank';
      link.rel = data.noreferrer ? 'noreferrer' : 'noopener';
      if (data.referrerPolicy) link.referrerPolicy = data.referrerPolicy;
      host.attachShadow({ mode: 'closed' }).append(link);
      document.documentElement.append(host); // a link must be connected to navigate
      try {
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: false, view: window, [modifier]: true }));
      } finally {
        host.remove();
      }
      e.preventDefault();
    }
    report(data);
  });
}

export const pageScripts = { main, isolated }; // for tests

const installed = new Map(); // Tab -> identifiers of its two scripts
const heard = new WeakSet(); // Tabs whose reports are listened to (once, however often they are installed)

// Call when an agent tab comes under control, before it navigates. Reports: 'close' sets tab.closedByPageAt; 'open' (a
// background tab the page just opened) is announced like a Page.windowOpen, so the action that caused it names the tab.
export async function installPopups(tab) {
  if (installed.has(tab)) return;
  installed.set(tab, []);
  if (!heard.has(tab)) {
    heard.add(tab);
    tab.on('binding', (name, payload) => {
      if (name !== BINDING) return;
      let data;
      try { data = JSON.parse(payload); } catch { return; }
      if (data?.type === 'close') tab.closedByPageAt = Date.now();
      else if (data?.type === 'open' && typeof data.url === 'string') tab.emit('windowopen', data.url);
    });
    tab.page.once('close', () => installed.delete(tab));
  }
  await cdp(tab, 'Runtime.addBinding', { name: BINDING, executionContextName: WORLD });
  const scripts = await Promise.all([
    cdp(tab, 'Page.addScriptToEvaluateOnNewDocument', { source: `(${main})(${JSON.stringify(EVENT)})`, runImmediately: true }),
    cdp(tab, 'Page.addScriptToEvaluateOnNewDocument', { source: `(${isolated})(${JSON.stringify(EVENT)}, ${JSON.stringify(BINDING)})`, worldName: WORLD, runImmediately: true }),
  ]);
  if (installed.has(tab)) installed.set(tab, scripts.map((s) => s.identifier));
}

// Before a tab goes back to the user (release, keep, turn end, handoff, takeover while attached; at session end every
// tab that still has them closes): new documents get nothing, and window.open is native again in the current ones.
// Best effort and capped, so it never holds up the release (after a detach every command fails).
export async function uninstallPopups(tab) {
  const identifiers = installed.get(tab);
  if (!identifiers) return;
  installed.delete(tab);
  const off = `window[Symbol.for('fowlbrowser.popups')]?.off()`;
  let timer;
  await Promise.race([
    Promise.allSettled([
      ...identifiers.map((identifier) => cdp(tab, 'Page.removeScriptToEvaluateOnNewDocument', { identifier })),
      cdp(tab, 'Runtime.removeBinding', { name: BINDING }),
      ...tab.page.frames().map((frame) => frame.evaluate(off)),
    ]),
    new Promise((resolve) => { timer = setTimeout(resolve, OFF_CAP_MS); }),
  ]).finally(() => clearTimeout(timer));
  debug('popups: uninstalled', tab.id);
}
