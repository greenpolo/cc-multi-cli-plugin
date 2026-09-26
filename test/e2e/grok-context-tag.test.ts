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
  throw new Error('Refused Grok requests must never invoke the native CLI');
};

for (const kind of ['grok', 'quota']) {
  test(`grok: ${kind === 'grok' ? 'unsupported [1m] tag is refused identically without native dispatch' : 'unexpired login stays signed in below one hour'}`, {
    ...(kind === 'quota'
      ? { todo: 'Grok quota floors remaining hours and reports Login expired early' }
      : {}),
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
          if (index === 0) {
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
    assert.equal(output.replies.length, 2);
    for (const reply of output.replies) {
      assert.equal(reply.status, 400);
      assert.equal(reply.body.type, 'error', 'Refusal must never become a successful message');
      assert.equal(reply.body.error.type, 'invalid_request_error');
      assert.match(reply.body.error.message, /Unknown Grok model/);
      assert.equal(reply.body.stop_reason, undefined);
      assert.equal(reply.body.content, undefined);
    }
    assert.deepEqual(
      output.replies[0],
      output.replies[1],
      'Identical retry receives the same refusal',
    );
    assert.equal(runs.length, 0, 'Neither refused request may invoke native inference');
    assert.match(
      result.stdout,
      /Unknown Grok model/,
      'The refusal is visible in the tool transcript',
    );
  });
}
