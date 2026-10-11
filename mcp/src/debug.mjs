// FOWLBROWSER_DEBUG=<file> appends a timestamped trace of tool calls, host requests and relay traffic.
// Never throws: a part that can't be serialized or a file that can't be written is skipped.
import fs from 'node:fs';

const file = process.env.FOWLBROWSER_DEBUG;
export const debugging = !!file;

function show(part) {
  if (typeof part === 'string') return part;
  try { return JSON.stringify(part) ?? String(part); } catch { return '[unserializable]'; }
}

export const debug = file
  ? (...parts) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString().slice(11, 23)} [${process.pid}] ${parts.map(show).join(' ').slice(0, 400)}\n`);
    } catch {}
  }
  : () => {};
