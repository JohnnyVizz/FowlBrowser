// One round of real Claude agents doing the user's everyday browser tasks, graded the way the user would grade them.
//   node tools/rounds.mjs [--tasks tools/agents/example.json] [--swap] [--only a,b] [--model opus] [--effort medium]
//                         [--mcp repo|installed] [--out <dir>] [--keep-tabs] [--serve "<command>"]
// All agents start at once, each its own `claude -p` session and MCP server (record mode on). While they run, a monitor
// logs the frontmost app, active tabs, windows and audible tabs. Then every run is graded (outcome, cursor, focus,
// sound, tabs, time, tokens), the round's leftovers are cleaned up and checked, and report.md and report.html are
// written. Exit code 1 when the round is not clean.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SOCKET_DIR = path.join(os.homedir(), '.fowlbrowser');
const BROWSERS = ['helium', 'chrome'];
const BROWSER_APP = { helium: 'Helium', chrome: 'Google Chrome' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const labelOf = (name) => `🧪 ${name}`;
const keyOf = (browser, tab) => `${browser}:${tab.id}`;

// --- Grading (pure, unit-tested in tools/test/rounds.test.mjs) ---

export function readJsonl(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

// Every tab an agent touched: tab ids in its journal, plus tabs the monitor saw in its tab group (works without a journal).
export function agentTabs(name, journal, monitor) {
  const tabs = new Set((journal || []).map((e) => e.tab).filter(Boolean));
  for (const e of monitor) if (e.kind === 'group' && e.label === labelOf(name)) tabs.add(e.tab);
  return tabs;
}

export function gradeOutcome({ task, run, journal, after, startKeys, grade }) {
  const problems = [];
  if (run.exitCode !== 0) problems.push(`exit ${run.exitCode ?? 'none'}${run.killed ? ' (killed after 20 s)' : ''}`);
  if (!run.result) problems.push('no result event');
  else if (run.result.is_error) problems.push(`is_error: ${String(run.result.result).slice(0, 120)}`);
  const text = String(run.result?.result ?? '');
  for (const e of task.expect || []) if (!new RegExp(e, 'i').test(text)) problems.push(`answer does not match /${e}/`);
  if (task.downloads) {
    const done = (journal || []).filter((e) => e.type === 'download' && e.state === 'complete' && e.bytes >= (task.downloads.minBytes || 0)).length;
    if (done < (task.downloads.min || 1)) problems.push(`${done} complete downloads, wanted ${task.downloads.min || 1}`);
  }
  if (task.keepMin) {
    const kept = [...run.tabs].filter((k) => after[k] && !after[k].owner && !startKeys.has(k) && keepMatches(task, after[k].url)).length;
    if (kept < task.keepMin) problems.push(`${kept} tabs left for the user, wanted ${task.keepMin}`);
  }
  // A form task (task.grade) also needs the site's grade: the cell gets its score, the problems each wrong field.
  const form = task.grade ? gradeForm(grade) : null;
  const ok = problems.length === 0 && (!form || form.ok);
  const cell = [ok ? 'ok' : problems.length ? `FAIL: ${problems.join('; ')}` : 'FAIL', form?.cell].filter(Boolean).join(', ');
  return { ok, cell, problems: [...problems, ...(form?.problems || [])] };
}

// grade: the JSON of GET task.grade (test/forms/server.mjs), or {error} when it could not be read.
export function gradeForm(grade) {
  if (!grade || grade.error) return { ok: false, cell: 'no grade', problems: [`grade unavailable: ${grade?.error ?? 'not fetched'}`] };
  const problems = [];
  if (!grade.submissions) problems.push('nothing submitted');
  else if (grade.submittedForm !== grade.form) problems.push(`submitted to ${grade.submittedForm}, wanted ${grade.form}`);
  if (grade.submissions) for (const f of grade.fields.filter((f) => !f.ok)) problems.push(`${f.name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.got)}`);
  for (const c of grade.crossTalk) problems.push(`cross-talk: ${c.field} has ${c.persona}'s ${JSON.stringify(c.value)}`);
  const talk = grade.crossTalk.length ? `, crossTalk ${grade.crossTalk.map((c) => `${c.field}=${c.persona}`).join(' ')}` : '';
  return { ok: !!grade.ok, cell: `score ${grade.score}/${grade.total}${talk}`, problems };
}

const scriptedClick = /\.click\(|dispatchEvent|\.submit\(/;
// Errors from the server's own checks before any input is sent: the action certainly did not happen.
const noInputSent = /older snapshot|not a ref|is covered by|is disabled|is not visible|Invalid frame|from an earlier page|not from a snapshot|is inside a closed shadow root/;

export function gradeCursor({ task, journal }) {
  if (!journal) return { ok: false, cell: 'no journal', problems: ['no journal'] };
  // A scroll with no target (by direction, nothing to aim at) has nothing to judge, nor has an action stopped by a
  // pre-check (no input was sent); any other point without one failed, including other errors (input may have gone).
  const points = journal.filter((e) => e.type === 'point' && (e.target || (e.tool !== 'scroll' && !noInputSent.test(e.error ?? ''))));
  const bad = points.filter((p) => !(p.target && p.cursor?.visible && Math.hypot(p.cursor.x - p.target.x, p.cursor.y - p.target.y) <= 4));
  const scriptClicks = journal.filter((e) => e.type === 'scriptClick');
  const scriptEvals = journal.filter((e) => e.type === 'call' && e.tool === 'evaluate' && scriptedClick.test(JSON.stringify(e.args || {})));
  const problems = [
    ...bad.map((p) => `${time(p.t)} ${p.tool} on ${p.tab}: ${p.target ? `${p.cursor ? `cursor ${p.cursor.visible ? '' : 'hidden '}at ${Math.round(p.cursor.x)},${Math.round(p.cursor.y)}` : 'no cursor'}, target ${Math.round(p.target.x)},${Math.round(p.target.y)}` : 'no cursor target'}${p.error ? ` (${p.error})` : ''}`),
    ...scriptClicks.map((e) => `${time(e.t)} page script clicked at ${e.x},${e.y} on ${e.tab}`),
    ...scriptEvals.map((e) => `${time(e.t)} evaluate clicks by script on ${e.tab}: ${JSON.stringify(e.args).slice(0, 120)}`),
  ];
  if ((task.needsClicks ?? true) && points.length === 0) problems.push('no pointer actions recorded');
  const extra = [scriptClicks.length && `${scriptClicks.length} script clicks`, scriptEvals.length && `${scriptEvals.length} scripted evaluates`].filter(Boolean);
  return { ok: problems.length === 0, cell: `${points.length - bad.length}/${points.length}${extra.length ? `, ${extra.join(', ')}` : ''}`, problems };
}

// Focus changes during the round. One counts against an agent (blame) only when the agent caused it: it asked for
// focus (tab_focus, tab_open with focus), a window opened with its tab, one of its tabs flashed active and back within
// FLASH_MS (the browser activating a new tab), the active tab changed while that browser was in the background (an
// agent's tab, else a round problem), or the browser came to the front within FRONT_MS of one of those. Everything
// else is the user using their Mac while they watch (switching apps, clicking through tabs): listed, not counted.
// calls: journal call lines with the agent's name in `agent`.
const FLASH_MS = 1500;
const CLOSED_MS = 2000;
const FRONT_MS = 2000;

// The user can only switch tabs in the frontmost browser. A tick reads the front app before the tabs, so a click that
// brings the browser forward can log its front change just after the tab change: allow FRONT_NEAR_MS either side.
// No front entry yet (lsappinfo failed): assume frontmost, so nothing is blamed on a guess.
const FRONT_NEAR_MS = 1000;
function browserFront(monitor, browser, t) {
  const fronts = monitor.filter((e) => e.kind === 'front');
  const current = fronts.filter((e) => e.t <= t).pop();
  return !current || current.app === BROWSER_APP[browser]
    || fronts.some((e) => e.app === BROWSER_APP[browser] && Math.abs(e.t - t) <= FRONT_NEAR_MS);
}
// closedAt: tab -> when its agent closed it; the browser then activates a neighbour of a tab the user was watching.
export function focusEvents(monitor, owners, calls = [], closedAt = new Map()) {
  const events = [];
  for (const c of calls) {
    if (c.tool === 'tab_focus' || (c.tool === 'tab_open' && c.args?.focus)) {
      events.push({ t: c.t, kind: 'call', owner: c.agent, blame: true, text: `${time(c.t)} ${c.tool} asked to focus ${c.args?.tab ?? c.args?.url ?? ''}` });
    }
  }
  const actives = monitor.filter((e) => e.kind === 'active');
  for (const e of monitor) {
    if (e.initial) continue;
    if (e.kind === 'window' && e.event === 'open') {
      const owner = e.tabs.map((k) => owners.get(k)).find(Boolean);
      events.push({ ...e, owner: owner || 'user', blame: !!owner, text: `${time(e.t)} ${e.browser} window ${e.windowId} opened with ${e.tabs.join(', ')}` });
    }
    if (e.kind === 'active') {
      const sameWindow = actives.filter((a) => a.browser === e.browser && a.windowId === e.windowId);
      const i = sameWindow.indexOf(e);
      const before = sameWindow[i - 1]; const after = sameWindow[i + 1];
      const flash = owners.has(e.tab) && before && after?.tab === before.tab && after.t - e.t <= FLASH_MS;
      const text = `${time(e.t)} active tab of ${e.browser} window ${e.windowId} became ${e.tab} ${e.url}`;
      const closed = before && closedAt.has(before.tab) && Math.abs(closedAt.get(before.tab) - e.t) <= CLOSED_MS;
      if (flash) events.push({ ...e, owner: owners.get(e.tab), blame: true, text: `${text} and flashed back` });
      else if (closed) events.push({ ...e, owner: 'user', blame: false, text: `${text} (its agent closed ${before.tab}, which the user had open)` });
      else if (!browserFront(monitor, e.browser, e.t)) {
        events.push({ ...e, owner: owners.get(e.tab) || 'round', blame: true, text: `${text} while ${BROWSER_APP[e.browser]} was in the background${owners.has(e.tab) ? '' : ' (programmatic, unknown cause)'}` });
      } else events.push({ ...e, owner: 'user', blame: false, text });
    }
  }
  const causes = events.filter((e) => e.blame);
  for (const e of monitor) {
    if (e.kind !== 'front' || e.initial || !Object.values(BROWSER_APP).includes(e.app)) continue;
    const cause = causes.find((c) => Math.abs(c.t - e.t) <= FRONT_MS);
    events.push({ ...e, owner: cause ? cause.owner : 'user', blame: !!cause, text: `${time(e.t)} ${e.app} came to the front` });
  }
  return events.sort((a, b) => a.t - b.t);
}

// Sound in a tab no agent's journal or tab group names is the user's own playback: listed, not counted.
export function soundEvents(monitor, owners) {
  return monitor.filter((e) => e.kind === 'audio' && e.event === 'start' && !e.initial)
    .map((e) => ({ ...e, owner: owners.get(e.tab) || 'user', text: `${time(e.t)} ${e.tab} started playing sound ${e.url}` }));
}

const keepMatches = (task, url) => (task.keep || []).some((re) => new RegExp(re, 'i').test(url));

// atTurnEnd (A) and afterExit (B): inventories keyed "browser:id". startKeys: tabs open at round start (the user's).
export function gradeTabs({ task, tabs, atTurnEnd, afterExit, startKeys }) {
  const mine = [...tabs];
  const left = mine.filter((k) => atTurnEnd[k]?.owner);
  const extra = mine.filter((k) => atTurnEnd[k] && !atTurnEnd[k].owner && !startKeys.has(k) && !keepMatches(task, atTurnEnd[k].url));
  const controlled = mine.filter((k) => afterExit[k]?.owner);
  const problems = [
    ...left.map((k) => `left at turn end: ${k} ${atTurnEnd[k].url}`),
    ...extra.map((k) => `extra tab for the user: ${k} ${atTurnEnd[k].url}`),
    ...controlled.map((k) => `still controlled after the session ended: ${k} ${afterExit[k].url}`),
  ];
  return { ok: problems.length === 0, cell: problems.length ? `left ${left.length}, extra ${extra.length}, controlled ${controlled.length}` : 'ok', problems };
}

export function gradeTime({ task, run, journal }) {
  const total = (run.result?.duration_ms ?? 0) / 1000;
  const capture = (journal || []).filter((e) => e.type === 'point').reduce((sum, p) => sum + (p.captureMs || 0), 0) / 1000;
  const net = total - capture;
  const ok = !task.budgetSeconds || net <= task.budgetSeconds;
  return { ok, cell: `${total.toFixed(0)} s, ${net.toFixed(0)} s net${task.budgetSeconds ? ` / ${task.budgetSeconds}` : ''}`,
    problems: ok ? [] : [`${net.toFixed(0)} s without recording overhead, budget ${task.budgetSeconds} s`] };
}

export function gradeTokens(run) {
  const u = run.result?.usage || {};
  const parts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens, u.output_tokens].map((n) => n || 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { cell: `in ${parts[0]}, write ${parts[1]}, read ${parts[2]}, out ${parts[3]}, total ${total}`, cost: run.result?.total_cost_usd ?? 0 };
}

// The user's own tabs (unowned at round start) must keep their url and stay open. A change counts only on a tab some
// agent's journal names (claimed, closed, called on): an agent can't touch their tabs any other way, and the rest is the user
// browsing while they watch (listed, not counted). Which tab is active is graded by focusEvents.
export function userTabChanges(start, end, touched = new Set()) {
  const changes = []; const browsing = [];
  for (const [k, tab] of Object.entries(start)) {
    if (tab.owner) continue;
    const now = end[k];
    const change = !now ? `${k} closed (${tab.url})` : now.url !== tab.url ? `${k} ${tab.url} -> ${now.url}` : null;
    if (change) (touched.has(k) ? changes : browsing).push(change);
  }
  return { changes, browsing };
}

// Monitor errors and gaps over MONITOR_GAP_MS between tick starts: the round was not watched then.
const MONITOR_GAP_MS = 2000;
export function monitorProblems(log, ticks) {
  const problems = log.filter((e) => e.kind === 'error').map((e) => `${time(e.t)} monitor error: ${e.message}`);
  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i] - ticks[i - 1] > MONITOR_GAP_MS) problems.push(`${time(ticks[i - 1])} monitor gap of ${((ticks[i] - ticks[i - 1]) / 1000).toFixed(1)} s`);
  }
  return problems;
}

// Teardown may close only tabs this round's agents created (opened, or adopted after an action opened them), never
// one open at round start; claimed tabs and tabs seen only in a tab group or a call are the user's. A `kept` adopt is a
// child of a claimed, kept or for_user tab, maybe the user's own Cmd-click: left open (keptChildren lists them).
export function createdTabs(journals, startKeys) {
  return new Set(journals.flatMap((journal) => (journal || [])
    .filter((e) => e.type === 'tab' && (e.event === 'open' || (e.event === 'adopt' && !e.kept)) && !startKeys.has(e.tab)).map((e) => e.tab)));
}

export function keptChildren(journals) {
  return journals.flatMap((journal) => (journal || []).filter((e) => e.type === 'tab' && e.event === 'adopt' && e.kept));
}

// A journaled download is deleted only if the file there is still that download: same inode and size, under
// ~/Downloads, modified after round start. stat(path) returns fs.Stats or null.
export function downloadsToDelete(journals, { downloadsDir, roundStart, stat }) {
  const remove = []; const skip = []; const seen = new Set();
  for (const e of journals.flat().filter((e) => e?.type === 'download' && e.path).reverse()) { // latest line per path
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    const s = e.path.startsWith(downloadsDir + path.sep) ? stat(e.path) : null;
    const why = !e.path.startsWith(downloadsDir + path.sep) ? 'not under ~/Downloads'
      : !s ? 'gone'
      : s.ino !== e.ino || s.size !== e.bytes ? `not the download any more (inode ${s.ino}/${e.ino}, ${s.size}/${e.bytes} bytes)`
      : s.mtimeMs < roundStart ? 'modified before the round started' : null;
    if (why) skip.push({ path: e.path, why }); else remove.push(e.path);
  }
  return { remove, skip };
}

const time = (t) => new Date(t).toTimeString().slice(0, 8);

// --- Host socket client ---

async function connectHost(browser) {
  const socket = net.connect(path.join(SOCKET_DIR, `${browser}.sock`));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const send = (m) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); socket.write(Buffer.concat([h, b])); };
  const waiting = new Map(); let nextId = 1; let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const n = buffer.readUInt32LE(0); const m = JSON.parse(buffer.subarray(4, 4 + n)); buffer = buffer.subarray(4 + n);
      const done = waiting.get(m.id); if (!done) continue;
      waiting.delete(m.id); m.error ? done.reject(new Error(m.error.message)) : done.resolve(m.result);
    }
  });
  send({ method: 'host.auth', params: { token: fs.readFileSync(path.join(SOCKET_DIR, 'token'), 'utf8').trim() } });
  return {
    request: (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, { resolve, reject }); send({ id, method, params }); }),
    close: () => socket.end(),
  };
}

