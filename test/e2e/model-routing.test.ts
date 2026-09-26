import assert from 'node:assert/strict';
import test from 'node:test';
import { runScenario } from './harness.ts';

// E2E covers default and alternate routes; unit tests own exhaustive catalogs.
const catalogs = [
  { provider: 'openai' as const, models: ['gpt-6-astra', 'gpt-6-luna'] },
  { provider: 'zen' as const, models: ['deepseek-v4-pro', 'kimi-k2.7-code'] },
];

for (const { provider, models } of catalogs) {
  for (const model of models) {
    test(`model-routing: picker multi/${provider}/${model}`, async (t) => {
      const result = await runScenario(t, {
        name: 'model-routing-picker',
        enabledProviders: ['openai', 'zen'],
        model: `multi/${provider}/${model}`,
        env: { MULTI_MODELS: `multi/${provider}/${model}` },
        upstream: { [provider]: () => ({ text: 'ROUTED_ONCE' }) },
      });
      if (!result) {
        return;
      }
      assert.equal(result.code, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /ROUTED_ONCE/);
      const calls = result.requests.filter((request) => !request.path.includes('/models'));
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.provider, provider);
      assert.equal(calls[0]?.body.model, model);
      assert.deepEqual(result.upstreamErrors, []);
    });
  }
}

for (const model of [
  'multi/openai/not-a-model',
  'multi/openai/kimi-k2.7-code',
  'multi/zen/gpt-6-astra',
]) {
  test(`model-routing: refuse unavailable picker ${model}`, async (t) => {
    const result = await runScenario(t, {
      name: 'model-routing-refused',
      enabledProviders: ['openai', 'zen'],
      model,
      env: { MULTI_MODELS: model },
    });
    if (!result) {
      return;
    }
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /not available from a connected provider/);
    assert.ok((result.stderr + result.stdout).includes(model));
    assert.equal(result.requests.filter((request) => !request.path.includes('/models')).length, 0);
    assert.deepEqual(result.upstreamErrors, []);
  });
}

test('model-routing: unknown Agent type returns the available worker list without dispatch', async (t) => {
  const result = await runScenario(t, {
    name: 'model-routing-unknown-worker',
    enabledProviders: ['openai', 'zen'],
    upstream: {
      anthropic: (_request, index) =>
        index === 0
          ? {
              tool: {
                name: 'Agent',
                input: {
                  subagent_type: 'openai-kimi-k2.7-code',
                  description: 'Reject invalid worker',
                  prompt: 'Reply ok.',
                },
              },
            }
          : { text: 'Invalid worker refused.' },
    },
  });
  if (!result) {
    return;
  }
  assert.match(result.stdout, /Agent type .* not found/);
  assert.match(result.stdout, /Available agents:.*(?:multi-openai|openai-)/);
  assert.equal(
    result.requests.filter(
      (request) => request.provider !== 'anthropic' && !request.path.includes('/models'),
    ).length,
    0,
  );
  assert.deepEqual(result.upstreamErrors, []);
});
