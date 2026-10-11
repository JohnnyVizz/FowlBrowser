// Run: node --test extension/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore, colorFor } from '../core.js';

function fakeChrome({ session = {}, local = {} } = {}) {
  const tabs = new Map();
  const calls = [];
  let nextTabId = 100;
  let nextGroupId = 1;
  const groupsById = new Map();
  const hooks = {};
  const gates = new Map(); // method name -> promise the next calls wait on (see gate())
  const wait = (name) => gates.get(name);
  const store = (data) => ({
    async get(keys) {
      return Object.fromEntries([keys].flat().filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
  });
  const addTab = (props) => {
    const tab = { id: nextTabId++, windowId: 1, index: tabs.size, url: 'about:blank', title: '', active: false,
      pinned: false, incognito: false, groupId: -1, mutedInfo: { muted: false }, status: 'complete', ...props };
    tabs.set(tab.id, tab);
    return tab;
  };
  const getTab = (id) => {
    const tab = tabs.get(id);
    if (!tab) throw new Error(`No tab with id: ${id}`);
    return tab;
  };
  const chrome = {
    calls, tabsById: tabs, groupsById, hooks, gates, addTab, session, local,
    storage: { session: store(session), local: store(local) },
    runtime: { id: 'fowlbrowser-ext', getManifest: () => ({ version: '0.1.0' }), reload: () => calls.push(['reload']) },
    windows: {
      async getLastFocused() { return { id: 1, type: 'normal', incognito: false }; },
      async getAll({ windowTypes } = {}) {
        const ids = new Set([1, ...[...tabs.values()].map((t) => t.windowId)]);
        return [...ids].map((id) => ({ id, type: 'normal', incognito: false, ...hooks.windows?.[id] }))
          .filter((w) => !windowTypes || windowTypes.includes(w.type));
      },
      async get(id) { return { id, type: 'normal', state: 'normal', incognito: false, ...hooks.windows?.[id] }; },
      async create(props) { calls.push(['windows.create', props]); return { id: 2, tabs: [addTab({ windowId: 2 })] }; },
      async update(id, props) { calls.push(['windows.update', id, props]); },
    },
    tabs: {
      async query(q) { return [...tabs.values()].filter((t) => (!q.active || t.active) && (q.groupId === undefined || t.groupId === q.groupId)); },
      async get(id) { await wait('tabs.get'); return structuredClone(getTab(id)); },
      async create(props) {
        calls.push(['tabs.create', props]);
        await wait('tabs.create');
        return structuredClone(addTab({ windowId: props.windowId, url: props.url, active: props.active }));
      },
      async update(id, props) {
        calls.push(['tabs.update', id, props]);
        const tab = getTab(id);
        if ('muted' in props) tab.mutedInfo = { muted: props.muted, reason: 'extension', extensionId: chrome.runtime.id };
        if ('url' in props) tab.url = props.url;
        if ('active' in props) tab.active = props.active;
        if ('autoDiscardable' in props) tab.autoDiscardable = props.autoDiscardable;
        return structuredClone(tab);
      },
      async remove(ids) {
        for (const id of [ids].flat()) {
          const tab = getTab(id);
          if (hooks.failRemove?.has(id)) throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
          tabs.delete(id);
          calls.push(['tabs.remove', id]);
          await hooks.onRemoved?.(id, { windowId: tab.windowId, isWindowClosing: false });
        }
      },
      async group({ groupId, tabIds }) {
        await wait('tabs.group');
        if (hooks.groupError) throw new Error(hooks.groupError);
        const id = groupId ?? nextGroupId++;
        if (groupId === undefined) groupsById.set(id, { id, title: '', collapsed: false });
        for (const t of tabIds) getTab(t).groupId = id;
        calls.push(['tabs.group', tabIds, id]);
        return id;
      },
      async ungroup(ids) { for (const id of [ids].flat()) getTab(id).groupId = -1; calls.push(['tabs.ungroup', ids]); },
    },
    tabGroups: {
      async update(id, props) { calls.push(['tabGroups.update', id, props]); Object.assign(groupsById.get(id) ?? {}, props); },
      async get(id) { return structuredClone(groupsById.get(id)); },
      async query() { return structuredClone([...groupsById.values()]); },
    },
    debugger: {
      async attach(target) {
        calls.push(['debugger.attach', target.tabId]);
        if (hooks.attachError) throw new Error(hooks.attachError);
      },
      async detach(target) { calls.push(['debugger.detach', target.tabId]); await wait('debugger.detach'); },
      async sendCommand(target, method, params) { calls.push(['debugger.sendCommand', target.tabId, method]); return { ok: method }; },
    },
  };
  return chrome;
}

// Makes calls to `name` wait until the returned function is called.
function gate(chrome, name) {
  let open;
  chrome.gates.set(name, new Promise((resolve) => { open = resolve; }));
  return () => { chrome.gates.delete(name); open(); };
}

// Timers that only fire when the test says so.
function manualTimers() {
  const pending = new Set();
  return {
    setTimeout(fn, ms) { const timer = { fn, ms }; pending.add(timer); return timer; },
    clearTimeout(timer) { pending.delete(timer); },
    async fire(ms) {
      for (const timer of [...pending]) if (timer.ms === ms) { pending.delete(timer); await timer.fn(); }
    },
    pending,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options = {}) {
  const chrome = fakeChrome(options);
  const sent = [];
  const core = createCore({ chrome, timers: options.timers, send: (msg) => msg.method !== 'extension.log' && sent.push(msg) });
  chrome.hooks.onRemoved = core.onTabRemoved;
  const connected = new Set();
  const connect = (client) => {
    connected.add(client);
    return core.handleMessage({ method: 'host.clientConnected', params: { client } });
  };
  let nextId = 1;
  // Sends the request; `call` waits for it, `start` returns the pending request and a reply getter.
  const start = (client, method, params) => {
    const id = nextId++;
    if (!connected.has(client)) void connect(client);
    const done = core.handleMessage({ id, method, params, client });
    return { done, reply: () => sent.find((m) => m.id === id) };
  };
  const call = async (client, method, params) => {
    const request = start(client, method, params);
    await request.done;
    return request.reply();
  };
  return { chrome, core, sent, call, start, connect };
}

test('only the owner may drive a tab', async () => {
  const { call } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://example.com' });

  assert.equal((await call(2, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error.message,
    `Tab ${tab.id} is not owned by this client`);
  assert.ok((await call(2, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.reload'])).error);
  assert.ok((await call(2, 'chrome.tabs.remove', [tab.id])).error);
  assert.ok((await call(2, 'tabs.release', { tabId: tab.id })).error);
  assert.match((await call(2, 'tabs.claim', { tabId: tab.id })).error.message, /owned by another client/);

  assert.ok(!(await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);
  assert.deepEqual((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.reload'])).result,
    { ok: 'Page.reload' });
});

test('tabs.open makes a muted background tab in a collapsed group and tells the client', async () => {
  const { chrome, call, sent } = setup();
  await call(1, 'client.hello', { label: 'Research' });
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://example.com' });

  assert.deepEqual(chrome.calls.find((c) => c[0] === 'tabs.create')[1], { windowId: 1, url: 'https://example.com', active: false });
  assert.deepEqual(chrome.calls.find((c) => c[0] === 'tabs.update')[2], { muted: true, autoDiscardable: false });
  assert.deepEqual(chrome.calls.find((c) => c[0] === 'tabGroups.update')[2], { title: 'Research', color: colorFor('Research'), collapsed: true });
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === tab.id));
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.update' && c[2].active));

  const { result: second } = await call(1, 'chrome.tabs.create', [{ url: 'https://example.org' }]);
  assert.equal(chrome.tabsById.get(second.id).groupId, chrome.tabsById.get(tab.id).groupId);
  assert.ok(!sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === second.id));
});

test('events go to the client that owns the tab', async () => {
  const { core, sent, call, chrome } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  const stranger = chrome.addTab({ url: 'https://user.example' });
  sent.length = 0;

  await core.onDebuggerEvent({ tabId: tab.id }, 'Page.loadEventFired', { timestamp: 1 });
  await core.onDebuggerEvent({ tabId: stranger.id }, 'Page.loadEventFired', {});
  await core.onDebuggerDetach({ tabId: tab.id }, 'canceled_by_user');
  assert.deepEqual(sent, [
    { method: 'chrome.debugger.onEvent', params: [{ tabId: tab.id }, 'Page.loadEventFired', { timestamp: 1 }], client: 1 },
    { method: 'chrome.debugger.onDetach', params: [{ tabId: tab.id }, 'canceled_by_user'], client: 1 },
  ]);

  sent.length = 0;
  await chrome.tabs.remove(tab.id);
  assert.deepEqual(sent, [{ method: 'chrome.tabs.onRemoved', params: [tab.id, { windowId: 1, isWindowClosing: false }], client: 1 }]);
  assert.equal(core.owners.has(tab.id), false);
});

test('a tab opened by an owned tab is adopted and the user keeps their active tab', async () => {
  const { core, sent, call, chrome } = setup();
  const userTab = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: userTab.id, windowId: 1 });
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://example.com' });
  sent.length = 0;

  // Chrome opened the popup in the foreground.
  chrome.tabsById.get(userTab.id).active = false;
  const child = chrome.addTab({ openerTabId: opener.id, active: true, url: 'https://example.com/popup' });
  await core.onTabActivated({ tabId: child.id, windowId: 1 });
  await core.onTabCreated(structuredClone(child));
  await core.onNavigationTarget({ sourceTabId: opener.id, tabId: child.id });

  assert.deepEqual(core.owners.get(child.id), { client: 1, origin: 'agent', group: 'Claude', kept: false });
  assert.ok(chrome.calls.some((c) => c[0] === 'tabs.update' && c[1] === userTab.id && c[2].active === true));
  assert.equal(chrome.tabsById.get(userTab.id).active, true);
  assert.equal(chrome.tabsById.get(child.id).mutedInfo.muted, true);
  assert.equal(chrome.tabsById.get(child.id).groupId, chrome.tabsById.get(opener.id).groupId);
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === child.id));

  // Tabs opened from unowned tabs stay the user's.
  const userChild = chrome.addTab({ openerTabId: userTab.id });
  await core.onTabCreated(structuredClone(userChild));
  assert.equal(core.owners.has(userChild.id), false);
});

test('a popup Chrome activates after Page.windowOpen is switched back inside the onCreated listener, once', async () => {
  const { core, call, chrome } = setup();
  const userTab = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: userTab.id, windowId: 1 });
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://example.com' });
  await call(1, 'tabs.expectChild', { tabId: opener.id, ms: 3000 });
  const switchedBack = () => chrome.calls.filter((c) => c[0] === 'tabs.update' && c[2].active === true);

  // Not armed: the user's own new tab (or a popup of a tab nobody drives) is left alone.
  core.onTabCreated(structuredClone(chrome.addTab({ active: true, url: 'https://elsewhere.example' })));
  assert.equal(switchedBack().length, 0);

  await core.onDebuggerEvent({ tabId: opener.id }, 'Page.windowOpen', { url: 'https://idp.example/auth' });
  // The user's Cmd+T in the armed window is theirs.
  core.onTabCreated(structuredClone(chrome.addTab({ active: true, url: 'chrome://newtab/' })));
  assert.equal(switchedBack().length, 0);

  const popup = chrome.addTab({ active: true, url: '' });
  core.onTabCreated(structuredClone(popup)); // not awaited: the switch is issued synchronously
  assert.deepEqual(switchedBack().map((c) => c[1]), [userTab.id]);

  // Used up: a second new active tab is the user's.
  core.onTabCreated(structuredClone(chrome.addTab({ active: true, url: '' })));
  assert.equal(switchedBack().length, 1);

  // A claimed tab arms only inside its expectChild window (the agent's own click).
  const { result: claimed } = await call(1, 'tabs.claim', { tabId: userTab.id });
  await core.onDebuggerEvent({ tabId: claimed.id }, 'Page.windowOpen', { url: 'https://user.example/' });
  core.onTabCreated(structuredClone(chrome.addTab({ active: true, url: '' })));
  assert.equal(switchedBack().length, 1);
});

test('client disconnect closes agent tabs, ungroups kept ones and releases claimed ones', async () => {
  const { core, call, chrome } = setup();
  const { result: agentTab } = await call(1, 'tabs.open', {});
  const { result: keptTab } = await call(1, 'tabs.open', {});
  await call(1, 'tabs.keep', { tabId: keptTab.id });
  const userTab = chrome.addTab({ url: 'https://user.example' });
  await call(1, 'tabs.claim', { tabId: userTab.id });
  const { result: otherTab } = await call(2, 'tabs.open', {});

  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });

  assert.equal(chrome.tabsById.has(agentTab.id), false);
  assert.equal(chrome.tabsById.get(keptTab.id).groupId, -1);
  assert.ok(chrome.tabsById.has(userTab.id));
  assert.ok(chrome.calls.some((c) => c[0] === 'debugger.detach' && c[1] === userTab.id));
  assert.deepEqual([...core.owners.keys()], [otherTab.id]);
  assert.deepEqual(Object.keys(chrome.session.owners), [String(otherTab.id)]);
});

