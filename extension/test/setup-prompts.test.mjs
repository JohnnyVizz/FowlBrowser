// Run: node --test extension/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AGENTS } from '../setup-prompts.js';

test('docs/agent-setup.md quotes the popup prompts word for word, one block per agent', () => {
  const doc = fs.readFileSync(new URL('../../docs/agent-setup.md', import.meta.url), 'utf8');
  const blocks = [...doc.matchAll(/^## (.+)\n\n```text\n([\s\S]+?)\n```$/gm)].map(([, name, prompt]) => ({ name, prompt }));
  assert.deepEqual(blocks, Object.values(AGENTS).map(({ name, prompt }) => ({ name, prompt })));
});
