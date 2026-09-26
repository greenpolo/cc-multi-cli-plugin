import assert from 'node:assert/strict';
import test from 'node:test';
import { restart } from './fixtures/native-lifecycle/restart.ts';
import { runScenario } from './harness.ts';
import type { NativeInvocation, Scenario } from './types.ts';

test('antigravity: /compact summarizes once with native tools denied', {
  todo: 'Fresh-process native /compact loses permission mode and returns unsupported-mode 502',
}, async (t) => {
  const runs: NativeInvocation[] = [];
  const scenario: Scenario = {
    name: 'native-session-compaction',
    model: 'multi/antigravity/e2e-model',
    enabledProviders: ['antigravity'],
    permissionMode: 'bypassPermissions',
    prompt: 'Remember native-release-731. Reply ok without tools.',
    live: {
      providers: ['antigravity'],
      purpose: 'compaction',
      prompt: 'Remember native-release-731. Reply ok without tools.',
      maxTurns: 1,
      maxBudgetUsd: 0.1,
    },
    native: {
      agy: (request) => {
        if (request.args[0] === 'models') {
          return { stdout: 'e2e-model\tE2E Model\n' };
        }
        runs.push(request);
        return {
          stdout: `${[
            { event: 'init', conversation_id: 'agy-compact', init: {} },
            {
              event: 'result',
              result: {
                conversation_id: 'agy-compact',
                status: 'SUCCESS',
                response: 'Summary: native-release-731 remains remembered.',
              },
            },
          ]
            .map((event) => JSON.stringify(event))
            .join('\n')}\n`,
        };
      },
    },
  };
  const first = await runScenario(t, scenario);
  if (!first) {
    return;
  }
  assert.equal(first.code, 0, first.stderr + first.stdout);
  const session = first.transcript.find((event) => event.type === 'result')?.session_id;
  assert.equal(typeof session, 'string');
  const compact = await restart(t, first.root, String(session), {
    ...scenario,
    prompt: '/compact Preserve the native release nonce.',
  });
  assert.ok(compact);
  assert.equal(compact.code, 0, compact.stderr + compact.stdout);
  assert.equal(
    compact.transcript.filter(
      (event) => event.type === 'system' && event.subtype === 'compact_boundary',
    ).length,
    1,
    compact.stdout,
  );
  assert.equal(runs.length, 2);
  const summary = runs[1];
  assert.ok(summary);
  assert.match(summary.env.MULTI_ANTIGRAVITY_DENY ?? '', /run_command/);
  assert.match(summary.env.MULTI_ANTIGRAVITY_DENY ?? '', /write_to_file/);
  const next = await restart(t, first.root, String(session), {
    ...scenario,
    prompt: 'Recall the release nonce without tools.',
  });
  assert.ok(next);
  assert.equal(next.code, 0, next.stderr + next.stdout);
  assert.equal(runs.length, 3);
  assert.ok(runs[2]?.args.includes('--conversation'));
  assert.match(next.stdout, /native-release-731/);
});