test('claim refuses browser pages and turns a new tab page into about:blank', async () => {
  const { call, chrome } = setup();
  const settings = chrome.addTab({ url: 'chrome://settings/' });
  const store = chrome.addTab({ url: 'https://chromewebstore.google.com/detail/x' });
  const ntp = chrome.addTab({ url: 'chrome://newtab/' });

  assert.match((await call(1, 'tabs.claim', { tabId: settings.id })).error.message, /can't be controlled/);
  assert.ok((await call(1, 'tabs.claim', { tabId: store.id })).error);
  const { result } = await call(1, 'tabs.claim', { tabId: ntp.id });
  assert.equal(result.url, 'about:blank');
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.update' && c[2].active));
});

test('chunked host messages are reassembled', async () => {
  const { sent, core, connect } = setup();
  await connect(1);
  const json = JSON.stringify({ id: 7, method: 'extension.info', params: {}, client: 1 });
  const parts = [json.slice(0, 10), json.slice(10, 30), json.slice(30)];
  await core.handleMessage({ method: 'host.chunk', params: { id: 'c1', index: 0, total: 3, data: parts[0] } });
  await core.handleMessage({ method: 'host.chunk', params: { id: 'c1', index: 1, total: 3, data: parts[1] } });
  assert.equal(sent.length, 0);
  await core.handleMessage({ method: 'host.chunk', params: { id: 'c1', index: 2, total: 3, data: parts[2] } });
  assert.equal(sent[0].id, 7);
  assert.equal(sent[0].result.version, '0.1.0');
});

test('a restarted worker cleans up what the previous worker owned', async () => {
  const chrome = fakeChrome();
  const agentTab = chrome.addTab({});
  const userTab = chrome.addTab({});
  Object.assign(chrome.session, {
    owners: { [agentTab.id]: { client: 3, origin: 'agent', group: 'Claude', kept: false },
      [userTab.id]: { client: 3, origin: 'user', group: null, kept: false } },
    labels: { 3: 'Claude' },
  });
  const core = createCore({ chrome, send: () => {} });
  await core.ready;
  assert.equal(chrome.tabsById.has(agentTab.id), false);
  assert.ok(chrome.tabsById.has(userTab.id));
  assert.equal(core.owners.size, 0);
});

test('only clients the host announced are served, and chunks never carry host messages', async () => {
  const { core, sent, connect, call, chrome } = setup();
  await core.handleMessage({ id: 'stranger', method: 'tabs.open', params: {}, client: 9 });
  assert.equal(sent.find((m) => m.id === 'stranger').error.message, 'Unknown client');
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.create'));

  const { result: tab } = await call(1, 'tabs.open', {});
  await connect(2);
  const smuggled = JSON.stringify({ method: 'host.clientDisconnected', params: { client: 1 } });
  await core.handleMessage({ method: 'host.chunk', params: { id: 'c', index: 0, total: 1, data: smuggled } });
  assert.ok(core.owners.has(tab.id));
  assert.ok(chrome.tabsById.has(tab.id));
});

test('a client that disconnects mid-open gets no tab: the late tab is closed', async () => {
  const { core, chrome, start } = setup();
  const release = gate(chrome, 'tabs.create');
  const request = start(1, 'tabs.open', {});
  await tick();
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  release();
  await request.done;
  assert.equal(request.reply().error.message, 'Client disconnected');
  assert.equal(core.owners.size, 0);
  assert.equal(chrome.tabsById.size, 0);
});

test('a client that disconnects mid-claim never owns the tab', async () => {
  const { core, chrome, start } = setup();
  const userTab = chrome.addTab({ url: 'https://user.example' });
  const release = gate(chrome, 'tabs.get');
  const request = start(1, 'tabs.claim', { tabId: userTab.id });
  await tick();
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  release();
  await request.done;
  assert.equal(request.reply().error.message, 'Client disconnected');
  assert.equal(core.owners.size, 0);
  assert.ok(chrome.tabsById.has(userTab.id));
});

test('replies and tabs from before a native port reconnect never reach the new port', async () => {
  const { core, chrome, sent, start, call } = setup();
  const release = gate(chrome, 'tabs.create');
  const request = start(1, 'tabs.open', {});
  await tick();
  const closing = core.portClosed();
  // The new host restarts client and request ids: client 1 is someone else now.
  await call(1, 'client.hello', { label: 'New' });
  sent.length = 0;
  release();
  await request.done;
  await closing;
  assert.equal(request.reply(), undefined);
  assert.deepEqual(sent.filter((m) => m.client === 1), []);
  assert.equal(core.owners.size, 0);
  assert.equal(chrome.tabsById.size, 0);
});

test('a tab being released stays reserved until its cleanup is done', async () => {
  const { core, chrome, call, start } = setup();
  const userTab = chrome.addTab({ url: 'https://user.example' });
  await call(1, 'tabs.claim', { tabId: userTab.id });

  const release = gate(chrome, 'debugger.detach');
  const releasing = start(1, 'tabs.release', { tabId: userTab.id });
  await tick();
  assert.match((await call(2, 'tabs.claim', { tabId: userTab.id })).error.message, /being released/);
  assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: userTab.id }, 'Page.reload'])).error.message, /being released/);
  release();
  await releasing.done;
  assert.deepEqual(releasing.reply().result, { ok: true });
  assert.equal(core.owners.has(userTab.id), false);

  // Disconnect cleanup: the same reservation, and the detach never lands on a later owner.
  await call(2, 'tabs.claim', { tabId: userTab.id });
  const release2 = gate(chrome, 'debugger.detach');
  const cleanup = core.handleMessage({ method: 'host.clientDisconnected', params: { client: 2 } });
  await tick();
  assert.match((await call(3, 'tabs.claim', { tabId: userTab.id })).error.message, /being released/);
  assert.equal(chrome.session.owners[userTab.id].client, 2, 'ownership stays stored until cleanup finishes');
  release2();
  await cleanup;
  assert.equal(core.owners.has(userTab.id), false);
  const detaches = chrome.calls.filter((c) => c[0] === 'debugger.detach').length;
  assert.ok(!(await call(3, 'tabs.claim', { tabId: userTab.id })).error);
  assert.equal(chrome.calls.filter((c) => c[0] === 'debugger.detach').length, detaches);
  assert.equal(core.owners.get(userTab.id).client, 3);
});

