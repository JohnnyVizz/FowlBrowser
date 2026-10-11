// After a detach (the user's Cancel on the debugging bar), nothing can reach the popup script over CDP any more: at its
// next decision it must see the debugger is gone, switch itself off and let the page's own open run natively.
// The scenario's raw host client plays the server here (its own tab, debugger and popup scripts), so it can detach
// the debugger itself. Exclusive: the native open after the detach comes to the front; the window gets its previous
// active tab back.
import { installPopups } from '../../mcp/src/popups.mjs';
import { sleep } from '../lib.mjs';
import { EventEmitter } from 'node:events';

export default {
  name: 'popup-detach',
  exclusive: true,
  async run(t) {
    const host = await t.host();
    const all = () => host.request('tabs.listAll', {});
    const send = (tabId, method, params = {}) => host.request('chrome.debugger.sendCommand', [{ tabId }, method, params]);
    const opened = [];
    let previous;
    try {
      t.step('a tab of our own, attached, with the popup scripts');
      const { id: tabId } = await host.request('tabs.open', { url: 'about:blank' });
      opened.push(tabId);
      const windowId = (await all()).find(x => x.id === tabId).windowId;
      previous = (await all()).find(x => x.windowId === windowId && x.active)?.id;
      await host.request('chrome.debugger.attach', [{ tabId }]);
      // Playwright's job in the server: page scripts run, and bindings go into new contexts, only with these on.
      await send(tabId, 'Page.enable');
      await send(tabId, 'Runtime.enable');
      // A tier 1 open's blank child is attached before it is navigated.
      const waitForTab = async (id) => { await host.request('chrome.debugger.attach', [{ tabId: id }]); return { tabId: id, browser: { host } }; };
      const tab = Object.assign(new EventEmitter(), { tabId, browser: { host, waitForTab },
        page: Object.assign(new EventEmitter(), { frames: () => [], url: () => `${t.site}/detach.html` }) });
      // The page's reports, as the server's Tab hears them (a tier 1 open becomes tabs.openChild).
      host.on('chrome.debugger.onEvent', ([source, method, params]) => {
        if (source.tabId === tabId && method === 'Runtime.bindingCalled') tab.emit('binding', params.name, params.payload);
      });
      await installPopups(tab);
      await send(tabId, 'Page.navigate', { url: `${t.site}/detach.html?tag=${t.tag}` });
      await t.until(async () => (await send(tabId, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })).result?.value === 'complete', 'page loaded');
      const box = (await send(tabId, 'Runtime.evaluate', { expression: 'JSON.stringify(document.getElementById("later").getBoundingClientRect())', returnByValue: true })).result.value;
      const { x, y, width, height } = JSON.parse(box);
      const click = async () => {
        for (const type of ['mousePressed', 'mouseReleased']) await send(tabId, 'Input.dispatchMouseEvent', { type, x: x + width / 2, y: y + height / 2, button: 'left', clickCount: 1 });
      };
      const popup = async (via) => t.until(async () => (await all()).find(x => x.url.includes(`via=${via}&tag=${t.tag}`)), `${via}: opened`);
      // Throws with what it saw, so a timeout reports it.
      const titled = (expected) => async () => {
        const seen = (await all()).find(x => x.id === tabId).title;
        if (seen !== expected) throw new Error(`title "${seen}"`);
        return true;
      };

      t.step('attached: the open goes the popup script\'s way (a background tab)');
      await click();
      const first = await popup('detach-1');
      opened.push(first.id);
      t.eq(first.active, false, 'detach-1: in the background');
      await t.until(titled('detach-1 wrapped'), 'detach-1: the wrapper in place');

      t.step('detached before the open runs: native, and the wrapper switched itself off');
      // As when the user presses Cancel: the tab is in front (a background tab's timers may not run once detached).
      await host.request('tabs.focus', { tabId });
      await click();
      await host.request('chrome.debugger.detach', [{ tabId }]);
      await t.until(titled('detach-2 native'), 'detach-2: window.open native again, with no CDP');
      const second = await popup('detach-2');
      opened.push(second.id);
    } finally {
      if (previous !== undefined) await host.request('tabs.focus', { tabId: previous }).catch(() => {});
      await sleep(200);
      for (const id of opened) {
        await host.request('chrome.tabs.remove', [id]).catch(() => host.request('tabs.closeUnowned', { tabId: id })).catch(() => {});
      }
    }
  },
};
