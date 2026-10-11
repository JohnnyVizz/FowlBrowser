// tab_handoff: an agent tab on a checkout page goes to the user mid-task. It leaves the group, is unmuted and stays in
// the background; calls on it fail at once with the handoff notice; a turn end leaves it owned; tab_claim with resume
// takes it back (attached, grouped, muted again, a fresh snapshot); release hands it over for good.
// Runs on a server of its own, so it can end that server's turn without touching other jobs' tabs.
import { connect, parseTabs, rawHost, ToolError } from '../lib.mjs';

export default {
  name: 'handoff',
  async run(t) {
    const own = await connect(`e2e-handoff-${t.tag}`, { ownTurns: true });
    const host = await rawHost(t.browser, `raw-${t.tag}`);
    const mine = async () => parseTabs(await own.call('tab_list', { browser: t.browser, scope: 'mine' }));
    const raw = async (id) => (await host.request('tabs.listAll', {})).find((x) => `${t.browser}:${x.id}` === id);
    let tab;
    try {
      t.step('agent tab on the checkout page');
      const opened = await own.call('tab_open', { browser: t.browser, url: `${t.site}/handoff-checkout.html?tag=${t.tag}` });
      tab = opened.text.match(new RegExp(`\\b${t.browser}:\\d+\\b`))[0];
      t.userTabs.add(tab); // the user's once released; cleanup closes it with the flag
      await own.call('type', { tab, ref: t.ref(opened.text, 'textbox', 'Name on card'), text: 'Ada Lovelace', snapshot: false });
      let entry = (await mine()).find((x) => x.tab === tab);
      t.ok(entry.muted && entry.group && !entry.active, `a muted, grouped background tab first: ${JSON.stringify(entry)}`);

      t.step('tab_handoff');
      const name = t.browser === 'chrome' ? 'Chrome' : 'Helium';
      const handed = await own.call('tab_handoff', { tab, reason: 'enter the card details' });
      t.ok(handed.text.includes(`Your turn in ${name} tab "Checkout": enter the card details, then tell me.`), `handoff line: ${handed.text}`);
      entry = (await mine()).find((x) => x.tab === tab);
      t.eq([entry.muted, entry.group, entry.active, entry.parked], [false, null, false, 'handoff'], 'handed over: unmuted, ungrouped, background, parked');
      const info = await raw(tab);
      t.eq([info.kept, info.handedOver, info.parked, info.owner], [true, true, 'handoff', 'other'], 'extension view');

      t.step('calls on it fail at once with the notice');
      for (const [name, args] of [['snapshot', {}], ['click', { ref: 'e1' }]]) {
        const started = Date.now();
        const error = await own.call(name, { tab, ...args }).then(() => null, (e) => e);
        t.ok(error instanceof ToolError && /You handed .* to the user at \d\d:\d\d \(enter the card details\); wait until they say they are done, then tab_claim it with resume: true\./.test(error.message),
          `${name} refused with the notice: ${error?.message}`);
        t.ok(Date.now() - started < 2000, `${name} refused at once (${Date.now() - started} ms)`);
      }
      const plain = await own.call('tab_claim', { tab }).then(() => null, (e) => e);
      t.ok(/You handed/.test(plain?.message), `a claim without resume is refused: ${plain?.message}`);

      t.step('turn end leaves it owned');
      const turn = await own.endTurn();
      t.ok(turn.skipped.includes(tab) && !turn.closed.includes(tab) && !turn.released.includes(tab), `turn end: ${JSON.stringify(turn)}`);
      t.eq((await raw(tab))?.parked, 'handoff', 'still parked and owned after the turn end');

      t.step('resume');
      const resumed = await own.call('tab_claim', { tab, resume: true, snapshot: false });
      t.ok(/Resumed .*you control it again/.test(resumed.text) && /Snapshot \d+ of this tab/.test(resumed.text), `resumed with a fresh snapshot: ${resumed.text.slice(0, 300)}`);
      t.eq(await own.call('evaluate', { tab, function: '() => document.querySelector("[name=name]").value' }).then((r) => /"Ada Lovelace"/.test(r.text)), true, 'the page is driven again');
      entry = (await mine()).find((x) => x.tab === tab);
      t.ok(entry.muted && entry.group && entry.parked === null, `back in its group and muted: ${JSON.stringify(entry)}`);

      t.step('release hands it over');
      await own.call('tab_release', { tab });
      const after = await raw(tab);
      t.eq([after.owner, after.muted, after.groupTitle, after.parked], [null, false, null, null], 'the user\'s tab now');
    } finally {
      host.close();
      await own.close();
    }
  },
};
