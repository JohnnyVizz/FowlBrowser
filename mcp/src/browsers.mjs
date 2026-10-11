// Connected browsers: one host socket + one CDP relay + one lazy Playwright connection per browser.
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { isOwnBinding } from './cdp.mjs';
import { watchClosedShadow } from './closedShadow.mjs';
import { prepare as prepareCursor } from './cursor/index.mjs';
import { debug } from './debug.mjs';
import { HostClient, listSockets } from './hostClient.mjs';
import { installPopups } from './popups.mjs';
import { downloadDone, record } from './record.mjs';
import { Activity, currentCall, refuseParked, watchTakeovers, watchUserInput } from './takeover.mjs';
import { CDPRelay } from './vendor/cdpRelay.mjs';

export const LABEL = process.env.FOWLBROWSER_LABEL || 'Claude';
const RESCAN_MS = 5000;
const BUFFER_LIMIT = 1000;
const NAMES = { chrome: 'Chrome', helium: 'Helium', chromium: 'Chromium', brave: 'Brave', edge: 'Edge' };

export const ACTION_TIMEOUT_MS = 10_000;
export const NAVIGATION_TIMEOUT_MS = 30_000;

function appVersion(browserPath) {
  const app = browserPath?.match(/^(.*?\.app)\//)?.[1];
  if (!app) return null;
  try {
    return execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', `${app}/Contents/Info.plist`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

function push(buffer, entry) {
  buffer.push(entry);
  if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
}

// One controlled chrome tab and its Playwright page. Calls on the same tab run one at a time.
export class Tab extends EventEmitter {
  constructor(browser, tabId, page) {
    super();
    this.browser = browser;
    this.tabId = tabId;
    this.id = `${browser.key}:${tabId}`;
    this.page = page;
    this.dialog = null;
    this.console = [];
    this.network = [];
    this.documentGeneration = 0; // bumped when the main frame commits a new document (refs from older ones are void)
    this.frameGeneration = 0; // bumped when any iframe navigates (its refs from before are void; snapshots.mjs numberRefs)
    this._queue = Promise.resolve();
    this._calls = 0; // run() calls not yet settled
    this.activity = new Activity(); // when calls ran on the tab: input in the page then is the agent's (takeover.mjs)
    this._busy = null;
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.on('dialog', (dialog) => {
      this.dialog = dialog;
      this.emit('dialog', dialog);
    });
    page.on('framenavigated', (frame) => { if (frame !== page.mainFrame()) this.frameGeneration++; });
    // Answered by the user in the browser, or by the dialog tool: actions are no longer blocked.
    page.on('dialogclosed', (dialog) => { if (this.dialog === dialog) this.dialog = null; });
    page.on('console', (message) => push(this.console, {
      time: Date.now(), level: message.type(), text: message.text(), url: message.location()?.url,
    }));
    page.on('pageerror', (error) => push(this.console, { time: Date.now(), level: 'error', text: `Uncaught ${error.message}` }));
    page.on('response', (response) => {
      const request = response.request();
      push(this.network, { time: Date.now(), method: request.method(), url: request.url(), status: response.status(), type: request.resourceType() });
    });
    page.on('requestfailed', (request) => push(this.network, {
      time: Date.now(), method: request.method(), url: request.url(), status: 'failed', type: request.resourceType(), failure: request.failure()?.errorText,
    }));
  }

  // The next call starts once this one, and any work it left running (keepBusy), has finished. The check runs
  // right before each call starts, so work that resumes after its dialog is answered still holds the tab.
  // A tool call queued before the tab was parked (taken over, handed off) fails with the notice when its turn comes.
  run(fn) {
    this._calls++;
    const acted = this.activity.begin();
    const call = currentCall();
    const result = this._queue.then(() => this._idle()).then(() => { refuseParked(this, call); return fn(); }).finally(() => { this._calls--; acted(); });
    this._queue = result.catch(() => {});
    return result;
  }

  // A call is running or queued, or an action still runs behind an open dialog.
  get busy() {
    return this._calls > 0 || !!this._busy;
  }

  // A new document in the main frame (not same-document history): any dialog of the old one is gone.
  _newDocument() {
    this.documentGeneration++;
    this.dialog = null;
  }

  // An action returned early (a dialog opened) but is still running: once the dialog is resolved it goes on,
  // and later calls wait for it. While a dialog is open they run (and report the dialog) instead of hanging.
  keepBusy(work) {
    const busy = work.finally(() => { if (this._busy === busy) this._busy = null; });
    this._busy = busy;
  }

  async _idle() {
    while (this._busy && !this.dialog) {
      let onDialog;
      const opened = new Promise((resolve) => { onDialog = resolve; this.once('dialog', resolve); });
      await Promise.race([this._busy, opened]);
      this.off('dialog', onDialog);
    }
  }

  // The browser's own title for the tab; unlike document.title it does not wait for the page's JS thread
  // (blocked while a dialog is open).
  async currentTitle() {
    const info = await this.browser.host.request('chrome.debugger.sendCommand', [{ tabId: this.tabId }, 'Target.getTargetInfo']).catch(() => null);
    return info?.targetInfo?.title ?? '';
  }
}

export class Browser {
  constructor(key, host) {
    this.key = key; // socket base name: "helium", "chrome", "helium-2"
    this.host = host;
    const [base, n] = key.split(/-(?=\d+$)/);
    this.name = (NAMES[base] ?? base) + (n ? ` (${n})` : '');
    const hello = host.hello;
    this.silentDebugger = hello.silentDebugger;
    this.version = appVersion(hello.browserPath);
    this.chromiumVersion = hello.extension?.userAgent?.match(/Chrome\/(\S+)/)?.[1] ?? null;
    this.tabs = new Map(); // chrome tab id -> Tab
    this.relay = new CDPRelay((method, params) => host.request(method, params), hello.extension?.userAgent);
    watchTakeovers(this); // first: it reads which tabs the relay knows before the relay handles the event
    host.on('event', (method, params) => {
      this.relay.handleExtensionEvent(method, params);
      if (method === 'chrome.debugger.onEvent') this._onDebuggerEvent(params);
      else if (method === 'extension.hello') this._identity(params);
      else if (method === 'host.hello') this._identity(params?.extension);
      else if (method === 'downloads.changed') for (const item of params ?? []) downloadDone(key, item); // record mode
    });
    this._pw = null;
    this._pages = new WeakMap(); // Playwright page -> Promise<Tab | null>
    this._waiters = new Map(); // chrome tab id -> resolve functions of waitForTab calls
  }

  // The extension's identity (user agent) can come after host.hello; keep the real one for Browser.getVersion.
  _identity(extension) {
    if (!extension?.userAgent) return;
    this.host.hello = { ...this.host.hello, extension };
    this.chromiumVersion = extension.userAgent.match(/Chrome\/(\S+)/)?.[1] ?? this.chromiumVersion;
    this.relay.setUserAgent(extension.userAgent);
  }

  // Raw CDP events of the tab's own session (not workers or frames): new documents, 'windowopen' (url) when the
  // page asks for a new tab or window, and 'binding' (name, payload) when one of FowlBrowser's page scripts reports.
  _onDebuggerEvent([source, method, params] = []) {
    if (source?.sessionId) return;
    const tab = this.tabs.get(source?.tabId);
    if (!tab) return;
    if (method === 'Page.frameNavigated' && !params?.frame?.parentId) {
      tab._newDocument();
      prepareCursor(tab);
    } else if (method === 'Page.windowOpen') tab.emit('windowopen', params?.url ?? '');
    else if (isOwnBinding(method, params)) tab.emit('binding', params.name, params.payload);
  }

  // The tab is no longer ours (released or closed) even if the extension's event never came.
  forget(tabId) {
    this.relay.model.forgetTab(tabId);
    this.relay.viewports.delete(tabId);
    this.tabs.delete(tabId);
  }

  async start() {
    this._relayUrl = await this.relay.start();
  }

  stop() {
    this.relay.stop();
    this._pw?.then((pw) => pw.close()).catch(() => {});
  }

  playwright() {
    this._pw ??= (async () => {
      const pw = await chromium.connectOverCDP(this._relayUrl, { timeout: NAVIGATION_TIMEOUT_MS });
      const context = pw.contexts()[0];
      context.on('page', (page) => this.tabFor(page));
      for (const page of context.pages()) this.tabFor(page);
      pw.on('disconnected', () => {
        this._pw = null;
        this.tabs.clear();
      });
      return pw;
    })();
    this._pw.catch(() => { this._pw = null; });
    return this._pw;
  }

  // The Tab for a Playwright page (null if it could not be mapped), adopting the page on first sight.
  tabFor(page) {
    if (!this._pages.has(page)) this._pages.set(page, this._adopt(page));
    return this._pages.get(page);
  }

  async _adopt(page) {
    let tab = null;
    // Registered before any await, so a page that closes during setup is never published (or is removed).
    page.once('close', () => {
      if (!tab || this.tabs.get(tab.tabId) !== tab) return;
      this.tabs.delete(tab.tabId);
      if (!tab.ending) record({ type: 'tab', event: 'close', tab: tab.id, url: page.url() }); // found gone
    });
    try {
      const session = await page.context().newCDPSession(page);
      const { tabId } = await session.send('FowlBrowser.getTabId');
      session.detach().catch(() => {});
      tab = new Tab(this, tabId, page);
      // The attachShadow hook goes only into agent tabs; the user's claimed tabs get a scan per document instead.
      const info = (await this.host.request('tabs.listAll', {}).catch(() => [])).find((t) => t.id === tabId);
      await watchClosedShadow(tab, info?.origin === 'agent').catch(() => {});
      // Popups open in the background only from the agent's own tabs, never from tabs that are (or went back to) the user's.
      if (info?.origin === 'agent' && !info.handedOver && !info.kept && !info.parked) await installPopups(tab).catch((e) => debug('popups: install failed', e.message));
      await watchUserInput(tab).catch(() => {});
      if (page.isClosed()) return null;
      this.relay.viewports.delete(tabId); // a new Tab has no viewport override (a detach ended any earlier one)
      this.tabs.set(tabId, tab);
      prepareCursor(tab);
      for (const resolve of this._waiters.get(tabId) ?? []) resolve(tab);
      this._waiters.delete(tabId);
      return tab;
    } catch (error) {
      if (!page.isClosed()) process.stderr.write(`[fowlbrowser] could not map a page to its tab: ${error.message}\n`);
      return null;
    }
  }

  // Resolves the Tab once Playwright has a page for this chrome tab.
  async waitForTab(tabId, timeout = ACTION_TIMEOUT_MS) {
    await this.playwright();
    if (this.tabs.has(tabId)) return this.tabs.get(tabId);
    let resolve;
    const mapped = new Promise((r) => { resolve = r; });
    if (!this._waiters.has(tabId)) this._waiters.set(tabId, new Set());
    this._waiters.get(tabId).add(resolve);
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this._waiters.get(tabId)?.delete(resolve);
        if (!this._waiters.get(tabId)?.size) this._waiters.delete(tabId);
        const detached = this.relay.model.hasTab(tabId) && !this.relay.model.isAttached(tabId);
        reject(new Error(`Tab ${this.key}:${tabId} did not become controllable within ${timeout / 1000} s.` + (detached
          ? ' Its debugger is detached (the user canceled debugging or opened DevTools on it); it is still yours. Call tab_claim on it to re-attach (DevTools must be closed).'
          : '')));
      }, timeout);
    });
    return Promise.race([mapped, timedOut]).finally(() => clearTimeout(timer));
  }
}

