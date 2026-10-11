// Controls inside a closed shadow root: page JS cannot reach them, so refs (s<N>) come from the browser's own tree.
export default {
  name: 'shadow-closed',
  async run(t) {
    const tab = await t.open(`${t.site}/shadow.html`);
    const s = await t.snapshot(tab);
    const input = t.ref(s, 'textbox', 'Closed shadow input');
    const save = t.ref(s, 'button', 'Closed shadow save');
    t.ok(/^s\d+$/.test(input) && /^s\d+$/.test(save), `closed shadow refs should be s refs, got ${input}, ${save}`);
    t.step('type and click in closed shadow root');
    await t.call('type', { tab, ref: input, text: `closed ${t.tag}`, snapshot: false });
    await t.call('click', { tab, ref: save, snapshot: false });
    t.step('assert');
    t.eq((await t.resultOf(tab)).closed, `closed ${t.tag}`, 'closed shadow value');
    t.step('append and retype through refs from a fresh snapshot');
    const s2 = await t.snapshot(tab);
    await t.call('type', { tab, ref: t.ref(s2, 'textbox', 'Closed shadow input'), text: ' more', append: true, snapshot: false });
    await t.call('click', { tab, ref: t.ref(s2, 'button', 'Closed shadow save'), snapshot: false });
    t.eq((await t.resultOf(tab)).closed, `closed ${t.tag} more`, 'closed shadow appended value');
    await t.call('type', { tab, ref: t.ref(s2, 'textbox', 'Closed shadow input'), text: 'replaced', snapshot: false });
    await t.call('click', { tab, ref: t.ref(s2, 'button', 'Closed shadow save'), snapshot: false });
    t.eq((await t.resultOf(tab)).closed, 'replaced', 'closed shadow replaced value');

    t.step('button that shows slotted text');
    const s3 = await t.snapshot(tab);
    await t.call('click', { tab, ref: t.ref(s3, 'button', 'Slotted save'), snapshot: false });
    t.eq((await t.resultOf(tab)).slotted, 'clicked', 'slotted button clicked');

    t.step('covered s ref is refused, not clicked through');
    await t.call('click', { tab, ref: t.ref(s3, 'button', 'Cover the page'), snapshot: false });
    const covered = await t.call('click', { tab, ref: t.ref(s3, 'button', 'Closed shadow save'), snapshot: false }).then(() => null, e => e.message);
    t.ok(/is covered at its centre/.test(covered ?? ''), `click on a covered s ref should fail: ${covered}`);
    await t.call('click', { tab, ref: await t.refOf(tab, 'button', 'Close cover'), snapshot: false });
    await t.call('click', { tab, ref: t.ref(await t.snapshot(tab), 'button', 'Closed shadow save'), snapshot: false });

    t.step('s refs die with their document');
    const old = t.ref(await t.snapshot(tab), 'button', 'Closed shadow save');
    await t.call('navigate', { tab, url: `${t.site}/shadow.html?again`, snapshot: false });
    const stale = await t.call('click', { tab, ref: old, snapshot: false }).then(() => null, e => e.message);
    t.ok(/from an earlier page/.test(stale ?? ''), `s ref from the previous document should be refused: ${stale}`);
    // The new page's scan gives its controls new numbers; the old one stays refused instead of naming them.
    const fresh = t.ref(await t.snapshot(tab), 'button', 'Closed shadow save');
    t.ok(fresh !== old, `the new page's save should get a new s ref, got ${fresh} again`);
    const after = await t.call('click', { tab, ref: old, snapshot: false }).then(() => null, e => e.message);
    t.ok(/from an earlier page/.test(after ?? ''), `old s ref after a new snapshot should be refused: ${after}`);
    await t.call('type', { tab, ref: await t.refOf(tab, 'textbox', 'Closed shadow input'), text: 'second page', snapshot: false });
    await t.call('click', { tab, ref: fresh, snapshot: false });
    t.eq((await t.resultOf(tab)).closed, 'second page', 'new s ref acts on the new page');

    t.step('declarative closed root (no script)');
    await t.call('navigate', { tab, url: `${t.site}/shadow-declarative.html`, snapshot: false });
    await t.call('click', { tab, ref: await t.refOf(tab, 'button', 'Declarative save'), snapshot: false });
    t.eq(await t.resultOf(tab), 'declarative:clicked', 'declarative closed root button clicked');

    t.step('closed root only inside a frame');
    await t.call('navigate', { tab, url: `${t.site}/shadow-framed.html`, snapshot: false });
    await t.until(async () => /^s\d+$/.test(await t.refOf(tab, 'button', 'Frame shadow save').catch(() => '')), 'frame closed root listed as an s ref');

    t.step('claimed tab: closed root attached later to an existing host');
    // The user's tab gets no hook, and the light DOM stays the same: only the periodic rescan (every 10 s) finds it.
    const own = await t.userTab(`${t.site}/shadow-late.html`);
    await t.call('tab_claim', { tab: own, snapshot: false });
    t.ok(!/\[ref=s\d+\]/.test(await t.snapshot(own)), 'no s refs before the late attach');
    await t.call('click', { tab: own, ref: await t.refOf(own, 'button', 'Attach late root'), snapshot: false });
    const late = await t.until(async () => t.ref(await t.snapshot(own), 'button', 'Late save'), 'late closed root listed as an s ref', 20_000);
    t.ok(/^s\d+$/.test(late), `late closed root button should be an s ref, got ${late}`);
    await t.call('click', { tab: own, ref: late, snapshot: false });
    t.eq(await t.resultOf(own), 'late:clicked', 'late closed root button clicked');
  },
};
