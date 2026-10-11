// Turn end: Claude Code's Stop hook (bin/turn-ended.mjs) connects to a socket named after the Claude process
// (this server's parent) and sends "turn_ended". This session's unkept agent tabs close, claimed and kept tabs go
// back to the user, and the session stays connected for the next turn. Modeled on Codex's per-turn cleanup.
import fs from 'node:fs';
import net from 'node:net';
import * as cursor from './cursor/index.mjs';
import { uninstallPopups } from './popups.mjs';
import { record, tabEvent } from './record.mjs';

export const turnSocketPath = (pid = process.ppid) => `/tmp/fowlbrowser-turn-${pid}.sock`;

// Tool calls running per tab id string ("chrome:52"), counted by the registration wrapper in tools.mjs.
export const callsByTab = new Map();
let subagents = 0; // SubagentStart minus SubagentStop hooks seen (never below 0)
let subagentsChanged = 0; // when that count last changed (Date.now())
// A count unchanged this long is taken as a lost SubagentStop (Claude interrupted mid-subagent), not a running one.
export const SUBAGENTS_STALE_MS = 30 * 60_000;

function countSubagents(delta) {
  subagents = Math.max(0, subagents + delta);
  subagentsChanged = Date.now();
  return subagents;
}

// Only tabs this session had mapped when the turn ended, taken before any await, so a later turn's tabs are never
// touched. Skipped: a tab with a call running or queued (a subagent may still use it), and owned tabs not among them
// (a tab_open or tab_claim in progress, or a later turn's). While background subagents run, nothing is cleaned.
export async function endTurn(manager) {
  const result = { closed: [], released: [], skipped: [] };
  if (subagents > 0 && Date.now() - subagentsChanged > SUBAGENTS_STALE_MS) countSubagents(-subagents);
  if (subagents > 0) {
    record({ type: 'turnEnded', ...result, deferred: true });
    return { ...result, deferred: true };
  }
  const plans = [...manager.browsers.values()].map((browser) => ({ browser, tabs: new Map(browser.tabs) }));
  const errors = [];
  await Promise.all(plans.map(async ({ browser, tabs }) => {
    const all = await browser.host.request('tabs.listAll', {}).catch(() => []);
    await Promise.all(all.filter((t) => t.owner === 'you').map(async (info) => {
      const id = `${browser.key}:${info.id}`;
      const tab = tabs.get(info.id);
      if (!tab || tab.busy || callsByTab.get(id) > 0) return result.skipped.push(id);
      // Older extensions don't send kept; handedOver was their rule.
      const close = info.origin === 'agent' && !(info.kept ?? info.handedOver);
      // Re-checked when its turn on the tab queue comes: a later turn may have released and reclaimed the same id.
      const same = () => browser.tabs.get(info.id) === tab;
      const work = async () => {
        if (!same()) return false;
        tab.ending = true; // its page closing now is ours, not "found gone" (record mode)
        await cursor.remove(tab, { wait: !close });
        if (close) await browser.host.request('chrome.tabs.remove', [info.id]);
        else {
          await uninstallPopups(tab);
          await browser.host.request('tabs.release', { tabId: info.id });
        }
        return true;
      };
      try {
        if (!(await tab.run(work))) return result.skipped.push(id);
        if (same()) browser.forget(info.id);
        tabEvent(close ? 'close' : 'release', id, info.url);
        (close ? result.closed : result.released).push(id);
      } catch (error) {
        errors.push({ tab: id, error: error.message });
        const now = await browser.host.request('tabs.listAll', {}).catch(() => null);
        if (same() && now && now.find((t) => t.id === info.id)?.owner !== 'you') browser.forget(info.id); // gone, or no longer ours
      }
    }));
  }));
  record({ type: 'turnEnded', ...result });
  return errors.length ? { ...result, errors } : result;
}

// Lines from bin/turn-ended.mjs: turn_ended (Stop), subagent_start, subagent_stop. Concurrent turn ends share one run.
export function listenForTurns(manager, socketPath = turnSocketPath()) {
  let running = null;
  const run = () => (running ??= endTurn(manager).finally(() => { running = null; }));
  const reply = (socket, result) => socket.end(`${JSON.stringify(result)}\n`);
  fs.rmSync(socketPath, { force: true });
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const line = buffer.split('\n')[0].trim();
      if (line === 'subagent_start') return reply(socket, { subagents: countSubagents(1) });
      if (line === 'subagent_stop') return reply(socket, { subagents: countSubagents(-1) });
      if (line !== 'turn_ended') return socket.end();
      run().then((result) => reply(socket, result), (error) => reply(socket, { error: error.message }));
    });
  });
  let inode = null; // a second server with the same parent may take the path over; only ours is removed
  server.listen(socketPath, () => { inode = fs.statSync(socketPath).ino; });
  server.unref();
  process.on('exit', () => {
    try { if (fs.statSync(socketPath).ino === inode) fs.rmSync(socketPath); } catch {}
  });
  return server;
}