// One inventory of every tab in both browsers, keyed "browser:id".
async function inventory(hosts) {
  const all = {};
  for (const [browser, host] of Object.entries(hosts)) for (const tab of await host.request('tabs.listAll')) all[keyOf(browser, tab)] = { ...tab, browser };
  return all;
}

// --- Monitor ---

function frontApp() {
  return new Promise((resolve) => execFile('lsappinfo', ['front'], (err, asn) => {
    if (err) return resolve(null);
    execFile('lsappinfo', ['info', '-only', 'name', asn.trim()], (err2, info) => resolve(err2 ? null : (info.match(/"([^"]*)"/) || [])[1] || null));
  }));
}

function startMonitor(hosts, file) {
  const log = [];
  const write = (e) => { const entry = { t: Date.now(), ...e }; log.push(entry); fs.appendFileSync(file, JSON.stringify(entry) + '\n'); };
  let front; const active = new Map(); const windows = new Map(); const audible = new Map(); const grouped = new Set();
  let first = true; let running = true;
  const tick = async () => {
    const app = await frontApp();
    if (app && app !== front) { write({ kind: 'front', app, initial: first || undefined }); front = app; }
    const tabs = await inventory(hosts);
    const seenWindows = new Map();
    for (const [k, tab] of Object.entries(tabs)) {
      const win = `${tab.browser}:${tab.windowId}`;
      if (!seenWindows.has(win)) seenWindows.set(win, []);
      seenWindows.get(win).push(k);
      if (tab.active && active.get(win) !== k) { write({ kind: 'active', browser: tab.browser, windowId: tab.windowId, tab: k, url: tab.url, initial: !active.has(win) || undefined }); active.set(win, k); }
      const sounding = tab.audible && !tab.muted;
      if (sounding && !audible.has(k)) { write({ kind: 'audio', event: 'start', tab: k, url: tab.url, owner: tab.owner, initial: first || undefined }); audible.set(k, tab); }
      if (!sounding && audible.has(k)) { write({ kind: 'audio', event: 'stop', tab: k, url: tab.url, owner: tab.owner }); audible.delete(k); }
      if (tab.groupTitle?.startsWith('🧪 ') && !grouped.has(k)) { write({ kind: 'group', tab: k, label: tab.groupTitle, url: tab.url }); grouped.add(k); }
    }
    for (const [k, tab] of audible) if (!tabs[k]) { write({ kind: 'audio', event: 'stop', tab: k, url: tab.url, owner: tab.owner, gone: true }); audible.delete(k); }
    for (const [win, keys] of seenWindows) if (!windows.has(win)) write({ kind: 'window', event: 'open', browser: win.split(':')[0], windowId: Number(win.split(':')[1]), tabs: keys, initial: first || undefined });
    for (const win of windows.keys()) if (!seenWindows.has(win)) { write({ kind: 'window', event: 'close', browser: win.split(':')[0], windowId: Number(win.split(':')[1]) }); active.delete(win); }
    windows.clear(); for (const [win, keys] of seenWindows) windows.set(win, keys);
    first = false;
  };
  const ticks = [];
  const done = (async () => {
    while (running) {
      const started = Date.now();
      ticks.push(started);
      await tick().catch((err) => write({ kind: 'error', message: err.message }));
      await sleep(Math.max(0, 250 - (Date.now() - started)));
    }
  })();
  return { log, ticks, stop: async () => { running = false; await done; } };
}

// --- One agent ---

function runAgent(task, out, model, effort, mcpRoot, hosts) {
  const dir = path.join(out, task.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { fowlbrowser: {
    command: path.join(mcpRoot, 'mcp/bin/fowlbrowser-mcp'),
    env: { FOWLBROWSER_LABEL: labelOf(task.name), FOWLBROWSER_RECORD: dir },
  } } }, null, 2));
  const browserName = task.browser === 'helium' ? 'Helium' : 'Chrome';
  const prompt = `${task.prompt.replaceAll('{browser}', browserName).replaceAll('{repo}', path.resolve(ROOT))}\n\nEnd your answer with one line starting with RESULT: that states ${task.result}.`;
  const run = { name: task.name, started: Date.now(), firstToolAt: null, tools: [], result: null, exitCode: null, killed: false };
  const child = spawn('claude', ['-p', '--model', model, '--effort', effort, '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--strict-mcp-config', '--mcp-config', path.join(dir, 'mcp.json'), '--settings', path.join(out, 'settings.json'),
    '--allowedTools', 'mcp__fowlbrowser', '--disallowedTools', 'Bash,WebFetch,WebSearch,Read,Write,Edit'],
  { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = fs.createWriteStream(path.join(dir, 'events.jsonl'));
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');
  const exited = new Promise((resolve) => child.on('close', (code) => { run.exitCode = code; resolve(); }));
  let pending = '';
  const gotResult = new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      events.write(chunk);
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'assistant') for (const c of e.message?.content || []) if (c.type === 'tool_use') {
          run.firstToolAt ??= Date.now();
          run.tools.push({ t: Date.now(), name: c.name });
        }
        if (e.type === 'result') { run.result = e; resolve(); }
      }
    });
    exited.then(resolve);
  });
  return (async () => {
    await gotResult;
    await sleep(1000);
    run.atTurnEnd = await inventory(hosts);
    child.stdin.end();
    const timer = setTimeout(() => { run.killed = true; child.kill('SIGKILL'); }, 20000);
    await exited; clearTimeout(timer);
    await sleep(2000);
    run.afterExit = await inventory(hosts);
    events.end();
    if (stderr) fs.writeFileSync(path.join(dir, 'stderr.txt'), stderr);
    return run;
  })();
}

