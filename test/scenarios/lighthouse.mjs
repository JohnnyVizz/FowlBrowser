// lighthouse: an audit over the tab's own debugger session leaves the tab as it was (no emulation left, Playwright still
// works), snapshot mode runs on a claimed tab and navigation mode is refused there.
import fs from 'node:fs';

const VIEW = `() => ({ width: innerWidth, ua: navigator.userAgent })`;
const STATUS = `() => document.getElementById('status').textContent`;
// Lighthouse's navigation init script swaps in a wrapper (an unnamed arrow function) for requestIdleCallback.
const RIC = `() => ({ own: Object.hasOwn(window, 'requestIdleCallback'), proto: Object.hasOwn(Window.prototype, 'requestIdleCallback'), type: typeof requestIdleCallback, name: window.requestIdleCallback?.name, symbols: Object.getOwnPropertySymbols(window).length })`;
const LH_TIMEOUT = 120_000;

function checkScores(t, out, what) {
  for (const name of ['performance', 'accessibility', 'best practices', 'SEO', 'agentic browsing']) {
    t.ok(new RegExp(`Scores:.*\\b${name} (\\d+|n/a)\\b`).test(out), `${what}: ${name} score in: ${out.slice(0, 600)}`);
  }
}

export default {
  name: 'lighthouse',
  async run(t) {
    t.step('navigation, mobile');
    const tab = await t.open(`${t.site}/perf.html?l=${t.tag}`);
    const before = await t.eval(tab, VIEW);
    const ricBefore = await t.eval(tab, RIC);
    const out = (await t.call('lighthouse', { tab }, LH_TIMEOUT)).text;
    t.ok(/^Lighthouse \d+\.\d+\.\d+ · mobile · navigation · [\d.]+ s$/m.test(out), `header line: ${out.slice(0, 600)}`);
    checkScores(t, out, 'navigation');
    t.ok(/Metrics: FCP \d[\d.,]* m?s · LCP \d[\d.,]* m?s/.test(out), `FCP and LCP: ${out}`);
    const [, html, json] = /Report: (\S+) · JSON: (\S+)/.exec(out) ?? [];
    t.ok(html && fs.existsSync(html), `html report exists: ${html}`);
    const lhr = JSON.parse(fs.readFileSync(json, 'utf8'));
    t.ok(lhr.categories?.performance, 'json report has lhr.categories');

    t.step('the tab afterwards');
    t.eq(await t.eval(tab, VIEW), before, 'innerWidth and user agent are back (emulation cleared)');
    const slow = await t.refOf(tab, 'button', 'Slow click');
    await t.call('click', { tab, ref: slow, snapshot: false });
    t.eq(await t.eval(tab, STATUS), 'slow:clicked', 'Playwright still clicks after the run');
    t.eq(await t.eval(tab, RIC), ricBefore, 'requestIdleCallback is the native one again');
    const navStarted = Date.now();
    const nav = (await t.call('navigate', { tab, url: `${t.site}/index.html?l=${t.tag}` }, 30_000)).text;
    t.ok(Date.now() - navStarted < 10_000, `navigate returned within 10 s (took ${Date.now() - navStarted} ms)`);
    t.ok(nav.includes('FowlBrowser test site'), `navigate's snapshot shows the new page: ${nav.slice(0, 400)}`);

    t.step('snapshot, desktop');
    const desk = (await t.call('lighthouse', { tab, device: 'desktop', mode: 'snapshot' }, LH_TIMEOUT)).text;
    t.ok(/^Lighthouse \d+\.\d+\.\d+ · desktop · snapshot \(page as it is, no device emulation\) · [\d.]+ s$/m.test(desk), `desktop snapshot header: ${desk.slice(0, 300)}`);
    checkScores(t, desk, 'desktop snapshot');
    t.ok(!/^Metrics:/m.test(desk), `no load metrics in snapshot mode: ${desk.slice(0, 600)}`);

    t.step('claimed tab');
    const own = await t.userTab(`${t.site}/perf.html?l=user-${t.tag}`);
    await t.call('tab_claim', { tab: own, snapshot: false });
    const refused = await t.call('lighthouse', { tab: own }, LH_TIMEOUT).then((r) => { throw new Error(`navigation on a claimed tab should fail: ${r.text.slice(0, 300)}`); }, (e) => e.message);
    t.ok(/user's own tab .*mode "snapshot"/.test(refused), `refusal: ${refused}`);
    const claimed = (await t.call('lighthouse', { tab: own, mode: 'snapshot' }, LH_TIMEOUT)).text;
    t.ok(/^Lighthouse \d+\.\d+\.\d+ · mobile · snapshot \(page as it is, no device emulation\) · [\d.]+ s$/m.test(claimed), `mobile snapshot header: ${claimed.slice(0, 300)}`);
    checkScores(t, claimed, 'claimed snapshot');
    await t.call('tab_release', { tab: own });
  },
};
