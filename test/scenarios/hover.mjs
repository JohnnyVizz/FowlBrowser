// CSS :hover menu: items only exist in the snapshot after hovering, and clicking one keeps the hover chain.
export default {
  name: 'hover',
  async run(t) {
    const tab = await t.open(`${t.site}/hover.html`);
    const before = await t.snapshot(tab);
    t.ok(!/button "Laptops"/.test(before), 'submenu hidden before hover');

    t.step('hover');
    await t.call('hover', { tab, ref: t.ref(before, 'navigation', 'Main menu'), snapshot: false });
    t.eq(await t.resultOf(tab), 'menu:open', 'mouseenter fired');

    t.step('click submenu item');
    const after = await t.snapshot(tab);
    await t.call('click', { tab, ref: t.ref(after, 'button', 'Laptops'), snapshot: false });
    t.eq(await t.resultOf(tab), 'picked:Laptops', 'submenu item clicked');
  },
};
