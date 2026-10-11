// FowlBrowser popup: connection status, the name agents see for this browser profile, and a setup prompt per agent.
const NAMES = { chrome: 'Chrome', helium: 'Helium', chromium: 'Chromium', brave: 'Brave', edge: 'Edge' };
const REPO = 'https://github.com/argofowl/FowlBrowser';
const SERVER = '"$HOME/Library/Application Support/FowlBrowser/mcp/bin/fowlbrowser-mcp"';
const SAVE_DELAY_MS = 300;
const COPIED_MS = 1500;

const INSTALL = `Set up FowlBrowser so you can use my browsers. Clone ${REPO} (or pull it if I already have it)`;
const AGENTS = {
  claude: {
    hint: 'Copy, then paste it into Claude Code.',
    prompt: `${INSTALL}, run \`sh install.sh\` in it and tell me what it changed. Then tell me to restart Claude Code.`,
  },
  codex: {
    hint: 'Copy, then paste it into Codex.',
    prompt: `${INSTALL}, run \`FOWLBROWSER_SKIP_CLAUDE=1 sh install.sh\` in it, then run ` +
      `\`codex mcp add fowlbrowser --env FOWLBROWSER_LABEL=Codex -- ${SERVER}\`. Tell me what changed, then tell me to restart Codex.`,
  },
  other: {
    hint: 'Copy, then paste it into your agent.',
    prompt: `${INSTALL} and run \`FOWLBROWSER_SKIP_CLAUDE=1 sh install.sh\` in it. Then add an MCP server named fowlbrowser to your ` +
      `config: command ${SERVER} (full path, no arguments), env FOWLBROWSER_LABEL set to your name. ` +
      'Tell me what changed and whether I need to restart you.',
  },
};

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
  statusEl.lastElementChild.textContent = { connected: 'Connected', missing: 'Not set up' }[status.state] ?? 'Connecting…';
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
    setupEl.open = status.state === 'missing';
  }
  render();
}

const stored = await chrome.storage.local.get(['label', 'agent']);
labelEl.value = stored.label ?? '';
if (AGENTS[stored.agent]) agent = stored.agent;
render();
await refreshStatus();
setInterval(refreshStatus, 1000);
