import assert from 'node:assert/strict';
import test from 'node:test';
import { addHooks, isOurs, removeHooks } from '../claude-hooks.mjs';

const SCRIPT = '/Users/Alex Doe/Library/Application Support/FowlBrowser/mcp/bin/turn-ended.mjs';
const NODE = '/Users/Alex Doe/.nvm/versions/node/v22.0.0/bin/node';
const other = { hooks: [{ type: 'command', command: '/usr/bin/true', timeout: 5 }] };
const lookalike = { hooks: [{ type: 'command', command: 'echo "FowlBrowser/mcp/bin/turn-ended.mjs"' }] };

test('ours: exactly <program> <our script>, quoted or not', () => {
  assert.equal(isOurs(`'${NODE}' '${SCRIPT}'`, SCRIPT), true);
  assert.equal(isOurs(`/opt/homebrew/bin/node "${SCRIPT}"`, SCRIPT), true);
  assert.equal(isOurs('echo "FowlBrowser/mcp/bin/turn-ended.mjs"', SCRIPT), false);
  assert.equal(isOurs(`node "${SCRIPT}" && rm -rf x`, SCRIPT), false);
  assert.equal(isOurs(`node '/other/checkout/FowlBrowser/mcp/bin/turn-ended.mjs'`, SCRIPT), false);
});

test('add: three hooks once, paths with spaces quoted, other hooks and keys untouched', () => {
  const settings = { env: { A: '1' }, hooks: { Stop: [other, lookalike] } };
  const first = addHooks(settings, NODE, SCRIPT);
  assert.deepEqual(first.changes, ['added a Stop hook', 'added a SubagentStart hook', 'added a SubagentStop hook']);
  assert.equal(first.command, `'${NODE}' '${SCRIPT}'`);
  assert.deepEqual(settings.hooks.Stop.slice(0, 2), [other, lookalike]);
  assert.deepEqual(settings.env, { A: '1' });
  assert.deepEqual(addHooks(settings, NODE, SCRIPT).changes, []);
});

test('add: an old hook of ours gets the current node, keeping its other fields', () => {
  const old = { type: 'command', command: `/opt/homebrew/bin/node "${SCRIPT}"`, timeout: 7 };
  const settings = { hooks: { Stop: [{ hooks: [old] }] } };
  const { changes } = addHooks(settings, NODE, SCRIPT);
  assert.deepEqual(changes, ['updated the Stop hook', 'added a SubagentStart hook', 'added a SubagentStop hook']);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: `'${NODE}' '${SCRIPT}'`, timeout: 7 }] }]);
});

test('remove: only our hooks, empty events and hooks dropped, lookalikes kept', () => {
  const settings = { env: { A: '1' }, hooks: { Stop: [other, lookalike] } };
  addHooks(settings, NODE, SCRIPT);
  assert.equal(removeHooks(settings, SCRIPT), 3);
  assert.deepEqual(settings, { env: { A: '1' }, hooks: { Stop: [other, lookalike] } });
  const only = {};
  addHooks(only, NODE, SCRIPT);
  assert.equal(removeHooks(only, SCRIPT), 3);
  assert.deepEqual(only, {});
});
