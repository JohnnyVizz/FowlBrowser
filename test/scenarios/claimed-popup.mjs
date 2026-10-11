// In a claimed tab (the user's), a tab opened by the agent's own click is the agent's, in the background
// (tabs.expectChild), and tab_close refuses the claimed tab itself unless the user asked for it.
import { tabIdsIn } from '../lib.mjs';

export default {
  name: 'claimed-popup',
  async run(t) {
    const tab = await t.open(`${t.site}/popups.html?tag=${t.tag}`);
    t.step('hand the tab to the user, then claim it');
    await t.eval(tab, '() => { window.__fbWrapped = window.open; return true; }');
    await t.call('tab_release', { tab });
    await t.call('tab_claim', { tab, snapshot: false });
    // The popup script left with the release (the user's popups are native again) and a claim puts none in.
    t.eq(await t.eval(tab, '() => window.open !== window.__fbWrapped'), true, 'window.open is native again after the release');

    t.step('click a target=_blank link');
    const res = await t.call('click', { tab, ref: await t.refOf(tab, 'link', 'Open link in new tab'), snapshot: false });
    const popup = await t.until(async () => (await t.listMine()).find(x => x.url.includes(`via=blank&tag=${t.tag}`)), 'popup of the claimed tab listed as mine');
    t.track(popup.tab);
    t.eq(tabIdsIn(res.text, t.browser).find(id => id !== tab), popup.tab, 'click result names the popup');
    t.eq(popup.active, false, 'popup stays in the background');
    await t.close(popup.tab);

    t.step('tab_close refuses the claimed tab');
    const refused = await t.call('tab_close', { tab }).then(() => null, e => e.message);
    t.ok(/tab_release/.test(refused ?? ''), `tab_close on a claimed tab should be refused: ${refused}`);
    await t.call('tab_close', { tab, confirm_close_users_tab: true });
    t.closed.add(tab);
  },
};
