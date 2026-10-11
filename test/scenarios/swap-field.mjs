// A field the page swaps for another when clicked (Wikipedia's search): typing into the old ref fails at once with a
// hint, instead of waiting the whole timeout for the hidden field, and typing without ref goes to the new field.
export default {
  name: 'swap-field',
  async run(t) {
    const tab = await t.open(`${t.site}/swap.html`, { snapshot: false });
    const field = t.ref(await t.snapshot(tab), 'textbox', 'Search');
    await t.call('click', { tab, ref: field, snapshot: false });

    t.step('type into the swapped-out field');
    const started = Date.now();
    const error = await t.call('type', { tab, ref: field, text: 'Ada', snapshot: false }).then(() => null, (e) => e.message);
    t.ok(error?.includes('Call type without ref to type into the focused field'), `swapped field named: ${error}`);
    t.ok(Date.now() - started < 4000, `failed fast: ${Date.now() - started} ms`);

    t.step('type without ref');
    await t.call('type', { tab, text: 'Ada Lovelace', snapshot: false });
    t.eq(await t.eval(tab, `() => document.getElementById('second').value`), 'Ada Lovelace', 'typed into the new field');
  },
};