// --- Reports ---

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function htmlReport(rows) {
  const parts = ['<!doctype html><meta charset="utf-8"><title>Round report</title><style>body{font-family:system-ui;background:#fff;color:#111;margin:24px}',
    'figure{margin:0 0 24px;display:inline-block}.shot{position:relative;display:inline-block;border:2px solid #ccc}.shot.bad{border-color:#d00}',
    '.shot img{display:block}.ring{position:absolute;width:24px;height:24px;margin:-12px 0 0 -12px;border:2px solid #07f;border-radius:50%}',
    '.dot{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;background:#f80;border-radius:50%}</style>'];
  for (const { task, journal, cursor } of rows) {
    parts.push(`<h2>${escapeHtml(task.name)} (${task.browser}) — cursor ${escapeHtml(cursor.cell)}</h2>`);
    const frames = (journal || []).filter((e) => e.type === 'point' && e.frame);
    if (!frames.length) parts.push(`<p>${journal ? 'No frames.' : 'No journal.'}</p>`);
    frames.forEach((p, i) => {
      const ok = p.target && p.cursor?.visible && Math.hypot(p.cursor.x - p.target.x, p.cursor.y - p.target.y) <= 4;
      parts.push(`<figure><div class="shot${ok ? '' : ' bad'}"><img src="${escapeHtml(`${task.name}/${p.frame}`)}">`
        + (p.target ? `<span class="ring" style="left:${p.target.x}px;top:${p.target.y}px"></span>` : '')
        + (p.cursor ? `<span class="dot" style="left:${p.cursor.x}px;top:${p.cursor.y}px"></span>` : '')
        + `</div><figcaption>${i + 1}. ${escapeHtml(p.tool)} ${time(p.t)}${ok ? '' : ' (not ok)'}</figcaption></figure>`);
    });
  }
  return parts.join('\n');
}

