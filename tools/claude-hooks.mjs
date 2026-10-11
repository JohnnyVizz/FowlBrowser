// Adds or removes FowlBrowser's Claude Code hooks (Stop, SubagentStart, SubagentStop) in a settings file. Used by
// install.sh and uninstall.sh:
//   node tools/claude-hooks.mjs add <settings.json> <node> <turn-ended.mjs>
//   node tools/claude-hooks.mjs remove <settings.json> <turn-ended.mjs>
// A hook is ours only when its whole command runs that exact script with one program: `<node> <script>`, either part
// optionally quoted. Every other hook and key is left as it is. A hook of ours with an old node path is updated.
import fs from 'node:fs';
import path from 'node:path';

const EVENTS = ['Stop', 'SubagentStart', 'SubagentStop'];
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const unquote = (s) => s.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1').replaceAll("'\\''", "'");

export function isOurs(command, script) {
  const match = /^\s*('[^']*(?:'\\''[^']*)*'|"[^"]*"|\S+)\s+('[^']*(?:'\\''[^']*)*'|"[^"]*"|\S+)\s*$/.exec(command ?? '');
  return !!match && unquote(match[2]) === script;
}

export function addHooks(settings, node, script) {
  const command = `${quote(node)} ${quote(script)}`;
  const changes = [];
  for (const event of EVENTS) {
    const entries = (settings.hooks ??= {})[event] ??= [];
    const ours = entries.flatMap((entry) => entry.hooks ?? []).filter((h) => isOurs(h.command, script));
    if (!ours.length) {
      entries.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
      changes.push(`added a ${event} hook`);
    }
    for (const hook of ours) {
      if (hook.command === command) continue;
      hook.command = command;
      changes.push(`updated the ${event} hook`);
    }
  }
  return { command, changes };
}

export function removeHooks(settings, script) {
  let removed = 0;
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    const kept = [];
    for (const entry of entries) {
      const hooks = (entry.hooks ?? []).filter((h) => !isOurs(h.command, script));
      removed += (entry.hooks?.length ?? 0) - hooks.length;
      if (hooks.length === (entry.hooks?.length ?? 0)) kept.push(entry);
      else if (hooks.length) kept.push({ ...entry, hooks });
    }
    if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return removed;
}

if (import.meta.main) {
  const [mode, file, ...rest] = process.argv.slice(2);
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const write = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`); };
  if (mode === 'add') {
    const [node, script] = rest;
    const { command, changes } = addHooks(settings, node, script);
    if (changes.length) {
      write();
      for (const change of changes) console.log(`Claude Code: ${change} in ${file}: ${command}`);
    } else console.log(`Claude Code: FowlBrowser hooks already in ${file}`);
  } else if (mode === 'remove') {
    const removed = removeHooks(settings, rest[0]);
    if (removed) { write(); console.log(`Claude Code: removed ${removed} FowlBrowser hooks from ${file}`); }
  } else {
    console.error('usage: claude-hooks.mjs add <settings> <node> <script> | remove <settings> <script>');
    process.exit(2);
  }
}
