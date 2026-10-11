/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Vendored from playwright-core/src/tools/mcp/{cdpRelay.ts,cdpRelayV2.ts} (Playwright 1.64), ported to JS:
// the browser-level CDP command handling and the extension event demux. FowlBrowser changes: the extension
// side is our host socket (passed in as `sendToExtension`) instead of a second WebSocket, the ws endpoint is
// guarded by a random path token, and `newCDPSession(page)` is answered locally so the server can ask
// which chrome tab a Playwright page is (`FowlBrowser.getTabId`). Page.bringToFront and page emulation
// (color scheme, user agent, locale, timezone, metrics, touch) are swallowed, and so are Runtime.bindingCalled
// events of FowlBrowser's own page scripts.
// Browser.getVersion reports the real browser user agent (Playwright picks macOS key handling from it), and
// when Playwright disconnects, the debugger is detached from its tabs (attached or still attaching) before
// another connection is served. Wrong paths are refused before the upgrade, and no socket or frame a local
// peer sends can throw out of the server.

import { isOwnBinding } from '../cdp.mjs';
import { debug } from '../debug.mjs';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { BrowserModel } from './browserModel.mjs';

const BROWSER_SESSION = 'fb-browser';
// Page emulation Playwright sends on page setup (prefers-color-scheme light, and more with context options):
// answered here, so the user's tabs keep their real appearance, locale and size. Focus emulation still goes through.
const SWALLOWED_EMULATION = new Set([
  'Emulation.setEmulatedMedia', 'Emulation.setAutoDarkModeOverride', 'Emulation.setUserAgentOverride',
  'Network.setUserAgentOverride', 'Emulation.setLocaleOverride', 'Emulation.setTimezoneOverride',
  'Emulation.setDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled', 'Emulation.setEmitTouchEventsForMouse',
]);
const TAB_ALIAS_PREFIX = 'fb-tab-';

export class CDPRelay {
  constructor(sendToExtension, userAgent) {
    this.model = new BrowserModel(sendToExtension);
    this._sendToExtension = sendToExtension;
    this._userAgent = userAgent;
    this._path = `/${crypto.randomBytes(16).toString('hex')}`;
    this._cdp = null;
    this._detaching = Promise.resolve();
    this.viewports = new Map(); // tabId -> { deviceScaleFactor } of a viewport override (viewport.mjs)
  }

  async start() {
    this._wss = new WebSocketServer({
      host: '127.0.0.1', port: 0, maxPayload: 256 * 1024 * 1024,
      // Refused with an HTTP error before the upgrade: only the secret path, one client at a time.
      verifyClient: ({ req }) => req.url === this._path && !this._cdp,
    });
    await new Promise((resolve, reject) => {
      this._wss.once('listening', resolve);
      this._wss.once('error', reject);
    });
    this._wss.on('error', (error) => debug('relay server error', error.message));
    this._wss.on('wsClientError', (error, socket) => { debug('relay handshake error', error.message); socket.destroy(); });
    this._wss.on('connection', (ws, request) => this._onConnection(ws, request));
    return `ws://127.0.0.1:${this._wss.address().port}${this._path}`;
  }

  stop() {
    this._cdp?.close();
    this._wss?.close();
  }

  // The extension's identity can arrive after host.hello (the extension starts later than the host).
  setUserAgent(userAgent) {
    if (userAgent) this._userAgent = userAgent;
  }

  // Extension events (already demuxed from the host socket).
  handleExtensionEvent(method, params) {
    switch (method) {
      case 'chrome.debugger.onEvent': {
        const [source, cdpMethod, cdpParams] = params;
        if (isOwnBinding(cdpMethod, cdpParams)) break; // FowlBrowser's page scripts, not Playwright's
        this.model.onDebuggerEvent(source, cdpMethod, cdpParams);
        break;
      }
      case 'chrome.debugger.onDetach':
        this.model.onDebuggerDetach(params[0]);
        break;
      case 'chrome.tabs.onCreated':
        this.model.onTabCreated(params[0]);
        break;
      case 'chrome.tabs.onRemoved':
        this.model.onTabRemoved(params[0]);
        break;
    }
  }

