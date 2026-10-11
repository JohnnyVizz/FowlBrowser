// The CDP relay in-process, with a fake extension: local peers can't crash it (wrong paths, broken handshakes,
// malformed JSON, invalid frames), and an attach still in flight when Playwright disconnects is undone before
// the next connection is served.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import WebSocket from 'ws';
import { CDPRelay } from '../src/vendor/cdpRelay.mjs';

const UA = 'Mozilla/5.0 (Macintosh) Chrome/141.0.1.2 Safari/537.36';
const calls = [];
const commands = []; // CDP methods forwarded through chrome.debugger.sendCommand
let releaseAttach = () => {};
let holdAttach = false;
const relay = new CDPRelay(async (method, params) => {
  calls.push(method);
  if (method === 'chrome.debugger.sendCommand') commands.push(params[1]);
  if (method === 'chrome.debugger.attach' && holdAttach) await new Promise((resolve) => { releaseAttach = resolve; });
  if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { targetId: 'T5', type: 'page' } };
  return {};
}, UA);
const url = await relay.start();
const { port } = new URL(url);

function open(path = new URL(url).pathname) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('unexpected-response', (_, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}
const closed = (ws) => new Promise((resolve) => { if (ws.readyState === WebSocket.CLOSED) resolve(); else ws.once('close', resolve); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function reply(conn, id, timeout = 2000) {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(10)) {
    const found = conn.messages.find((m) => m.id === id);
    if (found) return found;
  }
  throw new Error(`no reply to ${id}`);
}

test('wrong paths are refused before the upgrade', async () => {
  await assert.rejects(open('/wrong'), /HTTP 401/);
  // A raw upgrade with a broken handshake, then garbage: the socket is dropped, the server stays up.
  const raw = net.connect(port, '127.0.0.1');
  raw.on('error', () => {});
  raw.write('GET /wrong HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n\x88\x80garbage');
  await new Promise((resolve) => raw.once('close', resolve));
});

test('malformed messages get errors, not a crash', async () => {
  const conn = await open();
  conn.ws.send('not json');
  conn.ws.send('null');
  conn.ws.send(JSON.stringify({ id: 1 }));
  conn.ws.send(JSON.stringify({ id: 2, method: 'Browser.getVersion' }));
  assert.match((await reply(conn, 1)).error.message, /no method/);
  assert.equal((await reply(conn, 2)).result.userAgent, UA);
  // An invalid frame (reserved opcode 3): the connection closes, the server stays up.
  conn.ws._socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
  await closed(conn.ws);
  const again = await open();
  again.ws.send(JSON.stringify({ id: 3, method: 'Browser.getVersion' }));
  assert.equal((await reply(again, 3)).result.userAgent, UA);
  again.ws.close();
  await closed(again.ws);
});

test('an attach in flight at disconnect is detached before the next client is served', async () => {
  relay.handleExtensionEvent('chrome.tabs.onCreated', [{ id: 5 }]);
  holdAttach = true;
  const first = await open();
  first.ws.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true } }));
  for (let i = 0; i < 100 && !calls.includes('chrome.debugger.attach'); i++) await sleep(10);
  first.ws.close();
  await closed(first.ws);
  await sleep(50);

  const second = await open();
  second.ws.send(JSON.stringify({ id: 2, method: 'Browser.getVersion' }));
  await sleep(100);
  assert.equal(second.messages.length, 0, 'the new client waits for the old attach to be undone');
  holdAttach = false;
  releaseAttach();
  await reply(second, 2);
  assert.ok(calls.includes('chrome.debugger.detach'), 'the late attach was detached');
  assert.ok(!second.messages.some((m) => m.method === 'Target.attachedToTarget'), 'no session from the old connection');

  second.ws.send(JSON.stringify({ id: 3, method: 'Target.setAutoAttach', params: { autoAttach: true } }));
  await reply(second, 3);
  assert.equal(second.messages.filter((m) => m.method === 'Target.attachedToTarget').length, 1, 'a fresh attach for the new client');
  second.ws.close();
  await closed(second.ws);
});

test('page emulation is answered by the relay, focus emulation goes through', async () => {
  const conn = await open();
  conn.ws.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true } }));
  await reply(conn, 1);
  const sessionId = conn.messages.find((m) => m.method === 'Target.attachedToTarget').params.sessionId;
  commands.length = 0;
  const swallowed = ['Emulation.setEmulatedMedia', 'Emulation.setAutoDarkModeOverride', 'Emulation.setUserAgentOverride', 'Emulation.setDeviceMetricsOverride'];
  swallowed.forEach((method, i) => conn.ws.send(JSON.stringify({ id: 10 + i, sessionId, method, params: {} })));
  conn.ws.send(JSON.stringify({ id: 20, sessionId, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }));
  for (let i = 0; i < swallowed.length; i++) assert.deepEqual((await reply(conn, 10 + i)).result, {});
  await reply(conn, 20);
  assert.deepEqual(commands, ['Emulation.setFocusEmulationEnabled']);
  conn.ws.close();
  await closed(conn.ws);
});

test.after(() => relay.stop());

test("FowlBrowser's own binding calls never reach Playwright; other events do", () => {
  const seen = [];
  const original = relay.model.onDebuggerEvent;
  relay.model.onDebuggerEvent = (source, method, params) => seen.push(params?.name ?? method);
  try {
    relay.handleExtensionEvent('chrome.debugger.onEvent', [{ tabId: 5 }, 'Runtime.bindingCalled', { name: '__fowlbrowserUserInput', payload: 'x' }]);
    relay.handleExtensionEvent('chrome.debugger.onEvent', [{ tabId: 5 }, 'Runtime.bindingCalled', { name: '__playwright__binding__', payload: '{}' }]);
    relay.handleExtensionEvent('chrome.debugger.onEvent', [{ tabId: 5 }, 'Page.loadEventFired', {}]);
  } finally {
    relay.model.onDebuggerEvent = original;
  }
  assert.deepEqual(seen, ['__playwright__binding__', 'Page.loadEventFired']);
});
