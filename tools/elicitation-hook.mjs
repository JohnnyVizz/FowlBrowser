// Claude Code Elicitation hook for round agents (tools/rounds.mjs settings). `claude -p` never answers an MCP
// elicitation, so a Codex agent's question (site access, downloads, history) would hang its call for minutes. Rounds
// never answer Codex's safety prompts for the user: every one is declined at once, so the action fails fast, and
// tools/mcp-tee.mjs logs its text for the report. A task that keeps hitting one is a finding, not something to route around.
import fs from 'node:fs';

export function answer() {
  return 'decline';
}

if (import.meta.main) {
  fs.readFileSync(0, 'utf8');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action: answer(), content: {} } }));
}
