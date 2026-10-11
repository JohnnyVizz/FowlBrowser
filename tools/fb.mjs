#!/usr/bin/env node
// Dev CLI for a FowlBrowser host socket.
//   node tools/fb.mjs list                         sockets in ~/.fowlbrowser
//   node tools/fb.mjs [-b helium] <method> [json]  send one request, print host.hello and the response
//   node tools/fb.mjs [-b helium] events           client.hello, then print every event until Ctrl-C
//   node tools/fb.mjs [-b helium] reload           extension.reload
//   node tools/fb.mjs [-b helium] reload-if-idle   extension.reloadIfIdle: reload unless agents own or are opening tabs (a reload closes them)
// -b takes a browser name (helium -> helium.sock) or a socket path. Default: the only socket, if there is one.
// Env: FOWLBROWSER_DIR (socket dir), FOWLBROWSER_LABEL (client label, default "fb").
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const DIR = process.env.FOWLBROWSER_DIR || path.join(os.homedir(), '.fowlbrowser');
const LABEL = process.env.FOWLBROWSER_LABEL || 'fb';

const args = process.argv.slice(2);
let target = null;
if (args[0] === '-b') { target = args[1]; args.splice(0, 2); }
const [command, rawParams] = args;

const sockets = () => (fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.sock')) : []);

if (!command) {
  console.error('usage: fb.mjs list | [-b browser] <method> [json] | [-b browser] events | [-b browser] reload | [-b browser] reload-if-idle');
  process.exit(2);
}
if (command === 'list') {
  for (const name of sockets()) console.log(path.join(DIR, name));
  process.exit(0);
}

function socketPath() {
  if (target?.includes('/')) return target;
  if (target) return path.join(DIR, `${target}.sock`);
  const found = sockets();
  if (found.length !== 1) {
    console.error(found.length ? `several sockets, pick one with -b: ${found.join(' ')}` : `no sockets in ${DIR}`);
    process.exit(1);
  }
  return path.join(DIR, found[0]);
}

const socket = net.connect(socketPath());
socket.on('error', (error) => { console.error(error.message); process.exit(1); });

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  socket.write(Buffer.concat([header, body]));
}

send({ method: 'host.auth', params: { token: fs.readFileSync(path.join(DIR, 'token'), 'utf8').trim() } });

let buffer = Buffer.alloc(0);
const handlers = [];
socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
    const length = buffer.readUInt32LE(0);
    const message = JSON.parse(buffer.subarray(4, 4 + length).toString());
    buffer = buffer.subarray(4 + length);
    for (const handler of handlers) handler(message);
  }
});
socket.on('close', () => process.exit());

const print = (message) => console.log(JSON.stringify(message, null, 2));
let nextId = 1;
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => handlers.push((m) => m.id === id && resolve(m)));
}

if (command !== 'reload-if-idle') handlers.push((m) => m.method === 'host.hello' && print(m));

if (command === 'reload-if-idle') {
  // The extension checks and reloads in one step, so no tab can be opened in between.
  let response = await request('extension.reloadIfIdle', {});
  if (/Unknown method/.test(response.error?.message ?? '')) {
    // An extension from before reloadIfIdle: check, then reload (racy, but only once, to install the new one).
    const { result } = await request('extension.info', {});
    const owned = Object.values(result?.ownedTabs ?? {}).reduce((sum, n) => sum + n, 0);
    response = owned ? { result: { reloaded: false, ownedTabs: owned, inFlight: 0 } } : await request('extension.reload', {});
  }
  const { result, error } = response;
  if (error) console.log(`reload failed: ${error.message}`);
  else if (result.reloaded === false) {
    const busy = [result.ownedTabs && `agents own ${result.ownedTabs} tab${result.ownedTabs === 1 ? '' : 's'}`,
      result.inFlight && `${result.inFlight} tab open or claim under way`].filter(Boolean).join(', ');
    console.log(`reload later: ${busy} in this browser`);
  } else console.log('reloaded');
  socket.end();
} else if (command === 'events') {
  handlers.push((m) => m.id === undefined && m.method !== 'host.hello' && print(m));
  print(await request('client.hello', { label: LABEL }));
} else {
  const method = command === 'reload' ? 'extension.reload' : command;
  const params = rawParams ? JSON.parse(rawParams) : {};
  if (method !== 'client.hello') await request('client.hello', { label: LABEL });
  const response = await request(method, params);
  print(response);
  socket.end();
  process.exitCode = response.error ? 1 : 0;
}