test('a popup belongs to the tab webNavigation names, not to a wrong openerTabId', async () => {
  const timers = manualTimers();
  const { core, chrome, call, sent } = setup({ timers });
  const { result: tabA } = await call(1, 'tabs.open', {});
  const { result: tabB } = await call(2, 'tabs.open', {});
  sent.length = 0;

  // Helium names B's tab (the active one) as opener of A's popup.
  const popup = chrome.addTab({ openerTabId: tabB.id, url: 'https://example.com/popup' });
  await core.onTabCreated(structuredClone(popup));
  assert.equal(core.owners.has(popup.id), false, 'not adopted before the navigation target arrives');
  await core.onNavigationTarget({ sourceTabId: tabA.id, tabId: popup.id });
  await tick();
  assert.equal(core.owners.get(popup.id).client, 1);
  assert.equal(chrome.tabsById.get(popup.id).mutedInfo.muted, true);
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === popup.id));
  assert.ok(!sent.some((m) => m.client === 2 && m.params?.[0]?.id === popup.id));

  // A navigation target from the user's tab keeps the popup the user's, whatever openerTabId says.
  const userTab = chrome.addTab({ url: 'https://mail.example' });
  const userPopup = chrome.addTab({ openerTabId: tabB.id });
  await core.onTabCreated(structuredClone(userPopup));
  await core.onNavigationTarget({ sourceTabId: userTab.id, tabId: userPopup.id });
  await timers.fire(750);
  assert.equal(core.owners.has(userPopup.id), false);

  // Without a navigation target the popup is never adopted, whatever openerTabId says.
  const late = chrome.addTab({ openerTabId: tabB.id });
  await core.onTabCreated(structuredClone(late));
  await timers.fire(750);
  assert.equal(core.owners.has(late.id), false);
});

