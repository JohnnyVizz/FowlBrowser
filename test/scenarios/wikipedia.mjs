// Real site: search Wikipedia through its search box and land on the article.
export default {
  name: 'wikipedia',
  real: true,
  async run(t) {
    const tab = await t.open('https://en.wikipedia.org/wiki/Main_Page');
    t.step('find search box');
    const s = await t.snapshot(tab);
    const box = t.ref(s, ['searchbox', 'combobox', 'textbox'], /Search Wikipedia/i);
    t.step('type and submit');
    await t.call('type', { tab, ref: box, text: 'Ada Lovelace', submit: true, snapshot: false });
    await t.call('wait_for', { tab, url: 'Ada_Lovelace' });
    t.step('assert article');
    const title = await t.eval(tab, '() => document.title');
    t.ok(title.startsWith('Ada Lovelace'), `article title: ${title}`);
  },
};
