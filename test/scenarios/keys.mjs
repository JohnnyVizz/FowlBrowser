// Keyboard shortcuts with modifiers, page-level and focused-element key presses.
export default {
  name: 'keys',
  async run(t) {
    const tab = await t.open(`${t.site}/keys.html`);
    const state = () => t.resultOf(tab);

    t.step('Control+K opens palette');
    await t.call('press_key', { tab, key: 'Control+k', snapshot: false });
    t.eq((await state()).palette, true, 'palette open');

    t.step('ArrowDown moves selection');
    await t.call('press_key', { tab, key: 'ArrowDown', snapshot: false });
    await t.call('press_key', { tab, key: 'ArrowDown', snapshot: false });
    t.eq((await state()).selected, 2, 'selection');

    t.step('Escape closes');
    await t.call('press_key', { tab, key: 'Escape', snapshot: false });
    t.eq((await state()).palette, false, 'palette closed');

    t.step('? shows help');
    await t.call('press_key', { tab, key: '?', snapshot: false });
    t.eq((await state()).help, true, 'help shown');

    t.step('Meta+K reopens');
    await t.call('press_key', { tab, key: 'Meta+k', snapshot: false });
    const r = await state();
    t.eq(r.palette, true, 'palette reopened with Meta+K');
    t.ok(r.keys.includes('Meta+k'), `Meta+k seen in ${JSON.stringify(r.keys)}`);

    t.step('Escape on a focused element');
    const s = await t.snapshot(tab);
    await t.call('press_key', { tab, key: 'Escape', ref: t.ref(s, 'textbox', 'Command'), snapshot: false });
    t.eq((await state()).palette, false, 'palette closed from its input');

    // Select-all in a plain input needs Playwright to treat the Mac as macOS (real user agent from the relay).
    const selection = () => t.eval(tab, `() => { const el = document.getElementById('palette-input'); return [el.selectionStart, el.selectionEnd, el.value.length]; }`);
    t.step('ControlOrMeta+a selects all');
    await t.call('press_key', { tab, key: 'Meta+k', snapshot: false });
    await t.call('type', { tab, ref: t.ref(await t.snapshot(tab), 'textbox', 'Command'), text: 'hello world', snapshot: false });
    await t.call('press_key', { tab, key: 'ControlOrMeta+a', snapshot: false });
    t.eq(await selection(), [0, 11, 11], 'whole input selected by ControlOrMeta+a');

    t.step('Meta+a selects all, then typing replaces it');
    await t.call('press_key', { tab, key: 'End', snapshot: false });
    t.eq(await selection(), [11, 11, 11], 'caret at end');
    await t.call('press_key', { tab, key: 'Meta+a', snapshot: false });
    t.eq(await selection(), [0, 11, 11], 'whole input selected by Meta+a');
    await t.call('type', { tab, text: 'bye', snapshot: false });
    t.eq(await t.eval(tab, `() => document.getElementById('palette-input').value`), 'bye', 'typed text replaced the selection');
  },
};