test('a replaced tab keeps its owner and the client hears about the swap', async () => {
  const { core, chrome, call, sent } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  const replacement = chrome.addTab({ url: 'https://example.com/prerendered' });
  chrome.tabsById.delete(tab.id);
  sent.length = 0;
  await core.onTabReplaced(replacement.id, tab.id);
  assert.equal(core.owners.has(tab.id), false);
  assert.equal(core.owners.get(replacement.id).client, 1);
  assert.deepEqual(Object.keys(chrome.session.owners), [String(replacement.id)]);
  assert.deepEqual(sent.map((m) => [m.method, m.client, m.params[0]?.id ?? m.params[0]]), [
    ['chrome.tabs.onRemoved', 1, tab.id],
    ['chrome.tabs.onCreated', 1, replacement.id],
  ]);
});

test('a debugger taken away by the user stays owned and re-attaches only on an explicit claim', async () => {
  const { core, chrome, call, sent } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  const createdEvents = () => sent.filter((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === tab.id).length;

  assert.ok(!(await call(1, 'tabs.claim', { tabId: tab.id })).error);
  assert.equal(createdEvents(), 1, 'claiming an attached tab you own emits nothing');

  await core.onDebuggerDetach({ tabId: tab.id }, 'canceled_by_user');
  assert.equal(core.owners.get(tab.id).detached, true);
  assert.ok(!chrome.calls.some((c) => c[0] === 'debugger.attach'), 'never re-attaches on its own');
  assert.match((await call(2, 'tabs.claim', { tabId: tab.id })).error.message, /owned by another client/);
  assert.ok(!(await call(1, 'tabs.claim', { tabId: tab.id })).error);
  assert.equal(createdEvents(), 2);
  // The re-attach fails (DevTools still open): the tab stays detached, so a later claim can retry.
  chrome.hooks.attachError = 'Cannot attach to this target';
  assert.ok((await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);
  assert.equal(core.owners.get(tab.id).detached, true);
  assert.ok(!(await call(1, 'tabs.claim', { tabId: tab.id })).error);
  assert.equal(createdEvents(), 3);
  delete chrome.hooks.attachError;
  assert.ok(!(await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);
  assert.ok(!core.owners.get(tab.id).detached);
  assert.ok(!(await call(1, 'tabs.claim', { tabId: tab.id })).error);
  assert.equal(createdEvents(), 3);

  await core.onDebuggerDetach({ tabId: tab.id }, 'target_closed');
  assert.ok(!core.owners.get(tab.id).detached);
});

test('CDP commands that reach beyond the tab are refused for every client', async () => {
  const { call, chrome, core } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  for (const method of ['Browser.close', 'Browser.grantPermissions', 'Target.createTarget', 'Target.closeTarget',
    'Target.attachToBrowserTarget', 'Target.exposeDevToolsProtocol', 'Target.createBrowserContext',
    'Target.disposeBrowserContext', 'Network.clearBrowserCookies', 'Network.clearBrowserCache',
    'Storage.clearDataForOrigin', 'Storage.clearDataForStorageKey', 'Storage.clearCookies', 'Storage.setCookies',
    'Storage.clearSharedStorageEntries',
    // focus theft, other targets, profile-wide cookie and storage writes
    'Page.bringToFront', 'Target.activateTarget', 'Target.setDiscoverTargets', 'Target.getTargets',
    'Network.setCookie', 'Network.setCookies', 'Network.deleteCookies',
    'DOMStorage.clear', 'DOMStorage.removeDOMStorageItem', 'DOMStorage.setDOMStorageItem',
    'IndexedDB.deleteDatabase', 'IndexedDB.clearObjectStore', 'IndexedDB.deleteObjectStoreEntries',
    'CacheStorage.deleteCache', 'CacheStorage.deleteEntry',
    'ServiceWorker.unregister', 'ServiceWorker.skipWaiting', 'ServiceWorker.stopAllWorkers', 'ServiceWorker.startWorker',
    'Storage.setSharedStorageEntry', 'Storage.overrideQuotaForOrigin', 'Storage.clearTrustTokens',
    'Storage.deleteSharedStorageEntry', 'Storage.runBounceTrackingMitigations']) {
    const reply = await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, method, {}]);
    assert.match(reply.error?.message ?? '', /is blocked/, method);
  }
  // Target.attachToTarget / sendMessageToTarget only reach the tab's own children.
  for (const [method, params] of [['Target.attachToTarget', { targetId: 'other-tab', flatten: true }],
    ['Target.sendMessageToTarget', { targetId: 'other-tab', message: '{}' }],
    ['Target.sendMessageToTarget', { sessionId: 'other-session', message: '{}' }],
    ['Target.attachToTarget', {}]]) {
    const reply = await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, method, params]);
    assert.match(reply.error?.message ?? '', /is blocked/, `${method} ${JSON.stringify(params)}`);
  }
  assert.ok(!chrome.calls.some((c) => c[0] === 'debugger.sendCommand'));
  await core.onDebuggerEvent({ tabId: tab.id }, 'Target.attachedToTarget',
    { sessionId: 'child-session', targetInfo: { targetId: 'child-frame', type: 'iframe' } });
  assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Target.attachToTarget', { targetId: 'child-frame', flatten: true }])).error);
  // Non-flat sessions would carry commands past the filter: refused even for the tab's own child.
  assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Target.attachToTarget', { targetId: 'child-frame' }])).error?.message ?? '', /is blocked/);
  assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Target.sendMessageToTarget', { sessionId: 'child-session', message: '{}' }])).error?.message ?? '', /is blocked/);
  // Another tab's children are not this tab's.
  const { result: other } = await call(1, 'tabs.open', {});
  assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: other.id }, 'Target.attachToTarget', { targetId: 'child-frame', flatten: true }])).error?.message ?? '', /is blocked/);
  for (const method of ['Network.getCookies', 'Network.getAllCookies', 'Network.enable', 'Storage.getCookies',
    'IndexedDB.requestDatabaseNames', 'IndexedDB.enable', 'DOMStorage.getDOMStorageItems', 'CacheStorage.requestCacheNames',
    'ServiceWorker.enable', 'Storage.trackCacheStorageForOrigin', 'Target.getTargetInfo', 'Target.detachFromTarget',
    'Page.navigate', 'Runtime.evaluate']) {
    assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, method, {}])).error, method);
  }
  assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id, sessionId: 'child' }, 'Target.setAutoAttach', {}])).error);
});

