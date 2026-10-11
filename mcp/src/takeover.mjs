// Taking a tab back and handing a tab over (SPEC "Taking a tab back, handing a tab over, viewport (session 5)").
// The server decides takeovers, since only it knows when the agent acted: every tool call's run on a tab and every
// Input.* command the relay forwards for it are agent windows. Signals: trusted input in the page (an isolated-world
// listener), the user's navigations (the extension's tabs.committed), the debugger taken away, and the tab closed.
// A taken-over or handed-off tab is parked (extension tabs.park): still this session's, but the user's until the
// agent resumes it with tab_claim {resume: true}. Notices for the agent live here too.
import { cdp } from './cdp.mjs';
import * as cursor from './cursor/index.mjs';
import { debug } from './debug.mjs';
import { uninstallPopups } from './popups.mjs';
import { tabEvent } from './record.mjs';

const BEFORE_MS = 50; // an agent window starts this much before its command was sent (clock skew)
const AFTER_MS = 250; // and ends this much after its reply (the page's own handlers, timers)
const NAV_AFTER_MS = 1500; // the agent's own navigations commit well after the command that started them
const SELF_NAV_MS = 1000; // a navigation the page asked for this recently is the page's, not the user's
const SETTLE_MS = 300; // the page's own report of a navigation can trail the commit a little
const KEEP_MS = 5000; // finished agent windows kept this long
const CLOSED_BY_PAGE_MS = 3000;
const CRASH_MS = 5000;
const ENDING_MS = 30_000;
const THROTTLE_MS = 250;

export const USER_WORLD = 'fowlbrowser-user';
export const USER_BINDING = '__fowlbrowserUserInput';

// Runs in an isolated world of every same-process frame of a controlled tab, from document start (page listeners can't
// hide events from a capture listener on window registered first). Reports trusted input, at most one per type per
// 250 ms, as {type, at, what}: `at` on the page's wall clock, `what` a short name of the target, never field values.
// Cross-origin frames are other processes: a click into one shows up as the top window's blur with an iframe focused.
// Navigations the page starts itself (history.back() from a script) report as "navigate".
const USER_SCRIPT = `(() => {
  if (globalThis.__fowlbrowserUser) return;
  globalThis.__fowlbrowserUser = true;
  const last = {};
  const clip = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim().slice(0, 40);
  const name = (target) => {
    const el = target?.closest?.('a, button, input, textarea, select, summary, label, [role], [contenteditable]');
    if (!el) return '';
    const texty = /^(A|BUTTON|SUMMARY|LABEL)$/.test(el.tagName) || /^(button|link|tab|menuitem|option|checkbox|radio|switch)$/.test(el.getAttribute('role'));
    return clip(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.labels?.[0]?.innerText
      || (texty ? el.innerText : '') || el.getAttribute('title') || el.getAttribute('role'));
  };
  const report = (type, event, what = '') => {
    if (!event.isTrusted || performance.now() - (last[type] ?? -1e9) < ${THROTTLE_MS}) return;
    last[type] = performance.now();
    globalThis.${USER_BINDING}?.(JSON.stringify({ type, at: performance.timeOrigin + event.timeStamp, what }));
  };
  const modifiers = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS']);
  const options = { capture: true, passive: true };
  addEventListener('pointerdown', (e) => report('pointerdown', e, name(e.target)), options);
  // Cmd shortcuts belong to the browser (address bar, close, reload): its own signals cover them.
  addEventListener('keydown', (e) => { if (!e.metaKey && !modifiers.has(e.key)) report('keydown', e, name(e.target)); }, options);
  addEventListener('beforeinput', (e) => report('beforeinput', e, name(e.target)), options);
  addEventListener('wheel', (e) => report('wheel', e), options);
  if (window === top) addEventListener('blur', (e) => setTimeout(() => { if (document.activeElement?.tagName === 'IFRAME') report('frame', e); }), options);
  window.navigation?.addEventListener('navigate', (e) => { if (!e.userInitiated) report('navigate', e); });
})();`;

// Times the agent acted on a tab: [start, end] per window, end Infinity while it runs.
export class Activity {
  windows = [];

  begin() {
    const window = [Date.now(), Infinity];
    this.windows.push(window);
    return () => {
      window[1] = Date.now();
      this.windows = this.windows.filter(([, end]) => end > window[1] - KEEP_MS);
    };
  }