// --- Main ---

async function main() {
  const flags = new Set(['swap', 'keep-tabs']);
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i].slice(2);
    args[a] = flags.has(a) ? true : process.argv[++i];
  }
  let tasks = JSON.parse(fs.readFileSync(args.tasks || path.join(ROOT, 'tools/agents/example.json'), 'utf8'));
  if (args.only) tasks = tasks.filter((t) => args.only.split(',').includes(t.name));
  if (args.swap) tasks = tasks.map((t) => ({ ...t, browser: t.browser === 'helium' ? 'chrome' : 'helium' }));
  const model = args.model || 'opus';
  const effort = args.effort || 'medium';
  const mcpRoot = args.mcp === 'installed' ? path.join(os.homedir(), 'Library/Application Support/FowlBrowser') : ROOT;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const out = path.resolve(args.out || `/tmp/fb-rounds/${stamp}`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [
    { type: 'command', command: `node "${path.join(mcpRoot, 'mcp/bin/turn-ended.mjs')}"`, timeout: 5 },
  ] }] } }, null, 2));

  // --serve: the site the tasks grade against (tools/agents/forms.json), up before the agents and killed after grading.
  let server = null;
  if (args.serve) {
    const log = fs.openSync(path.join(out, 'serve.log'), 'a');
    server = spawn('sh', ['-c', `exec ${args.serve}`], { cwd: ROOT, stdio: ['ignore', log, log] });
    process.on('exit', () => server.kill());
    const origin = new URL(tasks.find((t) => t.grade).grade).origin;
    for (let i = 0; ; i++) {
      if (await fetch(origin).then(() => true, () => false)) break;
      if (i === 50) throw new Error(`--serve: ${origin} did not answer within 10 s (see ${out}/serve.log)`);
      await sleep(200);
    }
  }

  // Only browsers with FowlBrowser connected are watched; a task in one that isn't stops the round before it starts.
  const hosts = Object.fromEntries((await Promise.all(BROWSERS.map(async (b) => [b, await connectHost(b).catch(() => null)]))).filter(([, host]) => host));
  const missing = [...new Set(tasks.map((t) => t.browser))].filter((b) => !hosts[b]);
  if (missing.length) {
    console.error(`Not connected: ${missing.join(', ')} (no FowlBrowser socket in ${SOCKET_DIR}). Open the browser with the extension loaded, ` +
      'or pick tasks with --only, or move them to the other browser with --swap.');
    process.exit(2);
  }
  const roundStart = Date.now();
  const start = await inventory(hosts);
  const startKeys = new Set(Object.keys(start));
  const monitor = startMonitor(hosts, path.join(out, 'monitor.jsonl'));
  console.log(`round of ${tasks.length} agents (${model}, ${effort}, mcp ${args.mcp || 'repo'}); output in ${out}`);
  const runs = await Promise.all(tasks.map(async (task) => {
    const run = await runAgent(task, out, model, effort, mcpRoot, hosts);
    console.log(`${task.name} finished in ${((Date.now() - run.started) / 1000).toFixed(0)} s`);
    return run;
  }));
  await monitor.stop();
  const end = await inventory(hosts);
  const grades = await Promise.all(tasks.map((t) => t.grade && fetch(t.grade).then((r) => r.json()).catch((err) => ({ error: err.message }))));
  server?.kill();

  // Grade
  const journals = tasks.map((t) => readJsonl(path.join(out, t.name, 'journal.jsonl')));
  runs.forEach((run, i) => { run.tabs = agentTabs(tasks[i].name, journals[i], monitor.log); });
  const owners = new Map(runs.flatMap((run) => [...run.tabs].map((k) => [k, run.name])));
  const calls = journals.flatMap((journal, i) => (journal || []).filter((e) => e.type === 'call').map((e) => ({ ...e, agent: tasks[i].name })));
  const closedAt = new Map(journals.flatMap((journal) => (journal || []).filter((e) => e.type === 'tab' && e.event === 'close').map((e) => [e.tab, e.t])));
  const allFocus = focusEvents(monitor.log, owners, calls, closedAt);
  const focus = allFocus.filter((e) => e.blame);
  const sound = soundEvents(monitor.log, owners);
  const problems = [];
  const rows = tasks.map((task, i) => {
    const run = runs[i]; const journal = journals[i];
    const outcome = gradeOutcome({ task, run, journal, after: run.afterExit, startKeys, grade: grades[i] });
    const cursor = gradeCursor({ task, journal });
    const myFocus = focus.filter((e) => e.owner === task.name);
    const mySound = sound.filter((e) => e.owner === task.name);
    const tabs = gradeTabs({ task, tabs: run.tabs, atTurnEnd: run.atTurnEnd, afterExit: run.afterExit, startKeys });
    const timing = gradeTime({ task, run, journal });
    const tokens = gradeTokens(run);
    const toolAt = (t) => { const call = (journal || []).filter((e) => e.type === 'call' && e.t <= t).pop(); return call ? `, last tool ${call.tool}` : ''; };
    for (const p of outcome.problems) problems.push(`${task.name} · outcome · ${p}`);
    for (const p of cursor.problems) problems.push(`${task.name} · cursor · ${p}`);
    for (const e of myFocus) problems.push(`${task.name} · focus · ${e.text}${toolAt(e.t)}`);
    for (const e of mySound) problems.push(`${task.name} · sound · ${e.text}${toolAt(e.t)}`);
    for (const p of tabs.problems) problems.push(`${task.name} · tabs · ${p}`);
    for (const p of timing.problems) problems.push(`${task.name} · time · ${p}`);
    return { task, journal, outcome, cursor, focus: myFocus, sound: mySound, tabs, timing, tokens };
  });
  const touched = new Set(journals.flatMap((journal) => (journal || []).map((e) => e.tab).filter(Boolean)));
  const userTabs = userTabChanges(start, end, touched);
  for (const c of userTabs.changes) problems.push(`round · the user's tabs · ${c}`);
  for (const e of focus.filter((e) => e.owner === 'round')) problems.push(`round · focus · ${e.text}`);
  for (const p of monitorProblems(monitor.log, monitor.ticks)) problems.push(`round · monitor · ${p}`);

  // Cleanup before the report, so its failures count: tabs this round's agents created and left for the user, then this
  // round's downloads in ~/Downloads, then a final inventory.
  const created = createdTabs(journals, startKeys);
  if (!args['keep-tabs']) {
    const now = await inventory(hosts);
    for (const k of created) {
      if (!now[k] || now[k].owner) continue;
      try { await hosts[now[k].browser].request('tabs.closeUnowned', { tabId: now[k].id }); console.log(`closed ${k} ${now[k].url}`); }
      catch (err) { problems.push(`round · teardown · could not close ${k}: ${err.message}`); }
    }
  }
  for (const e of keptChildren(journals)) console.log(`left open (may be the user's): ${e.tab} ${e.url}`);
  const { remove, skip } = downloadsToDelete(journals, { downloadsDir: path.join(os.homedir(), 'Downloads'), roundStart,
    stat: (file) => { try { return fs.statSync(file); } catch { return null; } } });
  for (const { path: file, why } of skip) console.log(`kept ${file}: ${why}`);
  for (const file of remove) {
    try { fs.rmSync(file); console.log(`deleted ${file}`); }
    catch (err) { problems.push(`round · teardown · could not delete ${file}: ${err.message}`); }
  }
  if (!args['keep-tabs']) {
    const final = await inventory(hosts).catch((err) => { problems.push(`round · teardown · final inventory failed: ${err.message}`); return {}; });
    for (const k of created) if (final[k]) problems.push(`round · teardown · still open after cleanup: ${k} ${final[k].url}${final[k].owner ? ' (controlled)' : ''}`);
  }

  const cell = (events) => (events.length ? `FAIL: ${events.length}` : 'ok');
  const lines = ['| agent | browser | outcome | cursor | focus | sound | tabs | time | calls | tokens | $ |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const calls = r.journal ? r.journal.filter((e) => e.type === 'call').length : '-';
    lines.push(`| ${r.task.name} | ${r.task.browser} | ${r.outcome.cell} | ${r.cursor.cell} | ${cell(r.focus)} | ${cell(r.sound)} | ${r.tabs.cell} | ${r.timing.cell} | ${calls} | ${r.tokens.cell} | ${r.tokens.cost.toFixed(3)} |`);
  }
  lines.push('', problems.length ? `ROUND NOT CLEAN: ${problems.length} problems` : 'ROUND CLEAN', '', ...problems.map((p) => `- ${p}`));
  const notCounted = [...allFocus.filter((e) => !e.blame), ...sound.filter((e) => e.owner === 'user')].sort((a, b) => a.t - b.t);
  if (notCounted.length || userTabs.browsing.length) {
    lines.push('', 'Not counted, no agent caused it (the user using their Mac):', ...notCounted.map((e) => `- ${e.text}`), ...userTabs.browsing.map((c) => `- their tab ${c}`));
  }
  lines.push('', 'Answers:');
  for (const [i, run] of runs.entries()) {
    const answer = String(run.result?.result ?? '').split('\n').filter((l) => l.includes('RESULT:')).pop() ?? '(none)';
    lines.push(`- ${tasks[i].name}: ${answer.trim()}`);
  }
  const report = lines.join('\n') + '\n';
  fs.writeFileSync(path.join(out, 'report.md'), report);
  fs.writeFileSync(path.join(out, 'report.html'), htmlReport(rows));
  console.log('\n' + report);

  for (const host of Object.values(hosts)) host.close();
  process.exit(problems.length ? 1 : 0);
}

if (import.meta.main) await main();
