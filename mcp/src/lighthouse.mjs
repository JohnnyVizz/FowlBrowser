// Lighthouse audits in the tab's own debugger session, through a fake puppeteer page: Lighthouse only calls
// page.url() and page.target().createCDPSession(), and uses send, events ('*', by name, 'sessionattached'), id() and
// detach() on the session.
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { cdp, clearEmulation, fileTab, isUsersTab, onCdpEvent, outputDir, stamp, tracingSlot } from './perf.mjs';
import { debug } from './debug.mjs';
import * as record from './record.mjs';
import { resetEngine } from './trace.mjs';
import { clearViewport, setViewport } from './viewport.mjs';

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo', 'agentic-browsing'];
// bf-cache navigates to chrome://terms (refused), unused-javascript and script-treemap-data need the Profiler domain.
const SKIP_AUDITS = ['bf-cache', 'unused-javascript', 'script-treemap-data'];
const MOBILE_SCREEN = { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false };
// Domains an extension's debugger session doesn't have; Lighthouse only enables and disables them.
const STUBBED = new Set(['Animation.enable', 'Animation.disable']);
const MAX_IN_FLIGHT = 64; // the host refuses a client with over 256; Lighthouse's AnchorElements fires hundreds at once
const MAX_FLAGGED = 20;
const METRICS = [['FCP', 'first-contentful-paint'], ['LCP', 'largest-contentful-paint'], ['TBT', 'total-blocking-time'],
  ['CLS', 'cumulative-layout-shift'], ['Speed Index', 'speed-index'], ['TTI', 'interactive']];

// One CDP session of the run: the tab's own (root) or a flattened child (iframe, worker). They share the in-flight cap,
// the child map and the list of scripts Lighthouse added.
export class Session extends EventEmitter {
  constructor(shared, sessionId) { super(); this.shared = shared; this.sessionId = sessionId; }
  id() { return this.sessionId ?? `fb-${this.shared.tab.tabId}`; }
  async send(method, params, options) {
    if (this.shared.closed) throw closedError();
    // Lighthouse's ProtocolSession passes only {timeout} for commands without params.
    if (options === undefined && params && typeof params.timeout === 'number' && Object.keys(params).length === 1) params = undefined;
    const { tab } = this.shared;
    if (method === 'Browser.getVersion') {
      const userAgent = tab.browser.host.hello.extension.userAgent;
      return { protocolVersion: '1.3', product: `Chrome/${/Chrome\/(\S+)/.exec(userAgent)?.[1]}`, revision: '', jsVersion: '', userAgent };
    }
    if (STUBBED.has(method)) return {};
    await this.slot();
    if (this.shared.closed) { this.release(); throw closedError(); }
    let result;
    const sent = cdp(tab, method, params, this.sessionId);
    this.shared.inFlightSends.add(sent);
    const started = Date.now();
    try { result = await sent; } catch (error) { debug('lh err', method, String(error?.message).slice(0, 120)); throw error; } finally { this.shared.inFlightSends.delete(sent); this.release(); debug('lh', method, `${Date.now() - started} ms`); }
    if (method === 'Page.addScriptToEvaluateOnNewDocument' && result?.identifier) this.shared.scripts.push({ sessionId: this.sessionId, identifier: result.identifier });
    return result;
  }
  async detach() {}
  slot() {
    const s = this.shared;
    if (s.inFlight < MAX_IN_FLIGHT) { s.inFlight++; return Promise.resolve(); }
    return new Promise((resolve, reject) => s.waiting.push({ resolve, reject }));
  }
  release() {
    const s = this.shared;
    const next = s.waiting.shift();
    if (next) next.resolve(); // the slot passes straight to the next waiter
    else s.inFlight--;
  }
  dispatch(method, params) {
    let child;
    if (method === 'Target.attachedToTarget' && params?.sessionId) this.shared.children.set(params.sessionId, child = new Session(this.shared, params.sessionId));
    if (method === 'Target.detachedFromTarget') this.shared.children.delete(params?.sessionId);
    this.emitSafe('*', method, params);
    this.emitSafe(method, params);
    if (child) this.emitSafe('sessionattached', child);
  }
  // Lighthouse's listeners are partly async (TargetManager's sessionattached and frameNavigated) and their promises
  // reach nobody: a rejection there (a child target gone before its answer) would be unhandled and end the process.
  emitSafe(event, ...args) {
    for (const listener of this.rawListeners(event)) {
      try { listener.apply(this, args)?.catch?.(() => {}); } catch {}
    }
  }
}

