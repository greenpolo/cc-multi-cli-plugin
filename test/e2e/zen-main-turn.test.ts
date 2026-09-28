import assert from 'node:assert/strict';
import test from 'node:test';
import { runScenario } from './harness.ts';

for (const model of ['kimi-k3', 'gpt-6-luna']) {
  test(`Zen fake protocol: ${model}`, async (t) => {
    const result = await runScenario(t, {
      name: 'zen-main-turn',
      model: `multi/zen/${model}`,
      enabledProviders: ['zen'],
      upstream: { zen: () => ({ text: 'Zen fixture complete.' }) },
      live: {
        providers: ['zen'],
        purpose: 'main-session',
        prompt: 'Reply exactly ok. Do not use tools.',
        maxTurns: 1,
        // Claude prices unknown models itself; one Zen turn with cache writes estimates ~$0.07.
        maxBudgetUsd: 0.15,
      },
    });
    if (!result) {
      return;
    }
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.hookAcks.length, 1);
    if (result.tier === 'hermetic') {
      assert.match(result.stdout, /Zen fixture complete/);
      assert.equal(result.requests[0]?.headers.authorization, 'Bearer e2e-dummy-zen');
    }
  });
}
