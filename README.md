<p align="center">
  <img src="extension/icons/icon-128.png" width="96" height="96" alt="FowlBrowser icon">
</p>

<h1 align="center">FowlBrowser</h1>

<p align="center">Let your AI agents use your real browser, in background tabs, while you keep working.</p>

FowlBrowser lets AI agents like Claude Code and Codex use the Chrome or Helium you already have, with your logins,
bookmarks and open tabs. Agents work in their own tabs in the background, several at once, and never pull the browser
in front of you. Open an agent's tab whenever you like, and a cursor shows exactly what it is doing.

<p align="center">
  <img src="docs/cursor.png" width="720" alt="An agent filling in a checkout form; its cursor, labeled Claude, rests on the Phone field">
</p>

## What it does

- **Uses the browser you're already signed in to.** Gmail, GitHub, Google Docs, YouTube and X just work. There's no
  separate browser profile to set up and no logging in again.
- **Stays out of your way.** Agent tabs open in the background, muted, inside a folded tab group. Nothing jumps to the
  front, and pop-ups the agent triggers stay in the background too.
- **Shows its work.** In the tab you're looking at, a cursor with the agent's name moves to each click and says what
  it's doing ("typing", "scrolling").
- **Lets you step in.** Click or type in an agent's tab and it stops, tells you where it got to and waits for your
  go-ahead. When a step needs you, like a login, a code or a payment, it hands you the tab and waits until you're done.
- **Asks before acting for you.** Agents are told to check with you before they send, post, buy, delete or change
  account settings, and to treat text on web pages as information, never as instructions.
- **Cleans up.** When the agent finishes its reply, its work tabs close and any of your tabs it borrowed go back to
  you. Tabs it opened for you stay open.
- **Runs many agents at once.** Every agent session has its own tabs, so agents working in parallel never get in each
  other's way.
- **Measures pages too.** Performance traces with Core Web Vitals, Lighthouse audits and memory readings, in the agent's
  own tab, without a debugging port.

## What you can ask

Ask in plain words. The agent picks the browser you name, or the one where you're signed in.

> Open my GitHub notifications and tell me what needs a reply.

> Find the RSVP form in my email, fill it in with my details and stop before sending.

> Use my Work browser to download last month's invoices from the billing page. Hand me the tab if it asks me to sign in.

> Open YouTube in Helium, play my Watch Later list and leave the tab for me.

> Why is this page slow? Trace it and tell me what to fix first.

## Install

