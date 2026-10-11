// browser_data history finds the page this test just visited; the other kinds answer.
export default {
  name: 'browser-data',
  async run(t) {
    await t.open(`${t.site}/index.html?visit=${t.tag}`);

    t.step('history');
    const found = await t.until(async () => {
      const res = await t.call('browser_data', { browser: t.browser, kind: 'history', query: t.tag, since_hours: 1 });
      return res.text.includes(`visit=${t.tag}`) && res.text;
    }, 'history lists the visited page');
    t.ok(/FowlBrowser test site · .*· last visit \d{4}-\d\d-\d\d \d\d:\d\d · \d+ visits?/.test(found), `history line: ${found}`);

    for (const kind of ['bookmarks', 'recently_closed', 'top_sites']) {
      t.step(kind);
      const res = await t.call('browser_data', { browser: t.browser, kind, max_results: 3 });
      t.ok(/^Browser: /.test(res.text), `${kind} answers: ${res.text.slice(0, 200)}`);
    }
  },
};
