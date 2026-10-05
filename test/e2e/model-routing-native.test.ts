import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { registeredWorker } from './agents.ts';
import { runScenario } from './harness.ts';
import type { NativeScript } from './types.ts';

const agy: NativeScript = (request) => ({
  stdout:
    request.args[0] === 'models'
      ? 'e2e-model\tE2E Model\n'
      : `${JSON.stringify({ event: 'init', conversation_id: 'routing-agy', init: {} })}\n${JSON.stringify({ event: 'result', result: { conversation_id: 'routing-agy', status: 'SUCCESS', response: 'NATIVE_ROUTED_ONCE' } })}\n`,
});
const grok: NativeScript = (request) => ({
  stdout:
    request.args[0] === 'models'
      ? '- grok-e2e (default)\n'
      : `${[
          { type: 'available_commands', tools: [] },
          { type: 'text', data: 'NATIVE_ROUTED_ONCE' },
          {
            type: 'end',
            sessionId: request.args[request.args.indexOf('--session-id') + 1],
            stopReason: 'end_turn',
          },
        ]
          .map((event) => JSON.stringify(event))
          .join('\n')}\n`,
});

for (const [provider, id] of [
  ['antigravity', 'e2e-model'],
  ['grok', 'grok-e2e'],
  ['cursor', 'e2e-cursor'],
] as const) {
  for (const agent of [false, true]) {
    test(`model-routing: ${provider} ${agent ? 'Agent' : 'picker'} advertised fake catalog`, async (t) => {
      const result = await runScenario(t, {
        name: 'model-routing-native',
        enabledProviders: [provider],
        permissionMode: 'bypassPermissions',
        model: agent ? 'claude-sonnet-4-6' : `multi/${provider}/${id}`,
        env: { MULTI_MODELS: `multi/${provider}/${id}` },
        native: { agy, grok },
        cursorModule: fileURLToPath(new URL('./fixtures/provider-wire/cursor.ts', import.meta.url)),
        upstream: {
          anthropic: (request, index) =>
            index === 0
              ? {
                  tool: {
                    name: 'Agent',
                    input: {
                      ...registeredWorker(request, provider, id),
                      description: 'Check native route',
                      prompt: 'Reply NATIVE_ROUTED_ONCE without tools.',
                    },
                  },
                }
              : { text: 'ROUTING_COMPLETE' },
        },
      });
      if (!result) {
        return;
      }
      assert.equal(result.code, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /NATIVE_ROUTED_ONCE/);
      const runs = result.nativeInvocations.filter((invocation) => invocation.args[0] !== 'models');
      if (provider === 'cursor') {
        assert.equal(runs.length, 0);
        const sends = (await readFile(path.join(result.workspace, 'cursor-requests.jsonl'), 'utf8'))
          .trim()
          .split('\n');
        assert.equal(sends.length, 1);
        assert.match(sends[0] ?? '', /"id":"e2e-cursor"/);
        assert.match(sends[0] ?? '', /"id":"fast","value":"false"/);
      } else {
        assert.equal(runs.length, 1, result.stdout);
        assert.equal(runs[0]?.name, provider === 'grok' ? 'grok' : 'agy');
        assert.ok(runs[0]?.args.includes(id));
      }
      assert.equal(
        result.requests.filter(
          (request) => request.provider !== 'anthropic' && !request.path.includes('/models'),
        ).length,
        0,
      );
      assert.deepEqual(result.upstreamErrors, []);
    });
  }
}
