// FowlBrowser service worker: native messaging transport plus chrome event wiring.
// The logic lives in core.js so it can be tested without a browser.
import { createCore } from './core.js';

const HOST_NAME = 'com.fowl.browser';
const RECONNECT_DELAY_MS = 1000;
const RECONNECT_ALARM = 'reconnect';

let port = null;

const core = createCore({ chrome, send: (msg) => port?.postMessage(msg) });

function connect() {
  if (port) return;
  const current = chrome.runtime.connectNative(HOST_NAME);
  port = current;
  current.onMessage.addListener((msg) => core.handleMessage(msg));
  current.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // host missing or exited; read it so Chrome doesn't log it as unchecked
    if (port === current) port = null;
    core.portClosed();
    setTimeout(connect, RECONNECT_DELAY_MS);
  });
  core.instanceId().then((instanceId) => {
    if (port !== current) return;
    current.postMessage({
      method: 'extension.hello',
      params: { version: chrome.runtime.getManifest().version, instanceId, userAgent: navigator.userAgent },
    });
  });
}

// Listeners are registered synchronously so events wake the worker.
chrome.debugger.onEvent.addListener(core.onDebuggerEvent);
chrome.debugger.onDetach.addListener(core.onDebuggerDetach);
chrome.tabs.onCreated.addListener(core.onTabCreated);
chrome.webNavigation.onCreatedNavigationTarget.addListener(core.onNavigationTarget);
chrome.webNavigation.onCommitted.addListener(core.onNavigationCommitted);
chrome.tabs.onRemoved.addListener(core.onTabRemoved);
chrome.tabs.onReplaced.addListener(core.onTabReplaced);
chrome.tabs.onUpdated.addListener(core.onTabUpdated);
chrome.tabs.onActivated.addListener(core.onTabActivated);
chrome.downloads.onCreated.addListener(core.onDownloadCreated);
chrome.downloads.onChanged.addListener(core.onDownloadChanged);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

connect();