// Lighthouse treats "Target closed" as benign.
const closedError = () => new Error('Target closed: the Lighthouse run has ended');

// The root session of a run, receiving the tab's CDP events (its children's by sessionId). close() stops that.
export function rootSession(tab) {
  const shared = { tab, inFlight: 0, waiting: [], inFlightSends: new Set(), closed: false, scripts: [], children: new Map() };
  const root = new Session(shared);
  const off = onCdpEvent(tab, (method, params, sessionId) => (sessionId ? shared.children.get(sessionId) : root)?.dispatch(method, params));
  // After close, nothing more is sent: queued and new sends fail, so none lands after restore and undoes it.
  root.close = () => {
    off();
    shared.closed = true;
    for (const { reject } of shared.waiting.splice(0)) reject(closedError());
  };
  // Settles once the sends already in flight have (at most timeoutMs).
  root.settled = (timeoutMs) => {
    let timer;
    return Promise.race([Promise.allSettled([...shared.inFlightSends]), new Promise((r) => { timer = setTimeout(r, timeoutMs); })]).finally(() => clearTimeout(timer));
  };
  root.scripts = shared.scripts;
  return root;
}

// After a run, whatever happened: Lighthouse leaves its emulation, blocked URLs and scripts on the session, and
// disables Page, Runtime and Log, which Playwright (on the same session) needs.
export async function restore(tab, scripts) {
  await clearEmulation(tab);
  await cdp(tab, 'Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
  await cdp(tab, 'Network.setBlockedURLs', { urls: [] }).catch(() => {});
  for (const { sessionId, identifier } of scripts) await cdp(tab, 'Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId).catch(() => {});
  // Lighthouse's Page.disable also turned lifecycle events off, which Playwright's load waits need.
  for (const [method, params] of [['Page.enable'], ['Page.setLifecycleEventsEnabled', { enabled: true }], ['Runtime.enable'], ['Network.enable'], ['Log.enable']]) {
    await cdp(tab, method, params).catch(() => {});
  }
}

let loading;
const load = () => loading ??= (async () => {
  const [lighthouse, { userAgents }, logger] = await Promise.all([
    import('lighthouse'), import('lighthouse/core/config/constants.js'), import('lighthouse-logger')]);
  logger.default.setLevel(process.env.FOWLBROWSER_LH_LOG || 'error');
  return { navigation: lighthouse.navigation, snapshot: lighthouse.snapshot, generateReport: lighthouse.generateReport, desktopConfig: lighthouse.desktopConfig, mobileUA: userAgents.mobile };
})();

async function run(tab, lh, { device, mode, categories }) {
  const flags = { disableStorageReset: true, skipAudits: SKIP_AUDITS, logLevel: 'error', maxWaitForLoad: 30_000 }; // 30 s as chrome-devtools-mcp
  if (categories) flags.onlyCategories = categories;
  let config;
  if (device === 'desktop') config = lh.desktopConfig;
  else Object.assign(flags, { formFactor: 'mobile', screenEmulation: MOBILE_SCREEN, emulatedUserAgent: lh.mobileUA });
  // Snapshot mode never applies the emulation before collecting: it audits the page as it is (formFactor only sets
  // the audit thresholds), without the full-page screenshot, whose gatherer would emulate a device on its own.
  if (mode === 'snapshot') Object.assign(flags, { screenEmulation: { disabled: true }, emulatedUserAgent: false, disableFullPageScreenshot: true });
  const release = await tracingSlot(); // Lighthouse records and parses a trace: one at a time
  // A viewport the agent set (viewport tool) makes way for Lighthouse's emulation and comes back afterwards.
  const viewport = tab.viewport;
  if (viewport) await clearViewport(tab, 'lighthouse').catch(() => {});
  // For a navigation run Playwright leaves the tab (its relay session only; the debugger stays attached) and the Tab
  // gets a fresh page afterwards (the same object: its queue and id stay): with both on one session, Lighthouse's
  // network-quiet wait ran to its cap on busy pages. Control ending meanwhile (the tab closed, debugging canceled by
  // the user) is honoured: then there is nothing to come back to.
  const { browser } = tab;
  const detach = mode === 'navigation';
  let ended = null;
  const onEvent = (method, params) => {
    if (method === 'chrome.tabs.onRemoved' && params?.[0] === tab.tabId) ended = 'closed';
    else if (method === 'chrome.debugger.onDetach' && params?.[0]?.tabId === tab.tabId && params?.[1] !== 'target_closed') ended ??= 'canceled';
  };
  try {
    browser.host.on('event', onEvent);
    let info;
    if (detach) {
      info = (await browser.host.request('tabs.listAll', {})).find((t) => t.id === tab.tabId);
      tab.replacing = true;
      browser.relay.model.forgetTab(tab.tabId);
    }
    const root = rootSession(tab);
    const page = { url: async () => (await root.send('Target.getTargetInfo')).targetInfo.url, target: () => ({ createCDPSession: async () => root }) };
    let url, lhr;
    try {
      url = await page.url();
      await root.send('Network.enable');
      await root.send('Network.setCacheDisabled', { cacheDisabled: true });
      const result = detach ? await lh.navigation(page, url, { flags, config }) : await lh.snapshot(page, { flags, config });
      lhr = result.lhr;
    } finally {
      root.close();
      await root.settled(45_000); // a host request can take that long to time out
      await restore(tab, root.scripts);
      await resetEngine().catch(() => {}); // Lighthouse parsed its trace with the shared engine
    }
    if (detach) {
      if (ended) {
        delete tab.replacing;
        browser.forget(tab.tabId);
        if (ended === 'closed') record.tabEvent('close', tab.id, url);
        throw new Error(ended === 'closed' ? 'The tab was closed during the audit.' : 'The user canceled debugging during the audit; the tab is still yours: tab_claim it to re-attach.');
      }
      browser.relay.model.onTabCreated(info ?? { id: tab.tabId });
      await browser.waitForTab(tab.tabId, undefined, { fresh: true }).catch((error) => { throw new Error(`Lighthouse finished but the tab could not be taken back: ${error.message}`); });
      // Lighthouse's init scripts ran in the audited document and its frames (one wraps requestIdleCallback): a fresh
      // load gives the agent a page without them.
      await tab.page.goto(url, { waitUntil: 'load' }).catch((error) => { throw new Error(`Lighthouse finished but the page could not be loaded again (${error.message.split('\n')[0]}); navigate to it.`); });
    }
    if (viewport) await setViewport(tab, viewport).catch(() => {});
    return lhr;
  } finally {
    browser.host.off('event', onEvent);
    if (tab.replacing) { delete tab.replacing; browser.forget(tab.tabId); } // no fresh page came: unmapped, not half-mapped
    release();
  }
}

// "Best Practices" -> "best practices", "SEO" stays.
const label = (category) => category.title.replace(/\b[A-Z][a-z]+/g, (w) => w.toLowerCase());
const score = (s) => (s === null || s === undefined ? 'n/a' : String(Math.round(s * 100)));
const plain = (s) => s?.replace(/\u00a0/g, ' '); // Lighthouse puts no-break spaces in display values

// A category with only weight-0 audits (performance in snapshot mode) scores a meaningless 0: count passes instead.
function categoryScore(lhr, category) {
  if (category.score === null || category.auditRefs.some((ref) => ref.weight > 0)) return score(category.score);
  const scored = category.auditRefs.map((ref) => lhr.audits[ref.id]?.score).filter((s) => s !== null && s !== undefined);
  return `n/a (${scored.filter((s) => s >= 1).length} of ${scored.length} audits pass)`;
}

export function formatResult(lhr, { device, mode, seconds, html, json }) {
  const categories = Object.values(lhr.categories);
  const lines = [
    `Lighthouse ${lhr.lighthouseVersion} · ${device} · ${mode === 'snapshot' ? 'snapshot (page as it is, no device emulation)' : mode} · ${seconds.toFixed(1)} s`,
    `Scores: ${categories.map((c) => `${label(c)} ${categoryScore(lhr, c)}`).join(' · ')}`,
  ];
  if (METRICS.some(([, id]) => lhr.audits[id])) lines.push(`Metrics: ${METRICS.map(([name, id]) => `${name} ${plain(lhr.audits[id]?.displayValue) ?? 'n/a'}`).join(' · ')}`);
  const heaviest = new Map(); // audit id -> its heaviest reference across categories
  for (const c of categories) {
    for (const ref of c.auditRefs) {
      const audit = lhr.audits[ref.id];
      if (!audit || audit.score === null || audit.score >= 1) continue;
      if (!(heaviest.get(ref.id)?.weight >= ref.weight)) heaviest.set(ref.id, { category: label(c), weight: ref.weight, audit });
    }
  }
  const flagged = [...heaviest.values()];
  flagged.sort((a, b) => b.weight - a.weight || a.audit.score - b.audit.score);
  if (flagged.length) {
    lines.push(`Failed or flagged audits (${flagged.length}):`);
    for (const { category, audit } of flagged.slice(0, MAX_FLAGGED)) {
      const value = audit.scoreDisplayMode === 'binary' ? 'fail' : score(audit.score);
      lines.push(`- ${category} · ${audit.id} (${value}): ${audit.title}${audit.displayValue ? ` · ${plain(audit.displayValue)}` : ''}`);
    }
    if (flagged.length > MAX_FLAGGED) lines.push(`… and ${flagged.length - MAX_FLAGGED} more in the report.`);
  } else {
    lines.push('Failed or flagged audits: none.');
  }
  if (lhr.runWarnings?.length) lines.push(`Warnings: ${lhr.runWarnings.map(plain).join(' · ')}`);
  lines.push(`Report: ${html} · JSON: ${json}`);
  return lines.join('\n');
}

export function registerLighthouse(tool, manager, { withTab, header, text, tabArg }) {
  tool('lighthouse',
    'Run a Lighthouse audit in a tab: scores (0-100) for performance, accessibility, best practices, SEO and agentic browsing, ' +
    'the lab metrics (FCP, LCP, TBT, CLS, Speed Index, TTI), the failed or flagged audits heaviest first, and the paths of the full HTML and JSON reports. ' +
    'mode "navigation" (default) reloads the page and audits the load, emulating a phone (default) or desktop during the run and clearing that afterwards; ' +
    'it is refused on a claimed tab (the user\'s page): audit a tab_open of the URL instead, or use mode "snapshot", which audits the page as it is now ' +
    '(its current layout and user agent, no device emulation: device only sets the score thresholds; no load metrics). ' +
    'Never clears the user\'s cache or site data. Takes 10 to 60 s.',
    {
      tab: tabArg,
      device: z.enum(['mobile', 'desktop']).optional().describe('Emulated device in navigation mode (default mobile: Lighthouse\'s Moto G Power preset); in snapshot mode only the score thresholds.'),
      mode: z.enum(['navigation', 'snapshot']).optional().describe('navigation (default): reload and audit the page load. snapshot: audit the page as it is.'),
      categories: z.array(z.enum(CATEGORIES)).min(1).optional().describe('Only these categories (default all five).'),
    },
    withTab(async (tab, { device = 'mobile', mode = 'navigation', categories }) => {
      if (mode === 'navigation' && await isUsersTab(tab)) {
        throw new Error(`Tab ${tab.id} is the user's own tab (you claimed it): mode "navigation" reloads the page, so it was not run. ` +
          'Audit a tab_open of the URL instead, or use mode "snapshot" to audit the page as it is.');
      }
      const lh = await load();
      const started = Date.now();
      const lhr = await run(tab, lh, { device, mode, categories });
      const seconds = (Date.now() - started) / 1000;
      // Tracing is one per browser: a trace_start recording or DevTools' Performance panel in any tab blocks it.
      if (lhr.runtimeError?.code === 'TRACING_ALREADY_STARTED') throw new Error('Lighthouse could not trace the page: a trace is already recording in this browser (another session\'s trace or Lighthouse run, or DevTools\' Performance panel). Stop it, then run lighthouse again.');
      if (lhr.runtimeError) throw new Error(`Lighthouse could not audit the page: ${lhr.runtimeError.message} (${lhr.runtimeError.code})`);
      const dir = path.join(outputDir('lighthouse'), `${stamp()}-${fileTab(tab)}`);
      fs.mkdirSync(dir, { recursive: true });
      const html = path.join(dir, 'report.html');
      const json = path.join(dir, 'report.json');
      fs.writeFileSync(html, lh.generateReport(lhr, 'html'));
      fs.writeFileSync(json, JSON.stringify(lhr));
      return text(`${await header(tab)}\n${formatResult(lhr, { device, mode, seconds, html, json })}`);
    }));
}
