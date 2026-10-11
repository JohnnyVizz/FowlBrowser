// HTML5 drag and drop (dataTransfer) and a pointer-event drag, both through the drag tool.
export default {
  name: 'dnd',
  async run(t) {
    const tab = await t.open(`${t.site}/dnd.html`);
    const s = await t.snapshot(tab);

    t.step('html5 drag');
    await t.call('drag', { tab, from_ref: t.ref(s, 'button', 'Apple card'), to_ref: t.ref(s, 'region', 'HTML5 basket'), snapshot: false });
    t.eq((await t.resultOf(tab)).html5, 'apple', 'HTML5 drop received dataTransfer');

    t.step('pointer drag');
    await t.call('drag', { tab, from_ref: t.ref(s, 'button', 'Pear card'), to_ref: t.ref(s, 'region', 'Pointer basket'), snapshot: false });
    const r = await t.resultOf(tab);
    t.eq(r.pointer, 'pear', 'pointer drop');
    t.ok(r.pointerMoves > 0, 'pointermove events fired during drag');
  },
};
