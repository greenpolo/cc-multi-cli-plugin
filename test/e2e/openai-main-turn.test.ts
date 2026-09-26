import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runScenario } from './harness.ts';

test('openai-main-turn: Responses tool round trip through real Claude', async (t) => {
  const result = await runScenario(t, {
    name: 'openai-main-turn',
    model: 'multi/openai/gpt-6-astra',
    enabledProviders: ['openai'],
    permissionMode: 'bypassPermissions',
    upstream: {
      openai: (_request, index) =>
        index === 0
          ? {
              tool: {
                name: 'Bash',
                input: { command: 'echo openai > out.txt', description: 'Write test fixture' },
              },
            }
          : { text: 'OpenAI fixture complete.' },
    },
  });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(await readFile(path.join(result.workspace, 'out.txt'), 'utf8'), 'openai\n');
  assert.equal(result.hookAcks.length, 1);
  const requests = result.requests.filter((request) => request.path.endsWith('/responses'));
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.headers.authorization, 'Bearer e2e-dummy-openai');
  assert.match(JSON.stringify(requests[1]?.body), /function_call_output/);
  assert.match(result.stdout, /OpenAI fixture complete/);
  assert.deepEqual(result.upstreamErrors, []);
});