test("the user's new tab from a claimed tab is left alone", async () => {
  const timers = manualTimers();
  const { core, chrome, call, sent } = setup({ timers });
  const gmail = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: gmail.id, windowId: 1 });
  await call(1, 'tabs.claim', { tabId: gmail.id });
  sent.length = 0;
  const calls = chrome.calls.length;

  const mine = chrome.addTab({ openerTabId: gmail.id, active: true });
  await core.onTabCreated(structuredClone(mine));
  await core.onNavigationTarget({ sourceTabId: gmail.id, tabId: mine.id });
  await timers.fire(750);
  assert.equal(core.owners.has(mine.id), false);
  assert.deepEqual(chrome.calls.slice(calls), [], 'not activated away, muted or grouped');
  assert.deepEqual(sent, []);

  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  assert.ok(chrome.tabsById.has(mine.id));
});

test('parallel tabs.open calls share one group', async () => {
  const { chrome, call, start } = setup();
  await call(1, 'client.hello', { label: 'Fan' });
  const release = gate(chrome, 'tabs.group');
  const requests = [1, 2, 3, 4].map(() => start(1, 'tabs.open', {}));
  await tick();
  release();
  await Promise.all(requests.map((r) => r.done));
  const ids = requests.map((r) => r.reply().result.id);
  assert.equal(new Set(ids.map((id) => chrome.tabsById.get(id).groupId)).size, 1);
  assert.equal(chrome.groupsById.size, 1);
});

test('an adopted popup folds its expanded group back up', async () => {
  const { core, chrome, call } = setup();
  const { result: opener } = await call(1, 'tabs.open', {});
  const groupId = chrome.tabsById.get(opener.id).groupId;
  chrome.groupsById.get(groupId).collapsed = false; // Chrome expanded it when the popup took focus
  const popup = chrome.addTab({ openerTabId: opener.id, groupId, active: true });
  await core.onNavigationTarget({ sourceTabId: opener.id, tabId: popup.id });
  assert.equal(core.owners.get(popup.id).client, 1);
  assert.equal(chrome.groupsById.get(groupId).collapsed, true);
});

test('kept and released agent tabs are unmuted and discardable again', async () => {
  const { core, chrome, call } = setup();
  const { result: kept } = await call(1, 'tabs.open', {});
  const { result: released } = await call(1, 'tabs.open', {});
  await call(1, 'tabs.keep', { tabId: kept.id });
  const handedOver = chrome.tabsById.get(kept.id);
  assert.deepEqual([handedOver.mutedInfo.muted, handedOver.autoDiscardable, handedOver.groupId], [true, true, -1],
    'handed over right away, still muted while the agent drives it');
  assert.equal(core.owners.get(kept.id).client, 1, 'still driven by the client');
  assert.equal(chrome.session.owners[kept.id].agentMuted, true, 'persisted');
  await call(1, 'tabs.release', { tabId: released.id });
  // The user mutes the kept tab themselves before the session ends: the session end must not undo that.
  chrome.tabsById.get(kept.id).mutedInfo = { muted: true, reason: 'user' };
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  assert.equal(chrome.tabsById.get(kept.id).mutedInfo.muted, true, "the user's own mute stays");
  for (const id of [kept.id, released.id]) {
    const tab = chrome.tabsById.get(id);
    assert.equal(tab.autoDiscardable, true);
    assert.equal(tab.groupId, -1);
  }
  assert.equal(chrome.tabsById.get(released.id).mutedInfo.muted, false);
});

test('tabs.keep keeps a muted work tab muted until control ends; an unmuted one is left as it is', async () => {
  const { core, chrome, call } = setup();
  const { result: muted } = await call(1, 'tabs.open', {});
  const { result: loud } = await call(1, 'tabs.open', { muted: false });
  await call(1, 'tabs.keep', { tabId: muted.id });
  await call(1, 'tabs.keep', { tabId: loud.id });
  assert.equal(chrome.tabsById.get(muted.id).mutedInfo.muted, true, 'muted while the agent still drives it');
  assert.equal(core.owners.get(muted.id).agentMuted, true);
  assert.equal(chrome.tabsById.get(loud.id).mutedInfo.muted, false);
  assert.ok(!core.owners.get(loud.id).agentMuted);
  await call(1, 'tabs.release', { tabId: muted.id });
  assert.equal(chrome.tabsById.get(muted.id).mutedInfo.muted, false, 'unmuted on release');
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  assert.deepEqual([muted.id, loud.id].map((id) => chrome.tabsById.has(id)), [true, true], 'both stay open');
});

test('tabs.open forUser makes a tab like their own that stays after the session', async () => {
  const { core, chrome, call, sent } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://x.com/notifications', forUser: true });
  const live = chrome.tabsById.get(tab.id);
  assert.deepEqual([live.mutedInfo.muted, live.groupId, live.active], [true, -1, false], 'muted while the agent drives it');
  assert.equal(core.owners.get(tab.id).agentMuted, true);
  assert.equal(chrome.session.owners[tab.id].agentMuted, true, 'persisted');
  assert.deepEqual(chrome.calls.filter((c) => c[0] === 'tabs.update' && c[1] === tab.id).map((c) => c[2]), [{ muted: true }],
    'no autoDiscardable change');
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === tab.id));
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  assert.ok(chrome.tabsById.has(tab.id), 'kept');
  assert.equal(chrome.tabsById.get(tab.id).mutedInfo.muted, false, 'unmuted when control ends');
  assert.equal(core.owners.has(tab.id), false);
});