  covers(at, after = AFTER_MS) {
    return this.windows.some(([start, end]) => at >= start - BEFORE_MS && at <= end + after);
  }
}

const inputs = new Map(); // "chrome:52" -> Activity of the relay's Input.* commands for that tab
const records = new Map(); // "chrome:52" -> { kind: 'takeover'|'handoff', at, how?, reason?, gone? } of parked tabs
const unseen = new Set(); // takeovers no result has told the agent about yet
const ending = new Map(); // "chrome:52" -> when this session started closing or releasing it
const selfNavigated = new Map(); // "chrome:52" -> when the page last asked for a navigation itself
const crashed = new Map(); // "chrome:52" -> when its renderer died
const histories = new Map(); // "chrome:52" -> { urls, index }: the tab's committed documents, for back vs forward
const lastTabs = new Map(); // "chrome:52" -> the Tab it was when its debugger went (its page may close first)

const keyOf = (browser, tabId) => `${browser.key}:${tabId}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const recently = (map, key, ms) => Date.now() - (map.get(key) ?? -Infinity) <= ms;
const clock = (at) => new Date(at).toTimeString().slice(0, 5);

// Whether the agent acted on the tab around `at` (any tool call on it, or input the relay forwarded for it).
export function agentActed(browser, tabId, at, after = AFTER_MS) {
  return [browser.tabs.get(tabId)?.activity, inputs.get(keyOf(browser, tabId))].some((a) => a?.covers(at, after));
}

const INPUT_HOW = {
  pointerdown: (what) => (what ? `clicked "${what}"` : 'clicked in the page'),
  keydown: (what) => (what ? `typed in "${what}"` : 'typed in the page'),
  beforeinput: (what) => (what ? `typed in "${what}"` : 'typed in the page'),
  wheel: () => 'scrolled the page',
  frame: () => 'clicked inside a frame',
};
export const inputHow = ({ type, what }) => INPUT_HOW[type]?.(what) ?? null;

// How the user navigated, from a main-frame commit, or null when it was the agent or the page itself.
// agentActed: an agent window covers the commit (plus NAV_AFTER_MS); selfNavigated: the page asked for a navigation
// within SELF_NAV_MS; focused: the tab is the active tab of the focused window (a page's own history.back() looks like
// the Back button, but the user can only press that in a window they are in); direction: 'went back'/'went forward'.
export function navigationHow({ transitionType, transitionQualifiers = [] }, { agentActed, selfNavigated, focused, direction }) {
  if (transitionType === 'auto_bookmark') return 'opened a bookmark';
  if (transitionQualifiers.includes('from_address_bar') || ['keyword', 'keyword_generated', 'generated'].includes(transitionType)) {
    return 'typed an address in the address bar';
  }
  const back = transitionQualifiers.includes('forward_back');
  // A page reloading itself commits as a link with client_redirect; only the browser's reload is "reload".
  if ((!back && transitionType !== 'reload') || agentActed || selfNavigated) return null;
  if (back) return focused ? direction ?? 'went back or forward' : null;
  return 'reloaded the page';
}

// Back or forward, by the commit's URL against the documents the tab committed before; also records the commit.
function direction(key, { url, transitionType, transitionQualifiers = [] }) {
  const history = histories.get(key) ?? { urls: [], index: -1 };
  histories.set(key, history);
  if (transitionQualifiers.includes('forward_back')) {
    if (history.urls[history.index - 1] === url) { history.index--; return 'went back'; }
    if (history.urls[history.index + 1] === url) { history.index++; return 'went forward'; }
    return null;
  }
  if (history.index >= 0 && (transitionType === 'reload' || transitionQualifiers.includes('client_redirect'))) history.urls[history.index] = url;
  else history.urls.splice(++history.index, Infinity, url);
  return null;
}

// --- Notices ---

export function notice(key) {
  const record = records.get(key);
  if (!record) return null;
  if (record.kind === 'handoff') {
    return `You handed ${key} to the user at ${clock(record.at)} (${record.reason}); wait until they say they are done, then tab_claim it with resume: true.`;
  }
  return `The user took over ${key} at ${clock(record.at)} (${record.how}). Stop working in that tab, tell the user where you got to, and ask before going on.` +
    (record.gone ? '' : ' If they say to carry on there, call tab_claim on it with resume: true.');
}

export const parked = (key) => records.get(key) ?? null;

// A takeover of this tab that happened after `since` (a call running on it then gets the notice instead of its result).
export function takenOverSince(key, since) {
  const record = records.get(key);
  return record?.kind === 'takeover' && record.at >= since ? notice(key) : null;
}

// The start of the next result of any other tool tells the agent about takeovers it has not heard of, once each
// (calls naming the taken-over tab get its notice anyway, every time).
export function withNotices(result, tabKey) {
  const keys = [...unseen].filter((key) => key !== tabKey);
  if (!keys.length) return result;
  for (const key of keys) unseen.delete(key);
  const first = result.content?.find((c) => c.type === 'text');
  const lines = keys.map(notice).filter(Boolean);
  if (!lines.length) return result;
  if (first) first.text = `${lines.join('\n')}\n${first.text}`;
  else result.content = [{ type: 'text', text: lines.join('\n') }, ...(result.content ?? [])];
  return result;
}

// Control ended (released, closed, resumed): the tab's parked state and notice go.
export function forget(key) {
  records.delete(key);
  unseen.delete(key);
}

// This session is closing or releasing the tab: its removal is ours, not the user's.
export function markEnding(key) {
  ending.set(key, Date.now());
}

// --- Parking ---

// The user took the tab over: noted at once (so every later signal and call sees it), cursor gone (its exit fade
// while the debugger is still there; without it the overlay fades on its own idle timer), parked, journaled.
export async function takeOver(browser, tabId, how, { tab = browser.tabs.get(tabId), detached = false, gone = false } = {}) {
  const key = keyOf(browser, tabId);
  if (records.has(key)) return;
  records.set(key, { kind: 'takeover', at: Date.now(), how, gone });
  unseen.add(key);
  debug('takeover', key, how);
  const url = tab?.page.url();
  if (tab && !detached && !gone) {
    await cursor.remove(tab, { wait: true });
    await uninstallPopups(tab); // the user's own popups open natively again (after a detach they do from the next page on)
  }
  if (!gone) await browser.host.request('tabs.park', { tabId, kind: 'takeover' }).catch((error) => debug('park failed', key, error.message));
  tabEvent('takeover', key, url, { how });
}

// tab_handoff: the cursor fades, a viewport override goes, then the tab is parked for the user. Runs in the tab's queue.
export async function handOff(tab, reason) {
  const key = tab.id;
  records.set(key, { kind: 'handoff', at: Date.now(), reason });
  try {
    await cursor.remove(tab, { wait: true });
    await uninstallPopups(tab);
    await cdp(tab, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    await tab.browser.host.request('tabs.park', { tabId: tab.tabId, kind: 'handoff' });
  } catch (error) {
    records.delete(key);
    throw error;
  }
  tabEvent('handoff', key, tab.page.url(), { reason });
}

// --- Signals ---

// Installs the page listener in a tab that came under control (Browser._adopt).
export async function watchUserInput(tab) {
  tab.on('binding', (name, payload) => { if (name === USER_BINDING) onReport(tab, payload); });
  await cdp(tab, 'Runtime.addBinding', { name: USER_BINDING, executionContextName: USER_WORLD });
  await cdp(tab, 'Page.addScriptToEvaluateOnNewDocument', { source: USER_SCRIPT, worldName: USER_WORLD, runImmediately: true });
}

async function onReport(tab, payload) {
  let report;
  try { report = JSON.parse(payload); } catch { return; }
  const { browser, tabId } = tab;
  if (report.type === 'navigate') return void selfNavigated.set(tab.id, Date.now());
  const how = inputHow(report);
  if (!how || records.has(tab.id) || agentActed(browser, tabId, report.at)) return;
  // Agent input is trusted too; only input in the tab the user is looking at, in the window they are in, can be theirs.
  const seen = await browser.host.request('tabs.isShown', { tabId }).catch(() => null);
  if (!seen?.shown || !seen.focused || agentActed(browser, tabId, report.at)) return;
  await takeOver(browser, tabId, how, { tab });
}

// Extension events of a browser. Registered before the relay's handler, so the tab is still known to the model when
// its removal comes in.
export function watchTakeovers(browser) {
  browser.relay.onInput = (tabId) => {
    const key = keyOf(browser, tabId);
    if (!inputs.has(key)) inputs.set(key, new Activity());
    return inputs.get(key).begin();
  };
  browser.host.on('event', (method, params) => {
    if (method === 'chrome.debugger.onDetach') onDetach(browser, params?.[0]?.tabId, params?.[1]).catch((e) => debug('takeover: detach', e.message));
    else if (method === 'chrome.tabs.onRemoved') onRemoved(browser, params?.[0], params?.[1]).catch((e) => debug('takeover: removed', e.message));
    else if (method === 'tabs.committed') onCommitted(browser, params ?? {}).catch((e) => debug('takeover: committed', e.message));
    else if (method === 'chrome.debugger.onEvent') {
      const [source, cdpMethod] = params ?? [];
      if (source?.sessionId) return;
      if (cdpMethod === 'Page.frameRequestedNavigation') selfNavigated.set(keyOf(browser, source?.tabId), Date.now());
      else if (cdpMethod === 'Inspector.targetCrashed') crashed.set(keyOf(browser, source?.tabId), Date.now());
    }
  });
}

const BROWSER_PAGE = /^(chrome|chrome-extension|chrome-search|chrome-untrusted|devtools|edge|brave|about):/;

async function onDetach(browser, tabId, reason) {
  const key = keyOf(browser, tabId);
  if (reason === 'parked' || records.has(key)) return;
  const tab = browser.tabs.get(tabId);
  lastTabs.set(key, tab);
  setTimeout(() => lastTabs.delete(key), CLOSED_BY_PAGE_MS).unref();
  if (reason === 'canceled_by_user') return takeOver(browser, tabId, 'pressed Cancel on the browser\'s debugging bar', { tab, detached: true });
  // target_closed: the tab closed (onRemoved follows), its renderer died, or it went to a page the debugger may not stay on.
  if (reason !== 'target_closed' || recently(crashed, key, CRASH_MS)) return;
  await sleep(SETTLE_MS);
  if (records.has(key)) return;
  const info = (await browser.host.request('tabs.listAll', {}).catch(() => [])).find((t) => t.id === tabId && t.owner === 'you');
  if (!info || info.parked) return;
  const how = BROWSER_PAGE.test(info.url) && info.url !== 'about:blank' ? `opened a browser page (${info.url.slice(0, 60)})` : 'took the tab out of the agent\'s control';
  await takeOver(browser, tabId, how, { tab, detached: true });
}

async function onRemoved(browser, tabId, removeInfo) {
  const key = keyOf(browser, tabId);
  const tab = browser.tabs.get(tabId) ?? lastTabs.get(key);
  const known = !!tab || browser.relay.model.hasTab(tabId);
  histories.delete(key);
  inputs.delete(key);
  if (records.get(key)?.kind === 'handoff') return forget(key); // the user closed what they were handed
  if (!known || removeInfo?.replacedBy !== undefined || records.has(key) || recently(ending, key, ENDING_MS)) return;
  if (Date.now() - (tab?.closedByPageAt ?? -Infinity) <= CLOSED_BY_PAGE_MS) return; // the page closed itself
  await takeOver(browser, tabId, 'closed the tab', { tab, gone: true });
}

async function onCommitted(browser, commit) {
  const { tabId, transitionType, transitionQualifiers = [] } = commit;
  const key = keyOf(browser, tabId);
  if (records.has(key)) return;
  const at = Date.now();
  const way = direction(key, commit);
  const back = transitionQualifiers.includes('forward_back');
  // Back, forward and reload can be the agent's or the page's own: judged once the page's report had time to come.
  if (back || transitionType === 'reload') await sleep(SETTLE_MS);
  const seen = back ? await browser.host.request('tabs.isShown', { tabId }).catch(() => null) : null;
  const how = navigationHow(commit, {
    agentActed: agentActed(browser, tabId, at, AFTER_MS + NAV_AFTER_MS),
    selfNavigated: at - (selfNavigated.get(key) ?? -Infinity) <= SELF_NAV_MS,
    focused: !!(seen?.shown && seen.focused),
    direction: way,
  });
  if (how && !records.has(key)) await takeOver(browser, tabId, how);
}
