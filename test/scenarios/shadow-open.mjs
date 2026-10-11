// Controls inside an open shadow root.
export default {
  name: 'shadow-open',
  async run(t) {
    const tab = await t.open(`${t.site}/shadow.html`);
    const s = await t.snapshot(tab);
    t.step('type and click in open shadow root');
    await t.call('type', { tab, ref: t.ref(s, 'textbox', 'Open shadow input'), text: `open ${t.tag}`, snapshot: false });
    await t.call('click', { tab, ref: t.ref(s, 'button', 'Open shadow save'), snapshot: false });
    t.step('assert');
    t.eq((await t.resultOf(tab)).open, `open ${t.tag}`, 'open shadow value');
  },
};
