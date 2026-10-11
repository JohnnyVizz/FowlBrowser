// browser_list, tab_list, snapshot, screenshot (CSS pixel scale), console and network on our own tab.
export default {
  name: 'basics',
  async run(t) {
    t.step('browser_list');
    const browsers = await t.call('browser_list');
    t.ok(browsers.text.includes(t.browser), `browser_list names ${t.browser}: ${browsers.text.slice(0, 200)}`);

    const tab = await t.open(`${t.site}/index.html`);
    t.step('tab_list mine');
    const mine = await t.listMine();
    const entry = mine.find(x => x.tab === tab);
    t.ok(entry, `opened tab ${tab} listed as mine`);
    t.eq(entry.active, false, 'agent tab opened in the background');

    t.step('snapshot');
    const s = await t.snapshot(tab);
    t.ok(/heading "FowlBrowser test site"/.test(s), 'heading in snapshot');
    t.ok(/link "Form"/.test(s), 'link in snapshot');

    t.step('screenshot');
    const shot = await t.call('screenshot', { tab });
    t.eq(shot.images.length, 1, 'one image');
    t.eq(shot.images[0].mimeType, 'image/jpeg', 'jpeg');
    const width = jpegWidth(Buffer.from(shot.images[0].data, 'base64'));
    const cssWidth = await t.eval(tab, '() => innerWidth');
    t.eq(width, cssWidth, 'screenshot width equals CSS viewport width');

    t.step('console');
    const con = await t.call('console', { tab });
    t.ok(con.text.includes('fowlbrowser index loaded'), `console has page log: ${con.text.slice(0, 200)}`);

    t.step('network');
    const net = await t.call('network', { tab, filter: 'style.css' });
    t.ok(net.text.includes('style.css'), `network lists style.css: ${net.text.slice(0, 200)}`);
  },
};

// Reads the width from a JPEG SOF marker.
function jpegWidth(buf) {
  for (let i = 2; i < buf.length;) {
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return buf.readUInt16BE(i + 7);
    i += 2 + len;
  }
  return -1;
}
