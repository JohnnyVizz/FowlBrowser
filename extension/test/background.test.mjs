// Run: node --test extension/test/
// The popup's connection status from background.js, against a fake chrome whose native ports the test drives.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Every chrome API background.js and core.js touch at load: events take listeners, calls resolve to an empty list.
function fakeChrome() {
  const ports = [];
  const listeners = {};
  let badge = '';
  const event = (name) => ({ addListener: (fn) => { (listeners[name] ??= []).push(fn); } });
  const api = (prefix) => new Proxy({}, {
    get: (target, key) => target[key] ??= key.startsWith('on') ? event(`${prefix}.${key}`) : async () => [],
  });
  const chrome = new Proxy({
    runtime: {
      id: 'fowlbrowser-ext',
      lastError: undefined,
      getManifest: () => ({ version: '0.1.0' }),
      onMessage: event('runtime.onMessage'), onStartup: event('runtime.onStartup'), onInstalled: event('runtime.onInstalled'),
      connectNative() {
        const port = { messages: [], disconnects: [], postMessage: () => {} };
        port.onMessage = { addListener: (fn) => port.messages.push(fn) };
        port.onDisconnect = { addListener: (fn) => port.disconnects.push(fn) };
        ports.push(port);
        return port;
      },
    },
    action: { setBadgeText: ({ text }) => { badge = text; }, setBadgeBackgroundColor() {} },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} }, onChanged: event('storage.onChanged') },
  }, { get: (target, key) => target[key] ??= api(key) });
  const status = () => new Promise((resolve) => {
    listeners['runtime.onMessage'][0]({ type: 'status' }, { id: 'fowlbrowser-ext' }, resolve);
  });
  // The host's port ends: Chrome sets lastError for the listener, then clears it.
  const disconnect = (port, message) => {
    chrome.runtime.lastError = message ? { message } : undefined;
    for (const fn of port.disconnects) fn();
    chrome.runtime.lastError = undefined;
  };
  return { chrome, ports, status, disconnect, badge: () => badge };
}

let loads = 0;
async function load() {
  const fake = fakeChrome();
  globalThis.chrome = fake.chrome;
  globalThis.navigator ??= { userAgent: 'test' };
  await import(`../background.js?load=${++loads}`);
  return fake;
}

test('a host that ends before it listens reads as broken, with the badge', async () => {
  const fake = await load();
  assert.equal((await fake.status()).state, 'connecting');
  fake.disconnect(fake.ports[0], 'Native host has exited.');
  assert.equal((await fake.status()).state, 'broken');
  assert.equal(fake.badge(), '!');
  fake.disconnect(fake.ports[0], 'Failed to start native messaging host.');
  assert.equal((await fake.status()).state, 'broken');
});

test('a host that listened and then exits is reconnecting, not broken', async () => {
  const fake = await load();
  for (const fn of fake.ports[0].messages) fn({ method: 'host.listening', params: { browser: 'chrome', key: 'chrome' } });
  assert.deepEqual(await fake.status(), { state: 'connected', browser: 'chrome', key: 'chrome' });
  fake.disconnect(fake.ports[0], 'Native host has exited.');
  assert.equal((await fake.status()).state, 'connecting');
  assert.equal(fake.badge(), '');
});

test('no host installed still reads as missing', async () => {
  const fake = await load();
  fake.disconnect(fake.ports[0], 'Specified native messaging host not found.');
  assert.equal((await fake.status()).state, 'missing');
  assert.equal(fake.badge(), '!');
});
