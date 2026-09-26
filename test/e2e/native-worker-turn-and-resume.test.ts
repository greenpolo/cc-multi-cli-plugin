import assert from 'node:assert/strict';
import test from 'node:test';
import { registeredWorker, workerCompletions, workerId, workerTool } from './agents.ts';
import { runScenario } from './harness.ts';

test('native-worker-turn-and-resume: real agent tool and fake agy process', {
  todo: 'Main revokes a finished native worker after a later Claude prompt ("settings policy has not been admitted"); fixed on the refactor by 34ffc9a',
}, async (t) => {
  const result = await runScenario(t, {
    name: 'native-worker-turn-and-resume',
    permissionMode: 'bypassPermissions',
    enabledProviders: ['antigravity'],
    env: { MULTI_E2E_REPLAY_NATIVE: '1' },
    native: {
      agy: (request) => {
        if (request.args[0] === 'models') {
          return { stdout: 'e2e-model\tE2E Model\n' };
        }
        const resumed = request.args.includes('--conversation');
        return {
          stdout: `${[
            { event: 'init', conversation_id: 'agy-e2e-conversation', init: {} },
            {
              event: 'result',
              result: {
                conversation_id: 'agy-e2e-conversation',
                status: 'SUCCESS',
                response: resumed ? 'Native follow-up complete.' : 'Native first turn complete.',
              },
            },
          ]
            .map((event) => JSON.stringify(event))
            .join('\n')}\n`,
        };
      },
    },
    upstream: {
      anthropic: (request, index) => {
        if (index === 0) {
          return {
            tool: {
              name: workerTool(request),
              id: 'toolu_first',
              input: {
                ...registeredWorker(request, 'antigravity', 'e2e-model'),
                description: 'Native E2E turn',
                prompt: 'Reply ok, no tools.',
              },
            },
          };
        }
        if (JSON.stringify(request.body.messages).includes('toolu_resume')) {
          return { text: 'Native worker scenario complete.' };
        }
        if (workerCompletions(request, workerId(request)) === 0) {
          return { text: 'Waiting for the native worker.' };
        }
        return {
          tool: {
            name: 'SendMessage',
            id: 'toolu_resume',
            input: {
              to: workerId(request),
              summary: 'Resume the native E2E worker',
              message: 'Reply ok again, no tools.',
            },
          },
        };
      },
    },
  });
  if (!result) {
    return;
  }
  assert.equal(result.code, 0, result.stderr + result.stdout + result.upstreamErrors.join('\n'));
  const runs = result.nativeInvocations.filter(({ args }) => args[0] !== 'models');
  assert.equal(runs.length, 2, result.stderr + result.stdout + result.upstreamErrors.join('\n'));
  assert.ok(runs[0]?.args.includes('--new-project'));
  assert.ok(!runs[0]?.args.includes('--conversation'));
  const second = runs[1];
  assert.ok(second);
  assert.equal(
    second.args[second.args.indexOf('--conversation') + 1],
    'agy-e2e-conversation',
    result.stderr + result.stdout + JSON.stringify(runs),
  );
  for (const run of runs) {
    assert.ok(run.args.includes('--dangerously-skip-permissions'));
    assert.match(run.env.MULTI_ANTIGRAVITY_DENY ?? '', /invoke_subagent/);
    assert.equal(run.cwd, result.workspace);
  }
  assert.equal(result.hookAcks.length, 1);
  assert.deepEqual(result.nativeReplays, ['E2E_NATIVE_REPLAY=200']);
  assert.deepEqual(result.upstreamErrors, []);
});
