// window.open and target=_blank: the action reports the new tab (even one whose page loads slowly), it is ours,
// in the background, and closable.
import { tabIdsIn } from '../lib.mjs';

export default {
  name: 'popups',
  async run(t) {
    const tab = await t.open(`${t.site}/popups.html?tag=${t.tag}`);
    const s = await t.snapshot(tab);

    // slow: the popup's page commits 3 s after the click, long after the click has returned.
    for (const [name, role, via] of [['Open window', 'button', 'window-open'], ['Open link in new tab', 'link', 'blank'], ['Open slow window', 'button', 'slow']]) {
      t.step(`${via}: click`);
      const res = await t.call('click', { tab, ref: t.ref(s, role, name), snapshot: false });
      const reported = tabIdsIn(res.text, t.browser).find(id => id !== tab);
      if (reported) t.track(reported);
      if (via === 'slow') t.ok(/New tab opened by this action \(loading\)/.test(res.text), `slow popup reported while loading: ${res.text.slice(0, 300)}`);

      t.step(`${via}: find popup in tab_list mine`);
      const entry = await t.until(async () => (await t.listMine()).find(x => x.url.includes(`via=${via}&tag=${t.tag}`)),
        `popup via=${via} listed as mine`);
      t.track(entry.tab);
      t.eq(reported, entry.tab, 'click result names the new tab');
      t.eq(entry.active, false, 'popup stays in the background');
      t.eq(entry.muted, true, 'popup muted like its opener');
      t.eq(await t.resultOf(entry.tab), `popup:${via}`, 'popup page drivable');

      t.step(`${via}: close popup`);
      await t.close(entry.tab);
    }
  },
};