export class BrowserManager {
  constructor() {
    this.browsers = new Map(); // key -> Browser
    this._connecting = new Map(); // socket path -> promise
    this.ready = this.scan();
    setInterval(() => this.scan(), RESCAN_MS).unref();
  }

  async scan() {
    const connected = new Set([...this.browsers.values()].map((b) => b.host.socketPath));
    await Promise.all(listSockets().filter((p) => !connected.has(p)).map((p) => this._connect(p)));
  }

  _connect(socketPath) {
    if (this._connecting.has(socketPath)) return this._connecting.get(socketPath);
    const attempt = (async () => {
      const host = new HostClient(socketPath);
      try {
        await host.connect(LABEL);
      } catch {
        host.close();
        return; // stale socket file or a browser mid-restart; the next scan retries
      }
      const key = path.basename(socketPath, '.sock');
      const browser = new Browser(key, host);
      await browser.start();
      if (host.closed) { browser.stop(); return; } // closed while the relay started; the next scan retries
      this.browsers.set(key, browser);
      host.once('close', () => {
        browser.stop();
        if (this.browsers.get(key) === browser) this.browsers.delete(key);
      });
    })().finally(() => this._connecting.delete(socketPath));
    this._connecting.set(socketPath, attempt);
    return attempt;
  }

  async get(key) {
    await this.ready;
    if (!this.browsers.has(key)) await this.scan();
    const browser = this.browsers.get(key);
    if (!browser) {
      const known = [...this.browsers.keys()];
      throw new Error(`Browser "${key}" is not connected. Connected: ${known.length ? known.join(', ') : 'none'}. Use browser_list.`);
    }
    return browser;
  }

  async all() {
    await this.ready;
    return [...this.browsers.values()];
  }
}
