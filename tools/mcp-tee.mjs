// A stdio MCP server wrapped so its elicitations are logged: node tools/mcp-tee.mjs <log.jsonl> <command> [args...]
// Passes every line through unchanged. Logs the server's elicitation/create requests ({t, dir: 'out', message}) and
// every client reply to a server request ({t, dir: 'in', message}), so tools/rounds.mjs can say which prompt an agent
// hit and how Claude Code answered it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [log, command, ...args] = process.argv.slice(2);
const server = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
server.on('exit', (code) => process.exit(code ?? 0));
process.stdin.on('end', () => server.stdin.end());
const record = (dir, message) => fs.appendFileSync(log, JSON.stringify({ t: Date.now(), dir, message }) + '\n');
const serverRequests = new Set();

lines(process.stdin, (line) => {
  server.stdin.write(line + '\n');
  const message = parse(line);
  if (message && !message.method && serverRequests.delete(message.id)) record('in', message);
});
lines(server.stdout, (line) => {
  process.stdout.write(line + '\n');
  const message = parse(line);
  if (message?.method && message.id !== undefined) serverRequests.add(message.id);
  if (message?.method === 'elicitation/create') record('out', message);
});

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function lines(stream, onLine) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      onLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  });
}
