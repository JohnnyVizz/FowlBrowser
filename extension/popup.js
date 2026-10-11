// FowlBrowser popup: connection status, the name agents see for this browser profile, and a setup prompt per agent.
import { AGENTS } from './setup-prompts.js';

const NAMES = { chrome: 'Chrome', helium: 'Helium', chromium: 'Chromium', brave: 'Brave', edge: 'Edge' };
const SAVE_DELAY_MS = 300;
const COPIED_MS = 1500;

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const labelEl = $('label');
const setupEl = $('setup');
const promptEl = $('prompt');
const tabs = [...document.querySelectorAll('.agents button')];

let status = { state: 'connecting' };
let agent = 'claude';
let setupDecided = false;

// "Chrome (Work)": what browser_list and every tool result call this browser.
function seenAs() {
  const app = NAMES[status.browser] ?? (status.browser ? status.browser : null);
  if (!app) return 'this browser';
  const label = labelEl.value.trim();
  const n = status.key?.match(/-(\d+)$/)?.[1];
  return app + (label ? ` (${label})` : n ? ` (${n})` : '');
}

function render() {
  statusEl.dataset.state = status.state;
  statusEl.lastElementChild.textContent = { connected: 'Connected', missing: 'Not set up', broken: 'Can’t start' }[status.state] ?? 'Connecting…';
  $('problem').hidden = status.state !== 'broken';
  const preview = $('preview');
  preview.textContent = 'Agents see this browser as ';
  const name = document.createElement('b');
  name.textContent = seenAs();
  preview.append(name, '.');
  for (const tab of tabs) {
    tab.setAttribute('aria-selected', String(tab.dataset.agent === agent));
    tab.tabIndex = tab.dataset.agent === agent ? 0 : -1; // Tab reaches the selected one; arrows move between them
  }
  $('prompt-text').textContent = AGENTS[agent].prompt;
  $('prompt-hint').textContent = AGENTS[agent].hint;
}

let saveTimer = null;
function saveLabel() {
  clearTimeout(saveTimer);
  saveTimer = null;
  chrome.storage.local.set({ label: labelEl.value.trim() });
}

labelEl.addEventListener('input', () => {
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLabel, SAVE_DELAY_MS);
});
labelEl.addEventListener('keydown', (event) => { if (event.key === 'Enter') { saveLabel(); labelEl.blur(); } });
labelEl.addEventListener('blur', () => { if (saveTimer) saveLabel(); });
addEventListener('pagehide', () => { if (saveTimer) saveLabel(); });

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    agent = tab.dataset.agent;
    chrome.storage.local.set({ agent });
    render();
  });
}

// Left and right arrows move between the agent tabs.
$('setup').querySelector('.agents').addEventListener('keydown', (event) => {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const from = tabs.includes(document.activeElement) ? tabs.indexOf(document.activeElement) : tabs.findIndex((t) => t.dataset.agent === agent);
  const next = tabs[(from + step + tabs.length) % tabs.length];
  next.focus();
  next.click();
});

let copiedTimer = null;
promptEl.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(AGENTS[agent].prompt);
  } catch {
    $('prompt-hint').textContent = 'Could not copy. Select the text and press ⌘C.';
    return;
  }
  promptEl.classList.add('copied');
  $('prompt-hint').textContent = 'Copied.';
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { promptEl.classList.remove('copied'); render(); }, COPIED_MS);
});

async function refreshStatus() {
  const next = await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null);
  if (!next) return;
  status = next;
  // Setup starts open while it is needed and folded away once this browser is connected; then it is the user's.
  if (!setupDecided && status.state !== 'connecting') {
    setupDecided = true;
    setupEl.open = status.state === 'missing' || status.state === 'broken';
  }
  render();
}

const stored = await chrome.storage.local.get(['label', 'agent']);
labelEl.value = stored.label ?? '';
if (AGENTS[stored.agent]) agent = stored.agent;
render();
await refreshStatus();
setInterval(refreshStatus, 1000);
