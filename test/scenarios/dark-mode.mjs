// Pages keep the user's real appearance: the relay swallows Playwright's color-scheme emulation, so an agent tab and a
// claimed tab both match macOS (light or dark).
import { execFileSync } from 'node:child_process';

const osDark = () => { try { return execFileSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], { encoding: 'utf8' }).trim() === 'Dark'; } catch { return false; } };
const DARK = `() => matchMedia('(prefers-color-scheme: dark)').matches`;

export default {
  name: 'dark-mode',
  async run(t) {
    const dark = osDark();
    t.step('tab_open');
    const tab = await t.open(`${t.site}/index.html?dark=${t.tag}`);
    t.eq(await t.eval(tab, DARK), dark, 'prefers-color-scheme dark in an agent tab matches macOS');

    t.step('claimed tab');
    const own = await t.userTab(`${t.site}/user.html?n=dark-${t.tag}`);
    await t.call('tab_claim', { tab: own, snapshot: false });
    t.eq(await t.eval(own, DARK), dark, 'prefers-color-scheme dark in a claimed tab matches macOS');
    await t.call('tab_release', { tab: own });
  },
};