You need a Mac, [Node.js](https://nodejs.org) 22 or newer, Google Chrome or [Helium](https://helium.computer), and
[Claude Code](https://claude.com/claude-code) or another AI agent that supports MCP. Chromium, Brave, Edge, Arc and
Vivaldi work too, but are less tested.

**1. Run the installer.** In Terminal:

```sh
git clone https://github.com/argofowl/FowlBrowser.git
cd FowlBrowser
sh install.sh
```

It copies FowlBrowser to `~/Library/Application Support/FowlBrowser`, connects it to your browsers and, if you use
Claude Code, adds it there too. It prints everything it changed.

**2. Add the extension to your browser.** FowlBrowser isn't in the Chrome Web Store yet, so you load it yourself, once
per browser profile:

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose `~/Library/Application Support/FowlBrowser/extension`. The installer puts this path
   on your clipboard: in the file picker, press Cmd-Shift-G and paste.
3. Open the extension's **Details** and turn on **Allow access to file URLs**, so agents can upload files for you.

**3. Start a new agent session.** Claude Code picks FowlBrowser up in any session started after the install. Then just
ask.

**Optional: name your browsers.** Click the FowlBrowser icon in the toolbar and give the browser a name, like Work or
Personal. Agents then see it as "Chrome (Work)", so you can say "use my work browser". Each profile with the extension
counts as its own browser. The same popup shows whether FowlBrowser is connected.

**Optional: hide the debugging bar.** While an agent works, Chrome shows a "started debugging this browser" bar. To hide
it, quit Chrome and relaunch it with this command:

```sh
open -a "Google Chrome" --args --silent-debugger-extension-api --restore-last-session
```

To update, run `git pull` and then `sh install.sh` again. To remove FowlBrowser, run `sh uninstall.sh`, then remove the
extension from each browser.

## Using other agents

FowlBrowser works with any agent that supports MCP (Model Context Protocol, the standard way agents connect to tools).
The easiest route: click the FowlBrowser icon, open **Set up an agent**, choose your agent and paste the prompt into
it. Or set it up by hand:

- **Claude Code:** done by the installer.
- **Codex:**
  ```sh
  codex mcp add fowlbrowser --env FOWLBROWSER_LABEL=Codex -- \
    "$HOME/Library/Application Support/FowlBrowser/mcp/bin/fowlbrowser-mcp"
  ```
- **Any other MCP client:** add a stdio server with the command
  `~/Library/Application Support/FowlBrowser/mcp/bin/fowlbrowser-mcp` (no arguments). Set `FOWLBROWSER_LABEL` to the
  name the cursor should show.

One difference: Claude Code closes an agent's work tabs after every reply. Other agents close them when their session
ends.

## Privacy and safety

- **Everything stays on your Mac.** FowlBrowser has no servers and collects nothing. Pages an agent reads go only to
  the agent you're using.
- **No open debugging port.** Many automation tools open a port that any program on your Mac can use to control the
  browser. FowlBrowser doesn't: it works through Chrome's extension APIs, one tab at a time.
- **Agents only touch their own tabs.** An agent controls the tabs it opened and the ones it borrowed from you. It never
  closes your tabs unless you asked, and incognito windows are left alone.
- **Locked to your account.** Agents connect to the browser through a local channel that needs a secret only your Mac
  user can read.
- **Limited powers.** Commands that would reach beyond the agent's tab, such as other tabs, window focus or your whole
  profile's cookies and storage, are blocked.

## Good to know

- FowlBrowser runs on macOS only for now.
- A sign-in window that a website opens as a separate pop-up window can still bring the browser to the front.
- Agents read pages as text with numbered elements, not as screenshots, so they're fast and cheap. They can still take
  a screenshot when the layout matters.

## For developers

### How it works

```
Agent (Claude Code, Codex or any MCP client)
  │  MCP over stdio
FowlBrowser server: one per agent session, its subagents share it
  │  local socket, token-gated
Helper (native messaging host), started by the browser
  │  native messaging
Extension: chrome.debugger and chrome.tabs
```

The extension drives only the tabs a session opened or claimed, through `chrome.debugger`, so the browser never opens a
remote-debugging port. The server talks to each tab through a local CDP relay and Playwright, and identifies every tab
by browser and id (`chrome:52`, `helium:1834`). There is no "current tab", so parallel agents can't collide.

### Tools

| Area | Tools |
| --- | --- |
| Browsers and tabs | `browser_list`, `tab_list`, `tab_open`, `tab_claim`, `tab_release`, `tab_close`, `tab_keep`, `tab_handoff`, `tab_mute`, `tab_focus` |
| Reading | `snapshot`, `screenshot`, `evaluate`, `console`, `network`, `wait_for`, `viewport` |
| Acting | `navigate`, `click`, `hover`, `type`, `fill_form`, `select_option`, `press_key`, `scroll`, `drag`, `upload_files`, `dialog`, `media` |
| Files and data | `download`, `downloads`, `export`, `browser_data` |
| Performance | `trace_start`, `trace_stop`, `trace_insight`, `lighthouse`, `memory` |

- `snapshot` returns an accessibility tree with element refs (`[ref=e12]`). After an action, results list only what
  changed since the last snapshot, and errors say why an action failed ("covered by the cookie banner").
- `tab_open` with `for_user: true` opens a tab meant for the user, kept after the agent's turn. `tab_claim` borrows one
  of the user's tabs, and `tab_release` gives it back.
- `tab_handoff` gives a tab to the user mid-task (logins, codes, payments). `tab_claim` with `resume: true` takes it back
  once they're done. The same call resumes a tab the user took over; agents are told to wait for the user's go-ahead.
- `viewport` lays a tab out at a phone or window size and is reset before the tab goes back to the user.
- `export` reads YouTube transcripts and Google Docs, Sheets and Slides directly. `browser_data` reads history,
  bookmarks, recently closed tabs and top sites, read only.
- `trace_start` and `trace_stop` record a DevTools performance trace and explain it (LCP, INP, CLS, long tasks and the
  same insights as the Performance panel; `trace_insight` has the details). `lighthouse` runs all five categories, as a
  phone or a desktop. `memory` reads heap and DOM counts with the change since the last reading. All of it runs in the
  agent's own tab; emulation is cleared afterwards, raw traces and reports are saved under the system temp folder, and
  Lighthouse never clears your cache or site data. Heap snapshots need Chrome's debugging port, which FowlBrowser never
  opens.

### Configuration

| Variable | What it does |
| --- | --- |
| `FOWLBROWSER_LABEL` | The agent name on the cursor and its tab group. Default `Claude`. |
| `FOWLBROWSER_SKIP_CLAUDE=1` | Makes `install.sh` and `uninstall.sh` leave Claude Code's settings alone. |

### Development

```sh
npm ci --prefix mcp && npm install --prefix test   # once
node --test extension/test/ mcp/test/ tools/test/ test/forms/test/ test/demo/test/
node tools/fake-extension.mjs --test
```

- `node test/run.mjs --browser both` runs the end-to-end scenarios against a local test site in real browsers
  (`FOWLBROWSER_TEST_PORT=5451` moves the site so two checkouts can test at once).
- `node tools/rounds.mjs` runs a round of real Claude agents at once (half in Helium, half in Chrome) and grades every
  run: the answer, whether the cursor was on target at each click, focus steals, sound, tabs left behind, time, tool
  calls and tokens. `report.html` shows a frame of the cursor at every click. Bring your own tasks with
  `--tasks <file>`.
- `node tools/rounds.mjs --tasks tools/agents/forms.json --serve "node test/forms/server.mjs"` puts 12 agents on six
  tricky forms (custom dropdowns, a virtualized list, a cross-origin card field, closed shadow DOM, drag to reorder)
  and checks every field and any mix-up between agents.
- `--surface codex` runs the same tasks on Codex's browser extension instead, graded the same way, for a head-to-head
  on `tools/agents/codex-h2h.json` against a local demo shop and inbox (`--serve "node test/demo/server.mjs --all"`).
  `--remote <host>` runs the browsers and MCP servers on a second Mac over ssh.

The full contract is in [SPEC.md](SPEC.md), the agent cursor in [docs/cursor-spec.md](docs/cursor-spec.md).

## License

MIT, see [LICENSE](LICENSE). Includes code adapted from Playwright and cursor motion adapted from Cua, see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Made by [Fowl Labs](https://fowllabs.com).
