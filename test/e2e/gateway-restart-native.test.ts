import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { restart } from './fixtures/native-lifecycle/restart.ts';
import { runScenario } from './harness.ts';
import type { JsonObject, NativeInvocation, Scenario } from './types.ts';

for (const provider of ['antigravity', 'grok', 'cursor'] as const) {
  test(`${provider}: gateway-restart-resume preserves native conversation on disk`, async (t) => {
    const invocations: NativeInvocation[] = [];
    const native = (request: NativeInvocation) => {
      if (request.args[0] === 'models') {
        return {
          stdout: provider === 'grok' ? '* grok-e2e (default)\n' : 'e2e-model\tE2E Model\n',
        };
      }
      invocations.push(request);
      const flag = request.args.includes('--resume') ? '--resume' : '--session-id';
      const events =
        provider === 'grok'
          ? [
              { type: 'available_commands', tools: [] },
              { type: 'text', data: 'Native disk state remembered.' },
              {
                type: 'end',
                sessionId: request.args[request.args.indexOf(flag) + 1],
                stopReason: 'end_turn',
              },
            ]
          : [
              { event: 'init', conversation_id: 'agy-durable-conversation', init: {} },
              {
                event: 'result',
                result: {
                  conversation_id: 'agy-durable-conversation',
                  status: 'SUCCESS',
                  response: 'Native disk state remembered.',
                },
              },
            ];
      return { stdout: `${events.map((event) => JSON.stringify(event)).join('\n')}\n` };
    };
    const nativeScripts: Scenario['native'] = {};
    if (provider === 'antigravity') {
      nativeScripts.agy = native;
    } else if (provider === 'grok') {
      nativeScripts.grok = native;
    }
    const scenario: Scenario = {
      name: 'gateway-restart-resume',
      enabledProviders: [provider],
      permissionMode: 'bypassPermissions',
      model: `multi/${provider}/${provider === 'grok' ? 'grok-e2e' : 'e2e-model'}`,
      native: nativeScripts,
      env: {
        MULTI_CURSOR_EXTRA_MODELS: 'e2e-model',
        NODE_OPTIONS: `--import=${new URL('./fixtures/native-lifecycle/wire.ts', import.meta.url).href}`,
      },
      cursorModule:
        provider === 'cursor'
          ? fileURLToPath(new URL('./fixtures/native-lifecycle/cursor.ts', import.meta.url))
          : undefined,
      prompt: 'Remember the native nonce. Reply ok without tools.',
    };
    const first = await runScenario(t, scenario);
    if (!first) {
      return;
    }
    assert.equal(first.code, 0, first.stderr + first.stdout);
    const session = first.transcript.find((event) => event.type === 'result')?.session_id;
    assert.equal(typeof session, 'string');
    const second = await restart(t, first.root, String(session), {
      ...scenario,
      env: { ...scenario.env, MULTI_E2E_DISK_REPLAY: '1' },
      prompt: 'Resume the same native conversation. Reply ok without tools.',
    });
    assert.ok(second);
    assert.equal(second.code, 0, second.stderr + second.stdout);
    assert.ok(!second.stdout.includes('Outer history changed'), second.stdout);
    const replay = JSON.parse(
      await readFile(path.join(first.root, 'disk-replay.json'), 'utf8'),
    ) as { status: number; text: string };
    assert.equal(replay.status, 200, JSON.stringify(replay));
    const answer = first.transcript.find((event) => event.type === 'assistant')
      ?.message as JsonObject;
    assert.ok(answer?.id);
    assert.ok(replay.text.includes(String(answer.id)), replay.text);
    if (provider === 'cursor') {
      const events = (await readFile(path.join(first.root, 'cursor-events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as JsonObject);
      const creates = events.filter((event) => event.type === 'create');
      const resumes = events.filter((event) => event.type === 'resume');
      assert.equal(creates.length, 1, JSON.stringify(events));
      assert.equal(resumes.length, 1, JSON.stringify(events));
      assert.equal(resumes[0]?.agentId, creates[0]?.agentId);
      assert.equal(events.filter((event) => event.type === 'send').length, 2);
    } else {
      assert.equal(invocations.length, 2);
      const initial = invocations[0];
      const resumed = invocations[1];
      assert.ok(initial && resumed);
      const flag = provider === 'grok' ? '--resume' : '--conversation';
      const identity =
        provider === 'grok'
          ? initial.args[initial.args.indexOf('--session-id') + 1]
          : 'agy-durable-conversation';
      assert.ok(resumed.args.includes(flag));
      assert.equal(resumed.args[resumed.args.indexOf(flag) + 1], identity);
      assert.ok(
        !resumed.args.join(' ').includes('Remember the native nonce'),
        'Only newest prompt should be dispatched after disk resume',
      );
    }
  });
}
