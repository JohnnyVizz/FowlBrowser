// The viewport tool's metrics override, sent as raw CDP through the host: the relay answers Playwright's own
// Emulation.setDeviceMetricsOverride with {} so Playwright never resizes a tab, and this must not go that way.
// The override lives on the Tab (tab.viewport) and is cleared while the debugger is still attached before the tab
// leaves us (release, turn end, handoff). A detach clears it in Chrome anyway; it is never re-applied after one.
import { cdp } from './cdp.mjs';
import { viewportEvent } from './record.mjs';

export const MIN_SIZE = 200;
export const MAX_SIZE = 4000;

// deviceScaleFactor 0 keeps the screen's real one. Touch emulation follows mobile; setEmitTouchEventsForMouse is never
// sent (it would turn Playwright's clicks into touches).
export async function setViewport(tab, { width, height, mobile = false, deviceScaleFactor }) {
  const touchWasOn = tab.viewport?.mobile === true;
  // Remembered before the sends, so a half-applied override is still cleared later.
  tab.viewport = { width, height, mobile, deviceScaleFactor: deviceScaleFactor ?? null };
  tab.browser.relay.viewports.set(tab.tabId, tab.viewport);
  await cdp(tab, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: deviceScaleFactor ?? 0, mobile });
  if (mobile) await cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  else if (touchWasOn) await cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: false });
  viewportEvent('set', tab, tab.viewport, 'tool');
}

// reason: tool, release, turn end, handoff. Resolves false when no override was set.
export async function clearViewport(tab, reason = 'tool') {
  const was = tab.viewport;
  if (!was) return false;
  tab.viewport = null;
  tab.browser.relay.viewports.delete(tab.tabId);
  await cdp(tab, 'Emulation.clearDeviceMetricsOverride');
  if (was.mobile) await cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: false });
  viewportEvent('clear', tab, was, reason);
  return true;
}