test('a forUser tab is unmuted on release only while its agent mute is still on', async () => {
  const { core, chrome, call } = setup();
  const { result: plain } = await call(1, 'tabs.open', { forUser: true });
  const { result: userMuted } = await call(1, 'tabs.open', { forUser: true });
  const { result: userUnmuted } = await call(1, 'tabs.open', { forUser: true });
  chrome.tabsById.get(userMuted.id).mutedInfo = { muted: true, reason: 'user' }; // The user toggles them themselves
  chrome.tabsById.get(userUnmuted.id).mutedInfo = { muted: false, reason: 'user' };
  for (const tab of [plain, userMuted, userUnmuted]) assert.ok(!(await call(1, 'tabs.release', { tabId: tab.id })).error);
  assert.deepEqual([plain, userMuted, userUnmuted].map((t) => chrome.tabsById.get(t.id).mutedInfo),
    [{ muted: false, reason: 'extension', extensionId: 'fowlbrowser-ext' }, { muted: true, reason: 'user' }, { muted: false, reason: 'user' }]);
  assert.equal(core.owners.size, 0);
});

test("tabs.setMuted makes a forUser tab's mute the agent's choice; tabs.focus unmutes it", async () => {
  const { core, chrome, call } = setup();
  const { result: silenced } = await call(1, 'tabs.open', { forUser: true });
  const { result: shown } = await call(1, 'tabs.open', { forUser: true });
  await call(1, 'tabs.setMuted', { tabId: silenced.id, muted: true });
  assert.equal(core.owners.get(silenced.id).agentMuted, undefined);
  assert.equal(chrome.session.owners[silenced.id].agentMuted, undefined, 'persisted');
  await call(1, 'tabs.focus', { tabId: shown.id });
  assert.equal(chrome.tabsById.get(shown.id).mutedInfo.muted, false, 'the user asked to see it');
  assert.equal(core.owners.get(shown.id).agentMuted, undefined);
  chrome.tabsById.get(shown.id).mutedInfo = { muted: true, reason: 'extension', extensionId: 'fowlbrowser-ext' };
  await call(1, 'tabs.release', { tabId: silenced.id });
  await call(1, 'tabs.release', { tabId: shown.id });
  assert.equal(chrome.tabsById.get(silenced.id).mutedInfo.muted, true, "the agent's explicit mute stays");
  assert.equal(chrome.tabsById.get(shown.id).mutedInfo.muted, true, 'release no longer touches it');
});

test("tabs.closeUnowned closes the user's tab without attaching, and refuses owned tabs", async () => {
  const { chrome, call } = setup();
  const userTab = chrome.addTab({ url: 'https://www.youtube.com/watch?v=1' });
  const { result: mine } = await call(1, 'tabs.open', {});
  const { result: theirs } = await call(2, 'tabs.open', {});
  assert.match((await call(1, 'tabs.closeUnowned', { tabId: theirs.id })).error.message, /owned by another client/);
  assert.match((await call(1, 'tabs.closeUnowned', { tabId: mine.id })).error.message, /controlled by this client/);
  assert.deepEqual((await call(1, 'tabs.closeUnowned', { tabId: userTab.id })).result, { ok: true });
  assert.equal(chrome.tabsById.has(userTab.id), false);
  assert.ok(chrome.tabsById.has(theirs.id) && chrome.tabsById.has(mine.id));
  assert.ok(!chrome.calls.some((c) => c[0].startsWith('debugger.')), 'the debugger never attached');
});

test('the user\'s tabs in a group titled like an agent label are never closed (no title-based cleanup)', async () => {
  const chrome = fakeChrome();
  chrome.groupsById.set(1, { id: 1, title: 'Claude', collapsed: false });
  const userTab = chrome.addTab({ groupId: 1 });
  const core = createCore({ chrome, send: () => {} });
  await core.ready;
  await core.handleMessage({ method: 'host.clientConnected', params: { client: 1 } });
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  assert.ok(chrome.tabsById.has(userTab.id));
  assert.equal(core.closeOrphanGroups, undefined);
  assert.equal(chrome.local.agentLabels, undefined);
});