  _onConnection(ws, request) {
    ws.on('error', (error) => debug('relay socket error', error.message)); // e.g. a bad frame; 'close' follows
    if (request.url !== this._path || this._cdp) {
      ws.close(1000, this._cdp ? 'Another CDP client already connected' : 'Not found');
      return;
    }
    this._cdp = ws;
    const send = (message) => { try { ws.send(JSON.stringify(message)); } catch (error) { debug('relay send failed', error.message); } };
    this.model.connectOverCDP(send);
    ws.on('message', async (data) => {
      let id, sessionId, method;
      const started = Date.now();
      try {
        let message;
        try { message = JSON.parse(data.toString()); } catch { throw new Error('Message is not JSON'); }
        if (message === null || typeof message !== 'object') throw new Error('Message is not an object');
        ({ id, sessionId, method } = message);
        if (typeof method !== 'string' || (sessionId !== undefined && typeof sessionId !== 'string')) throw new Error('Message has no method');
        await this._detaching; // the previous connection's debuggers (paused workers, old child sessions) go first
        const result = await this._handleCDPCommand(method, message.params, sessionId);
        debug('cdp', method, sessionId ?? '-', `${Date.now() - started} ms`);
        send({ id, sessionId, result });
      } catch (error) {
        debug('cdp !', method, sessionId ?? '-', `${Date.now() - started} ms`, error?.message);
        if (id !== undefined) send({ id, sessionId, error: { message: String(error?.message ?? error) } });
      }
    });
    ws.on('close', () => {
      if (this._cdp !== ws) return;
      this._cdp = null;
      const { tabIds, attaching } = this.model.disconnectCDP();
      // Attachments still in flight detach themselves once they land (see BrowserModel._attachTab).
      this._detaching = Promise.all([
        ...tabIds.map((tabId) => this._sendToExtension('chrome.debugger.detach', [{ tabId }]).catch(() => {})),
        ...attaching.map((attach) => attach.catch(() => {})),
      ]);
    });
  }

  async _handleCDPCommand(method, params, sessionId) {
    // newCDPSession(page): root -> browser session -> per-tab alias that only answers FowlBrowser.getTabId.
    if (sessionId === BROWSER_SESSION) {
      if (method === 'Target.attachToTarget') {
        const tabId = this.model.tabIdForTarget(params?.targetId);
        if (tabId === undefined) throw new Error(`No tab for target ${params?.targetId}`);
        return { sessionId: `${TAB_ALIAS_PREFIX}${tabId}` };
      }
      if (method === 'Target.detachFromTarget') return {};
      throw new Error(`${method} is not supported on the browser session`);
    }
    if (sessionId?.startsWith(TAB_ALIAS_PREFIX)) {
      if (method === 'FowlBrowser.getTabId') return { tabId: Number(sessionId.slice(TAB_ALIAS_PREFIX.length)) };
      if (method === 'Runtime.runIfWaitingForDebugger') return {};
      throw new Error(`${method} is not supported on a tab id session`);
    }
    if (SWALLOWED_EMULATION.has(method)) return {};

    switch (method) {
      case 'Page.bringToFront':
      case 'Target.activateTarget':
        return {}; // never steal focus from the user; tab_focus is the only way to activate a tab
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: `Chrome/${this._userAgent?.match(/Chrome\/(\S+)/)?.[1] ?? '0'}`,
          revision: '', jsVersion: '',
          userAgent: this._userAgent ?? 'CDP-Bridge-Server/1.0.0',
        };
      case 'Browser.setDownloadBehavior':
        return {};
      case 'Target.attachToBrowserTarget':
        return { sessionId: BROWSER_SESSION };
      case 'Target.setAutoAttach':
        if (sessionId) break;
        await this.model.enableAutoAttach();
        return {};
      case 'Target.createTarget':
        return await this.model.createTarget(params?.url);
      case 'Target.closeTarget':
        return await this.model.closeTarget(params?.targetId);
      case 'Target.getTargetInfo':
        return this.model.getTargetInfo(sessionId);
    }
    if (!sessionId) return await this.model.sendBrowserCommand(method, params);
    const result = await this.model.sendCommand(sessionId, method, params);
    // Playwright's CSS-px screenshots under a viewport override (viewport.mjs): they divide by contentSize / cssContentSize,
    // which stays the screen's own scale, so report the override's devicePixelRatio; and a mobile page zoomed out (no
    // viewport meta) is reported at page scale 1, so the shot covers the layout viewport in layout px, as clicks use.
    const override = method === 'Page.getLayoutMetrics' && this.viewports.get(this.model.tabIdForSession(sessionId));
    if (override && result?.cssContentSize) {
      const scale = override.deviceScaleFactor;
      if (scale) result.contentSize = { ...result.contentSize, width: result.cssContentSize.width * scale, height: result.cssContentSize.height * scale };
      if (result.visualViewport) result.visualViewport = { ...result.visualViewport, scale: 1 };
    }
    return result;
  }
}
