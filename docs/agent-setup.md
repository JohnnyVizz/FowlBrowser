# Set up FowlBrowser with an agent

Paste the prompt for your agent into it. It installs FowlBrowser on your Mac (cloning it first if needed), tells you
how to add the extension to your browser, and checks that everything works after a restart. The FowlBrowser popup
offers the same prompts under **Set up an agent**.



## Claude Code

```text
Set up FowlBrowser so you can use my browsers (Chrome, Helium and other Chromium browsers on this Mac).
1. Check that git and Node.js 22.19 or newer are installed. If one is missing, tell me how to install it and wait for me.
2. Clone https://github.com/argofowl/FowlBrowser into ~/FowlBrowser (if I already have it, git pull there instead) and run `sh install.sh` in it.
3. Tell me what changed. Then walk me through adding the extension, once in each browser the installer set up: open its extensions page (chrome://extensions), turn on Developer mode, click Load unpacked and pick the folder ~/Library/Application Support/FowlBrowser/extension (write it out for me as an absolute path; Cmd-Shift-G in the file picker pastes it), then open FowlBrowser's Details and turn on Allow access to file URLs.
4. Tell me to restart Claude Code. After that, when I ask you to check FowlBrowser: call browser_list, open https://example.com in a background tab with tab_open, tell me its title and close the tab.
```

## Codex

```text
Set up FowlBrowser so you can use my browsers (Chrome, Helium and other Chromium browsers on this Mac).
1. Check that git and Node.js 22.19 or newer are installed. If one is missing, tell me how to install it and wait for me.
2. Clone https://github.com/argofowl/FowlBrowser into ~/FowlBrowser (if I already have it, git pull there instead) and run `FOWLBROWSER_SKIP_CLAUDE=1 sh install.sh` in it.
3. Run `codex mcp add fowlbrowser --env FOWLBROWSER_LABEL=Codex -- "$HOME/Library/Application Support/FowlBrowser/mcp/bin/fowlbrowser-mcp"`.
4. Tell me what changed. Then walk me through adding the extension, once in each browser the installer set up: open its extensions page (chrome://extensions), turn on Developer mode, click Load unpacked and pick the folder ~/Library/Application Support/FowlBrowser/extension (write it out for me as an absolute path; Cmd-Shift-G in the file picker pastes it), then open FowlBrowser's Details and turn on Allow access to file URLs.
5. Tell me to restart Codex. After that, when I ask you to check FowlBrowser: call browser_list, open https://example.com in a background tab with tab_open, tell me its title and close the tab.
```

## Other MCP clients

```text
Set up FowlBrowser so you can use my browsers (Chrome, Helium and other Chromium browsers on this Mac).
1. Check that git and Node.js 22.19 or newer are installed. If one is missing, tell me how to install it and wait for me.
2. Clone https://github.com/argofowl/FowlBrowser into ~/FowlBrowser (if I already have it, git pull there instead) and run `FOWLBROWSER_SKIP_CLAUDE=1 sh install.sh` in it.
3. Add an MCP server named fowlbrowser to your config: its command is ~/Library/Application Support/FowlBrowser/mcp/bin/fowlbrowser-mcp written out as an absolute path (no arguments), env FOWLBROWSER_LABEL set to your name.
4. Tell me what changed. Then walk me through adding the extension, once in each browser the installer set up: open its extensions page (chrome://extensions), turn on Developer mode, click Load unpacked and pick the folder ~/Library/Application Support/FowlBrowser/extension (write it out for me as an absolute path; Cmd-Shift-G in the file picker pastes it), then open FowlBrowser's Details and turn on Allow access to file URLs.
5. Tell me to restart you. After that, when I ask you to check FowlBrowser: call browser_list, open https://example.com in a background tab with tab_open, tell me its title and close the tab.
```
