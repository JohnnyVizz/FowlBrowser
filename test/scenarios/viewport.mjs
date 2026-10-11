// The viewport tool on test/site/mobile.html, through its own server in record mode (FOWLBROWSER_RECORD, so the agent
// cursor shows in background tabs and every pointer action leaves a frame and a point line). At 390x844 mobile with
// DPR 3 and at 1280x800: the page sees the size, screenshots have it, clicks by ref and by screenshot x,y land, scroll
// works, and the cursor is where the click was. Then the same on a page without a viewport meta (page scale < 1: the
// screenshot is then in layout px, 980 wide, like click coordinates), and
// reset, release and a plain detach (session end) each giving the page its real width back.
// Frames and journals stay in /tmp/fowlbrowser-viewport/<browser> for a look.
import fs from 'node:fs';
import path from 'node:path';
import { connect, makeContext, MCP_BIN, parseJSON } from '../lib.mjs';

// Decodes the agent's JPEG in the page: its size, and the box of the Add to cart red (#e0245e).
const RED_BOX_FN = (b64) => `async () => {
  const img = new Image();
  img.src = 'data:image/jpeg;base64,${b64}';
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const i = (y * c.width + x) * 4;
    if (d[i] > 190 && d[i + 1] < 80 && d[i + 2] > 60 && d[i + 2] < 140) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  return JSON.stringify({ w: img.width, h: img.height, box: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } });
}`;

