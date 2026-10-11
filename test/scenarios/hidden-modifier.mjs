// Agent clicks that may open a popup carry the new-tab modifier (SPEC "Popups (session 5)"), but the page never sees
// it: its mouse handlers read metaKey and ctrlKey false and no Meta or Control key event reaches it. Buttons that
// navigate (location.href, or a page that opens a new tab itself on Cmd-click) still navigate in place.
export default {
  name: 'hidden-modifier',
  async run(t) {
    const url = `${t.site}/modifier.html?tag=${t.tag}`;
    const tab = await t.open(url);

    t.step('the page sees a plain click');
    await t.call('click', { tab, ref: await t.refOf(tab, 'button', 'Record modifiers'), snapshot: false });
    const seen = await t.resultOf(tab);
    const types = seen.mouse.map(([type]) => type);
    t.ok(['pointerdown', 'mousedown', 'mouseup', 'click'].every((type) => types.includes(type)), `the click's events reached the page: ${JSON.stringify(seen)}`);
    t.eq(seen.mouse.filter(([, ...mods]) => mods.some(Boolean)), [], 'no mouse event showed a modifier');
    t.eq(seen.keys, [], 'no key event reached the page');

    for (const [name, via] of [['Go in place', 'in-place'], ['Cmd-click opens new tab', 'cmd-tab']]) {
      t.step(`${via}: navigates in place`);
      if (via !== 'in-place') await t.call('navigate', { tab, url });
      const res = await t.call('click', { tab, ref: await t.refOf(tab, 'button', name), snapshot: false });
      t.ok(!/New tab opened/.test(res.text), `${via}: no new tab (${res.text.slice(0, 200)})`);
      t.eq(await t.resultOf(tab), `popup:${via}`, `${via}: the tab itself went there`);
      await new Promise((r) => setTimeout(r, 500));
      t.eq((await t.listMine()).filter((x) => x.url.includes(`tag=${t.tag}`) && x.tab !== tab).map((x) => x.url), [], `${via}: no tab added`);
    }
  },
};
