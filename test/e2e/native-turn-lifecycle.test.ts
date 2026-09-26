import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  changedPrompt,
  deliver,
  readWire,
  waitForCompletion,
} from './fixtures/native-lifecycle/probe.ts';
import { runScenario } from './harness.ts';
import type { JsonObject, NativeInvocation } from './types.ts';

function reply(provider: 'antigravity' | 'grok', request: NativeInvocation, failed = false) {
  if (request.args[0] === 'models') {
    return { stdout: provider === 'grok' ? '* grok-e2e (default)\n' : 'e2e-model\tE2E Model\n' };
  }
  const resumeFlag = request.args.includes('--resume') ? '--resume' : '--session-id';
  const events =
    provider === 'grok'
      ? [
          { type: 'available_commands', tools: [] },
          { type: 'text', data: 'Native lifecycle complete.' },
          {
            type: 'end',
            sessionId: request.args[request.args.indexOf(resumeFlag) + 1],
            stopReason: 'end_turn',
          },
        ]
      : [
          { event: 'init', conversation_id: 'agy-lifecycle', init: {} },
          {
            event: 'result',
            result: {
              conversation_id: 'agy-lifecycle',
              status: failed ? 'ERROR' : 'SUCCESS',
              response: failed ? 'Native execution failed.' : 'Native lifecycle complete.',
            },
          },
        ];
  return { stdout: `${events.map((event) => JSON.stringify(event)).join('\n')}\n` };
}

for (const provider of ['antigravity', 'grok'] as const) {
  for (const scenario of ['busy-prompt-refused', 'history-rewind-notice'] as const) {
    test(`${provider}: ${scenario}`, async (t) => {
      const started = Promise.withResolvers<string>();
      let runs = 0;
      let probe: Awaited<ReturnType<typeof deliver>> | undefined;
      const native = async (request: NativeInvocation) => {
        if (request.args[0] !== 'models') {
          started.resolve(path.dirname(request.cwd));
          runs++;
          if (scenario === 'busy-prompt-refused' && runs === 1) {
            const wire = await readWire(await started.promise);
            probe = await deliver(
              wire,
              changedPrompt(wire, 'A different prompt during the active native run.'),
            );
          }
        }
        return reply(provider, request);
      };
      const result = await runScenario(t, {
        name: scenario,
        enabledProviders: [provider],
        permissionMode: 'bypassPermissions',
        env: {
          NODE_OPTIONS: `--import=${new URL('./fixtures/native-lifecycle/wire.ts', import.meta.url).href}`,
        },
        native: provider === 'grok' ? { grok: native } : { agy: native },
        upstream: {
          anthropic: async (request, index) => {
            if (index === 0) {
              return {
                tool: {
                  name: (request.body.tools as JsonObject[]).some((tool) => tool.name === 'Agent')
                    ? 'Agent'
                    : 'Task',
                  input: {
                    subagent_type: provider === 'grok' ? 'grok-e2e' : 'antigravity-e2e-model',
                    description: 'Native lifecycle',
                    prompt: 'Reply ok, no tools.',
                  },
                },
              };
            }
            if (scenario === 'history-rewind-notice' && !probe) {
              const wire = await readWire(await started.promise);
              const replay = await deliver(wire);
              assert.equal(replay.status, 200);
              assert.equal(runs, 1, 'Identical delivery must replay, not dispatch');
              probe = await deliver(wire, changedPrompt(wire, 'Edited outer history. Reply ok.'));
            }
            return { text: 'Lifecycle verified.' };
          },
        },
      });
      if (!result) {
        return;
      }
      assert.equal(
        result.code,
        0,
        result.upstreamErrors.join('\n') + result.stderr + result.stdout,
      );
      assert.deepEqual(result.upstreamErrors, []);
      assert.ok(probe);
      if (scenario === 'busy-prompt-refused') {
        assert.equal(probe.status, 400, probe.text);
        assert.match(probe.text, /busy|running|in progress/i);
        assert.equal(runs, 1, 'Rejected prompt must never reach native CLI');
      } else {
        assert.equal(probe.status, 200, probe.text);
        assert.match(
          probe.text,
          /Outer history changed; the native conversation continues with its own record/,
        );
        assert.equal(runs, 2);
        const invocations = result.nativeInvocations.filter(({ args }) => args[0] !== 'models');
        assert.ok(
          invocations[1]?.args.includes(provider === 'grok' ? '--resume' : '--conversation'),
        );
      }
    });
  }
}

test('native-failure-no-blind-rerun: agy ERROR must not redispatch identical prompt', {
  todo: 'Antigravity ERROR returns retryable 502 and blindly resends identical requests',
}, async (t) => {
  const started = Promise.withResolvers<string>();
  let runs = 0;
  let replay: Awaited<ReturnType<typeof deliver>> | undefined;
  const result = await runScenario(t, {
    name: 'native-failure-no-blind-rerun',
    enabledProviders: ['antigravity'],
    permissionMode: 'bypassPermissions',
    env: {
      NODE_OPTIONS: `--import=${new URL('./fixtures/native-lifecycle/wire.ts', import.meta.url).href}`,
    },
    native: {
      agy: (request) => {
        if (request.args[0] !== 'models') {
          started.resolve(path.dirname(request.cwd));
          runs++;
        }
        return reply('antigravity', request, true);
      },
    },
    upstream: {
      anthropic: async (request, index) => {
        if (index === 0) {
          return {
            tool: {
              name: (request.body.tools as JsonObject[]).some((tool) => tool.name === 'Agent')
                ? 'Agent'
                : 'Task',
              input: {
                subagent_type: 'antigravity-e2e-model',
                description: 'Known native failure',
                prompt: 'Reply ok.',
              },
            },
          };
        }
        if (!replay) {
          await waitForCompletion(await started.promise);
          const wire = await readWire(await started.promise);
          replay = await deliver(wire, { ...wire.body, stream: false });
        }
        return { text: 'Failure examined.' };
      },
    },
  });
  if (!result) {
    return;
  }
  assert.equal(result.code, 0, result.upstreamErrors.join('\n') + result.stderr + result.stdout);
  assert.ok(replay);
  assert.equal(runs, 1, `Identical retry dispatched ${runs} native runs; HTTP ${replay.status}`);
  assert.notEqual(replay.status, 502);
});