export default {
  name: 'viewport',
  async run(t) {
    const dir = `/tmp/fowlbrowser-viewport/${t.browser}`;
    fs.rmSync(dir, { recursive: true, force: true });
    const journal = () => fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    // Its own sh as parent (the trailing ':' keeps sh from exec'ing it): servers sharing a parent share a turn socket.
    const rec = await connect(`viewport-${t.tag}`, { env: { FOWLBROWSER_RECORD: dir }, command: '/bin/sh', args: ['-c', `'${MCP_BIN}'; :`] });
    const r = makeContext({ server: rec, browser: t.browser, tag: t.tag });
    let recOpen = true;
    try {
      const url = `${t.site}/mobile.html?tag=${t.tag}`;
      const tab = await r.open(url);
      const page = () => r.resultOf(tab);
      const real = () => r.eval(tab, '() => ({ inner: innerWidth, outer: outerWidth, narrow: matchMedia("(max-width: 599px)").matches })');
      const lastClick = async () => (await page()).clicks.at(-1);
      const shot = async () => {
        const res = await r.call('screenshot', { tab });
        const decoded = JSON.parse(parseJSON((await r.call('evaluate', { tab, function: RED_BOX_FN(res.images[0].data) })).text));
        fs.writeFileSync(path.join(dir, `shot-${Date.now()}.jpg`), Buffer.from(res.images[0].data, 'base64'));
        return decoded;
      };
      // The cursor's own report at each pointer action must match where it was sent.
      const pointsSince = (n) => journal().filter(l => l.type === 'point').slice(n);
      const checkPoints = (points, what) => {
        t.ok(points.length > 0, `${what}: no point lines`);
        for (const p of points) {
          t.ok(p.cursor?.visible && p.target && Math.abs(p.cursor.x - p.target.x) <= 2 && Math.abs(p.cursor.y - p.target.y) <= 2,
            `${what}: cursor not at its target: ${JSON.stringify(p)}`);
        }
      };

      t.step('Playwright attaching resizes nothing');
      const base = await real();
      t.ok(!base.narrow && Math.abs(base.outer - base.inner) <= 40, `page width without an override: ${JSON.stringify(base)}`);

      t.step('390x844 mobile, DPR 3');
      const set = await r.call('viewport', { tab, width: 390, height: 844, mobile: true, device_scale_factor: 3, snapshot: false });
      t.ok(/Viewport set to 390x844 \(mobile\)/.test(set.text) && /innerWidth 390\b/.test(set.text), `viewport result: ${/Viewport set.*/.exec(set.text)?.[0]}`);
      let s = { ...(await page()), ...(await r.eval(tab, '() => now()')) }; // live values: the page's log is written at the resize, before touch goes on
      t.eq([s.innerWidth, s.innerHeight, s.dpr, s.narrow, s.coarse, s.touchPoints], [390, 844, 3, true, true, 5], `page under mobile: ${JSON.stringify(s)}`);
      t.ok(s.resizes.includes(390), 'the page saw a resize');

      t.step('mobile screenshot and click x,y off it');
      let points = pointsSince(0).length;
      let img = await shot();
      t.eq([img.w, img.h], [390, 844], 'screenshot size in CSS px');
      t.ok(img.box && img.box.w >= 380 && img.box.y + img.box.h >= 840, `Add to cart bar across the bottom: ${JSON.stringify(img.box)}`);
      const cx = Math.round(img.box.x + img.box.w / 2), cy = Math.round(img.box.y + img.box.h / 2);
      await r.call('click', { tab, x: cx, y: cy, snapshot: false });
      t.eq(await lastClick(), { id: 'cart', x: cx, y: cy, pointerType: 'mouse' }, 'click x,y hit Add to cart (as a mouse)');

      t.step('mobile click by ref, scroll, click a ref below the fold');
      await r.call('click', { tab, ref: await r.refOf(tab, 'button', 'Item 2'), snapshot: false });
      t.eq((await lastClick()).id, 'item-2', 'ref click');
      await r.call('click', { tab, ref: await r.refOf(tab, 'button', 'Menu'), snapshot: false });
      t.eq((await lastClick()).id, 'menu', 'narrow-only Menu button');
      await r.call('scroll', { tab, direction: 'down', pages: 2, snapshot: false });
      t.ok((await page()).scrollY > 800, 'scrolled down');
      await r.call('click', { tab, ref: await r.refOf(tab, 'button', 'Item 12'), snapshot: false });
      t.eq((await lastClick()).id, 'item-12', 'ref click after scrolling');
      checkPoints(pointsSince(points), 'mobile');

      t.step('1280x800 desktop');
      await r.call('viewport', { tab, width: 1280, height: 800, snapshot: false });
      s = await r.eval(tab, '() => now()');
      t.eq([s.innerWidth, s.innerHeight, s.narrow, s.coarse, s.touchPoints], [1280, 800, false, false, 0], `page under desktop: ${JSON.stringify(s)}`);
      t.ok(s.dpr !== 3, 'real devicePixelRatio again');
      points = pointsSince(0).length;
      img = await shot();
      t.eq([img.w, img.h], [1280, 800], 'desktop screenshot size');
      await r.call('click', { tab, ref: await r.refOf(tab, 'link', 'Deals'), snapshot: false });
      t.eq((await lastClick()).id, 'deals', 'desktop ref click');
      checkPoints(pointsSince(points), 'desktop');

      t.step('reset');
      const reset = await r.call('viewport', { tab, reset: true, snapshot: false });
      t.ok(/Viewport reset/.test(reset.text), reset.text);
      t.eq((await real()).inner, base.inner, 'real width after reset');

      t.step('no viewport meta: mobile lays out at 980 and zooms out');
      await r.call('navigate', { tab, url: `${t.site}/mobile.html?nometa&tag=${t.tag}`, snapshot: false });
      await r.call('viewport', { tab, width: 390, height: 844, mobile: true, snapshot: false });
      s = await r.eval(tab, '() => now()');
      t.ok(s.innerWidth === 980 && s.scale < 0.5, `page under mobile without meta: ${JSON.stringify(s)}`);
      points = pointsSince(0).length;
      img = await shot();
      // In layout px, as clicks are: the whole 980 px wide layout the phone shows zoomed out.
      t.eq([img.w, img.h], [980, s.innerHeight], 'screenshot covers the zoomed-out layout viewport');
      await r.call('click', { tab, ref: await r.refOf(tab, 'button', 'Item 2'), snapshot: false });
      t.eq((await lastClick()).id, 'item-2', 'ref click at page scale < 1');
      const zx = Math.round(img.box.x + img.box.w / 2), zy = Math.round(img.box.y + img.box.h / 2);
      await r.call('click', { tab, x: zx, y: zy, snapshot: false });
      t.eq((await lastClick()).id, 'cart', `click x,y (${zx},${zy}) off the zoomed-out screenshot`);
      checkPoints(pointsSince(points), 'page scale < 1');

      t.step('release clears it');
      await r.call('tab_release', { tab });
      await r.call('tab_claim', { tab, snapshot: false });
      t.eq((await real()).inner, base.inner, 'real width after release');
      await r.call('tab_close', { tab, confirm_close_users_tab: true }); // claimed back after the release: the user's now
      r.closed.add(tab);

      t.step('a detach clears it (session end, no explicit clear)');
      const user = await t.userTab(`${t.site}/mobile.html?user&tag=${t.tag}`);
      await rec.call('tab_claim', { tab: user, snapshot: false });
      const warned = await rec.call('viewport', { tab: user, width: 500, height: 700, snapshot: false });
      t.ok(/This is the user's tab/.test(warned.text), `warning on a claimed tab: ${warned.text}`);
      t.eq((await r.eval(user, '() => innerWidth')), 500, 'claimed tab resized');
      await rec.close();
      recOpen = false;
      await t.until(async () => (await t.listAll()).find(x => x.tab === user)?.owner === null, 'claimed tab back with the user after session end');
      await t.call('tab_claim', { tab: user, snapshot: false });
      const after = await t.eval(user, '() => ({ inner: innerWidth, outer: outerWidth })');
      t.ok(after.inner !== 500 && Math.abs(after.outer - after.inner) <= 40, `width after the detach: ${JSON.stringify(after)}`);
      await t.call('tab_release', { tab: user });

      t.step('journal');
      const lines = journal().filter(l => l.type === 'viewport').map(l => `${l.event} ${l.tab === user ? 'user' : 'tab'} ${l.width}x${l.height}${l.mobile ? ' mobile' : ''} ${l.reason}`);
      t.eq(lines, ['set tab 390x844 mobile tool', 'set tab 1280x800 tool', 'clear tab 1280x800 tool', 'set tab 390x844 mobile tool',
        'clear tab 390x844 mobile release', 'set user 500x700 tool'], 'viewport journal lines');
    } finally {
      if (recOpen) { await r.cleanup(); await rec.close(); }
    }
  },
};
