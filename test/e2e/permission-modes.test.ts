import assert from 'node:assert/strict';
import test from 'node:test';
import { runScenario } from './harness.ts';
import type { PermissionMode } from './types.ts';

// Admission smoke only. Interactive approval/deny decisions belong in TTY scenarios.
const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
for (const permissionMode of modes) {
  test(`permission mode is owned by real Claude: ${permissionMode}`, async (t) => {
    const result = await runScenario(t, {
      name: `permission-${permissionMode}`,
      permissionMode,
      upstream: { anthropic: () => ({ text: 'ok' }) },
      live: {
        providers: ['anthropic'],
        purpose: 'permissions',
        prompt: 'Reply with exactly ok. Do not use tools.',
        maxTurns: 1,
        maxBudgetUsd: 0.05,
      },
    });
    if (!result) {
      return;
    }
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const init = result.transcript.find(
      (event) => event.type === 'system' && event.subtype === 'init',
    );
    assert.equal(init?.permissionMode, permissionMode);
    assert.match(result.stdout, /ok/i);
  });
}

test('live scenarios reject unbounded requests before looking up credentials', async (t) => {
  await assert.rejects(
    runScenario(t, {
      name: 'invalid-live-budget',
      tier: 'live',
      live: {
        providers: [],
        purpose: 'main-session',
        prompt: 'ok',
        maxTurns: 100,
        maxBudgetUsd: 100,
      },
    }),
    /require 1–6 turns/,
  );
});

test('unscripted live variants report a skip, not a failure', async (t) => {
  assert.equal(await runScenario(t, { name: 'unscripted-live', tier: 'live' }), undefined);
});
