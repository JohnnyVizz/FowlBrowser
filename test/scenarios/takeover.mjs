// Takeover, with a real mouse and keyboard (mac2 only, under its GUI lock: run.mjs --gui). The agent's own input in
// the tab the user is looking at never counts, however much of it there is; one real click, real typing, an address
// typed into the address bar or Cmd-W does, and the next call says so in words. Pages that reload or go back by
// themselves don't count either. Also records what opening DevTools on an agent tab does.
// Real input comes from cua-driver-local (mac2's GUI driver): pixel clicks posted to the browser, keys through the HID
// queue for the browser's own shortcuts. The scenario brings its tabs to the front and gives the window its previous
// active tab back at the end, like cursor.mjs.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { rawHost, sleep, ToolError } from '../lib.mjs';

const CUA = `${os.homedir()}/.local/bin/cua-driver-local`;
const APPS = { chrome: 'Google Chrome', helium: 'Helium' };
// One driver session per job, so a pixel click finds the capture it was measured on; ended when the job is done.
// Exclusive scenarios run one at a time, so one variable does.
let session = null;
const QUIET_MS = 800; // real input comes this long after the agent's last call (its windows end 250 ms after a call)

function cua(tool, args) {
  let out;
  try {
    out = execFileSync(CUA, ['call', tool, JSON.stringify({ session, ...args })], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const output = `${error.stdout ?? ''} ${error.stderr ?? ''}`.trim();
    console.error(`cua-driver-local call ${tool} failed: ${output}`);
    throw new Error(`cua-driver-local call ${tool} ${JSON.stringify(args)} failed: ${output.slice(0, 600)}`);
  }
  try { return JSON.parse(out); } catch { return out; }
}

// The element's centre in screen points (CSS px at zoom 100%), from the page.
const SCREEN_POINT_FN = (selector) => `() => {
  const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
  return { x: screenX + (outerWidth - innerWidth) / 2 + r.left + r.width / 2, y: screenY + (outerHeight - innerHeight) + r.top + r.height / 2 };
}`;

export default {
  name: 'takeover',
  gui: true,
  exclusive: true,
  async run(t) {
    session = `fowlbrowser-${t.tag}`;
    const host = await rawHost(t.browser, `raw-${t.tag}`);
    const activeBefore = (await t.listAll()).filter((x) => x.active).map((x) => x.tab);
    const restoreFocus = async () => {
      const now = (await t.listAll()).filter((x) => x.active).map((x) => x.tab);
      for (const previous of activeBefore.filter((x) => !now.includes(x))) await t.call('tab_focus', { tab: previous }).catch(() => {});
    };
    // The browser window holding the page titled `title` (the active tab's title is the window's).
    const windowOf = (title) => {
      const found = cua('list_windows', { on_screen_only: true }).windows
        .filter((w) => w.app_name === APPS[t.browser] && w.title.includes(title)).sort((a, b) => b.z_index - a.z_index)[0];
      if (!found) throw new Error(`no ${APPS[t.browser]} window titled "${title}"`);
      return found;
    };
    // The point is read first: an agent call running on the tab would queue the read behind it.
    const realClick = async (tab, selector, title) => realClickAt(await t.eval(tab, SCREEN_POINT_FN(selector)), title);
    const realClickAt = async (point, title) => {
      const win = windowOf(title);
      const state = cua('get_window_state', { pid: win.pid, window_id: win.window_id, include_accessibility_tree: false });
      const bounds = state.window_bounds ?? win.bounds;
      const scale = state.screenshot_width / bounds.width;
      await sleep(QUIET_MS);
      const at = Date.now();
      cua('click', { pid: win.pid, window_id: win.window_id, ...(state.capture_id && { capture_id: state.capture_id }),
        x: Math.round((point.x - bounds.x) * scale), y: Math.round((point.y - bounds.y) * scale) });
      return at;
    };
    const keys = (title, combo) => {
      const win = windowOf(title);
      cua('hotkey', { pid: win.pid, window_id: win.window_id, keys: combo, delivery_mode: 'foreground' });
    };
    // Every result so far, so case 1 can show no notice ever came.
    const texts = [];
    const call = async (name, args) => {
      const res = await t.call(name, args);
      texts.push(res.text);
      return res;
    };
    const refusal = async (tab) => {
      const error = await t.call('snapshot', { tab }).then(() => null, (e) => e);
      t.ok(error instanceof ToolError, `calls on ${tab} are refused now`);
      return error.message;
    };
    const parkedOf = async (tab) => (await host.request('tabs.listAll', {})).find((x) => `${t.browser}:${x.id}` === tab)?.parked ?? null;

    const tab = await t.open(`${t.site}/takeover.html?tag=${t.tag}`);
    const other = await t.open(`${t.site}/index.html?other=${t.tag}`);
    try {
      await t.call('tab_focus', { tab });

      t.step('1: a burst of agent actions in the focused tab is no takeover');
      const s = await t.snapshot(tab);
      const ref = (role, name) => t.ref(s, role, name);
      const [add, search, notes, size, gift, drag, drop, hover, box] = [ref('button', 'Add to cart'), ref('textbox', 'Search'), ref('textbox', 'Notes'),
        ref('combobox', 'Size'), ref('checkbox', 'Gift wrap'), ref('generic', 'Drag me'), ref('generic', 'Drop here'), ref('generic', 'Hover me'), ref('generic', 'Scroll inside me')];
      const burst = [
        ['click', { ref: add }], ['type', { ref: search, text: 'agent' }], ['type', { ref: search, text: 'slow', slowly: true }],
        ['press_key', { ref: search, key: 'ArrowLeft' }], ['press_key', { key: 'Tab' }], ['type', { ref: notes, text: ' more', append: true }],
        ['scroll', { direction: 'down' }], ['scroll', { direction: 'up' }], ['scroll', { ref: box, direction: 'down' }], ['drag', { from_ref: drag, to_ref: drop }],
        ['fill_form', { fields: [{ ref: search, value: 'filled' }, { ref: gift, value: true }, { ref: size, value: 'Large' }] }],
        ['select_option', { ref: size, values: ['Medium'] }], ['hover', { ref: hover }], ['click', { x: 600, y: 30 }], ['click', { ref: gift }], ['click', { ref: add }],
      ];
      let count = 0;
      for (let round = 0; round < 2; round++) {
        for (const [name, args] of burst) { await call(name, { tab, snapshot: false, ...args }); count++; }
      }
      // The agent's own navigations in the focused tab: a link, back, forward, reload, a URL.
      for (const [name, args] of [['click', { ref: t.ref(s, 'link', 'Next page') }], ['navigate', { action: 'back' }], ['navigate', { action: 'forward' }],
        ['navigate', { action: 'reload' }], ['navigate', { url: `${t.site}/takeover.html?tag=${t.tag}` }]]) {
        await call(name, { tab, snapshot: false, ...args });
        count++;
      }
      await sleep(1500); // late reports and commits
      await call('snapshot', { tab });
      t.ok(count >= 30, `${count} agent actions`);
      t.ok(!texts.some((x) => /took over/.test(x)), `no takeover notice: ${texts.find((x) => /took over/.test(x))?.slice(0, 300)}`);
      t.eq(await parkedOf(tab), null, 'not parked after the burst');

      t.step('pages that reload or go back by themselves are no takeover');
      await call('navigate', { tab, url: `${t.site}/takeover-self.html?do=reload&wait=2500&tag=${t.tag}`, snapshot: false });
      await sleep(4500);
      await call('navigate', { tab, url: `${t.site}/takeover-self.html?do=back&wait=2500&tag=${t.tag}`, snapshot: false });
      await sleep(5000);
      const selfDone = await call('evaluate', { tab, function: '() => [location.search, document.getElementById("result").textContent]' });
      t.ok(!/second=1/.test(selfDone.text), `the page went back by itself: ${selfDone.text}`);
      t.ok(!texts.some((x) => /took over/.test(x)), `no takeover notice: ${texts.find((x) => /took over/.test(x))?.slice(0, 300)}`);
      t.eq(await parkedOf(tab), null, 'not parked after the page navigated itself');
      await call('navigate', { tab, url: `${t.site}/takeover.html?tag=${t.tag}`, snapshot: false });

      t.step('2: one real click is a takeover');
      const clickedAt = await realClick(tab, '#add', 'Takeover test');
      await t.until(async () => (await parkedOf(tab)) === 'takeover', 'parked as taken over', 5000);
      let message = await refusal(tab);
      t.ok(/The user took over .* at \d\d:\d\d \(clicked "Add to cart"\)\. Stop working in that tab, tell the user where you got to, and ask before going on\. If they say to carry on there, call tab_claim on it with resume: true\./.test(message), `notice: ${message}`);
      const first = await t.call('snapshot', { tab: other });
      t.ok(first.text.startsWith(`The user took over ${tab}`), `another tab's next result starts with it: ${first.text.slice(0, 200)}`);
      t.ok(!(await t.call('snapshot', { tab: other })).text.includes('took over'), 'only once');
      const entry = (await t.listMine()).find((x) => x.tab === tab);
      t.eq([entry.parked, entry.group, entry.muted], ['takeover', null, false], 'parked: out of the group, unmuted');

      t.step('3: resume');
      const resumed = await t.call('tab_claim', { tab, resume: true });
      t.ok(/Resumed/.test(resumed.text), `resumed: ${resumed.text.slice(0, 200)}`);
      const log = await t.eval(tab, '() => cursorLog');
      t.ok(log.some(([what, at]) => what === 'removed' && at >= clickedAt), `the cursor left after the click: ${JSON.stringify(log)}`);
      t.eq(await t.resultOf(tab), 'added 1', 'the user\'s click landed (one more than the agent\'s, which were before the reload)');
      const back = (await t.listMine()).find((x) => x.tab === tab);
      t.ok(back.parked === null && back.group && back.muted, `back in its group and muted: ${JSON.stringify(back)}`);

      t.step('3b: a real click while the agent\'s wait_for runs on the tab is a takeover too');
      const point = await t.eval(tab, SCREEN_POINT_FN('#add'));
      const waitStarted = Date.now();
      const waiting = t.call('wait_for', { tab, seconds: 15, snapshot: false }).then(() => null, (e) => e);
      await realClickAt(point, 'Takeover test');
      await t.until(async () => (await parkedOf(tab)) === 'takeover', 'parked while wait_for ran', 5000);
      const waitError = await waiting;
      t.ok(waitError instanceof ToolError && /The user took over .* \(clicked "Add to cart"\)/.test(waitError.message), `wait_for ends with the notice: ${waitError?.message ?? 'it succeeded'}`);
      console.log(`WAIT_FOR ${t.browser}: ended ${Date.now() - waitStarted} ms after it started (15 s asked)`);
      await t.call('tab_claim', { tab, resume: true, snapshot: false });

      t.step('4: real typing in a field');
      await t.call('click', { tab, ref: await t.refOf(tab, 'textbox', 'Search'), snapshot: false });
      await sleep(QUIET_MS);
      const win = windowOf('Takeover test');
      cua('type_text', { pid: win.pid, window_id: win.window_id, text: 'hello', delivery_mode: 'foreground' });
      await t.until(async () => (await parkedOf(tab)) === 'takeover', 'parked after typing', 5000);
      message = await refusal(tab);
      t.ok(/\(typed in "Search"\)/.test(message), `notice: ${message}`);
      await t.call('tab_claim', { tab, resume: true, snapshot: false });

      t.step('5: an address typed into the address bar');
      await sleep(QUIET_MS);
      keys('Takeover test', ['cmd', 'l']);
      await sleep(300);
      const win5 = windowOf('Takeover test');
      cua('type_text', { pid: win5.pid, window_id: win5.window_id, text: `${t.site}/takeover.html?typed&tag=${t.tag}`, delivery_mode: 'foreground' });
      cua('press_key', { pid: win5.pid, window_id: win5.window_id, key: 'return', delivery_mode: 'foreground' });
      await t.until(async () => (await parkedOf(tab)) === 'takeover', 'parked after the address bar', 8000);
      message = await refusal(tab);
      t.ok(/\(typed an address in the address bar\)/.test(message), `notice: ${message}`);
      const typed = await t.call('tab_claim', { tab, resume: true });
      t.ok(typed.text.includes('takeover.html?typed'), `resumed on the page the user typed: ${typed.text.slice(0, 300)}`);

      t.step('6: Cmd-W');
      await t.call('tab_focus', { tab });
      await sleep(QUIET_MS);
      keys('Takeover test', ['cmd', 'w']);
      await t.until(async () => !(await host.request('tabs.listAll', {})).some((x) => `${t.browser}:${x.id}` === tab), 'tab closed', 5000);
      t.closed.add(tab);
      message = await refusal(tab);
      t.ok(/The user took over .* \(closed the tab\)\. Stop working in that tab, tell the user where you got to, and ask before going on\.$/.test(message), `notice: ${message}`);

      t.step('7: DevTools on an agent tab (recorded)');
      await t.call('tab_focus', { tab: other });
      await sleep(QUIET_MS);
      const title = 'FowlBrowser test site';
      keys(title, ['cmd', 'option', 'i']);
      await sleep(2500);
      const devtools = await t.call('snapshot', { tab: other }).then((r) => `call ok${r.text.includes('took over') ? `, notice: ${r.text.split('\n')[0]}` : ''}`, (e) => `call refused: ${e.message.split('\n').slice(0, 2).join(' ')}`);
      const parked = await parkedOf(other);
      // DevTools docks into the window by default: its panel tabs show in the window's accessibility tree.
      const devWindow = windowOf(title);
      const opened = cua('get_window_state', { pid: devWindow.pid, window_id: devWindow.window_id, include_screenshot: false, query: 'Elements' });
      const shown = (opened.filtered_element_count ?? opened.elements?.length ?? 0) > 0
        || cua('list_windows', { on_screen_only: true }).windows.some((w) => w.app_name === APPS[t.browser] && /DevTools/.test(w.title));
      console.log(`DEVTOOLS ${t.browser}: open: ${shown}; ${devtools}; parked: ${parked}`);
      t.ok(shown, 'DevTools opened');
      keys(title, ['cmd', 'option', 'i']); // closes it again (the shortcut works from the DevTools window too)
      await sleep(1500);
      if (parked) {
        const again = await t.call('tab_claim', { tab: other, resume: true });
        t.ok(/Resumed/.test(again.text), 'resumed once DevTools closed');
      }
      await t.snapshot(other);
    } finally {
      host.close();
      await restoreFocus();
      try { cua('end_session', {}); } catch {}
    }
  },
};
