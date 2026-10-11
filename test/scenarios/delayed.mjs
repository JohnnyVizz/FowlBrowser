// Content that appears and disappears on timers: wait_for text, text_gone, then act on the late element.
export default {
  name: 'delayed',
  async run(t) {
    const tab = await t.open(`${t.site}/delayed.html`);
    t.step('wait_for text');
    await t.call('wait_for', { tab, text: 'Data ready: 42 rows' });
    t.step('wait_for text_gone');
    await t.call('wait_for', { tab, text_gone: 'Loading data…' });
    t.step('click late button');
    const s = await t.snapshot(tab);
    t.ok(!/Loading data/.test(s), 'spinner gone from snapshot');
    await t.call('click', { tab, ref: t.ref(s, 'button', 'Late button'), snapshot: false });
    t.eq(await t.resultOf(tab), 'late:clicked', 'late button clicked');
  },
};