test('a navigation target arriving while the opener fallback runs still decides the owner', async () => {
  const timers = manualTimers();
  const { core, chrome, call, sent } = setup({ timers });
  const { result: tabA } = await call(1, 'tabs.open', {});
  const { result: tabB } = await call(2, 'tabs.open', {});
  sent.length = 0;
  const popup = chrome.addTab({ openerTabId: tabB.id });
  await core.onTabCreated(structuredClone(popup));
  const release = gate(chrome, 'tabs.get');
  const fallback = timers.fire(750);
  await tick();
  const target = core.onNavigationTarget({ sourceTabId: tabA.id, tabId: popup.id });
  await tick();
  release();
  await fallback;
  await target;
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(core.owners.get(popup.id).client, 1);
  const created = sent.filter((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === popup.id).map((m) => m.client);
  assert.equal(created.at(-1), 1);
  const toB = sent.filter((m) => m.client === 2 && (m.params?.[0]?.id ?? m.params?.[0]) === popup.id).map((m) => m.method);
  assert.ok(toB.length === 0 || toB.at(-1) === 'chrome.tabs.onRemoved', `B ends without the popup: ${toB}`);
});

test('a client that disconnects while its popup is being adopted gets the popup closed', async () => {
  const { core, chrome, call } = setup();
  const { result: opener } = await call(1, 'tabs.open', {});
  const popup = chrome.addTab({ openerTabId: opener.id, url: 'https://example.com/popup' });
  const release = gate(chrome, 'tabs.get');
  const adopting = core.onNavigationTarget({ sourceTabId: opener.id, tabId: popup.id });
  await tick();
  const cleanup = core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await tick();
  release();
  await adopting;
  await cleanup;
  assert.equal(chrome.tabsById.has(popup.id), false);
  assert.equal(chrome.tabsById.has(opener.id), false);
  assert.equal(core.owners.size, 0);
});

test('a tab replaced while its owner is being cleaned up is cleaned up under its new id', async () => {
  const { core, chrome, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  const userTab = chrome.addTab({ url: 'https://user.example' });
  await call(1, 'tabs.claim', { tabId: userTab.id });
  const release = gate(chrome, 'tabs.get');
  const releaseDetach = gate(chrome, 'debugger.detach');
  const cleanup = core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await tick();
  // Chrome swaps both tabs for prerendered ones mid-cleanup.
  const replacement = chrome.addTab({ url: 'https://example.com/next', groupId: chrome.tabsById.get(tab.id).groupId });
  chrome.tabsById.delete(tab.id);
  const userReplacement = chrome.addTab({ url: 'https://user.example/next' });
  chrome.tabsById.delete(userTab.id);
  const swaps = [core.onTabReplaced(replacement.id, tab.id), core.onTabReplaced(userReplacement.id, userTab.id)];
  await tick();
  release();
  releaseDetach();
  await cleanup;
  await Promise.all(swaps);
  assert.equal(chrome.tabsById.has(replacement.id), false, 'agent replacement closed');
  assert.ok(chrome.tabsById.has(userReplacement.id), "the user's replacement stays open");
  assert.ok(chrome.calls.some((c) => c[0] === 'debugger.detach' && c[1] === userReplacement.id));
  assert.equal(core.owners.size, 0);
  assert.ok(!(await call(2, 'tabs.claim', { tabId: userReplacement.id })).error, 'claimable again');
});

test('a cleanup that fails keeps the ownership record and is retried', async () => {
  const { core, chrome, call } = setup();
  const { result: stuck } = await call(1, 'tabs.open', {});
  const { result: gone } = await call(1, 'tabs.open', {});
  chrome.hooks.failRemove = new Set([stuck.id, gone.id]);
  const cleanup = core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await tick();
  chrome.tabsById.delete(gone.id); // closed by the user while cleanup kept failing
  await cleanup;
  assert.ok(chrome.tabsById.has(stuck.id));
  assert.equal(core.owners.get(stuck.id)?.client, 1, 'provenance kept');
  assert.equal(chrome.session.owners[stuck.id]?.client, 1, 'and stored');
  assert.equal(core.owners.has(gone.id), false, 'a tab that is gone drops its record');
  assert.match((await call(2, 'tabs.claim', { tabId: stuck.id })).error.message, /being released/);

  // Retried on the next disconnect (port close / worker restart), once Chrome lets go.
  chrome.hooks.failRemove.clear();
  await core.portClosed();
  assert.equal(chrome.tabsById.has(stuck.id), false);
  assert.equal(core.owners.size, 0);
});

test('a failed ungroup is retried before closing, so no saved group is left behind', async () => {
  const { core, chrome, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  let failures = 1;
  const ungroup = chrome.tabs.ungroup;
  chrome.tabs.ungroup = async (ids) => {
    if (failures-- > 0) throw new Error('Tabs cannot be edited right now');
    return ungroup(ids);
  };
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  const removed = chrome.calls.findIndex((c) => c[0] === 'tabs.remove' && c[1] === tab.id);
  const ungrouped = chrome.calls.findIndex((c) => c[0] === 'tabs.ungroup' && [c[1]].flat().includes(tab.id));
  assert.ok(ungrouped !== -1 && ungrouped < removed, 'ungrouped, then closed');
});

test('tabs.open that fails after creating the tab closes it and reports the error', async () => {
  const { core, chrome, call, sent } = setup();
  chrome.hooks.groupError = 'Grouping is not supported by tabs in this window.';
  const reply = await call(1, 'tabs.open', { url: 'https://example.com' });
  assert.match(reply.error.message, /Grouping is not supported/);
  assert.equal(chrome.tabsById.size, 0, 'no undisclosed tab');
  assert.equal(core.owners.size, 0);
  assert.ok(!sent.some((m) => m.method === 'chrome.tabs.onCreated'));
});

test('a release racing the tab closing still tells the client', async () => {
  const { core, chrome, call, start, sent } = setup();
  const userTab = chrome.addTab({ url: 'https://user.example' });
  await call(1, 'tabs.claim', { tabId: userTab.id });
  sent.length = 0;
  const release = gate(chrome, 'debugger.detach');
  const releasing = start(1, 'tabs.release', { tabId: userTab.id });
  await tick();
  await chrome.tabs.remove(userTab.id); // The user closes it mid-release
  release();
  await releasing.done;
  assert.deepEqual(releasing.reply().result, { ok: true });
  assert.deepEqual(sent.filter((m) => m.method === 'chrome.tabs.onRemoved').map((m) => [m.client, m.params[0]]), [[1, userTab.id]]);
  assert.equal(core.owners.size, 0);
});

test('a popup is handed to its client even when backgrounding it partly fails', async () => {
  const { core, chrome, call, sent } = setup();
  const userTab = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: userTab.id, windowId: 1 });
  const { result: opener } = await call(1, 'tabs.open', {});
  sent.length = 0;
  const popup = chrome.addTab({ openerTabId: opener.id, active: true });
  await core.onTabActivated({ tabId: popup.id, windowId: 1 });
  chrome.tabsById.delete(userTab.id); // the tab to re-activate is gone (no event yet)
  await core.onNavigationTarget({ sourceTabId: opener.id, tabId: popup.id });
  assert.equal(core.owners.get(popup.id).client, 1);
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === popup.id));

  // Its opener closed by a parallel tab_close: still handed over (muted by default).
  const second = chrome.addTab({ openerTabId: opener.id });
  await chrome.tabs.remove(opener.id);
  await core.onNavigationTarget({ sourceTabId: opener.id, tabId: second.id });
  assert.equal(core.owners.has(second.id), false, 'no adopter any more');
  const third = chrome.addTab({ openerTabId: popup.id });
  const getTab = chrome.tabs.get;
  chrome.tabs.get = async (id) => { if (id === popup.id) throw new Error(`No tab with id: ${id}`); return getTab(id); };
  await core.onNavigationTarget({ sourceTabId: popup.id, tabId: third.id });
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === third.id));
  assert.equal(chrome.tabsById.get(third.id).mutedInfo.muted, true);
});

test('tabs.expectChild lets the agent own a tab its click opens from a claimed tab, for a few seconds', async () => {
  const timers = manualTimers();
  const { core, chrome, call, sent } = setup({ timers });
  await call(1, 'client.hello', { label: 'Research' });
  const gmail = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: gmail.id, windowId: 1 });
  await call(1, 'tabs.claim', { tabId: gmail.id });
  assert.match((await call(2, 'tabs.expectChild', { tabId: gmail.id, ms: 1000 })).error.message, /not owned/);
  assert.deepEqual((await call(1, 'tabs.expectChild', { tabId: gmail.id, ms: 1000 })).result, { ok: true });
  sent.length = 0;

  const child = chrome.addTab({ openerTabId: gmail.id, active: true });
  chrome.tabsById.get(gmail.id).active = false;
  await core.onTabActivated({ tabId: child.id, windowId: 1 });
  await core.onTabCreated(structuredClone(child));
  await core.onNavigationTarget({ sourceTabId: gmail.id, tabId: child.id });
  // kept: handed back to the user when the session ends, never closed (it may be their own Cmd-click).
  assert.deepEqual(core.owners.get(child.id), { client: 1, origin: 'agent', group: 'Research', kept: true });
  assert.equal(chrome.tabsById.get(gmail.id).active, true, 'the user keeps their tab in front');
  assert.equal(chrome.tabsById.get(child.id).mutedInfo.muted, false, 'muted like its opener');
  assert.equal(chrome.groupsById.get(chrome.tabsById.get(child.id).groupId).title, 'Research');
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === child.id));

  // The window is capped at 5 s, and outside it the claimed tab's children are the user's again.
  await call(1, 'tabs.expectChild', { tabId: gmail.id, ms: 60_000 });
  const now = Date.now;
  Date.now = () => now() + 5001;
  try {
    const late = chrome.addTab({ openerTabId: gmail.id });
    await core.onTabCreated(structuredClone(late));
    await core.onNavigationTarget({ sourceTabId: gmail.id, tabId: late.id });
    await timers.fire(750);
    assert.equal(core.owners.has(late.id), false);
  } finally {
    Date.now = now;
  }
});

