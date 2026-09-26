import assert from 'node:assert/strict';
import test from 'node:test';
import { MODELS, OPENAI_WORKERS } from '../../plugins/multi-openai/src/models.ts';
import { ZEN_MODELS, ZEN_WORKERS } from '../../plugins/multi-zen/src/models.ts';
import { runScenario } from './harness.ts';

const catalogs = [
  {
    provider: 'openai' as const,
    models: Object.values(MODELS),
    workers: Object.entries(OPENAI_WORKERS).map(([name, worker]) => ({
      name,
      model: worker.model,
    })),
  },
  {
    provider: 'zen' as const,
    models: ZEN_MODELS.map((model) => model.id),
    workers: Object.entries(ZEN_WORKERS).map(([name, worker]) => ({
      name,
      model: worker.model.replace('multi/zen/', ''),
    })),
  },
];

for (const { provider, models, workers } of catalogs) {
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
  for (const { name, model } of workers) {
    test(`model-routing: Agent ${name}`, async (t) => {
      const result = await runScenario(t, {
        name: 'model-routing-worker',
        enabledProviders: ['openai', 'zen'],
        env: { MULTI_MODELS: `multi/${provider}/${model}` },
        upstream: {
          [provider]: () => ({ text: 'WORKER_ROUTED_ONCE' }),
          anthropic: (_request, index) =>
            index === 0
              ? {
                  tool: {
                    name: 'Agent',
                    input: {
                      subagent_type: name,
                      description: 'Check provider routing',
                      prompt: 'Reply WORKER_ROUTED_ONCE, no tools.',
                    },
                  },
                }
              : { text: 'ROUTING_COMPLETE' },
        },
      });
      if (!result) {
        return;
      }
      assert.equal(result.code, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /WORKER_ROUTED_ONCE/);
      const calls = result.requests.filter(
        (request) => request.provider !== 'anthropic' && !request.path.includes('/models'),
      );
      assert.equal(calls.length, 1, result.stdout);
      assert.equal(calls[0]?.provider, provider);
      assert.equal(calls[0]?.body.model, model);
      const main = result.requests.filter(
        (request) => request.provider === 'anthropic' && request.path.startsWith('/v1/messages?'),
      );
      // Claude may make an additional worker-summary request.
      assert.ok(main.length >= 2);
      assert.ok(
        main.some(
          (request) =>
            request.raw.includes('WORKER_ROUTED_ONCE') && request.raw.includes('tool_result'),
        ),
      );
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
  assert.match(result.stdout, /Available agents:.*openai-native/);
  assert.equal(
    result.requests.filter(
      (request) => request.provider !== 'anthropic' && !request.path.includes('/models'),
    ).length,
    0,
  );
  assert.deepEqual(result.upstreamErrors, []);
});
