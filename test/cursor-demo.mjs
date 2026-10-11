#!/usr/bin/env node
// Drives the agent cursor through its motions in a real, shown tab, for recording and judging it (best on a machine nobody is using: it
// brings its tab to the front). Talks to the cursor module directly, so it can retarget a move mid-flight.
//   node test/cursor-demo.mjs [--browser chrome] [--dark] [--hold <s>] [--reduced] [--record <dir>] [--url <page>]
// --hold parks the cursor at rest for that many seconds (for still crops) instead of the motion sequence.
// --url shows it on a real page instead of the test site's (sites with strict CSP or Trusted Types).
// --record films the tab at device resolution through the browser's screencast: <dir>/<ms>.jpg per painted frame.
// Prints each move's time to arrival (capped at cursor.ARRIVAL_CAP_MS like the tools).
import fs from 'node:fs';
import path from 'node:path';
import { BrowserManager } from '../mcp/src/browsers.mjs';
import * as cursor from '../mcp/src/cursor/index.mjs';
import { ensureSite, parseArgs, SITE, sleep } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), { browser: 'chrome' });
const stopSite = await ensureSite();
const manager = new BrowserManager();
const browser = await manager.get(args.browser);
await browser.playwright();
const created = await browser.host.request('tabs.open', {});
const tab = await browser.waitForTab(created.id);
const log = (...parts) => console.log(`${((Date.now() - t0) / 1000).toFixed(2)}s`, ...parts);
let t0 = Date.now();
try {
  // The relay swallows Playwright's media emulation (pages keep the user's look), so ask the tab directly.
  if (args.reduced) {
    await browser.host.request('chrome.debugger.sendCommand', [{ tabId: tab.tabId }, 'Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }]);
  }
  await tab.page.goto(args.url || `${SITE}/cursor.html${args.dark ? '?dark' : ''}`);
  await browser.host.request('tabs.focus', { tabId: tab.tabId });
  await sleep(1500);
  t0 = Date.now();
  if (args.record) {
    fs.mkdirSync(args.record, { recursive: true });
    // Straight to the tab's debugger session: the relay's tab sessions don't carry screencasts.
    const send = (method, params) => browser.host.request('chrome.debugger.sendCommand', [{ tabId: tab.tabId }, method, params]);
    browser.host.on('chrome.debugger.onEvent', ([source, method, params]) => {
      if (source?.tabId !== tab.tabId || source.sessionId || method !== 'Page.screencastFrame') return;
      fs.writeFileSync(path.join(args.record, `${String(Math.round(params.metadata.timestamp * 1000)).padStart(14, '0')}.jpg`), Buffer.from(params.data, 'base64'));
      send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    });
    await send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 2048, maxHeight: 2048, everyNthFrame: 2 });
  }
  const move = async (name, x, y) => {
    const started = Date.now();
    await cursor.moveTo(tab, { x, y });
    log(name, `(${x}, ${y})`, `${Date.now() - started} ms`);
  };
  if (args.hold) {
    await move('appear + rest', 300, 450);
    await sleep(Number(args.hold) * 1000);
  } else {
    // Kept to the lower left and right of a 1280x720 viewport, clear of macOS's centred system alerts.
    await move('appear + travel', 300, 450);
    await sleep(800);
    await move('short', 420, 520);
    await sleep(800);
    await move('long curved', 1200, 620);
    await sleep(400);
    cursor.click(tab);
    log('click');
    await sleep(900);
    cursor.click(tab);
    await sleep(120);
    cursor.click(tab);
    log('double click (retarget)');
    await sleep(900);
    cursor.moveTo(tab, { x: 250, y: 680 });
    log('interrupted move to (250, 680)');
    await sleep(220);
    await move('retarget mid-flight', 1100, 420);
    await sleep(600);
    await move('long back', 200, 420);
    cursor.click(tab);
    await sleep(900);
    // Each action cue, as the tools play them (looping cues end after 1.6 s).
    for (const kind of ['observe', 'scroll', 'text', 'key', 'navigate', 'drag', 'transfer']) {
      cursor.cue(tab, kind);
      log('cue', kind);
      await sleep(1600);
      cursor.cueEnd(tab);
      await sleep(900);
    }
    // An agent clicking from a script (evaluate): the overlay follows those clicks itself.
    cursor.cue(tab, 'observe');
    cursor.follow(tab, true);
    log('script clicks');
    await tab.page.evaluate(async () => {
      for (const id of ['target', 'field', 'target']) {
        document.getElementById(id)?.click();
        await new Promise((r) => setTimeout(r, 900));
      }
    }).catch((error) => log('script clicks failed:', error.message));
    cursor.follow(tab, false);
    cursor.cueEnd(tab);
    await sleep(900);
    // A modal dialog (top layer) opened after the cursor: the cursor must stay above it and its backdrop.
    await tab.page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.id = 'demo-modal';
      dialog.style.cssText = 'padding:32px;border:0;border-radius:12px';
      const button = document.createElement('button');
      button.textContent = 'Inside the modal';
      dialog.append(button);
      document.body.append(dialog);
      dialog.showModal();
    }).catch((error) => log('modal failed:', error.message));
    const inModal = await tab.page.evaluate(() => {
      const r = document.querySelector('#demo-modal button')?.getBoundingClientRect();
      return r && { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    }).catch(() => null);
    if (inModal) {
      await cursor.moveTo(tab, inModal);
      cursor.click(tab);
      log('modal click', JSON.stringify(inModal));
      await sleep(1200);
      await tab.page.evaluate(() => document.getElementById('demo-modal')?.close()).catch(() => {});
    }
    log('idle: fades out in 15 s');
    await sleep(16_500);
    log('done');
  }
} catch (error) {
  console.error('demo failed:', error);
  process.exitCode = 1;
} finally {
  await browser.host.request('chrome.tabs.remove', [tab.tabId]).catch(() => {});
  stopSite();
  process.exit();
}