test('extension.reloadIfIdle refuses while tabs are owned or being opened, then blocks new work', async () => {
  const timers = manualTimers();
  const { chrome, call, start, core } = setup({ timers });
  const { result: tab } = await call(1, 'tabs.open', {});
  assert.deepEqual((await call(9, 'extension.reloadIfIdle', {})).result, { reloaded: false, ownedTabs: 1, inFlight: 0 });
  await call(1, 'chrome.tabs.remove', [tab.id]);

  const release = gate(chrome, 'tabs.create');
  const opening = start(1, 'tabs.open', {});
  await tick();
  assert.equal((await call(9, 'extension.reloadIfIdle', {})).result.reloaded, false, 'an open in flight counts');
  release();
  await opening.done;
  await call(1, 'chrome.tabs.remove', [opening.reply().result.id]);
  assert.equal(core.owners.size, 0);

  assert.deepEqual((await call(9, 'extension.reloadIfIdle', {})).result, { reloaded: true });
  assert.match((await call(1, 'tabs.open', {})).error.message, /reloading/);
  assert.equal(chrome.tabsById.size, 0);
  await timers.fire(50);
  assert.ok(chrome.calls.some((c) => c[0] === 'reload'));
});

test('a tab adopted from a claimed tab is handed back to the user, never closed, when the session ends', async () => {
  const { core, chrome, call } = setup();
  const gmail = chrome.addTab({ url: 'https://mail.example' });
  await call(1, 'tabs.claim', { tabId: gmail.id });
  await call(1, 'tabs.expectChild', { tabId: gmail.id, ms: 3000 });
  const child = chrome.addTab({ openerTabId: gmail.id });
  await core.onNavigationTarget({ sourceTabId: gmail.id, tabId: child.id });
  await tick();
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await tick();
  assert.ok(chrome.tabsById.has(child.id), 'still open');
  assert.equal(chrome.tabsById.get(child.id).groupId, -1);
  assert.equal(chrome.tabsById.get(child.id).mutedInfo.muted, false);
  assert.ok(chrome.tabsById.has(gmail.id));
});

test('tabs.isShown: only an active tab in a normal, app or popup window that is not minimized, and only for its owner', async () => {
  const { chrome, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  assert.deepEqual((await call(1, 'tabs.isShown', { tabId: tab.id })).result, { shown: false }, 'background tab');
  chrome.tabsById.get(tab.id).active = true;
  assert.deepEqual((await call(1, 'tabs.isShown', { tabId: tab.id })).result, { shown: true }, 'active tab');
  chrome.hooks.windows = { 1: { state: 'minimized' } };
  assert.deepEqual((await call(1, 'tabs.isShown', { tabId: tab.id })).result, { shown: false }, 'minimized window');
  chrome.hooks.windows = { 1: { type: 'popup' } };
  assert.deepEqual((await call(1, 'tabs.isShown', { tabId: tab.id })).result, { shown: true }, 'popup window');
  chrome.hooks.windows = { 1: { type: 'app' } };
  assert.deepEqual((await call(1, 'tabs.isShown', { tabId: tab.id })).result, { shown: true }, 'app window');
  chrome.hooks.windows = { 1: { type: 'devtools' } };
  assert.deepEqual((await call(1, 'tabs.isShown', { tabId: tab.id })).result, { shown: false }, 'devtools window');
  assert.match((await call(2, 'tabs.isShown', { tabId: tab.id })).error.message, /not owned by this client/);
});

test('tabs.listAll: kept and windowType per tab, tabs of popup and app windows, never DevTools or incognito ones', async () => {
  const { core, chrome, call } = setup();
  const gmail = chrome.addTab({ url: 'https://mail.example' });
  await call(1, 'tabs.claim', { tabId: gmail.id });
  await call(1, 'tabs.expectChild', { tabId: gmail.id, ms: 3000 });
  const child = chrome.addTab({ openerTabId: gmail.id, windowId: 3 }); // a popup window
  await core.onNavigationTarget({ sourceTabId: gmail.id, tabId: child.id });
  await tick();
  const { result: work } = await call(1, 'tabs.open', {});
  const { result: forUser } = await call(1, 'tabs.open', { forUser: true });
  const app = chrome.addTab({ windowId: 4 });
  const devtools = chrome.addTab({ windowId: 5 });
  const incognito = chrome.addTab({ windowId: 6, incognito: true });
  chrome.hooks.windows = { 3: { type: 'popup' }, 4: { type: 'app' }, 5: { type: 'devtools' }, 6: { incognito: true } };
  const listed = new Map((await call(1, 'tabs.listAll', {})).result.map((t) => [t.id, t]));
  const pick = (id) => { const t = listed.get(id); return { owner: t.owner, origin: t.origin, kept: t.kept, handedOver: t.handedOver, windowType: t.windowType }; };
  assert.deepEqual(pick(child.id), { owner: 'you', origin: 'agent', kept: true, handedOver: false, windowType: 'popup' });
  assert.deepEqual(pick(work.id), { owner: 'you', origin: 'agent', kept: false, handedOver: false, windowType: 'normal' });
  assert.deepEqual(pick(forUser.id), { owner: 'you', origin: 'agent', kept: true, handedOver: true, windowType: 'normal' });
  assert.deepEqual(pick(gmail.id), { owner: 'you', origin: 'user', kept: false, handedOver: false, windowType: 'normal' });
  assert.equal(listed.get(app.id).windowType, 'app');
  assert.ok(!listed.has(devtools.id) && !listed.has(incognito.id));
});

test('a tab the user opens from a tab already handed to them stays theirs', async () => {
  const { core, chrome, call } = setup();
  const { result: kept } = await call(1, 'tabs.open', { forUser: true });
  const child = chrome.addTab({ openerTabId: kept.id });
  await core.onNavigationTarget({ sourceTabId: kept.id, tabId: child.id });
  await tick();
  assert.equal(core.owners.has(child.id), false, 'not adopted without an expectChild window');
  // Inside the window (the agent's own click) it is adopted, but kept: handed back, never closed.
  await call(1, 'tabs.expectChild', { tabId: kept.id, ms: 3000 });
  const agentChild = chrome.addTab({ openerTabId: kept.id });
  await core.onNavigationTarget({ sourceTabId: kept.id, tabId: agentChild.id });
  await tick();
  assert.equal(core.owners.get(agentChild.id)?.kept, true);
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await tick();
  assert.ok(chrome.tabsById.has(child.id) && chrome.tabsById.has(agentChild.id) && chrome.tabsById.has(kept.id));
});
