// Real site: three YouTube watch tabs of the user's (never attached, unmuted, in the background) closed with tab_close
// and no claim. None may ever play: they never become audible before or while closing.
export default {
  name: 'youtube-close',
  real: true,
  async run(t) {
    const ids = ['jNQXAC9IVRw', 'dQw4w9WgXcQ', 'M7lc1UVf-VE'];
    const tabs = [];
    for (const id of ids) tabs.push(await t.userTab(`https://www.youtube.com/watch?v=${id}&fbtag=${t.tag}`));
    let heard = [];
    const watch = async () => {
      const all = (await t.listAll()).filter((x) => tabs.includes(x.tab));
      heard.push(...all.filter((x) => x.audible).map((x) => x.tab));
      return all;
    };

    t.step('loaded in the background, silent');
    await t.until(async () => (await watch()).filter((x) => / - YouTube$/.test(x.title)).length === 3, 'watch pages loaded', 30000);
    for (let i = 0; i < 8; i++) { await watch(); await new Promise((r) => setTimeout(r, 250)); }

    t.step('close without claiming');
    for (const tab of tabs) {
      await t.call('tab_close', { tab, confirm_close_users_tab: true });
      t.closed.add(tab);
      await watch();
    }
    t.eq([...new Set(heard)], [], 'no tab ever played audio');
    t.eq(await watch(), [], 'all three closed');
  },
};
