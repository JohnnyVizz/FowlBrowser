// Agent cursor (docs/cursor-spec.md). The only scenario that brings its own tab to the front: while it
// acts the overlay host exists, is aria-hidden and pointer-events none, stays out of snapshots and screenshots,
// removes itself after 15 s idle and comes back for a read-only action, on a page with Trusted Types and no inline
// styles. A background tab gets nothing injected.
import { parseJSON, sleep } from '../lib.mjs';

const HOST = `document.querySelector('fowlbrowser-cursor')`;
const IDLE_MS = 15_000;

// Decodes the agent's JPEG in the page and returns the darkest pixel and the bluest pixel (blue minus red) in rectangles.
const PIXELS_FN = (b64, rects) => `async () => {
  const img = new Image();
  img.src = 'data:image/jpeg;base64,${b64}';
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return JSON.stringify(${JSON.stringify(rects)}.map(([x, y, w, h]) => {
    const d = g.getImageData(x, y, w, h).data;
    let dark = 255, blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      dark = Math.min(dark, (d[i] + d[i + 1] + d[i + 2]) / 3);
      blue = Math.max(blue, d[i + 2] - d[i]);
    }
    return { dark: Math.round(dark), blue };
  }));
}`;

export default {
  name: 'cursor',
  async run(t) {
    const activeBefore = (await t.listAll()).filter(x => x.active).map(x => x.tab);
    // Served under a strict policy (Trusted Types, no inline styles) like YouTube's: the overlay must still draw.
    const tab = await t.open(`${t.site}/cursor.html?strict&${t.tag}`);
    const host = () => t.eval(tab, `() => { const h = ${HOST}; if (!h) return null;
      const s = getComputedStyle(h); return { aria: h.getAttribute('aria-hidden'), pe: s.pointerEvents, position: s.position, display: s.display, z: s.zIndex, parent: h.parentElement === document.documentElement }; }`);
    // Give the window its own active tab back before ours closes, so no other scenario's tab gets activated.
    const restoreFocus = async () => {
      const now = (await t.listAll()).filter(x => x.active).map(x => x.tab);
      for (const previous of activeBefore.filter(x => !now.includes(x))) await t.call('tab_focus', { tab: previous }).catch(() => {});
    };
    try {
      t.step('nothing before the first action');
      await t.call('tab_focus', { tab });
      t.eq(await host(), null, 'no overlay before acting');

      t.step('click x,y in the shown tab');
      await t.call('click', { tab, x: 300, y: 200, snapshot: false });
      t.eq(await t.resultOf(tab), 'click:300,200', 'the click itself landed');
      t.eq(await host(), { aria: 'true', pe: 'none', position: 'fixed', display: 'block', z: '2147483647', parent: true }, 'overlay host while acting');

      t.step('click a ref');
      await t.call('click', { tab, ref: await t.refOf(tab, 'button', 'Target'), snapshot: false });
      t.eq(await t.resultOf(tab), 'target', 'ref click landed through the overlay');

      t.step('type into a ref');
      const field = await t.refOf(tab, 'textbox', 'Field');
      await t.call('type', { tab, ref: field, text: 'hello', snapshot: false });
      t.eq(await t.eval(tab, `() => document.getElementById('field').value`), 'hello', 'typed through the overlay');

      t.step('back to a blank spot, then snapshot');
      await t.call('click', { tab, x: 300, y: 200, snapshot: false });
      const snap = await t.snapshot(tab);
      t.ok(!snap.includes(t.server.label) && !/fowlbrowser-cursor/i.test(snap) && !/closed shadow/i.test(snap), `snapshot shows the overlay:\n${snap.slice(0, 800)}`);

      t.step('screenshot without the overlay');
      const shot = await t.call('screenshot', { tab });
      // The arrow sits right of and below (300, 200), the label pill under it; the black mark proves the decoding works.
      const decoded = parseJSON((await t.call('evaluate', { tab, function: PIXELS_FN(shot.images[0].data, [[50, 50, 20, 20], [300, 200, 16, 18], [284, 230, 40, 14]]) })).text);
      const [mark, arrow, pill] = JSON.parse(decoded);
      t.ok(mark.dark < 40, `decoded screenshot shows the black mark: ${JSON.stringify(mark)}`);
      t.ok(arrow.dark > 220 && arrow.blue < 30 && pill.dark > 220, `screenshot shows the overlay: arrow ${JSON.stringify(arrow)}, pill ${JSON.stringify(pill)}`);
      t.eq((await host())?.display, 'block', 'overlay shown again after the screenshot');

      t.step('removes itself after 15 s idle');
      // Every agent action shows the cursor again (evaluate too), so the page watches for it to go instead of polling.
      const since = await t.eval(tab, `() => { window.__cursorGone = null; const id = setInterval(() => {
        if (!${HOST}) { window.__cursorGone = Date.now(); clearInterval(id); } }, 100); return Date.now(); }`);
      await sleep(IDLE_MS + 2500);
      const gone = await t.eval(tab, '() => window.__cursorGone');
      t.ok(gone, 'overlay gone after the idle timeout');
      t.ok(gone - since > IDLE_MS - 1000 && gone - since < IDLE_MS + 2000, `overlay left after ${gone - since} ms, not ${IDLE_MS}`);

      t.step('a read-only action shows it again');
      await t.snapshot(tab);
      t.ok(await t.until(host, 'overlay back after a snapshot', 3000), 'overlay back after a snapshot');

      t.step('tab_release removes it');
      await t.call('click', { tab, x: 300, y: 200, snapshot: false });
      t.ok(await host(), 'overlay back for the next action');
      // The evaluate that reads it after the claim shows the cursor again itself, so the page notes when it goes.
      const watching = await t.eval(tab, `() => { window.__cursorRemoved = null; new MutationObserver((records, observer) => {
        if (records.some((r) => [...r.removedNodes].some((n) => n.localName === 'fowlbrowser-cursor'))) { window.__cursorRemoved = Date.now(); observer.disconnect(); } })
        .observe(document.documentElement, { childList: true, subtree: true }); return Date.now(); }`);
      await t.call('tab_release', { tab });
      await t.call('tab_claim', { tab, snapshot: false });
      const removed = await t.eval(tab, '() => window.__cursorRemoved');
      t.ok(removed >= watching, `overlay removed by the release: ${removed}`);
      await restoreFocus();
      await t.call('tab_close', { tab, confirm_close_users_tab: true });
      t.closed.add(tab);

      t.step('background tab: nothing injected');
      const back = await t.open(`${t.site}/cursor.html?back-${t.tag}`);
      await t.call('click', { tab: back, x: 300, y: 200, snapshot: false });
      t.eq(await t.resultOf(back), 'click:300,200', 'background click landed');
      t.eq(await t.eval(back, `() => !!${HOST}`), false, 'no overlay in a background tab');
    } finally {
      await restoreFocus();
    }
  },
};
