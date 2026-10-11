// Infinite scroll in a background tab: scrolling must load more items (IntersectionObserver keeps working).
export default {
  name: 'scroll',
  async run(t) {
    const tab = await t.open(`${t.site}/scroll.html`);
    // A tall window already shows the end of the first 20, so it preloads more on its own.
    const initial = (await t.resultOf(tab)).count;
    t.ok(initial >= 20, `initial items: expected at least 20, got ${initial}`);
    t.step('scroll down');
    const r = await t.until(async () => {
      await t.call('scroll', { tab, direction: 'down', pages: 3, snapshot: false });
      const v = await t.resultOf(tab);
      return v.count >= initial + 40 && v;
    }, `at least ${initial + 40} items after scrolling`, 15000);
    t.ok(r.scrollY > 0, 'page scrolled');

    t.step('scroll a ref into view');
    const s = await t.snapshot(tab);
    await t.call('scroll', { tab, ref: t.ref(s, 'listitem', 'Item 5'), snapshot: false });
    t.ok((await t.resultOf(tab)).scrollY < r.scrollY, 'scrolled back up to item 5');
  },
};
