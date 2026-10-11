// The paste-to-agent setup prompts, one per agent. Written for a fresh Mac where nothing is installed yet.
// docs/agent-setup.md quotes them word for word (extension/test/setup-prompts.test.mjs keeps the two the same).
const REPO = 'https://github.com/argofowl/FowlBrowser';
const SERVER = '"$HOME/Library/Application Support/FowlBrowser/mcp/bin/fowlbrowser-mcp"';

const start = (install) => 'Set up FowlBrowser so you can use my browsers (Chrome, Helium and other Chromium browsers on this Mac). ' +
  '1) Check that git and Node.js 22.19 or newer are installed; if one is missing, tell me how to install it and wait for me. ' +
  `2) Clone ${REPO} into ~/FowlBrowser (if I already have it, git pull there instead) and run \`${install}\` in it.`;
const load = (n, agent) => `${n}) Tell me what changed. Then tell me how to load the extension, once in each browser the installer ` +
  'registered: open its extensions page (chrome://extensions), turn on Developer mode, click Load unpacked and pick the ' +
  'folder ~/Library/Application Support/FowlBrowser/extension (write it out for me as an absolute path; Cmd-Shift-G in ' +
  'the file picker pastes it), then open FowlBrowser\'s Details and turn on Allow access to file URLs. ' +
  `${n + 1}) Tell me to restart ${agent} and then ask you to check FowlBrowser: call browser_list, open https://example.com ` +
  'in a background tab with tab_open, tell me its title and close the tab.';

export const AGENTS = {
  claude: {
    name: 'Claude Code',
    hint: 'Copy, then paste it into Claude Code.',
    prompt: `${start('sh install.sh')} ${load(3, 'Claude Code')}`,
  },
  codex: {
    name: 'Codex',
    hint: 'Copy, then paste it into Codex.',
    prompt: `${start('FOWLBROWSER_SKIP_CLAUDE=1 sh install.sh')} ` +
      `3) Run \`codex mcp add fowlbrowser --env FOWLBROWSER_LABEL=Codex -- ${SERVER}\`. ${load(4, 'Codex')}`,
  },
  other: {
    name: 'Other MCP clients',
    hint: 'Copy, then paste it into your agent.',
    prompt: `${start('FOWLBROWSER_SKIP_CLAUDE=1 sh install.sh')} ` +
      '3) Add an MCP server named fowlbrowser to your config: its command is ~/Library/Application Support/FowlBrowser/mcp/bin/fowlbrowser-mcp ' +
      `written out as an absolute path (no arguments), env FOWLBROWSER_LABEL set to your name. ${load(4, 'you')}`,
  },
};
