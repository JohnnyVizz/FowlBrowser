// HostClient against a fake host socket: a rename (extension.hello) during the handshake is kept in hello.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hostclient-'));
fs.writeFileSync(path.join(dir, 'token'), 'token');
process.env.FOWLBROWSER_DIR = dir;
const { HostClient } = await import('../src/hostClient.mjs');

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

test('a rename between host.hello and extension.initialized is not lost', async () => {
  const extension = { version: '0.1.0', instanceId: 'x', userAgent: 'Chrome/1' };
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const message = JSON.parse(chunk.subarray(4).toString());
      if (message.method === 'host.auth') socket.write(frame({ method: 'host.hello', params: { browser: 'chrome', extension: { ...extension, label: 'Old' } } }));
      else if (message.method === 'client.hello') {
        socket.write(frame({ method: 'extension.hello', params: { ...extension, label: 'Work' } }));
        socket.write(frame({ id: message.id, result: { ok: true } }));
        socket.write(frame({ method: 'extension.initialized', params: [] }));
      }
    });
  });
  const socketPath = path.join(dir, 'chrome.sock');
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const host = new HostClient(socketPath);
  try {
    await host.connect('unit');
    assert.equal(host.hello.extension.label, 'Work');
  } finally {
    host.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
