// Real site: a YouTube watch page driven with the media tool (status, play, pause, seek, volume, mute). Mute goes
// through YouTube's player, so its own mute button shows it.
// No login, no consent clicks: a consent wall is reported as a failure.
export default {
  name: 'youtube',
  real: true,
  async run(t) {
    const tab = await t.open('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    const video = () => t.eval(tab, `() => { const v = document.querySelector('video'); return v && { paused: v.paused, time: v.currentTime, volume: v.volume, ready: v.readyState, host: location.host }; }`);

    t.step('page loads with a video');
    const first = await t.until(video, 'video element present', 20000);
    t.ok(!first.host.startsWith('consent.'), 'landed on the consent wall');

    t.step('media status');
    const status = await t.call('media', { tab, action: 'status' });
    t.ok(/paused|playing|duration/i.test(status.text), `media status: ${status.text.slice(0, 200)}`);

    t.step('play');
    await t.call('media', { tab, action: 'play' });
    await t.until(async () => { const v = await video(); return !v.paused && v.time > 0.5; }, 'playing and advancing', 20000);

    t.step('pause');
    await t.call('media', { tab, action: 'pause' });
    await t.until(async () => (await video()).paused, 'paused');

    t.step('seek');
    await t.call('media', { tab, action: 'seek', value: 10 });
    await t.until(async () => Math.abs((await video()).time - 10) < 1.5, 'currentTime near 10', 10000);

    t.step('volume');
    await t.call('media', { tab, action: 'volume', value: 0.4 });
    await t.until(async () => Math.abs((await video()).volume - 0.4) < 0.02, 'volume 0.4');

    t.step('mute shows in the player');
    const player = () => t.eval(tab, `() => { const p = document.querySelector('#movie_player'); const w = document.querySelector('.ytp-mute-button'); const b = w?.matches('button') ? w : w?.querySelector('button');
      return { muted: p.isMuted(), button: b?.getAttribute('data-title-no-tooltip') || b?.getAttribute('aria-label') || b?.title || '' }; }`);
    const muted = await t.call('media', { tab, action: 'mute' });
    t.ok(/"player":"youtube"/.test(muted.text) && /"muted":true/.test(muted.text), `media mute used the player: ${muted.text.slice(0, 300)}`);
    await t.until(async () => { const p = await player(); return p.muted && /unmute/i.test(p.button) && p; }, 'player muted, its button offers Unmute');
    await t.call('media', { tab, action: 'unmute' });
    await t.until(async () => { const p = await player(); return !p.muted && !/unmute/i.test(p.button) && p; }, 'player unmuted, its button offers Mute');
  },
};
