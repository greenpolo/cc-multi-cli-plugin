import assert from 'node:assert/strict';
import test from 'node:test';
import { restart } from './fixtures/native-lifecycle/restart.ts';
import { runScenario } from './harness.ts';
import type { Scenario, UpstreamScript } from './types.ts';

for (const provider of ['anthropic', 'openai'] as const) {
  test(`${provider}: /compact runs once without tools and preserves summary on resume`, async (t) => {
    let calls = 0;
    const script: UpstreamScript = () => ({
      text:
        ++calls === 2
          ? 'COMPACT_SUMMARY_731: The release password is violet-otter-731. No tools were used.'
          : 'The release password is violet-otter-731.',
    });
    const scenario: Scenario = {
      name: `${provider}-compaction`,
      model: provider === 'openai' ? 'multi/openai/gpt-6-astra' : 'claude-sonnet-4-6',
      enabledProviders: provider === 'openai' ? ['openai'] : [],
      prompt: 'Remember the release password violet-otter-731. Reply ok. No tools.',
      upstream: { [provider]: script },
      live: {
        providers: [provider],
        purpose: 'compaction',
        prompt: 'Remember the release password violet-otter-731. Reply ok. No tools.',
        maxTurns: 1,
        maxBudgetUsd: 0.1,
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
      prompt: '/compact Preserve the exact release password.',
    });
    if (!compact) {
      return;
    }
    assert.equal(compact.code, 0, compact.stderr + compact.stdout);
    const boundaries = compact.transcript.filter(
      (event) => event.type === 'system' && event.subtype === 'compact_boundary',
    );
    assert.equal(boundaries.length, 1, compact.stdout);
    assert.ok(
      !compact.transcript.some(
        (event) =>
          event.type === 'assistant' && JSON.stringify(event).includes('"type":"tool_use"'),
      ),
    );
    const followup = await restart(t, first.root, String(session), {
      ...scenario,
      prompt: 'What was the release password? Reply with it, no tools.',
    });
    if (!followup) {
      return;
    }
    assert.equal(followup.code, 0, followup.stderr + followup.stdout);
    assert.match(followup.stdout, /violet-otter-731/);
    if (first.tier === 'hermetic') {
      const inference = compact.requests.filter(
        (request) => !request.path.includes('count_tokens') && !request.path.includes('/models'),
      );
      assert.equal(inference.length, 1, JSON.stringify(inference));
      const next = followup.requests.find(
        (request) => !request.path.includes('count_tokens') && !request.path.includes('/models'),
      );
      assert.ok(next);
      assert.match(JSON.stringify(next.body), /COMPACT_SUMMARY_731/);
      assert.equal(calls, 3);
      assert.deepEqual(compact.errors.concat(followup.errors), []);
    }
  });
}
