#!/usr/bin/env node
// Concurrency stress for FowlBrowser.
//   node test/stress.mjs [--mode a|b|both]
// A: one MCP server, 8 scenario runs at once on different tabs across both browsers (Agent-tool subagents).
// B: 4 MCP server processes at once, each running scenarios in both browsers (separate Claude sessions).
// Checks: every run sees only its own server's tabs in tab_list mine (runJob does this), nothing is left
// open, and "user" tabs that existed before the run (the user's real ones plus stand-ins we open and release
// first) keep their url, title, active state, mute and group. tab_list has no window or position fields.
import { connect, ensureSite, loadScenarios, parseArgs, parseTabs, pool, printTable, runJob, SITE, sleep, sweepLeaks } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), { mode: 'both' });
const BROWSERS = ['chrome', 'helium'];
const LOCAL = ['form', 'keys', 'dialogs', 'popups', 'delayed', 'navigation', 'hover', 'frames'];
const scenarios = Object.fromEntries((await loadScenarios(LOCAL.join(','))).map(s => [s.name, s]));

const stopSite = await ensureSite();
const setup = await connect(`stress-setup-${process.pid}`);
let failed = false;

// Every tab in normal windows, keyed by tab id, with the fields a user would notice changing.
async function allTabs(browser) {
  const list = parseTabs(await setup.call('tab_list', { browser, scope: 'all' }));
  return new Map(list.map(x => [x.tab, { url: x.url, title: x.title, active: x.active, owner: x.owner, muted: x.muted, group: x.group }]));
}

// User tabs (owned by nobody before the run) must be unchanged; any new tab still open is a leak,
// except tabs other sessions own (another agent may be working in the same browser at the same time).
function diffTabs(browser, before, after) {
  const problems = [];
  for (const [tab, b] of before) {
    if (b.owner !== null) continue;
    const a = after.get(tab);
    if (!a) { problems.push(`${tab} (${b.url}) disappeared`); continue; }
    for (const k of ['url', 'title', 'active', 'owner', 'muted', 'group']) {
      if (a[k] !== b[k]) problems.push(`${tab} ${k}: ${JSON.stringify(b[k])} -> ${JSON.stringify(a[k])}`);
    }
  }
  for (const [tab, a] of after) if (!before.has(tab) && a.owner !== 'other') problems.push(`${tab} (${a.url}) left open`);
  return problems.map(p => `${browser} ${p}`);
}

async function modeA() {
  const server = await connect(`stress-a-${process.pid}`);
  try {
    const jobs = LOCAL.map((name, i) => [scenarios[name], BROWSERS[i % 2]]);
    const rows = await pool(jobs, 8, ([s, b]) => runJob(server, s, b));
    printTable(rows, 'Stress A: one server, 8 parallel runs');
    return rows;
  } finally { await server.close(); }
}

async function modeB() {
  const names = ['form', 'keys', 'dialogs', 'popups'];
  const servers = await Promise.all([1, 2, 3, 4].map(n => connect(`stress-b${n}-${process.pid}`)));
  try {
    const perServer = await Promise.all(servers.map((server, n) => {
      // Each server runs two scenarios in both browsers, rotated so different servers hit different pages at once.
      const mine = [names[n % 4], names[(n + 1) % 4]];
      const jobs = mine.flatMap(name => BROWSERS.map(b => [scenarios[name], b]));
      return pool(jobs, 2, ([s, b]) => runJob(server, s, b)).then(rows => rows.map(r => ({ ...r, scenario: `${server.label.split('-')[1]}/${r.scenario}` })));
    }));
    // Each server must end up owning nothing.
    for (const server of servers) {
      for (const browser of BROWSERS) {
        const left = parseTabs(await server.call('tab_list', { browser, scope: 'mine' }));
        if (left.length) perServer.push([{ scenario: `${server.label}/leftovers`, browser, ok: false, ms: 0, error: left.map(x => x.url).join(', ') }]);
      }
    }
    const rows = perServer.flat();
    printTable(rows, 'Stress B: 4 servers at once, both browsers each');
    return rows;
  } finally { await Promise.all(servers.map(s => s.close())); }
}

try {
  // Stand-in user tabs: opened by the setup client, then released so they are owned by nobody.
  const standIns = [];
  for (const browser of BROWSERS) {
    for (const n of [1, 2]) {
      const res = await setup.call('tab_open', { browser, url: `${SITE}/user.html?n=${browser}-${n}` });
      const tab = res.structured?.tab ?? res.text.match(new RegExp(`\\b${browser}:\\d+\\b`))?.[0];
      await setup.call('tab_release', { tab });
      standIns.push(tab);
    }
  }
  await sleep(1500); // let titles settle
  const before = Object.fromEntries(await Promise.all(BROWSERS.map(async b => [b, await allTabs(b)])));

  const rows = [];
  if (args.mode === 'a' || args.mode === 'both') rows.push(...(await modeA()));
  if (args.mode === 'b' || args.mode === 'both') rows.push(...(await modeB()));
  if (rows.some(r => !r.ok)) failed = true;

  await sleep(1500); // disconnect cleanup in the extension
  const problems = [];
  for (const b of BROWSERS) problems.push(...diffTabs(b, before[b], await allTabs(b)));
  console.log(`\nUser tabs and leftovers: ${problems.length ? 'FAIL' : 'pass'} (${[...before.chrome.values(), ...before.helium.values()].filter(x => x.owner === null).length} user tabs checked)`);
  for (const p of problems) console.log(`  ${p}`);
  if (problems.length) failed = true;
  const leaked = await sweepLeaks(setup, BROWSERS);
  if (leaked.length) console.log(`  closed leaked unowned tabs: ${leaked.join(', ')}`);

  // Remove the stand-ins we created.
  for (const tab of standIns) {
    await setup.call('tab_claim', { tab }).then(() => setup.call('tab_close', { tab, confirm_close_users_tab: true })).catch(e => console.log(`cleanup ${tab}: ${e.message}`));
  }
} catch (e) {
  failed = true;
  console.error(`stress harness error: ${e.message}`);
} finally {
  await setup.close();
  stopSite();
}
process.exit(failed ? 1 : 0);
