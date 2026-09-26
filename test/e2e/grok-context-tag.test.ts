import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runScenario } from './harness.ts';
import type { JsonObject, NativeScript } from './types.ts';

const grok: NativeScript = ({ args }) => {
  if (args[0] === 'models') {
    return { stdout: '* e2e (default)\n' };
  }
  const flag = args.includes('--resume') ? '--resume' : '--session-id';
  return {
    stdout: `${[
      { type: 'available_commands', tools: [] },
      { type: 'text', data: 'Grok fixture complete.' },
      {
        type: 'end',
        sessionId: args[args.indexOf(flag) + 1],
        stopReason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 7 },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')}\n`,
  };
};

for (const kind of ['grok', 'quota']) {
  test(`grok: ${kind === 'grok' ? 'context tag preserves retry identity' : 'unexpired login stays signed in below one hour'}`, {
    todo:
      kind === 'grok'
        ? 'Grok request key does not normalize the [1m] context tag'
        : 'Grok quota floors remaining hours and reports Login expired early',
  }, async (t) => {
    const result = await runScenario(t, {
      name: `grok-${kind}`,
      enabledProviders: ['grok'],
      permissionMode: 'bypassPermissions',
      native: { grok },
      fixtures: {
        'workspace/wire.mjs': await readFile(
          new URL('./fixtures/usage-receipts/wire.mjs', import.meta.url),
          'utf8',
        ),
        '.grok/auth.json': JSON.stringify({
          account: {
            key: 'e2e-dummy-grok',
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          },
        }),
      },
      upstream: {
        anthropic: (request, index) => {
          if (kind === 'grok' && index === 0) {
            const tools = request.body.tools as JsonObject[];
            return {
              tool: {
                name: tools.some((tool) => tool.name === 'Agent') ? 'Agent' : 'Task',
                input: {
                  subagent_type: 'grok-e2e',
                  description: 'Grok worker',
                  prompt: 'Reply ok, no tools.',
                },
              },
            };
          }
          if (index === (kind === 'grok' ? 1 : 0)) {
            const metadata = request.body.metadata as { user_id: string };
            const { session_id: session } = JSON.parse(metadata.user_id) as { session_id: string };
            return {
              tool: {
                name: 'Bash',
                id: 'toolu_wire',
                input: {
                  command: `node wire.mjs ${session} ${kind} 2`,
                  description: 'Exercise authenticated Grok gateway routes',
                },
              },
            };
          }
          return { text: 'Grok scenario complete.' };
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
    assert.deepEqual(result.upstreamErrors, []);
    const runs = result.nativeInvocations.filter(({ args }) => args[0] !== 'models');
    if (kind === 'quota') {
      assert.equal(runs.length, 0, 'Quota display must not invoke inference');
      const row = output.providers.find((provider: JsonObject) => provider.id === 'grok');
      assert.ok(row);
      assert.notEqual(row.summary, 'Login expired');
      assert.equal(row.status, 'ready');
      return;
    }
    assert.equal(output.replies.length, 3);
    assert.equal(output.replies[0].status, 200, JSON.stringify(output.replies[0].body));
    assert.equal(output.replies[1].status, 200, JSON.stringify(output.replies[1].body));
    assert.deepEqual(
      output.replies[0],
      output.replies[1],
      'Byte-identical tagged retry replays the saved answer',
    );
    assert.equal(
      runs.length,
      2,
      'One setup worker and one tagged worker; context-only retry must not dispatch again',
    );
    assert.deepEqual(output.replies[0].body, output.replies[2]);
  });
}
