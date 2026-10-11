// Run: node --test extension/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../core.js';

function setup() {
  const store = (data) => ({ async get() { return {}; }, async set(values) { Object.assign(data, values); } });
  const chrome = {
    storage: { session: store({}), local: store({}) },
    runtime: { id: 'fowlbrowser-ext', getManifest: () => ({ version: '0.1.0' }) },
    windows: { async get(id) { return { id, type: id === 7 ? 'popup' : 'normal' }; }, async getAll() { return []; } },
    tabs: { async query() { return []; } },
    tabGroups: { async query() { return []; } },
  };
  const sent = [];
  const core = createCore({ chrome, send: (msg) => msg.method !== 'extension.log' && sent.push(msg) });
  let nextId = 1;
  const call = async (client, method, params = {}) => {
    const id = nextId++;
    await core.handleMessage({ id, method, params, client });
    return sent.find((m) => m.id === id);
  };
  const connect = (client) => core.handleMessage({ method: 'host.clientConnected', params: { client } });
  const events = () => sent.filter((m) => m.method === 'tabs.activity');
  return { core, call, connect, events };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('tabs.watchActivity streams activations, new tabs, new windows and focus changes to the watcher only', async () => {
  const { core, call, connect, events } = setup();
  await connect(1); await connect(2);
  await core.onTabActivated({ tabId: 5, windowId: 1 }); // before anyone watches: nothing
  await settle();
  assert.deepEqual(events(), []);
  assert.deepEqual((await call(1, 'tabs.watchActivity')).result, { ok: true });

  await core.onTabActivated({ tabId: 5, windowId: 1 });
  await core.onTabCreated({ id: 6, windowId: 7, active: true });
  core.onWindowCreated({ id: 7, type: 'popup', focused: true });
  core.onWindowFocusChanged(7);
  core.onWindowFocusChanged(-1);
  await settle();
  const got = events();
  assert.ok(got.every((m) => m.client === 1 && typeof m.params.at === 'number'));
  assert.deepEqual(got.map(({ params: { at, ...rest } }) => rest), [
    { kind: 'activated', tabId: 5, windowId: 1, active: true, windowType: 'normal' },
    { kind: 'created', tabId: 6, windowId: 7, active: true, windowType: 'popup' },
    { kind: 'windowCreated', tabId: null, windowId: 7, active: true, windowType: 'popup' },
    { kind: 'windowFocus', tabId: null, windowId: 7, active: true, windowType: 'popup' },
    { kind: 'windowFocus', tabId: null, windowId: -1, active: false, windowType: null },
  ]);
});

test('a watcher that disconnected gets no more activity', async () => {
  const { core, call, connect, events } = setup();
  await connect(1);
  await call(1, 'tabs.watchActivity');
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await core.onTabActivated({ tabId: 5, windowId: 1 });
  await settle();
  assert.deepEqual(events(), []);
});
