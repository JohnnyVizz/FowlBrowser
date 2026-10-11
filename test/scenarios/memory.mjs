// memory: a reading of the tab's heap and DOM counts, and the change since the last reading on the same page.
export default {
  name: 'memory',
  async run(t) {
    t.step('first reading');
    const tab = await t.open(`${t.site}/perf.html?m=${t.tag}`);
    const first = (await t.call('memory', { tab })).text;
    t.ok(/JS heap: [\d.]+ MB used of [\d.]+ MB/.test(first), `heap line: ${first}`);
    t.ok(/DOM: [\d,]+ nodes · \d+ JS event listeners · \d+ documents and \d+ frames alive/.test(first), `dom line: ${first}`);
    t.ok(/First reading of this page/.test(first), `first reading note: ${first}`);

    t.step('leak, then the delta');
    const leak = await t.refOf(tab, 'button', 'Leak');
    for (let i = 0; i < 3; i++) await t.call('click', { tab, ref: leak, snapshot: false });
    const second = (await t.call('memory', { tab })).text;
    const heap = /heap \+([\d.]+) MB/.exec(second);
    t.ok(heap && Number(heap[1]) >= 3, `heap grew by at least 3 MB after three 2 MB leaks: ${second}`);
    t.ok(/Since the reading \d+ s ago on this page/.test(second), `delta line: ${second}`);

    t.step('new page: first reading again');
    await t.call('navigate', { tab, url: `${t.site}/index.html?m=${t.tag}`, snapshot: false });
    const third = (await t.call('memory', { tab })).text;
    t.ok(/First reading of this page/.test(third), `no delta across documents: ${third}`);
  },
};
