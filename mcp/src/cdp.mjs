// Raw CDP to a controlled tab's own session, or to one of its flattened child sessions (iframes, workers), through the
// host and the extension (never through Playwright's relay).
export function cdp(tab, method, params = {}, sessionId) {
  return tab.browser.host.request('chrome.debugger.sendCommand', [{ tabId: tab.tabId, sessionId }, method, params]);
}

// Page-side bindings of FowlBrowser's own scripts (Runtime.addBinding) are named with this prefix. Their
// Runtime.bindingCalled events never reach Playwright (it parses every binding payload as one of its own); the
// tab emits them as 'binding' (name, payload) instead.
export const BINDING_PREFIX = '__fowlbrowser';
export const isOwnBinding = (method, params) => method === 'Runtime.bindingCalled' && String(params?.name ?? '').startsWith(BINDING_PREFIX);
