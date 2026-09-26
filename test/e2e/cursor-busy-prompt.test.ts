import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from './harness.ts';
import type { JsonObject } from './types.ts';

test('cursor: busy-prompt-refused with one 400 and no additional SDK send', async (t) => {
  const result = await runScenario(t, {
    name: 'cursor-busy-prompt',
    model: 'multi/cursor/e2e-model',
    enabledProviders: ['cursor'],
    permissionMode: 'bypassPermissions',
    cursorModule: fileURLToPath(new URL('./fixtures/native-lifecycle/cursor.ts', import.meta.url)),
    env: {
      MULTI_CURSOR_EXTRA_MODELS: 'e2e-model',
      MULTI_E2E_CURSOR_BUSY: '1',
      NODE_OPTIONS: `--import=${new URL('./fixtures/native-lifecycle/wire.ts', import.meta.url).href}`,
    },
  });
  if (!result) {
    return;
  }
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const events = (await readFile(path.join(result.root, 'cursor-events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as JsonObject);
  assert.equal(events.filter((event) => event.type === 'send').length, 1, JSON.stringify(events));
  const refusals = events.filter((event) => event.type === 'busy-response');
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0]?.status, 400);
  assert.match(String(refusals[0]?.text), /running|busy/i);
});
