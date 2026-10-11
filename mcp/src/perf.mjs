// Performance tools. Everything here talks to the tab's own debugger session through the host, beside Playwright's
// relay session: the relay's emulation swallowing and the extension's Browser-domain block don't apply, and what is
// set this way ends with the session (a release or close detaches, which clears every Emulation and Network override).
// Traces: trace.mjs. Lighthouse: lighthouse.mjs. Memory: here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cdp } from './cdp.mjs';
import { registerLighthouse } from './lighthouse.mjs';
import { registerTrace } from './trace.mjs';

export { cdp } from './cdp.mjs';

// CDP events of the tab and its child sessions: listener(method, params, sessionId). Returns the unsubscribe.
export function onCdpEvent(tab, listener) {
  const handler = ([source, method, params] = []) => { if (source?.tabId === tab.tabId) listener(method, params, source.sessionId); };
  tab.browser.host.on('chrome.debugger.onEvent', handler);
  return () => tab.browser.host.off('chrome.debugger.onEvent', handler);
}

// The next `method` event of the tab's own session whose params pass `test`, within timeoutMs; an aborted `signal`
// stops waiting (and listening) early.
export function cdpEvent(tab, method, { timeoutMs = 60_000, test = () => true, signal } = {}) {
  return new Promise((resolve, reject) => {
    const done = (settle) => { clearTimeout(timer); off(); signal?.removeEventListener('abort', onAbort); settle(); };
    const timer = setTimeout(() => done(() => reject(new Error(`No ${method} event within ${Math.round(timeoutMs / 1000)} s`))), timeoutMs);
    const onAbort = () => done(() => reject(new Error(`Stopped waiting for ${method}`)));
    signal?.addEventListener('abort', onAbort, { once: true });
    const off = onCdpEvent(tab, (m, params, sessionId) => {
      if (m === method && !sessionId && test(params)) done(() => resolve(params));
    });
  });
}

// Undoes device, touch, user agent, network and CPU emulation on the tab's session while it stays controlled.
export async function clearEmulation(tab) {
  for (const [method, params] of [
    ['Emulation.clearDeviceMetricsOverride'],
    ['Emulation.setTouchEmulationEnabled', { enabled: false }],
    ['Network.setUserAgentOverride', { userAgent: '' }],
    ['Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }],
    ['Emulation.setCPUThrottlingRate', { rate: 1 }],
    ['Emulation.setScriptExecutionDisabled', { value: false }], // Lighthouse disables scripts on a page it found hung
  ]) await cdp(tab, method, params).catch(() => {});
}

// Chrome records one trace per browser, and the trace engine (shared by traces and Lighthouse) parses one trace at a
// time per process, so this server's recordings and Lighthouse runs take turns: resolves with the release function
// once the previous holder released (a holder that never did, a recording nobody stops, is skipped after 10 min).
const SLOT_WAIT_MS = 600_000;
let tracing = Promise.resolve();
export async function tracingSlot() {
  const previous = tracing;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  tracing = previous.then(() => held);
  let timer;
  await Promise.race([previous, new Promise((resolve) => { timer = setTimeout(resolve, SLOT_WAIT_MS); })]).finally(() => clearTimeout(timer));
  return release;
}

// A claimed or handed-over tab (for_user, tab_keep) is the user's own page: reloading it for a measurement would throw
// their state away.
export async function isUsersTab(tab) {
  const info = (await tab.browser.host.request('tabs.listAll', {})).find((t) => t.id === tab.tabId);
  return info?.origin === 'user' || !!info?.handedOver;
}

// Where big results go: os.tmpdir()/fowlbrowser-<kind>/, created for this user only. stamp(): 20261011-131500-123 (ms);
// with the tab id ("chrome-52") in the name, two measurements never share a file.
export function outputDir(kind) {
  const dir = path.join(os.tmpdir(), `fowlbrowser-${kind}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export const stamp = () => new Date().toISOString().slice(0, 23).replace(/[-:]/g, '').replace('T', '-').replace('.', '-');
export const fileTab = (tab) => tab.id.replace(':', '-');

// --- memory ---

// Counters (layouts, style recalcs) are left out: they only count while the Performance domain is enabled.
const METRICS = ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'Frames', 'JSEventListeners'];
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const n = (v) => v.toLocaleString('en-US');
const plus = (v, format = n) => `${v < 0 ? '-' : '+'}${format(Math.abs(v))}`;

async function readMemory(tab) {
  await cdp(tab, 'Performance.enable');
  let metrics;
  try { ({ metrics } = await cdp(tab, 'Performance.getMetrics')); } finally { await cdp(tab, 'Performance.disable').catch(() => {}); }
  const heap = await cdp(tab, 'Runtime.getHeapUsage');
  const values = Object.fromEntries(metrics.filter((m) => METRICS.includes(m.name)).map((m) => [m.name, m.value]));
  return { time: Date.now(), generation: tab.documentGeneration, embedder: heap.embedderHeapUsedSize ?? 0, ...values };
}

function memoryLines(now, last) {
  const lines = [
    `JS heap: ${mb(now.JSHeapUsedSize)} used of ${mb(now.JSHeapTotalSize)} · DOM and other engine objects: ${mb(now.embedder)}`,
    `DOM: ${n(now.Nodes)} nodes · ${n(now.JSEventListeners)} JS event listeners · ${n(now.Documents)} documents and ${n(now.Frames)} frames alive in the renderer (old ones linger until garbage collection)`,
  ];
  if (last && last.generation === now.generation) {
    const ago = Math.round((now.time - last.time) / 1000);
    lines.push(`Since the reading ${ago} s ago on this page: heap ${plus(now.JSHeapUsedSize - last.JSHeapUsedSize, mb)} · engine objects ${plus(now.embedder - last.embedder, mb)} · ` +
      `nodes ${plus(now.Nodes - last.Nodes)} · listeners ${plus(now.JSEventListeners - last.JSEventListeners)} · documents ${plus(now.Documents - last.Documents)}`);
  } else {
    lines.push('First reading of this page. Do what might leak (open and close a view, repeat an action), then call memory again: what keeps growing is what leaks.');
  }
  return lines;
}

export function registerPerf(tool, manager, helpers) {
  const { withTab, header, text, tabArg } = helpers;
  tool('memory',
    'Memory of a tab now: JS heap used and total, DOM nodes, documents, frames and JS event listeners, and the change since this tool last read the same page. ' +
    'Call it before and after the actions you suspect: a heap, node or listener count that keeps growing is a leak. ' +
    'Heap snapshots (retained objects) are not available through the extension API; for those use Chrome DevTools.',
    { tab: tabArg },
    withTab(async (tab) => {
      const now = await readMemory(tab);
      const lines = memoryLines(now, tab.memory);
      tab.memory = now;
      return text(`${await header(tab)}\n${lines.join('\n')}`);
    }));
  registerTrace(tool, manager, helpers);
  registerLighthouse(tool, manager, helpers);
}
