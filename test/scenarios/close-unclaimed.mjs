// Closing the user's tabs: tab_close with the confirm flag and no claim closes them without ever attaching the
// debugger (which would wake them: focus emulation, media starting). Without the flag it is refused.
// wake.html records document.hasFocus() as it goes away; a claimed tab is the control (focus emulation on).
export default {
  name: 'close-unclaimed',
  async run(t) {
    const observer = await t.open(`${t.site}/index.html?observer=${t.tag}`);
    const tags = [1, 2, 3, 4].map((n) => `${t.tag}-${n}`);
    const tabs = [];
    for (const tag of tags) tabs.push(await t.userTab(`${t.site}/wake.html?tag=${tag}`));
    await t.until(async () => (await t.listAll()).filter((x) => tabs.includes(x.tab) && x.title === 'Sleeping user tab').length === 4, 'stand-in tabs loaded', 10000);

    t.step('refused without the flag');
    const refused = await t.call('tab_close', { tab: tabs[0] }).then(() => null, (e) => e.message);
    t.ok(/confirm_close_users_tab: true \(no claim needed\)/.test(refused ?? ''), `tab_close without the flag should be refused: ${refused}`);

    t.step('close three without claiming');
    for (const tab of tabs.slice(0, 3)) {
      const res = await t.call('tab_close', { tab, confirm_close_users_tab: true });
      t.ok(/without claiming it/.test(res.text), `closed without claim: ${res.text}`);
      t.closed.add(tab);
    }

    t.step('control: claim the fourth, then close it');
    await t.call('tab_claim', { tab: tabs[3], snapshot: false });
    await t.call('tab_close', { tab: tabs[3], confirm_close_users_tab: true });
    t.closed.add(tabs[3]);

    t.step('none of the three woke up');
    const records = await t.until(async () => {
      const r = await t.eval(observer, `() => ${JSON.stringify(tags)}.map((tag) => JSON.parse(localStorage.getItem('wake-' + tag)))`);
      return r.every(Boolean) && r;
    }, 'every closed tab left its record');
    t.eq(records.slice(0, 3).map((r) => r.hasFocus), [false, false, false], 'closed tabs never had (emulated) focus');
    t.eq(records[3].hasFocus, true, 'the claimed control tab had focus emulation, so the probe works');
    const left = (await t.listAll()).filter((x) => tabs.includes(x.tab));
    t.eq(left, [], 'all four are gone');
  },
};
