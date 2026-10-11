// Tabs for the user: tab_open for_user is ungrouped from the start and stays after the session ends; tab_keep hands a
// work tab over right away (ungrouped) while the session still drives it. Both stay muted while driven (nothing plays
// aloud before the user looks) and are unmuted when control ends.
import { connect } from '../lib.mjs';

export default {
  name: 'handover',
  async run(t) {
    t.step('for_user');
    const forUser = await t.open(`${t.site}/index.html?foruser=${t.tag}`, { for_user: true });
    let mine = (await t.listMine()).find((x) => x.tab === forUser);
    t.eq([mine.muted, mine.group, mine.active], [true, null, false], 'for_user tab: muted while driven, ungrouped, background');

    t.step('tab_keep hands over now');
    const work = await t.open(`${t.site}/index.html?keep=${t.tag}`);
    mine = (await t.listMine()).find((x) => x.tab === work);
    t.ok(mine.muted && mine.group, `work tab starts muted and grouped: ${JSON.stringify(mine)}`);
    await t.call('tab_keep', { tab: work });
    mine = (await t.listMine()).find((x) => x.tab === work);
    t.eq([mine.muted, mine.group], [true, null], 'kept tab is ungrouped right away, muted while driven');
    await t.call('snapshot', { tab: work }); // still controlled

    t.step('for_user tab outlives its session');
    const other = await connect(`e2e-handover-${t.tag}`);
    let left;
    try {
      const res = await other.call('tab_open', { browser: t.browser, url: `${t.site}/index.html?outlive=${t.tag}`, for_user: true, snapshot: false });
      left = res.text.match(new RegExp(`\\b${t.browser}:\\d+\\b`))[0];
    } finally {
      await other.close();
    }
    t.userTabs.add(left); // closed by cleanup
    const after = await t.until(async () => (await t.listAll()).find((x) => x.tab === left && x.owner === null), 'tab stays, owned by nobody');
    t.eq([after.muted, after.group], [false, null], 'unmuted once control ended, still ungrouped');
  },
};
