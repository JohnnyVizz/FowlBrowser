// Local HTML5 video: the media tool (status, play, pause, seek, volume, mute) and the page's own buttons.
export default {
  name: 'video',
  async run(t) {
    const tab = await t.open(`${t.site}/video.html`);
    const video = () => t.eval(tab, `() => { const v = document.querySelector('video'); return { paused: v.paused, time: v.currentTime, volume: v.volume, muted: v.muted, ready: v.readyState }; }`);
    await t.until(async () => (await video()).ready >= 2, 'video loaded');

    t.step('media status');
    const status = await t.call('media', { tab, action: 'status' });
    t.ok(/paused|playing|currentTime|duration/i.test(status.text), `media status looks like status: ${status.text.slice(0, 200)}`);

    t.step('media play');
    await t.call('media', { tab, action: 'play' });
    await t.until(async () => { const v = await video(); return !v.paused && v.time > 0.3; }, 'video playing and advancing');

    t.step('media pause');
    await t.call('media', { tab, action: 'pause' });
    await t.until(async () => (await video()).paused, 'video paused');

    t.step('media seek');
    await t.call('media', { tab, action: 'seek', value: 4 });
    await t.until(async () => Math.abs((await video()).time - 4) < 0.5, 'currentTime near 4');

    t.step('media volume');
    await t.call('media', { tab, action: 'volume', value: 0.3 });
    await t.until(async () => Math.abs((await video()).volume - 0.3) < 0.01, 'volume 0.3');

    t.step('media mute/unmute');
    await t.call('media', { tab, action: 'mute' });
    await t.until(async () => (await video()).muted, 'muted');
    await t.call('media', { tab, action: 'unmute' });
    await t.until(async () => !(await video()).muted, 'unmuted');

    t.step('custom controls');
    const s = await t.snapshot(tab);
    await t.call('click', { tab, ref: t.ref(s, 'button', 'Seek to 6s'), snapshot: false });
    await t.until(async () => Math.abs((await video()).time - 6) < 0.5, 'custom seek to 6');
    await t.call('click', { tab, ref: t.ref(s, 'button', 'Play'), snapshot: false });
    await t.until(async () => !(await video()).paused, 'custom play');
    await t.call('click', { tab, ref: t.ref(s, 'button', 'Pause'), snapshot: false });
    await t.until(async () => (await video()).paused, 'custom pause');
  },
};
