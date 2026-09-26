import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { registeredWorker } from './agents.ts';
import { runScenario } from './harness.ts';
import type { JsonObject } from './types.ts';

for (const count of [1, 33]) {
  test(`usage-receipts: ${count} Cursor workers remain in session billing`, {
    ...(count > 32
      ? { todo: 'Cursor billed usage omits workers evicted from the 32-agent cache' }
      : {}),
  }, async (t) => {
    const result = await runScenario(t, {
      name: 'usage-receipts',
      enabledProviders: ['cursor'],
      env: { MULTI_CURSOR_EXTRA_MODELS: 'e2e' },
      permissionMode: 'bypassPermissions',
      cursorModule: fileURLToPath(new URL('./fixtures/usage-receipts/cursor.mjs', import.meta.url)),
      fixtures: {
        'workspace/wire.mjs': await readFile(
          new URL('./fixtures/usage-receipts/wire.mjs', import.meta.url),
          'utf8',
        ),
      },
      upstream: {
        anthropic: (request, index) => {
          if (index === 0) {
            const tools = request.body.tools as JsonObject[];
            return {
              tool: {
                name: tools.some((tool) => tool.name === 'Agent') ? 'Agent' : 'Task',
                input: {
                  ...registeredWorker(request, 'cursor', 'e2e'),
                  description: 'Metered worker',
                  prompt: 'Reply ok, no tools.',
                },
              },
            };
          }
          if (index === 1) {
            const metadata = request.body.metadata as { user_id: string };
            const { session_id: session } = JSON.parse(metadata.user_id) as { session_id: string };
            return {
              tool: {
                name: 'Bash',
                id: 'toolu_usage',
                input: {
                  command: `node wire.mjs ${session} cursor ${count}`,
                  description: 'Read session billing through authenticated gateway',
                },
              },
            };
          }
          return { text: 'Usage scenario complete.' };
        },
      },
    });
    if (!result) {
      return;
    }
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const output = JSON.parse(
      await readFile(path.join(result.workspace, 'wire-output.json'), 'utf8'),
    );
    assert.equal(
      output.usage.entries.find((entry: JsonObject) => entry.provider === 'cursor').requests,
      count,
    );
    const receipt = output.receipts.receipts.find((item: { entries: JsonObject[] }) =>
      item.entries.some((entry) => entry.provider === 'cursor'),
    );
    assert.ok(receipt, 'Real worker completion emits a Cursor receipt');
    assert.equal(receipt.outcome, 'completed');
    assert.equal(receipt.usage.input_tokens, 11);
    assert.equal(receipt.usage.output_tokens, 7);
    assert.equal(
      output.billed.agents.length,
      count,
      'Billed session must include every native worker, including evicted agents',
    );
    assert.equal(
      new Set(output.billed.agents.map((agent: JsonObject) => agent.agentId)).size,
      count,
    );
    assert.equal(output.billed.agents[0].usage.inputTokens, 11);
    assert.equal(output.billed.agents[0].usage.outputTokens, 7);
    assert.deepEqual(result.upstreamErrors, []);
  });
}
