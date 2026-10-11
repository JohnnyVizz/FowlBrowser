// A form that navigates on submit, then back / forward / reload and a direct navigate.
export default {
  name: 'navigation',
  async run(t) {
    const tab = await t.open(`${t.site}/search.html`);
    const href = () => t.eval(tab, '() => location.href');

    t.step('type with submit');
    const s = await t.snapshot(tab);
    await t.call('type', { tab, ref: t.ref(s, 'searchbox', 'Query'), text: t.tag, submit: true, snapshot: false });
    await t.call('wait_for', { tab, url: 'results.html' });
    t.eq(await t.resultOf(tab), `results:${t.tag}`, 'results page');

    t.step('back');
    await t.call('navigate', { tab, action: 'back' });
    await t.until(async () => (await href()).endsWith('/search.html'), 'back on search page');

    t.step('forward');
    await t.call('navigate', { tab, action: 'forward' });
    await t.until(async () => (await href()).includes('results.html'), 'forward on results page');

    t.step('reload');
    const nav = await t.call('navigate', { tab, action: 'reload' });
    t.ok(nav.text.includes('Results for'), `reload reports title: ${nav.text.slice(0, 200)}`);

    t.step('navigate url');
    await t.call('navigate', { tab, url: `${t.site}/index.html` });
    t.eq(await t.eval(tab, '() => document.title'), 'FowlBrowser test site', 'navigated to index');

    t.step('a click that navigates to a slow page returns on the new page, also without a snapshot');
    // The new document answers 600 ms late: until it commits the old one still counts as loaded.
    // A click at x,y (ref clicks wait for their navigation inside Playwright; coordinate clicks and keys don't).
    const at = await t.eval(tab, `() => { const a = document.querySelector('a[href="form.html"]'); a.href = 'form.html?delay=600';
      const r = a.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }`);
    await t.call('click', { tab, x: at.x, y: at.y, snapshot: false });
    t.ok((await href()).includes('form.html?delay=600'), `click returned before the new page committed: ${await href()}`);

    t.step('a link that redirects to no new page (204) returns at once');
    await t.call('navigate', { tab, url: `${t.site}/index.html`, snapshot: false });
    const nowhere = await t.eval(tab, `() => { const a = document.querySelector('a[href="form.html"]');
      a.href = 'index.html?redirect=' + encodeURIComponent('/index.html?status=204');
      const r = a.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }`);
    const started = Date.now();
    await t.call('click', { tab, x: nowhere.x, y: nowhere.y, snapshot: false });
    t.ok(Date.now() - started < 4000, `click on a redirect to 204 waited ${Date.now() - started} ms`);
    t.ok((await href()).endsWith('/index.html'), `still on the page: ${await href()}`);
  },
};
